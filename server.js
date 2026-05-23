console.log('🚀 Starting Branch Competition Server v5...');

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cron = require('node-cron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// مجلد التخزين الدائم
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const COOKIES_FILE = path.join(DATA_DIR, 'cookies.txt');

// تخزين الحالة المشتركة (للتحديث التلقائي و /display)
let sharedState = {
    branches: [],
    discoveredPosts: [],
    manualPosts: [],
    sourcePlatform: 'instagram',
    sourceUsername: '',
    maxPosts: 50,
    startDate: '',
    endDate: '',
    autoUpdateEnabled: false,
    autoUpdateInterval: 6, // كل كم ساعة
    lastUpdate: null
};

function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        try {
            sharedState = { ...sharedState, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) };
            console.log('✓ State loaded:', sharedState.branches.length, 'branches');
        } catch (e) {
            console.error('Failed to load state:', e.message);
        }
    }
}

function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(sharedState, null, 2));
    } catch (e) {
        console.error('Failed to save state:', e.message);
    }
}

loadState();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// Multer for cookies upload
const upload = multer({
    storage: multer.diskStorage({
        destination: DATA_DIR,
        filename: (req, file, cb) => cb(null, 'cookies.txt')
    }),
    limits: { fileSize: 5 * 1024 * 1024 }
});

// =================== Helpers ===================
function detectPlatform(url) {
    const u = (url || '').toLowerCase();
    if (u.includes('tiktok.com')) return 'tiktok';
    if (u.includes('instagram.com')) return 'instagram';
    if (u.includes('snapchat.com')) return 'snapchat';
    return 'unknown';
}

function cleanUsername(u) { return (u || '').replace(/^@/, '').trim(); }

function parseYtDlpDate(d) {
    if (!d || d.length !== 8) return null;
    return new Date(parseInt(d.substring(0,4)), parseInt(d.substring(4,6))-1, parseInt(d.substring(6,8)));
}

function isInDateRange(uploadDate, startDate, endDate) {
    if (!uploadDate) return true;
    if (!startDate && !endDate) return true;
    const upload = parseYtDlpDate(uploadDate);
    if (!upload) return true;
    if (startDate) {
        const s = new Date(startDate); s.setHours(0,0,0,0);
        if (upload < s) return false;
    }
    if (endDate) {
        const e = new Date(endDate); e.setHours(23,59,59,999);
        if (upload > e) return false;
    }
    return true;
}

function getCookiesArg(platform) {
    if (platform === 'instagram' && fs.existsSync(COOKIES_FILE)) {
        return ` --cookies "${COOKIES_FILE}"`;
    }
    return '';
}

// =================== yt-dlp Functions ===================
function fetchPostData(url) {
    return new Promise((resolve, reject) => {
        const platform = detectPlatform(url);
        const cookiesArg = getCookiesArg(platform);
        const command = `yt-dlp --dump-json --no-warnings --no-playlist --skip-download${cookiesArg} "${url}"`;
        exec(command, { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => {
            if (error) { reject(new Error(stderr.split('\n')[0] || error.message)); return; }
            try {
                const lines = stdout.trim().split('\n').filter(l => l.trim());
                if (lines.length === 0) { reject(new Error('No data')); return; }
                const data = JSON.parse(lines[0]);
                
                let thumbnail = data.thumbnail || '';
                if (data.thumbnails && data.thumbnails.length > 0) {
                    const sorted = data.thumbnails.filter(t => t.url).sort((a, b) => (b.width || 0) - (a.width || 0));
                    if (sorted.length > 0) thumbnail = sorted[0].url;
                }
                
                let videoUrl = '';
                if (data.url && data.ext && ['mp4', 'webm'].includes(data.ext)) videoUrl = data.url;
                else if (data.formats) {
                    const playable = data.formats.filter(f => f.ext === 'mp4' && f.url);
                    if (playable.length > 0) videoUrl = playable[playable.length - 1].url;
                }
                
                resolve({
                    url, likes: data.like_count || 0, views: data.view_count || 0,
                    comments: data.comment_count || 0,
                    title: (data.title || data.description || '').substring(0, 200),
                    uploader: data.uploader || data.channel || data.uploader_id || '',
                    upload_date: data.upload_date || '', thumbnail, video_url: videoUrl,
                    duration: data.duration || 0
                });
            } catch (e) { reject(new Error('Parse error: ' + e.message)); }
        });
    });
}

function discoverUserPosts(username, platform, maxPosts) {
    return new Promise((resolve, reject) => {
        const cleanUser = cleanUsername(username);
        let url;
        if (platform === 'tiktok') url = `https://www.tiktok.com/@${encodeURIComponent(cleanUser)}`;
        else if (platform === 'instagram') url = `https://www.instagram.com/${encodeURIComponent(cleanUser)}/`;
        else return reject(new Error('Unsupported platform'));
        
        const cookiesArg = getCookiesArg(platform);
        console.log(`[${platform}] Discovering @${cleanUser}...${cookiesArg ? ' (with cookies)' : ''}`);
        const command = `yt-dlp --flat-playlist --dump-json --no-warnings --playlist-end ${maxPosts}${cookiesArg} "${url}"`;
        
        exec(command, { maxBuffer: 30 * 1024 * 1024, timeout: 120000 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`[${platform}] Discover error:`, stderr.substring(0, 300));
                reject(new Error(stderr.split('\n')[0] || error.message));
                return;
            }
            const urls = [];
            const lines = stdout.trim().split('\n').filter(l => l.trim());
            for (const line of lines) {
                try {
                    const d = JSON.parse(line);
                    if (d.url || d.webpage_url) urls.push(d.url || d.webpage_url);
                } catch (e) {}
            }
            console.log(`[${platform}] Found ${urls.length} posts`);
            resolve(urls);
        });
    });
}

// =================== APIs ===================
app.post('/api/fetch-user', async (req, res) => {
    const { username, platform, startDate, endDate, maxPosts } = req.body;
    if (!username || !platform) return res.status(400).json({ error: 'username and platform required' });
    const limit = parseInt(maxPosts) || 50;
    
    try {
        if (platform === 'snapchat') return res.status(400).json({ error: 'Snapchat لا يدعم' });
        const urls = await discoverUserPosts(username, platform, limit);
        if (urls.length === 0) {
            return res.json({ username, platform, posts: [], discoveredCount: 0, filteredOutCount: 0, failedCount: 0 });
        }
        const posts = [];
        let filteredOutCount = 0, failedCount = 0;
        for (const url of urls) {
            try {
                const data = await fetchPostData(url);
                if (!isInDateRange(data.upload_date, startDate, endDate)) { filteredOutCount++; continue; }
                posts.push(data);
            } catch (e) { failedCount++; }
        }
        res.json({ username, platform, posts, discoveredCount: urls.length, filteredOutCount, failedCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fetch-post', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const data = await fetchPostData(url);
        data.platform = detectPlatform(url);
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: حفظ الحالة (يرسلها الـ frontend بعد كل تعديل)
app.post('/api/save-state', (req, res) => {
    sharedState = { ...sharedState, ...req.body };
    saveState();
    res.json({ ok: true });
});

// API: جلب الحالة (للـ frontend عند الفتح + لشاشة العرض)
app.get('/api/state', (req, res) => {
    res.json(sharedState);
});

// API: رفع cookies
app.post('/api/upload-cookies', upload.single('cookies'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ ok: true, message: 'Cookies uploaded successfully' });
});

// API: حذف cookies
app.delete('/api/cookies', (req, res) => {
    if (fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE);
    res.json({ ok: true });
});

// API: حالة الـ cookies
app.get('/api/cookies-status', (req, res) => {
    const exists = fs.existsSync(COOKIES_FILE);
    let mtime = null;
    if (exists) {
        const stat = fs.statSync(COOKIES_FILE);
        mtime = stat.mtime;
    }
    res.json({ exists, mtime });
});

// API: تحديث يدوي للايكات (لجميع المنشورات المعتمدة)
app.post('/api/refresh-all', async (req, res) => {
    console.log('[Refresh] Starting full refresh...');
    const allPosts = [...sharedState.discoveredPosts, ...sharedState.manualPosts];
    const assigned = allPosts.filter(p => p.assignedTo);
    
    let updated = 0, failed = 0;
    for (const post of assigned) {
        try {
            const fresh = await fetchPostData(post.url);
            post.likes = fresh.likes;
            post.views = fresh.views;
            updated++;
        } catch (e) {
            failed++;
        }
    }
    
    sharedState.lastUpdate = new Date().toISOString();
    saveState();
    
    console.log(`[Refresh] Done: ${updated} updated, ${failed} failed`);
    res.json({ updated, failed, total: assigned.length, lastUpdate: sharedState.lastUpdate });
});

// API: تشغيل/إيقاف التحديث التلقائي
app.post('/api/auto-update', (req, res) => {
    const { enabled, interval } = req.body;
    sharedState.autoUpdateEnabled = !!enabled;
    if (interval) sharedState.autoUpdateInterval = parseInt(interval) || 6;
    saveState();
    
    if (enabled) {
        startAutoUpdate();
        console.log(`[Cron] Auto-update enabled, interval: ${sharedState.autoUpdateInterval}h`);
    } else {
        stopAutoUpdate();
        console.log('[Cron] Auto-update disabled');
    }
    
    res.json({ ok: true, enabled: sharedState.autoUpdateEnabled, interval: sharedState.autoUpdateInterval });
});

// =================== Auto Update (Cron) ===================
let cronJob = null;

async function performAutoUpdate() {
    console.log('[Cron] Running auto-update...');
    const allPosts = [...sharedState.discoveredPosts, ...sharedState.manualPosts];
    const assigned = allPosts.filter(p => p.assignedTo);
    
    let updated = 0, failed = 0;
    for (const post of assigned) {
        try {
            const fresh = await fetchPostData(post.url);
            post.likes = fresh.likes;
            post.views = fresh.views;
            updated++;
            await new Promise(r => setTimeout(r, 1000)); // تأخير بين الطلبات
        } catch (e) {
            failed++;
        }
    }
    
    sharedState.lastUpdate = new Date().toISOString();
    saveState();
    console.log(`[Cron] Auto-update done: ${updated}/${assigned.length}`);
}

function startAutoUpdate() {
    stopAutoUpdate();
    const interval = sharedState.autoUpdateInterval || 6;
    // كل X ساعة
    const cronExpr = `0 */${interval} * * *`;
    cronJob = cron.schedule(cronExpr, performAutoUpdate);
    console.log(`[Cron] Scheduled: ${cronExpr}`);
}

function stopAutoUpdate() {
    if (cronJob) {
        cronJob.stop();
        cronJob = null;
    }
}

// تشغيل التحديث التلقائي عند البدء إذا كان مفعّلاً
if (sharedState.autoUpdateEnabled) {
    startAutoUpdate();
}

// =================== Health ===================
app.get('/api/health', (req, res) => {
    exec('yt-dlp --version', (error, stdout) => {
        res.json({
            status: 'ok',
            ytdlp_installed: !error,
            ytdlp_version: error ? null : stdout.trim(),
            cookies_present: fs.existsSync(COOKIES_FILE),
            auto_update_enabled: sharedState.autoUpdateEnabled,
            auto_update_interval: sharedState.autoUpdateInterval,
            last_update: sharedState.lastUpdate,
            version: '5.0'
        });
    });
});

// =================== Routes ===================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'display.html')));

app.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log(`✅ Server v5 running on port ${PORT}`);
    console.log(`✅ Main UI: http://localhost:${PORT}/`);
    console.log(`✅ Display: http://localhost:${PORT}/display`);
    console.log('========================================');
    exec('yt-dlp --version', (error, stdout) => {
        if (error) console.log('⚠️ yt-dlp NOT installed:', error.message);
        else console.log(`✅ yt-dlp v${stdout.trim()} ready`);
    });
    if (fs.existsSync(COOKIES_FILE)) console.log('✅ Instagram cookies present');
    else console.log('⚠️ No Instagram cookies');
});

process.on('uncaughtException', (err) => console.error('❌ Uncaught:', err));
process.on('unhandledRejection', (r) => console.error('❌ Unhandled:', r));

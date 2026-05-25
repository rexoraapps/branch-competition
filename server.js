console.log('🚀 Starting Branch Competition Server v6 - Luxury Edition');

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cron = require('node-cron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// مجلدات التخزين
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const COOKIES_FILE = path.join(DATA_DIR, 'cookies.txt');

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
    autoUpdateInterval: 6,
    lastUpdate: null,
    systemLogo: null,
    systemName: 'مجوهرات نفائس الألماس'
};

function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        try {
            sharedState = { ...sharedState, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) };
            console.log('✓ State loaded:', sharedState.branches.length, 'branches');
        } catch (e) { console.error('Failed to load state:', e.message); }
    }
}

function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(sharedState, null, 2));
    } catch (e) { console.error('Failed to save state:', e.message); }
}

loadState();

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

// Multer للـ cookies
const cookiesUpload = multer({
    storage: multer.diskStorage({
        destination: DATA_DIR,
        filename: (req, file, cb) => cb(null, 'cookies.txt')
    }),
    limits: { fileSize: 5 * 1024 * 1024 }
});

// Multer للصور
const imageUpload = multer({
    storage: multer.diskStorage({
        destination: UPLOADS_DIR,
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase() || '.png';
            const safeExt = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext) ? ext : '.png';
            const uniqueName = Date.now() + '_' + Math.random().toString(36).substr(2, 8) + safeExt;
            cb(null, uniqueName);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files allowed'));
        }
        cb(null, true);
    }
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

// =================== yt-dlp ===================
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
        console.log(`[${platform}] Discovering @${cleanUser}...`);
        const command = `yt-dlp --flat-playlist --dump-json --no-warnings --playlist-end ${maxPosts}${cookiesArg} "${url}"`;
        
        exec(command, { maxBuffer: 30 * 1024 * 1024, timeout: 120000 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`[${platform}] Error:`, stderr.substring(0, 300));
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

// =================== APIs: Posts ===================
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

// =================== APIs: State ===================
app.post('/api/save-state', (req, res) => {
    sharedState = { ...sharedState, ...req.body };
    saveState();
    res.json({ ok: true });
});

app.get('/api/state', (req, res) => {
    res.json(sharedState);
});

// =================== APIs: Cookies ===================
app.post('/api/upload-cookies', cookiesUpload.single('cookies'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ ok: true });
});

app.delete('/api/cookies', (req, res) => {
    if (fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE);
    res.json({ ok: true });
});

app.get('/api/cookies-status', (req, res) => {
    const exists = fs.existsSync(COOKIES_FILE);
    let mtime = null;
    if (exists) mtime = fs.statSync(COOKIES_FILE).mtime;
    res.json({ exists, mtime });
});

// =================== APIs: Images (NEW) ===================
// رفع صورة عامة (تُستخدم للوجو، صور فروع، صور موظفين)
app.post('/api/upload-image', imageUpload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    // رابط الصورة النسبي
    const imageUrl = '/uploads/' + req.file.filename;
    res.json({ ok: true, url: imageUrl, filename: req.file.filename });
});

// حذف صورة
app.delete('/api/image/:filename', (req, res) => {
    const filename = req.params.filename;
    // أمان: لا نسمح بمسارات نسبية
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const filepath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
        return res.json({ ok: true });
    }
    res.status(404).json({ error: 'Not found' });
});

// =================== APIs: Refresh & Auto-Update ===================
app.post('/api/refresh-all', async (req, res) => {
    console.log('[Refresh] Starting...');
    const allPosts = [...sharedState.discoveredPosts, ...sharedState.manualPosts];
    const assigned = allPosts.filter(p => p.assignedTo);
    
    let updated = 0, failed = 0;
    for (const post of assigned) {
        try {
            const fresh = await fetchPostData(post.url);
            post.likes = fresh.likes;
            post.views = fresh.views;
            updated++;
        } catch (e) { failed++; }
    }
    
    sharedState.lastUpdate = new Date().toISOString();
    saveState();
    console.log(`[Refresh] Done: ${updated}/${assigned.length}`);
    res.json({ updated, failed, total: assigned.length, lastUpdate: sharedState.lastUpdate });
});

app.post('/api/auto-update', (req, res) => {
    const { enabled, interval } = req.body;
    sharedState.autoUpdateEnabled = !!enabled;
    if (interval) sharedState.autoUpdateInterval = parseInt(interval) || 6;
    saveState();
    
    if (enabled) startAutoUpdate();
    else stopAutoUpdate();
    
    res.json({ ok: true, enabled: sharedState.autoUpdateEnabled, interval: sharedState.autoUpdateInterval });
});

let cronJob = null;

async function performAutoUpdate() {
    console.log('[Cron] Running auto-update...');
    const allPosts = [...sharedState.discoveredPosts, ...sharedState.manualPosts];
    const assigned = allPosts.filter(p => p.assignedTo);
    
    let updated = 0;
    for (const post of assigned) {
        try {
            const fresh = await fetchPostData(post.url);
            post.likes = fresh.likes;
            post.views = fresh.views;
            updated++;
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {}
    }
    
    sharedState.lastUpdate = new Date().toISOString();
    saveState();
    console.log(`[Cron] Done: ${updated}/${assigned.length}`);
}

function startAutoUpdate() {
    stopAutoUpdate();
    const interval = sharedState.autoUpdateInterval || 6;
    cronJob = cron.schedule(`0 */${interval} * * *`, performAutoUpdate);
    console.log(`[Cron] Scheduled every ${interval}h`);
}

function stopAutoUpdate() {
    if (cronJob) { cronJob.stop(); cronJob = null; }
}

if (sharedState.autoUpdateEnabled) startAutoUpdate();

// =================== Health & Routes ===================
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
            version: '6.0'
        });
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'display.html')));

app.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log(`✅ Server v6 Luxury running on port ${PORT}`);
    console.log(`✅ Main: /`);
    console.log(`✅ Display: /display`);
    console.log(`✅ Uploads: /uploads/<filename>`);
    console.log('========================================');
    exec('yt-dlp --version', (error, stdout) => {
        if (error) console.log('⚠️ yt-dlp NOT installed');
        else console.log(`✅ yt-dlp v${stdout.trim()}`);
    });
});

process.on('uncaughtException', (err) => console.error('❌ Uncaught:', err));
process.on('unhandledRejection', (r) => console.error('❌ Unhandled:', r));

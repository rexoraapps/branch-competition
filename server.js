console.log('🚀 Starting Branch Competition Server v4...');
console.log('Node version:', process.version);
console.log('PORT env:', process.env.PORT);

const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('Using PORT:', PORT);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

function detectPlatform(url) {
    const u = (url || '').toLowerCase();
    if (u.includes('tiktok.com')) return 'tiktok';
    if (u.includes('instagram.com')) return 'instagram';
    if (u.includes('snapchat.com')) return 'snapchat';
    return 'unknown';
}

function cleanUsername(username) {
    return (username || '').replace(/^@/, '').trim();
}

function parseYtDlpDate(dateStr) {
    if (!dateStr || dateStr.length !== 8) return null;
    const year = parseInt(dateStr.substring(0, 4));
    const month = parseInt(dateStr.substring(4, 6)) - 1;
    const day = parseInt(dateStr.substring(6, 8));
    return new Date(year, month, day);
}

function isInDateRange(uploadDate, startDate, endDate) {
    if (!uploadDate) return true;
    if (!startDate && !endDate) return true;
    const upload = parseYtDlpDate(uploadDate);
    if (!upload) return true;
    if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        if (upload < start) return false;
    }
    if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        if (upload > end) return false;
    }
    return true;
}

// جلب بيانات منشور واحد كاملة (مع thumbnail و video url)
function fetchPostData(url) {
    return new Promise((resolve, reject) => {
        const command = `yt-dlp --dump-json --no-warnings --no-playlist --skip-download "${url}"`;
        exec(command, { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => {
            if (error) { reject(new Error(stderr.split('\n')[0] || error.message)); return; }
            try {
                const lines = stdout.trim().split('\n').filter(l => l.trim());
                if (lines.length === 0) { reject(new Error('No data')); return; }
                const data = JSON.parse(lines[0]);
                
                let thumbnail = data.thumbnail || '';
                if (data.thumbnails && data.thumbnails.length > 0) {
                    const sorted = data.thumbnails.filter(t => t.url).sort((a, b) => (b.width || 0) - (a.width || 0));
                    if (sorted.length > 0 && sorted[0].url) thumbnail = sorted[0].url;
                }
                
                // محاولة الحصول على رابط مباشر للفيديو (إن وجد)
                let videoUrl = '';
                if (data.url && data.ext && ['mp4', 'webm'].includes(data.ext)) {
                    videoUrl = data.url;
                } else if (data.formats) {
                    // اختر أفضل فورمات قابلة للتشغيل
                    const playable = data.formats.filter(f => f.ext === 'mp4' && f.url);
                    if (playable.length > 0) {
                        videoUrl = playable[playable.length - 1].url;
                    }
                }
                
                resolve({
                    url: url,
                    likes: data.like_count || 0,
                    views: data.view_count || 0,
                    comments: data.comment_count || 0,
                    title: (data.title || data.description || '').substring(0, 200),
                    uploader: data.uploader || data.channel || data.uploader_id || '',
                    upload_date: data.upload_date || '',
                    thumbnail: thumbnail,
                    video_url: videoUrl,
                    duration: data.duration || 0
                });
            } catch (e) { reject(new Error('Parse error: ' + e.message)); }
        });
    });
}

// اكتشاف منشورات يوزر
function discoverUserPosts(username, platform, maxPosts) {
    return new Promise((resolve, reject) => {
        const cleanUser = cleanUsername(username);
        let url;
        if (platform === 'tiktok') {
            url = `https://www.tiktok.com/@${encodeURIComponent(cleanUser)}`;
        } else if (platform === 'instagram') {
            url = `https://www.instagram.com/${encodeURIComponent(cleanUser)}/`;
        } else {
            return reject(new Error('Unsupported platform'));
        }
        
        console.log(`[${platform}] Discovering @${cleanUser}...`);
        const command = `yt-dlp --flat-playlist --dump-json --no-warnings --playlist-end ${maxPosts} "${url}"`;
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
                    const data = JSON.parse(line);
                    if (data.url || data.webpage_url) urls.push(data.url || data.webpage_url);
                } catch (e) {}
            }
            console.log(`[${platform}] Found ${urls.length} posts for @${cleanUser}`);
            resolve(urls);
        });
    });
}

// API: جلب منشورات يوزر مع التفاصيل والفلترة بالتاريخ
app.post('/api/fetch-user', async (req, res) => {
    const { username, platform, startDate, endDate, maxPosts } = req.body;
    if (!username || !platform) return res.status(400).json({ error: 'username and platform required' });
    const limit = parseInt(maxPosts) || 50;
    
    try {
        if (platform === 'snapchat') return res.status(400).json({ error: 'Snapchat لا يدعم جلب منشورات اليوزر' });
        
        const discoveredUrls = await discoverUserPosts(username, platform, limit);
        
        if (discoveredUrls.length === 0) {
            return res.json({ username, platform, posts: [], discoveredCount: 0, filteredOutCount: 0, failedCount: 0 });
        }
        
        const posts = [];
        let filteredOutCount = 0, failedCount = 0;
        
        for (const url of discoveredUrls) {
            try {
                const data = await fetchPostData(url);
                if (!isInDateRange(data.upload_date, startDate, endDate)) {
                    filteredOutCount++;
                    continue;
                }
                posts.push(data);
            } catch (e) {
                failedCount++;
            }
        }
        
        res.json({
            username, platform, posts,
            discoveredCount: discoveredUrls.length,
            filteredOutCount, failedCount
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: جلب رابط واحد
app.post('/api/fetch-post', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const platform = detectPlatform(url);
    try {
        const data = await fetchPostData(url);
        data.platform = platform;
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message, platform });
    }
});

// API: تحديث بيانات منشور (لإعادة جلب اللايكات)
app.post('/api/refresh-post', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    try {
        const data = await fetchPostData(url);
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Health
app.get('/api/health', (req, res) => {
    exec('yt-dlp --version', (error, stdout) => {
        res.json({
            status: 'ok',
            ytdlp_installed: !error,
            ytdlp_version: error ? null : stdout.trim(),
            version: '4.0',
            timestamp: new Date().toISOString()
        });
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log(`✅ Server v4 running on port ${PORT}`);
    console.log(`✅ Listening on 0.0.0.0:${PORT}`);
    console.log('========================================');
    exec('yt-dlp --version', (error, stdout) => {
        if (error) console.log('⚠️ yt-dlp NOT installed:', error.message);
        else console.log(`✅ yt-dlp v${stdout.trim()} ready`);
    });
});

process.on('uncaughtException', (err) => console.error('❌ Uncaught:', err));
process.on('unhandledRejection', (r, p) => console.error('❌ Unhandled:', r));

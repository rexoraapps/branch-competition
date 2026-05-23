// =====================================================
// Branch Competition Backend Server v2 — Railway Edition
// =====================================================

const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// =====================================================
// Helpers
// =====================================================
function detectPlatform(url) {
    const u = (url || '').toLowerCase();
    if (u.includes('tiktok.com')) return 'tiktok';
    if (u.includes('instagram.com')) return 'instagram';
    if (u.includes('snapchat.com')) return 'snapchat';
    return 'unknown';
}

function cleanHashtag(hashtag) {
    return (hashtag || '').replace(/^#/, '').trim();
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

// =====================================================
// جلب بيانات منشور واحد
// =====================================================
function fetchPostData(url) {
    return new Promise((resolve, reject) => {
        const command = `yt-dlp --dump-json --no-warnings --no-playlist --skip-download "${url}"`;
        
        exec(command, { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr.split('\n')[0] || error.message));
                return;
            }

            try {
                const lines = stdout.trim().split('\n').filter(l => l.trim());
                if (lines.length === 0) {
                    reject(new Error('No data returned'));
                    return;
                }
                const data = JSON.parse(lines[0]);
                resolve({
                    url: url,
                    likes: data.like_count || 0,
                    views: data.view_count || 0,
                    comments: data.comment_count || 0,
                    title: (data.title || data.description || '').substring(0, 100),
                    uploader: data.uploader || data.channel || '',
                    upload_date: data.upload_date || '',
                });
            } catch (e) {
                reject(new Error('Parse error: ' + e.message));
            }
        });
    });
}

// =====================================================
// اكتشاف منشورات الهاشتاق على TikTok
// =====================================================
function discoverTikTokHashtag(hashtag, maxPosts = 50) {
    return new Promise((resolve, reject) => {
        const cleanTag = cleanHashtag(hashtag);
        const url = `https://www.tiktok.com/tag/${encodeURIComponent(cleanTag)}`;
        
        console.log(`[TikTok] Discovering #${cleanTag}...`);
        
        const command = `yt-dlp --flat-playlist --dump-json --no-warnings --playlist-end ${maxPosts} "${url}"`;
        
        exec(command, { maxBuffer: 20 * 1024 * 1024, timeout: 90000 }, (error, stdout, stderr) => {
            if (error) {
                console.error('[TikTok] Error:', stderr.substring(0, 200));
                reject(new Error('فشل اكتشاف الهاشتاق على TikTok: ' + (stderr.split('\n')[0] || error.message)));
                return;
            }

            const urls = [];
            const lines = stdout.trim().split('\n').filter(l => l.trim());
            
            for (const line of lines) {
                try {
                    const data = JSON.parse(line);
                    if (data.url || data.webpage_url) {
                        urls.push(data.url || data.webpage_url);
                    } else if (data.id) {
                        urls.push(`https://www.tiktok.com/@${data.uploader || 'user'}/video/${data.id}`);
                    }
                } catch (e) {}
            }
            
            console.log(`[TikTok] Found ${urls.length} posts`);
            resolve(urls);
        });
    });
}

// =====================================================
// اكتشاف منشورات الهاشتاق على Instagram
// =====================================================
function discoverInstagramHashtag(hashtag, maxPosts = 50) {
    return new Promise((resolve, reject) => {
        const cleanTag = cleanHashtag(hashtag);
        const url = `https://www.instagram.com/explore/tags/${encodeURIComponent(cleanTag)}/`;
        
        console.log(`[Instagram] Discovering #${cleanTag}...`);
        
        const command = `yt-dlp --flat-playlist --dump-json --no-warnings --playlist-end ${maxPosts} "${url}"`;
        
        exec(command, { maxBuffer: 20 * 1024 * 1024, timeout: 90000 }, (error, stdout, stderr) => {
            if (error) {
                const errMsg = stderr.toLowerCase();
                console.error('[Instagram] Error:', stderr.substring(0, 300));
                
                if (errMsg.includes('login') || errMsg.includes('cookie') || errMsg.includes('rate')) {
                    reject(new Error('Instagram يتطلب تسجيل دخول. استخدم الروابط المباشرة'));
                } else {
                    reject(new Error('فشل اكتشاف الهاشتاق: ' + (stderr.split('\n')[0] || error.message)));
                }
                return;
            }

            const urls = [];
            const lines = stdout.trim().split('\n').filter(l => l.trim());
            
            for (const line of lines) {
                try {
                    const data = JSON.parse(line);
                    if (data.url || data.webpage_url) {
                        urls.push(data.url || data.webpage_url);
                    } else if (data.id) {
                        urls.push(`https://www.instagram.com/p/${data.id}/`);
                    }
                } catch (e) {}
            }
            
            console.log(`[Instagram] Found ${urls.length} posts`);
            resolve(urls);
        });
    });
}

// =====================================================
// API: اكتشاف هاشتاق
// =====================================================
app.post('/api/fetch-hashtag', async (req, res) => {
    const { hashtag, platform, startDate, endDate, maxPosts } = req.body;
    
    if (!hashtag || !platform) {
        return res.status(400).json({ error: 'hashtag and platform are required' });
    }

    const limit = parseInt(maxPosts) || 50;
    console.log(`\n[Hashtag] Processing #${hashtag} on ${platform}`);

    try {
        let discoveredUrls = [];
        
        if (platform === 'tiktok') {
            discoveredUrls = await discoverTikTokHashtag(hashtag, limit);
        } else if (platform === 'instagram') {
            discoveredUrls = await discoverInstagramHashtag(hashtag, limit);
        } else if (platform === 'snapchat') {
            return res.status(400).json({ 
                error: 'Snapchat لا يدعم البحث بالهاشتاق' 
            });
        }

        if (discoveredUrls.length === 0) {
            return res.json({
                hashtag, platform,
                posts: [], totalLikes: 0, postsCount: 0,
                discoveredCount: 0, filteredOutCount: 0, failedCount: 0,
                message: 'لم يتم العثور على منشورات'
            });
        }

        const posts = [];
        let totalLikes = 0;
        let filteredOutCount = 0;
        let failedCount = 0;

        for (let i = 0; i < discoveredUrls.length; i++) {
            const url = discoveredUrls[i];
            try {
                console.log(`  [${i+1}/${discoveredUrls.length}] ${url.substring(0, 60)}...`);
                const data = await fetchPostData(url);
                
                if (!isInDateRange(data.upload_date, startDate, endDate)) {
                    filteredOutCount++;
                    continue;
                }

                posts.push(data);
                totalLikes += data.likes;
            } catch (e) {
                failedCount++;
            }
        }

        console.log(`[Hashtag] ✓ ${posts.length} posts, ${totalLikes} likes\n`);

        res.json({
            hashtag, platform, posts, totalLikes,
            postsCount: posts.length,
            discoveredCount: discoveredUrls.length,
            filteredOutCount, failedCount,
            dateRange: { startDate, endDate }
        });

    } catch (e) {
        console.error('[Hashtag] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =====================================================
// API: جلب رابط واحد
// =====================================================
app.post('/api/fetch-post', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const platform = detectPlatform(url);
    console.log(`[Single] ${platform}: ${url.substring(0, 60)}...`);

    try {
        const data = await fetchPostData(url);
        data.platform = platform;
        console.log(`  ✓ ${data.likes} likes`);
        res.json(data);
    } catch (e) {
        console.error(`  ✗ ${e.message.substring(0, 100)}`);
        res.status(500).json({ error: e.message, platform });
    }
});

// =====================================================
// Health
// =====================================================
app.get('/api/health', (req, res) => {
    exec('yt-dlp --version', (error, stdout) => {
        res.json({
            status: 'ok',
            ytdlp_installed: !error,
            ytdlp_version: error ? null : stdout.trim(),
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development'
        });
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// =====================================================
// Start
// =====================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✓ Server running on port ${PORT}`);
    
    exec('yt-dlp --version', (error, stdout) => {
        if (error) {
            console.log('⚠️  yt-dlp not installed!\n');
        } else {
            console.log(`✓ yt-dlp v${stdout.trim()} ready\n`);
        }
    });
});

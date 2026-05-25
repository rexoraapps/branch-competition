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
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbnails');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
if (!fs.existsSync(THUMBS_DIR)) fs.mkdirSync(THUMBS_DIR, { recursive: true });

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

// ============== Backup System ==============
function createBackup(reason = 'auto') {
    try {
        const now = new Date();
        const dateStr = now.toISOString().replace(/:/g, '-').split('.')[0]; // 2026-05-25T03-15-00
        const filename = `backup-${dateStr}-${reason}.json`;
        const filepath = path.join(BACKUPS_DIR, filename);
        
        const backupData = {
            createdAt: now.toISOString(),
            reason: reason,
            state: sharedState
        };
        
        fs.writeFileSync(filepath, JSON.stringify(backupData, null, 2));
        console.log(`[Backup] ✓ Created: ${filename}`);
        
        // احذف النسخ القديمة (أكثر من 14)
        cleanOldBackups(14);
        return filename;
    } catch (e) {
        console.error('[Backup] Failed:', e.message);
        return null;
    }
}

function cleanOldBackups(keepCount = 14) {
    try {
        const files = fs.readdirSync(BACKUPS_DIR)
            .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
            .map(f => ({
                name: f,
                mtime: fs.statSync(path.join(BACKUPS_DIR, f)).mtime
            }))
            .sort((a, b) => b.mtime - a.mtime); // الأحدث أولاً
        
        if (files.length > keepCount) {
            const toDelete = files.slice(keepCount);
            for (const f of toDelete) {
                fs.unlinkSync(path.join(BACKUPS_DIR, f.name));
                console.log(`[Backup] Deleted old: ${f.name}`);
            }
        }
    } catch (e) {
        console.error('[Backup] Clean failed:', e.message);
    }
}

function listBackups() {
    try {
        return fs.readdirSync(BACKUPS_DIR)
            .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
            .map(f => {
                const filepath = path.join(BACKUPS_DIR, f);
                const stat = fs.statSync(filepath);
                let data = null;
                try {
                    const content = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
                    data = {
                        createdAt: content.createdAt,
                        reason: content.reason,
                        branchCount: (content.state?.branches || []).length,
                        memberCount: (content.state?.branches || []).reduce((s, b) => s + (b.members || []).length, 0),
                        postCount: (content.state?.discoveredPosts || []).length + (content.state?.manualPosts || []).length
                    };
                } catch (e) {}
                return {
                    filename: f,
                    size: stat.size,
                    mtime: stat.mtime,
                    ...data
                };
            })
            .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    } catch (e) {
        console.error('[Backup] List failed:', e.message);
        return [];
    }
}

function restoreBackup(filename) {
    try {
        // أمان: ما نسمح بمسارات نسبية
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            throw new Error('Invalid filename');
        }
        const filepath = path.join(BACKUPS_DIR, filename);
        if (!fs.existsSync(filepath)) throw new Error('Backup not found');
        
        const content = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        if (!content.state) throw new Error('Invalid backup file');
        
        // قبل الاستعادة، انسخ احتياطي للحالة الحالية
        createBackup('pre-restore');
        
        sharedState = { ...sharedState, ...content.state };
        saveState();
        console.log(`[Backup] ✓ Restored from: ${filename}`);
        return true;
    } catch (e) {
        console.error('[Backup] Restore failed:', e.message);
        throw e;
    }
}

// نسخة احتياطية تلقائية كل ساعة
setInterval(() => {
    const allPosts = [...(sharedState.discoveredPosts || []), ...(sharedState.manualPosts || [])];
    // ما نعمل backup إذا فاضي
    if (sharedState.branches.length > 0 || allPosts.length > 0) {
        createBackup('hourly');
    }
}, 60 * 60 * 1000);

// نسخة احتياطية عند بدء التشغيل (لو فيه بيانات)
setTimeout(() => {
    if (sharedState.branches.length > 0) {
        createBackup('startup');
    }
}, 5000);

loadState();

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/thumbnails', express.static(THUMBS_DIR));

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

// =================== Thumbnail Cache ===================
const httpModule = require('http');
const httpsModule = require('https');

function downloadThumbnail(url, filename) {
    return new Promise((resolve) => {
        if (!url || !url.startsWith('http')) { resolve(null); return; }
        const protocol = url.startsWith('https') ? httpsModule : httpModule;
        const filepath = path.join(THUMBS_DIR, filename);
        const file = fs.createWriteStream(filepath);
        
        const req = protocol.get(url, { timeout: 15000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close();
                try { fs.unlinkSync(filepath); } catch(e) {}
                downloadThumbnail(res.headers.location, filename).then(resolve);
                return;
            }
            if (res.statusCode !== 200) {
                file.close();
                try { fs.unlinkSync(filepath); } catch(e) {}
                resolve(null);
                return;
            }
            res.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve('/thumbnails/' + filename);
            });
        });
        req.on('timeout', () => { req.destroy(); file.close(); try { fs.unlinkSync(filepath); } catch(e) {} resolve(null); });
        req.on('error', () => { file.close(); try { fs.unlinkSync(filepath); } catch(e) {} resolve(null); });
    });
}

async function cacheThumbnail(originalUrl, postUrl) {
    if (!originalUrl) return null;
    try {
        const hash = require('crypto').createHash('md5').update(postUrl).digest('hex').substring(0, 12);
        const filename = `thumb_${hash}.jpg`;
        const filepath = path.join(THUMBS_DIR, filename);
        if (fs.existsSync(filepath)) {
            const stat = fs.statSync(filepath);
            if (stat.size > 1024) return '/thumbnails/' + filename;
            try { fs.unlinkSync(filepath); } catch(e) {}
        }
        return await downloadThumbnail(originalUrl, filename);
    } catch (e) {
        return null;
    }
}

// =================== Instagram Multi-Source Fetcher ===================
// طرق متعددة لاستخراج لايكات Instagram، يجرب واحدة بعد أخرى

const https = require('https');

// User-Agents حقيقية للتظاهر كمتصفح عادي
const USER_AGENTS = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
];

function getRandomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// HTTP GET مبسّط مع إعادة توجيه و timeout
function httpGet(url, headers = {}, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        const finalHeaders = {
            'User-Agent': getRandomUA(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
            'Accept-Encoding': 'identity', // ما نستخدم gzip عشان نقرا النص مباشرة
            ...headers
        };
        
        const req = https.get(url, { headers: finalHeaders, timeout: 15000 }, (res) => {
            // إعادة توجيه
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
                const nextUrl = res.headers.location.startsWith('http')
                    ? res.headers.location
                    : new URL(res.headers.location, url).toString();
                res.destroy();
                return httpGet(nextUrl, headers, maxRedirects - 1).then(resolve).catch(reject);
            }
            
            let data = '';
            res.on('data', chunk => data += chunk.toString('utf-8'));
            res.on('end', () => {
                resolve({ statusCode: res.statusCode, body: data, headers: res.headers });
            });
        });
        
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.on('error', (err) => reject(err));
    });
}

// استخراج shortcode من رابط Instagram
function extractInstagramShortcode(url) {
    // أنماط روابط Instagram:
    // https://www.instagram.com/p/SHORTCODE/
    // https://www.instagram.com/reel/SHORTCODE/
    // https://www.instagram.com/tv/SHORTCODE/
    // https://instagram.com/reels/SHORTCODE/
    const match = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
}

// ============== الطريقة 1: Embed Endpoint ==============
// Instagram يوفر صفحة embed بدون login تعرض اللايكات في الـ HTML المرئي
async function fetchFromEmbed(url) {
    const shortcode = extractInstagramShortcode(url);
    if (!shortcode) throw new Error('Invalid Instagram URL');
    
    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
    
    const response = await httpGet(embedUrl, {
        'Referer': 'https://www.instagram.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    });
    
    if (response.statusCode !== 200) {
        throw new Error(`Embed HTTP ${response.statusCode}`);
    }
    
    const html = response.body;
    let likes = 0;
    let comments = 0;
    
    // طريقة 1: البحث في الـ HTML المرئي عن "X,XXX likes" أو "X likes"
    // مثال HTML: <div class="SocialProof">1,234 likes</div>
    const visiblePatterns = [
        // مع كلمة likes
        /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*likes?/gi,
        // مع كلمة إعجاب (عربي)
        /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*(?:إعجاب|اعجاب)/gi,
        // K notation: 1.2K likes
        /([0-9.]+)K\s*likes?/gi,
        // M notation: 1.2M likes
        /([0-9.]+)M\s*likes?/gi
    ];
    
    const allMatches = [];
    for (const pattern of visiblePatterns) {
        let m;
        const re = new RegExp(pattern.source, pattern.flags);
        while ((m = re.exec(html)) !== null) {
            let num = m[1].replace(/,/g, '');
            // معالجة K و M
            if (pattern.source.includes('K')) num = parseFloat(num) * 1000;
            else if (pattern.source.includes('M')) num = parseFloat(num) * 1000000;
            else num = parseInt(num);
            
            if (num > 0) allMatches.push(num);
        }
    }
    
    // طريقة 2: البحث في JSON المُضمَّن
    const jsonPatterns = [
        /"like_count":\s*(\d+)/g,
        /"edge_media_preview_like":\s*{\s*"count":\s*(\d+)/g,
        /"edge_liked_by":\s*{\s*"count":\s*(\d+)/g,
        /"likes":\s*(\d+)/g
    ];
    
    for (const pattern of jsonPatterns) {
        let m;
        while ((m = pattern.exec(html)) !== null) {
            const num = parseInt(m[1]);
            if (num > 0) allMatches.push(num);
        }
    }
    
    // ناخذ أعلى رقم (الأكثر دقة)
    if (allMatches.length > 0) {
        likes = Math.max(...allMatches);
    }
    
    // التعليقات
    const commentPatterns = [
        /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*comments?/i,
        /"edge_media_to_comment":\s*{\s*"count":\s*(\d+)/,
        /"edge_media_preview_comment":\s*{\s*"count":\s*(\d+)/,
        /"comment_count":\s*(\d+)/
    ];
    
    for (const pattern of commentPatterns) {
        const match = html.match(pattern);
        if (match) {
            const num = parseInt(match[1].replace(/,/g, ''));
            if (num > comments) comments = num;
        }
    }
    
    // المعلومات الإضافية
    let title = '';
    let uploader = '';
    let thumbnail = '';
    
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    if (titleMatch) {
        title = titleMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").substring(0, 200);
    }
    
    const userMatch = html.match(/instagram\.com\/([a-zA-Z0-9_.]+)\//) ||
                     html.match(/@([a-zA-Z0-9_.]+)/);
    if (userMatch) uploader = userMatch[1];
    
    const thumbMatch = html.match(/"display_url":"([^"]+)"/) ||
                      html.match(/<meta property="og:image" content="([^"]+)"/);
    if (thumbMatch) {
        thumbnail = thumbMatch[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    }
    
    if (likes === 0 && !title) {
        throw new Error('Embed returned no usable data');
    }
    
    return { likes, comments, title, uploader, thumbnail, source: 'embed' };
}

// ============== الطريقة 2: Public Page Scraper ==============
async function fetchFromPublicPage(url) {
    const shortcode = extractInstagramShortcode(url);
    if (!shortcode) throw new Error('Invalid Instagram URL');
    
    const publicUrl = `https://www.instagram.com/p/${shortcode}/`;
    
    const response = await httpGet(publicUrl, {
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
    });
    
    if (response.statusCode !== 200) {
        throw new Error(`Public HTTP ${response.statusCode}`);
    }
    
    const html = response.body;
    const allMatches = [];
    
    // JSON patterns - نستخدم global flag للبحث في كل النص
    const jsonPatterns = [
        /"edge_media_preview_like":\s*{\s*"count":\s*(\d+)/g,
        /"edge_liked_by":\s*{\s*"count":\s*(\d+)/g,
        /"like_count":\s*(\d+)/g
    ];
    
    for (const pattern of jsonPatterns) {
        let m;
        while ((m = pattern.exec(html)) !== null) {
            const num = parseInt(m[1]);
            if (num > 0) allMatches.push(num);
        }
    }
    
    // البحث في الـ meta tags
    const metaPatterns = [
        /<meta[^>]+content="([0-9,]+)\s+(?:Likes?|إعجاب)/i,
        /<meta property="instapp:hashtags"[^>]+content="[^"]*?([0-9,]+)\s+likes?/i
    ];
    
    for (const pattern of metaPatterns) {
        const match = html.match(pattern);
        if (match) {
            const num = parseInt(match[1].replace(/,/g, ''));
            if (num > 0) allMatches.push(num);
        }
    }
    
    const likes = allMatches.length > 0 ? Math.max(...allMatches) : 0;
    
    let comments = 0;
    const commentsMatch = html.match(/"edge_media_to_(?:parent_)?comment":\s*{\s*"count":\s*(\d+)/) ||
                         html.match(/"comment_count":\s*(\d+)/);
    if (commentsMatch) comments = parseInt(commentsMatch[1]);
    
    let title = '';
    let uploader = '';
    let thumbnail = '';
    
    const titleMatch = html.match(/<title>([^<]+)<\/title>/) ||
                       html.match(/<meta property="og:title" content="([^"]+)"/);
    if (titleMatch) {
        title = titleMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").substring(0, 200);
    }
    
    const userMatch = html.match(/"username":"([^"]+)"/) ||
                     html.match(/<meta property="og:title" content="([^"]+) on Instagram/);
    if (userMatch) uploader = userMatch[1];
    
    const thumbMatch = html.match(/<meta property="og:image" content="([^"]+)"/) ||
                       html.match(/"display_url":"([^"]+)"/);
    if (thumbMatch) {
        thumbnail = thumbMatch[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    }
    
    if (likes === 0) {
        throw new Error('No likes found in public page (Instagram may have blocked)');
    }
    
    return { likes, comments, title, uploader, thumbnail, source: 'public' };
}

// ============== الطريقة 3: yt-dlp (Fallback) ==============
function fetchFromYtdlp(url) {
    return new Promise((resolve, reject) => {
        const cookiesArg = fs.existsSync(COOKIES_FILE) ? ` --cookies "${COOKIES_FILE}"` : '';
        const command = `yt-dlp --dump-json --no-warnings --no-playlist --skip-download${cookiesArg} "${url}"`;
        
        exec(command, { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => {
            if (error) { reject(new Error(stderr.split('\n')[0] || error.message)); return; }
            try {
                const lines = stdout.trim().split('\n').filter(l => l.trim());
                if (lines.length === 0) { reject(new Error('No yt-dlp output')); return; }
                const data = JSON.parse(lines[0]);
                
                let thumbnail = data.thumbnail || '';
                if (data.thumbnails && data.thumbnails.length > 0) {
                    const sorted = data.thumbnails.filter(t => t.url).sort((a, b) => (b.width || 0) - (a.width || 0));
                    if (sorted.length > 0) thumbnail = sorted[0].url;
                }
                
                let videoUrl = '';
                if (data.formats) {
                    const playable = data.formats.filter(f => f.ext === 'mp4' && f.url);
                    if (playable.length > 0) videoUrl = playable[playable.length - 1].url;
                }
                
                resolve({
                    likes: data.like_count || 0,
                    views: data.view_count || 0,
                    comments: data.comment_count || 0,
                    title: (data.title || data.description || '').substring(0, 200),
                    uploader: data.uploader || data.channel || data.uploader_id || '',
                    upload_date: data.upload_date || '',
                    thumbnail,
                    video_url: videoUrl,
                    source: 'yt-dlp'
                });
            } catch (e) { reject(new Error('Parse error: ' + e.message)); }
        });
    });
}

// ============== الطريقة 4: GraphQL Internal API ==============
// Instagram يستخدم GraphQL داخلياً، نقدر نطلب بدون login
async function fetchFromGraphQL(url) {
    const shortcode = extractInstagramShortcode(url);
    if (!shortcode) throw new Error('Invalid Instagram URL');
    
    // GraphQL query hash المعروف للحصول على معلومات المنشور
    const queryHashes = [
        '2efa04f61586458cef44441f474eee7c',
        '477b65a610463740ccdb83135b2014db',
        '9f8827793ef34641b2fb195d4d41151c'
    ];
    
    for (const queryHash of queryHashes) {
        try {
            const variables = JSON.stringify({ shortcode });
            const graphqlUrl = `https://www.instagram.com/graphql/query/?query_hash=${queryHash}&variables=${encodeURIComponent(variables)}`;
            
            const response = await httpGet(graphqlUrl, {
                'X-IG-App-ID': '936619743392459',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': '*/*',
                'Referer': `https://www.instagram.com/p/${shortcode}/`
            });
            
            if (response.statusCode !== 200) continue;
            
            const data = JSON.parse(response.body);
            const media = data?.data?.shortcode_media;
            if (!media) continue;
            
            return {
                likes: media.edge_media_preview_like?.count || media.edge_liked_by?.count || 0,
                comments: media.edge_media_to_comment?.count || media.edge_media_preview_comment?.count || 0,
                title: media.edge_media_to_caption?.edges?.[0]?.node?.text?.substring(0, 200) || '',
                uploader: media.owner?.username || '',
                thumbnail: media.display_url || '',
                video_url: media.video_url || '',
                source: 'graphql'
            };
        } catch (e) {
            continue;
        }
    }
    
    throw new Error('GraphQL all hashes failed');
}

// ============== الطريقة 5: Instagram Web Profile Info API ==============
async function fetchFromWebAPI(url) {
    const shortcode = extractInstagramShortcode(url);
    if (!shortcode) throw new Error('Invalid Instagram URL');
    
    const apiUrl = `https://www.instagram.com/api/v1/media/${shortcode}/info/`;
    
    const response = await httpGet(apiUrl, {
        'X-IG-App-ID': '936619743392459',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
        'Referer': `https://www.instagram.com/p/${shortcode}/`
    });
    
    if (response.statusCode !== 200) {
        throw new Error(`WebAPI HTTP ${response.statusCode}`);
    }
    
    try {
        const data = JSON.parse(response.body);
        const item = data.items?.[0];
        if (!item) throw new Error('No items in API response');
        
        return {
            likes: item.like_count || 0,
            views: item.play_count || item.view_count || 0,
            comments: item.comment_count || 0,
            title: item.caption?.text?.substring(0, 200) || '',
            uploader: item.user?.username || '',
            thumbnail: item.image_versions2?.candidates?.[0]?.url || '',
            video_url: item.video_versions?.[0]?.url || '',
            source: 'webapi'
        };
    } catch (e) {
        throw new Error('WebAPI parse: ' + e.message);
    }
}

// ============== Multi-Source Master Function ==============
async function fetchInstagramData(url) {
    const results = [];
    const errors = [];
    
    // الطريقة 1: WebAPI (الأدق - يستخدم نفس API الموقع)
    try {
        const data = await fetchFromWebAPI(url);
        if (data.likes > 0) {
            results.push(data);
            console.log(`[IG] WebAPI: likes=${data.likes}`);
        }
    } catch (e) {
        errors.push(`webapi: ${e.message}`);
    }
    
    // الطريقة 2: GraphQL
    try {
        const data = await fetchFromGraphQL(url);
        if (data.likes > 0) {
            results.push(data);
            console.log(`[IG] GraphQL: likes=${data.likes}`);
        }
    } catch (e) {
        errors.push(`graphql: ${e.message}`);
    }
    
    // الطريقة 3: Embed
    try {
        const data = await fetchFromEmbed(url);
        if (data.likes > 0 || data.title) {
            results.push(data);
            console.log(`[IG] Embed: likes=${data.likes}`);
        }
    } catch (e) {
        errors.push(`embed: ${e.message}`);
    }
    
    // الطريقة 4: Public page
    try {
        const data = await fetchFromPublicPage(url);
        if (data.likes > 0) {
            results.push(data);
            console.log(`[IG] Public: likes=${data.likes}`);
        }
    } catch (e) {
        errors.push(`public: ${e.message}`);
    }
    
    // الطريقة 5: yt-dlp (دائماً نشغّلها للحصول على video_url و upload_date)
    let ytdlpData = null;
    try {
        ytdlpData = await fetchFromYtdlp(url);
        if (ytdlpData.likes > 0) results.push(ytdlpData);
        console.log(`[IG] yt-dlp: likes=${ytdlpData.likes}`);
    } catch (e) {
        errors.push(`yt-dlp: ${e.message}`);
    }
    
    if (results.length === 0) {
        throw new Error('All methods failed: ' + errors.join(', '));
    }
    
    // نأخذ أعلى رقم لايكات (الأكثر دقة)
    const maxLikes = Math.max(...results.map(r => r.likes || 0));
    const bestResult = results.find(r => r.likes === maxLikes) || results[0];
    
    const originalThumb = bestResult.thumbnail || (ytdlpData && ytdlpData.thumbnail) || '';
    const localThumb = await cacheThumbnail(originalThumb, url);
    const finalThumb = localThumb || originalThumb;
    
    return {
        likes: maxLikes,
        views: (ytdlpData && ytdlpData.views) || bestResult.views || 0,
        comments: bestResult.comments || (ytdlpData && ytdlpData.comments) || 0,
        title: bestResult.title || (ytdlpData && ytdlpData.title) || '',
        uploader: bestResult.uploader || (ytdlpData && ytdlpData.uploader) || '',
        upload_date: (ytdlpData && ytdlpData.upload_date) || '',
        thumbnail: finalThumb,
        video_url: (ytdlpData && ytdlpData.video_url) || bestResult.video_url || '',
        duration: (ytdlpData && ytdlpData.duration) || 0,
        sources: results.map(r => `${r.source}=${r.likes}`).join(', ')
    };
}

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
async function fetchPostData(url) {
    const platform = detectPlatform(url);
    
    // لـ Instagram: استخدم الفاتشر متعدد المصادر
    if (platform === 'instagram') {
        try {
            const data = await fetchInstagramData(url);
            return { url, ...data };
        } catch (e) {
            console.error('[IG] Multi-source failed:', e.message);
            throw e;
        }
    }
    
    // لباقي المنصات (TikTok, etc): استخدم yt-dlp مباشرة
    return new Promise((resolve, reject) => {
        const cookiesArg = getCookiesArg(platform);
        const command = `yt-dlp --dump-json --no-warnings --no-playlist --skip-download${cookiesArg} "${url}"`;
        exec(command, { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, async (error, stdout, stderr) => {
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
                
                // نزّل الـ thumbnail محلياً
                const localThumb = await cacheThumbnail(thumbnail, url);
                const finalThumb = localThumb || thumbnail;
                
                resolve({
                    url, likes: data.like_count || 0, views: data.view_count || 0,
                    comments: data.comment_count || 0,
                    title: (data.title || data.description || '').substring(0, 200),
                    uploader: data.uploader || data.channel || data.uploader_id || '',
                    upload_date: data.upload_date || '', 
                    thumbnail: finalThumb,
                    video_url: videoUrl,
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
let lastBackupSize = 0;
app.post('/api/save-state', (req, res) => {
    sharedState = { ...sharedState, ...req.body };
    saveState();
    
    // backup تلقائي إذا التغيير كبير (>10% أو أكثر من 10 منشورات)
    const allPosts = [...(sharedState.discoveredPosts || []), ...(sharedState.manualPosts || [])];
    const currentSize = (sharedState.branches?.length || 0) * 10 + allPosts.length;
    if (Math.abs(currentSize - lastBackupSize) >= 10) {
        createBackup('change');
        lastBackupSize = currentSize;
    }
    
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

// API لاختبار جلب Instagram (debugging)
app.post('/api/test-instagram', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    
    const platform = detectPlatform(url);
    if (platform !== 'instagram') {
        return res.status(400).json({ error: 'Not an Instagram URL' });
    }
    
    const results = { url, methods: {} };
    
    // الطريقة 1: WebAPI
    try {
        const data = await fetchFromWebAPI(url);
        results.methods.webapi = { ok: true, likes: data.likes, comments: data.comments, views: data.views };
    } catch (e) {
        results.methods.webapi = { ok: false, error: e.message };
    }
    
    // الطريقة 2: GraphQL
    try {
        const data = await fetchFromGraphQL(url);
        results.methods.graphql = { ok: true, likes: data.likes, comments: data.comments };
    } catch (e) {
        results.methods.graphql = { ok: false, error: e.message };
    }
    
    // الطريقة 3: Embed
    try {
        const data = await fetchFromEmbed(url);
        results.methods.embed = { ok: true, likes: data.likes, comments: data.comments };
    } catch (e) {
        results.methods.embed = { ok: false, error: e.message };
    }
    
    // الطريقة 4: Public page
    try {
        const data = await fetchFromPublicPage(url);
        results.methods.public = { ok: true, likes: data.likes, comments: data.comments };
    } catch (e) {
        results.methods.public = { ok: false, error: e.message };
    }
    
    // الطريقة 5: yt-dlp
    try {
        const data = await fetchFromYtdlp(url);
        results.methods.ytdlp = { ok: true, likes: data.likes, comments: data.comments };
    } catch (e) {
        results.methods.ytdlp = { ok: false, error: e.message };
    }
    
    // النتيجة النهائية
    try {
        const final = await fetchInstagramData(url);
        results.final = { likes: final.likes, sources: final.sources };
    } catch (e) {
        results.final = { error: e.message };
    }
    
    res.json(results);
});

// =================== APIs: Refresh & Auto-Update ===================

// =================== Diagnostic & Fix Assignment ===================
app.get('/api/diagnose', (req, res) => {
    const allPosts = [...(sharedState.discoveredPosts || []), ...(sharedState.manualPosts || [])];
    
    // كل الـ memberIds الموجودين في الفروع
    const allMemberIds = new Set();
    const memberDetails = {};
    (sharedState.branches || []).forEach(b => {
        (b.members || []).forEach(m => {
            allMemberIds.add(m.id);
            memberDetails[m.id] = { name: m.name, branchName: b.name, branchId: b.id };
        });
    });
    
    // المنشورات و حالة الـ assignedTo
    const assigned = [];
    const unassigned = [];
    const orphaned = []; // معيّن لكن لـ ID غير موجود
    
    allPosts.forEach(p => {
        if (!p.assignedTo) {
            unassigned.push({ url: p.url, title: p.title, likes: p.likes });
        } else if (allMemberIds.has(p.assignedTo)) {
            assigned.push({ 
                url: p.url, 
                title: p.title, 
                likes: p.likes,
                assignedTo: p.assignedTo,
                memberName: memberDetails[p.assignedTo].name,
                branchName: memberDetails[p.assignedTo].branchName
            });
        } else {
            orphaned.push({ 
                url: p.url, 
                title: p.title, 
                likes: p.likes,
                assignedTo: p.assignedTo // الـ ID المعيّن (لكن غير موجود!)
            });
        }
    });
    
    res.json({
        summary: {
            totalPosts: allPosts.length,
            assigned: assigned.length,
            unassigned: unassigned.length,
            orphaned: orphaned.length,
            totalMembers: allMemberIds.size,
            totalBranches: (sharedState.branches || []).length
        },
        memberDetails,
        assigned,
        unassigned,
        orphaned
    });
});

// إصلاح ذكي: ربط المنشورات المعزولة بالموظف الصحيح حسب الاسم
app.post('/api/fix-orphaned', (req, res) => {
    const allPosts = [...(sharedState.discoveredPosts || []), ...(sharedState.manualPosts || [])];
    
    const allMemberIds = new Set();
    (sharedState.branches || []).forEach(b => {
        (b.members || []).forEach(m => allMemberIds.add(m.id));
    });
    
    let removed = 0;
    
    // إزالة الـ assignedTo من المنشورات اللي يشير لـ ID غير موجود
    function getPostMemberId(p) {
        if (!p.assignedTo) return null;
        if (typeof p.assignedTo === 'object') return p.assignedTo.memberId;
        return p.assignedTo;
    }
    
    allPosts.forEach(p => {
        const mid = getPostMemberId(p);
        if (mid && !allMemberIds.has(mid)) {
            p.assignedTo = null;
            removed++;
        }
    });
    
    if (removed > 0) saveState();
    
    res.json({ ok: true, cleaned: removed, message: `تم إزالة ${removed} نسبة قديمة` });
});


app.post('/api/refresh-all', async (req, res) => {
    console.log('[Refresh] Starting...');
    const allPosts = [...sharedState.discoveredPosts, ...sharedState.manualPosts];
    const assigned = allPosts.filter(p => p.assignedTo);
    
    let updated = 0, failed = 0, skipped = 0;
    for (const post of assigned) {
        if (post.manuallyEdited) { skipped++; continue; }
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
    if (interval) sharedState.autoUpdateInterval = parseFloat(interval) || 6;
    saveState();
    
    if (enabled) startAutoUpdate();
    else stopAutoUpdate();
    
    res.json({ ok: true, enabled: sharedState.autoUpdateEnabled, interval: sharedState.autoUpdateInterval });
});

let cronJob = null;

let autoUpdateRunning = false;

async function performAutoUpdate() {
    // منع تشغيلين متزامنين
    if (autoUpdateRunning) {
        console.log('[Cron] Skipped - previous still running');
        return;
    }
    autoUpdateRunning = true;
    
    const startTime = Date.now();
    console.log('[Cron] Running auto-update...');
    const allPosts = [...sharedState.discoveredPosts, ...sharedState.manualPosts];
    const assigned = allPosts.filter(p => p.assignedTo);
    
    let updated = 0, failed = 0;
    for (const post of assigned) {
        try {
            const fresh = await fetchPostData(post.url);
            post.likes = fresh.likes;
            post.views = fresh.views;
            post.comments = fresh.comments;
            updated++;
            // تأخير 2 ثانية بين كل منشور لتجنب الحظر
            await new Promise(r => setTimeout(r, 2000));
        } catch (e) { failed++; }
    }
    
    sharedState.lastUpdate = new Date().toISOString();
    saveState();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Cron] Done: ${updated}/${assigned.length} (${failed} failed, ${duration}s)`);
    autoUpdateRunning = false;
}

function startAutoUpdate() {
    stopAutoUpdate();
    const interval = sharedState.autoUpdateInterval || 6;
    
    // إذا أقل من 1 → يعني بالدقائق (مثل 0.083 = 5 دقائق، 0.017 = دقيقة)
    let cronExpr;
    if (interval < 1) {
        const minutes = Math.max(1, Math.round(interval * 60));
        cronExpr = `*/${minutes} * * * *`;
        console.log(`[Cron] Scheduled every ${minutes} minutes`);
    } else {
        const hours = Math.round(interval);
        cronExpr = `0 */${hours} * * *`;
        console.log(`[Cron] Scheduled every ${hours} hours`);
    }
    
    cronJob = cron.schedule(cronExpr, performAutoUpdate);
}

function stopAutoUpdate() {
    if (cronJob) { cronJob.stop(); cronJob = null; }
}

if (sharedState.autoUpdateEnabled) startAutoUpdate();

// =================== APIs: Backups (NEW) ===================
app.get('/api/backups', (req, res) => {
    const backups = listBackups();
    res.json({ backups, total: backups.length });
});

app.post('/api/backups/create', (req, res) => {
    const filename = createBackup('manual');
    if (!filename) return res.status(500).json({ error: 'Failed to create backup' });
    res.json({ ok: true, filename });
});

app.post('/api/backups/restore', (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    try {
        restoreBackup(filename);
        res.json({ ok: true, state: sharedState });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/backups/download/:filename', (req, res) => {
    const filename = req.params.filename;
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const filepath = path.join(BACKUPS_DIR, filename);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Not found' });
    res.download(filepath, filename);
});

app.delete('/api/backups/:filename', (req, res) => {
    const filename = req.params.filename;
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const filepath = path.join(BACKUPS_DIR, filename);
    if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
        return res.json({ ok: true });
    }
    res.status(404).json({ error: 'Not found' });
});

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
app.get('/analytics', (req, res) => res.sendFile(path.join(__dirname, 'analytics.html')));

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

# 🚀 خطوات النشر على Railway

## الملفات في هذا المجلد:
- `server.js` - السيرفر
- `index.html` - الواجهة
- `package.json` - المكتبات
- `Dockerfile` - تعليمات البناء (مهم!)
- `.gitignore` - ملفات يتم تجاهلها

## خطوات النشر:

### 1. ارفع المجلد على GitHub
- اضغط "New repository" في GitHub
- اسحب الملفات ورفعها

### 2. اربط Railway بالـ repo
- في Railway: New Project → Deploy from GitHub
- اختر الـ repo
- Railway سيبني المشروع تلقائيًا

### 3. احصل على الرابط
- بعد البناء، اضغط Settings → Networking
- اضغط "Generate Domain"
- ستحصل على رابط مثل: yourapp.up.railway.app

## مهم:
Railway يقرأ Dockerfile تلقائيًا ويثبت yt-dlp.
لا تحتاج تثبيت أي شي يدويًا.

# استخدم Node.js
FROM node:20-slim

# تثبيت Python و yt-dlp و ffmpeg
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# تثبيت yt-dlp بأحدث إصدار
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# مجلد العمل
WORKDIR /app

# نسخ package.json أولاً (لتسريع البناء)
COPY package*.json ./

# تثبيت dependencies
RUN npm install --production

# نسخ باقي الملفات
COPY . .

# المنفذ
EXPOSE 3000

# تشغيل السيرفر
CMD ["node", "server.js"]

FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# تثبيت yt-dlp عبر pip (يجلب أحدث نسخة دائمًا)
RUN pip3 install --no-cache-dir --break-system-packages --upgrade yt-dlp \
    && yt-dlp --version

WORKDIR /app

COPY package*.json ./

RUN npm install --no-cache --force

COPY . .

RUN mkdir -p /app/data

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

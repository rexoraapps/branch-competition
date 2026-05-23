FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# تثبيت أحدث نسخة nightly من yt-dlp مباشرة من GitHub
# هذي الأحدث دائمًا وتدعم آخر تغييرات Instagram
RUN pip3 install --no-cache-dir --break-system-packages --upgrade --pre "yt-dlp[default]" \
    && yt-dlp --update-to nightly \
    && yt-dlp --version

WORKDIR /app

COPY package*.json ./

RUN npm install --no-cache --force

COPY . .

RUN mkdir -p /app/data

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

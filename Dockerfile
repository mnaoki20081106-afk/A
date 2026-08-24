# Chromeのパスを自分で確定させるため、Debianのchromiumを使う。
# ghcr.io/puppeteer/puppeteer の最近のイメージはChromeをapt(/usr/bin/google-chrome-stable)ではなく
# Puppeteerのキャッシュに入れるようになり、パスが版によって変わるため依存しない。
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

# 非rootで実行する
RUN useradd -r -m -U appuser && chown -R appuser:appuser /usr/src/app
USER appuser

# Cloud Run は PORT を注入する（server.js は process.env.PORT を参照）
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]

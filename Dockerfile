# Puppeteer公式イメージ（Chrome同梱・/usr/bin/google-chrome-stable）
FROM ghcr.io/puppeteer/puppeteer:latest

# npm install 時にChromeを再ダウンロードさせない。
# v20以降の正式名は PUPPETEER_SKIP_DOWNLOAD（旧名だけでは効かない）。
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production

# このベースイメージは最終行が USER pptruser（非root）。
# そのまま WORKDIR を作ると root 所有になり、pptruser での npm install が
# EACCES で失敗してビルドが落ちる。インストール中だけ root に戻す。
USER root
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

# 実行はベースイメージ本来の非rootユーザーで行う
RUN chown -R pptruser:pptruser /usr/src/app
USER pptruser

# Cloud Run は PORT を注入する（server.js は process.env.PORT を参照）
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]

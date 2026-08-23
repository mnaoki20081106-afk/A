const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Stealthプラグインを有効化（Bot検知を回避）
puppeteer.use(StealthPlugin());

const app = express();
app.use(cors()); // どこからでも叩けるようにCORSを許可

app.get('/api/extract', async (req, res) => {
    const shortUrl = req.query.url;
    if (!shortUrl) return res.status(400).json({ success: false, error: 'URLが指定されていません' });

    let browser;
    try {
        // Docker内のChromeを使用するための設定
        browser = await puppeteer.launch({
            headless: "new",
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        const page = await browser.newPage();
        
        // iPhoneとして偽装（LPをスマホ用レイアウトで確実に表示させるため）
        await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1');
        
        // 不要な画像やCSSを読み込まない設定（高速化）
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // ページへアクセス（DOMが読み込まれたら完了）
        await page.goto(shortUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // HTMLを取得してJSONブロックを引っこ抜く
        const html = await page.content();
        const match = html.match(/<script id="?universal-data"? type="?application\/json"?>([\s\S]*?)<\/script>/);

        if (!match) throw new Error('データが見つかりません。LPの構造が異なります。');

        const json = JSON.parse(match[1]);
        const onelink = json?.app_context?.config?.shareOptions?.onelink;
        const query = json?.app_context?.query || {};

        if (!onelink) throw new Error('OneLinkが見つかりません。');

        // 生のトラッキングURLを復元
        const urlObj = new URL(onelink);
        for (const key in query) {
            urlObj.searchParams.set(key, query[key]);
        }

        // 成功したら抽出完了したURLを返す
        res.json({ success: true, trackingUrl: urlObj.toString() });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API Server running on port ${PORT}`));

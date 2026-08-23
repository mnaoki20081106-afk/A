'use strict';

/**
 * ローカル検証用のダミーLP + ダミーMMPエンドポイント。
 * 「LP → 302 → 302 → apps.apple.com」という実運用と同じ形の
 * リダイレクトチェーンを再現し、mmp-link-check の動作確認に使う。
 */

const http = require('http');

const LP_HTML = `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>Spring Campaign</title></head>
<body>
  <h1>春のキャンペーン</h1>
  <p id="status">読み込み中...</p>
  <script>
    // 実LPと同様、CTAは初期HTMLに無く後から描画される想定にする
    setTimeout(function () {
      document.getElementById('status').textContent = '準備完了';
      var cta = document.createElement('div');
      cta.setAttribute('data-testid', 'cta-download');
      cta.setAttribute('role', 'button');
      cta.textContent = '今すぐダウンロード';
      cta.addEventListener('click', function () {
        location.href = '/mmp/onelink?pid=owned_lp&c=spring2026&af_sub1=qa-run-1&af_siteid=lp';
      });
      document.body.appendChild(cta);
    }, 600);
  </script>
</body>
</html>`;

function start(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(LP_HTML);
      return;
    }

    // 1 ホップ目: MMP の受け口（パラメータを保持したまま次へ）
    if (url.pathname === '/mmp/onelink') {
      const next = `/mmp/redirect${url.search}`;
      res.writeHead(302, { location: next });
      res.end();
      return;
    }

    // 2 ホップ目: ストアへの最終リダイレクト
    if (url.pathname === '/mmp/redirect') {
      const store = new URL('https://apps.apple.com/jp/app/id0000000000');
      for (const [key, value] of url.searchParams.entries()) store.searchParams.set(key, value);
      res.writeHead(302, { location: store.toString() });
      res.end();
      return;
    }

    res.writeHead(404).end('not found');
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { start };

if (require.main === module) {
  start(Number(process.env.PORT) || 8787).then(({ port }) => {
    console.log(`fixture server: http://127.0.0.1:${port}/`);
  });
}

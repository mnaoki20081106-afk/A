'use strict';

/**
 * スモークテスト: ダミーLPに対して mmp-link-check を実行し、
 * トラッキングURLとパラメータが正しく捕捉できることを確認する。
 *   node test/smoke.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { start } = require('./fixture-server');

(async () => {
  const { server, port } = await start(0);
  const configPath = path.join(os.tmpdir(), `mmp-link-check-smoke-${process.pid}.json`);

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      targetUrl: `http://127.0.0.1:${port}/`,
      allowedHosts: ['127.0.0.1'],
      trackingHosts: ['127.0.0.1'],
      device: 'iPhone 13',
      cta: { selectors: ["[data-testid='cta-download']"], texts: ['ダウンロード'] },
      expectedParams: ['pid', 'c', 'af_sub1'],
      expectedParamValues: { pid: 'owned_lp', c: 'spring2026' },
      redirectTimeoutMs: 15000,
    })
  );

  // フィクスチャサーバはこのプロセスで動いているため、
  // 同期 spawn ではイベントループが止まってリクエストを捌けない。必ず非同期で待つ。
  const result = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, '..', 'src', 'mmp-link-check.js'), configPath],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

  server.close();
  fs.unlinkSync(configPath);

  const out = `${result.stdout}${result.stderr}`;
  const checks = [
    ['ストア到達を確認', out.includes('ストア到達を確認')],
    ['パラメータ検証 OK', out.includes('パラメータ検証 OK')],
    ['af_sub1 を保持', out.includes('af_sub1 = qa-run-1')],
    ['exit code 0', result.status === 0],
  ];

  console.log('\n=== smoke test ===');
  let ok = true;
  for (const [label, passed] of checks) {
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}`);
    if (!passed) ok = false;
  }
  process.exit(ok ? 0 : 1);
})();

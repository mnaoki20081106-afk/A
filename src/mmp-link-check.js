#!/usr/bin/env node
'use strict';

/**
 * mmp-link-check
 *
 * 自社プロモーションLP → MMPトラッキングURL → App Store / Google Play
 * のリダイレクト経路を自動で踏み、
 *   - リダイレクトチェーン（3xx / meta refresh / JS遷移 / popup）
 *   - ストア直前の最終トラッキングURL
 *   - そのURLが保持しているクエリパラメータ
 * を出力する社内QAツール。
 *
 * 使い方:
 *   node src/mmp-link-check.js config/example.json
 *   node src/mmp-link-check.js config/example.json --url https://lp.example.com/campaign/spring
 */

const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');
const { RedirectTracker, isStoreUrl, hostOf, hostMatches } = require('./redirect-tracker');

const DEFAULTS = {
  device: 'iPhone 13',
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
  headless: true,
  navigationTimeoutMs: 30000,
  ctaTimeoutMs: 15000,
  redirectTimeoutMs: 20000,
  blockStoreNavigation: true,
  harPath: null,
  browserExecutablePath: null,
  cta: { selectors: [], texts: [], nth: 0 },
  expectedParams: [],
  expectedParamValues: {},
  trackingHosts: [],
  allowedHosts: [],
};

function parseArgs(argv) {
  const args = { configPath: null, overrides: {} };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--url') { args.overrides.targetUrl = rest[++i]; continue; }
    if (token === '--device') { args.overrides.device = rest[++i]; continue; }
    if (token === '--har') { args.overrides.harPath = rest[++i]; continue; }
    if (token === '--executable-path') { args.overrides.browserExecutablePath = rest[++i]; continue; }
    if (token === '--headed') { args.overrides.headless = false; continue; }
    if (token === '--json') { args.overrides.jsonOutput = true; continue; }
    if (token.startsWith('--')) throw new Error(`不明なオプション: ${token}`);
    args.configPath = token;
  }
  return args;
}

function loadConfig(args) {
  if (!args.configPath) {
    throw new Error('設定ファイルを指定してください（例: node src/mmp-link-check.js config/example.json）');
  }
  const raw = fs.readFileSync(path.resolve(args.configPath), 'utf8');
  const parsed = JSON.parse(raw);
  const cfg = {
    ...DEFAULTS,
    ...parsed,
    ...args.overrides,
    cta: { ...DEFAULTS.cta, ...(parsed.cta || {}) },
  };

  if (!cfg.targetUrl) throw new Error('targetUrl が未設定です。');

  // --- 安全弁 ---------------------------------------------------------------
  // 自社ドメイン以外を誤って叩かないよう、allowedHosts の明示を必須にする。
  // 第三者サイトのCTAを自動クリックする用途に流用されるのを防ぐガードでもある。
  if (!Array.isArray(cfg.allowedHosts) || cfg.allowedHosts.length === 0) {
    throw new Error('allowedHosts が空です。検証対象の自社ドメインを明示的に列挙してください。');
  }
  const host = hostOf(cfg.targetUrl);
  if (!hostMatches(host, cfg.allowedHosts)) {
    throw new Error(
      `targetUrl のホスト "${host}" は allowedHosts (${cfg.allowedHosts.join(', ')}) に含まれていません。`
    );
  }
  return cfg;
}

/** 設定された selector / text から、最初に可視になったCTA要素を返す */
async function findCta(page, cfg) {
  const { selectors = [], texts = [], nth = 0 } = cfg.cta;
  const candidates = [];

  for (const selector of selectors) {
    candidates.push({ label: `selector=${selector}`, locator: page.locator(selector) });
  }
  for (const text of texts) {
    const re = new RegExp(text);
    candidates.push({ label: `role=button name=/${text}/`, locator: page.getByRole('button', { name: re }) });
    candidates.push({ label: `role=link name=/${text}/`, locator: page.getByRole('link', { name: re }) });
    candidates.push({
      label: `text=/${text}/`,
      locator: page
        .locator('a, button, [role="button"], [onclick], div, span')
        .filter({ hasText: re }),
    });
  }
  if (candidates.length === 0) {
    throw new Error('cta.selectors / cta.texts のいずれも設定されていません。');
  }

  const deadline = Date.now() + cfg.ctaTimeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      const count = await candidate.locator.count().catch(() => 0);
      if (count <= nth) continue;
      // filter({hasText}) は祖先要素も拾うため、最も内側の可視要素を優先する
      const target = candidate.locator.nth(Math.min(nth, count - 1));
      if (await target.isVisible().catch(() => false)) {
        return { locator: target, label: candidate.label };
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`CTA が ${cfg.ctaTimeoutMs}ms 以内に表示されませんでした。`);
}

function summarizeParams(url) {
  try {
    const parsed = new URL(url);
    const params = {};
    for (const [key, value] of parsed.searchParams.entries()) params[key] = value;
    return { base: `${parsed.origin}${parsed.pathname}`, params };
  } catch {
    return { base: url, params: {} };
  }
}

function verifyParams(params, cfg) {
  const issues = [];
  for (const key of cfg.expectedParams || []) {
    if (!(key in params) || params[key] === '') {
      issues.push({ level: 'error', message: `必須パラメータ "${key}" が欠落しています。` });
    }
  }
  for (const [key, expected] of Object.entries(cfg.expectedParamValues || {})) {
    if (params[key] !== expected) {
      issues.push({
        level: 'error',
        message: `パラメータ "${key}" の値が不一致: expected="${expected}" actual="${params[key] ?? '(なし)'}"`,
      });
    }
  }
  return issues;
}

function printChain(hops) {
  console.log('\n=== リダイレクトチェーン ===');
  for (const hop of hops) {
    const status = hop.status ? ` ${hop.status}` : '';
    const tag = hop.isTracking ? ' [tracking]' : isStoreUrl(hop.url) ? ' [store]' : '';
    console.log(`  #${String(hop.index).padStart(2, '0')} (${hop.kind}${status})${tag} ${hop.url}`);
    if (hop.location) console.log(`        Location: ${hop.location}`);
  }
}

async function run() {
  const cfg = loadConfig(parseArgs(process.argv));
  const deviceProfile = devices[cfg.device];
  if (!deviceProfile) throw new Error(`未知のデバイス指定: ${cfg.device}`);

  const tracker = new RedirectTracker({ trackingHosts: cfg.trackingHosts });
  // CI やコンテナでブラウザを固定したい場合は browserExecutablePath / 環境変数で指定する
  const executablePath = cfg.browserExecutablePath || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({ headless: cfg.headless, ...(executablePath ? { executablePath } : {}) });
  let exitCode = 0;

  try {
    const context = await browser.newContext({
      ...deviceProfile,
      locale: cfg.locale,
      timezoneId: cfg.timezoneId,
      ...(cfg.harPath ? { recordHar: { path: cfg.harPath, content: 'omit' } } : {}),
    });
    context.setDefaultNavigationTimeout(cfg.navigationTimeoutMs);
    tracker.attachContext(context);

    // ストアへの実遷移は QA では不要なので中断する。
    // （中断してもリクエスト自体は発火済みなので、直前のトラッキングURLは捕捉できる）
    if (cfg.blockStoreNavigation) {
      await context.route('**/*', (route) => {
        if (isStoreUrl(route.request().url())) return route.abort();
        return route.continue();
      });
    }

    const page = await context.newPage();
    console.log(`[1/4] LPを開いています: ${cfg.targetUrl}`);
    await page.goto(cfg.targetUrl, { waitUntil: 'domcontentloaded' });

    console.log('[2/4] CTA の表示を待機中...');
    const cta = await findCta(page, cfg);
    console.log(`      検出: ${cta.label}`);

    console.log('[3/4] CTA をクリックします');
    await cta.locator.click({ timeout: cfg.ctaTimeoutMs }).catch(async (err) => {
      // オーバーレイ等で通常クリックが弾かれた場合のフォールバック
      console.warn(`      通常クリック失敗 (${err.message.split('\n')[0]}) → force click で再試行`);
      await cta.locator.click({ force: true, timeout: cfg.ctaTimeoutMs });
    });

    console.log('[4/4] ストアへの遷移を待機中...');
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), cfg.redirectTimeoutMs));
    const storeHit = await Promise.race([tracker.waitForStore(), timeout]);

    printChain(tracker.chain);

    const finalHop = tracker.finalTrackingHop();
    if (!finalHop) {
      console.error('\n❌ トラッキングURLを捕捉できませんでした。');
      console.error('   cta の指定、または trackingHosts の設定を見直してください。');
      exitCode = 1;
    } else {
      const { base, params } = summarizeParams(finalHop.url);
      console.log('\n=== ストア直前のトラッキングURL ===');
      console.log(`  ${finalHop.url}`);
      console.log(`\n  base : ${base}`);
      console.log('  params:');
      for (const [key, value] of Object.entries(params)) {
        console.log(`    - ${key} = ${value}`);
      }

      const issues = verifyParams(params, cfg);
      if (issues.length > 0) {
        console.error('\n=== パラメータ検証 NG ===');
        for (const issue of issues) console.error(`  ✗ ${issue.message}`);
        exitCode = 1;
      } else if ((cfg.expectedParams || []).length || Object.keys(cfg.expectedParamValues || {}).length) {
        console.log('\n✅ パラメータ検証 OK');
      }

      if (storeHit) {
        console.log(`\n✅ ストア到達を確認: ${storeHit.url}`);
      } else {
        console.warn('\n⚠️  ストアURLへの到達は確認できませんでした（トラッキングURLまでは到達）。');
        console.warn('   MMP側が User-Agent でストア出し分けをするため、device 設定を確認してください。');
        exitCode = 1;
      }
    }

    if (cfg.jsonOutput) {
      console.log(`\n${JSON.stringify({ chain: tracker.chain, final: finalHop, store: storeHit }, null, 2)}`);
    }

    await context.close();
  } catch (err) {
    console.error(`\n❌ 実行エラー: ${err.message}`);
    if (tracker.chain.length) printChain(tracker.chain);
    exitCode = 1;
  } finally {
    await browser.close();
  }

  process.exit(exitCode);
}

run();

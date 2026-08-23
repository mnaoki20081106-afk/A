'use strict';

/**
 * リダイレクトチェーンの収集ロジック。
 * Playwright の Page / BrowserContext に listener を張り、
 *   - HTTP 3xx (Location ヘッダ)
 *   - meta refresh / JS による location 書き換え（framenavigated）
 *   - window.open による popup 遷移
 * をすべて時系列 1 本のチェーンとして記録する。
 */

const STORE_PATTERNS = [
  /^https?:\/\/apps\.apple\.com\//i,
  /^https?:\/\/itunes\.apple\.com\//i,
  /^https?:\/\/play\.google\.com\/store\//i,
  /^itms-apps:/i,
  /^itms-appss:/i,
  /^market:/i,
];

function isStoreUrl(url) {
  return STORE_PATTERNS.some((re) => re.test(url));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** host が allowList のいずれか（サブドメイン含む）に一致するか */
function hostMatches(host, allowList) {
  return allowList.some((allowed) => {
    const a = String(allowed).toLowerCase().replace(/^\./, '');
    return host === a || host.endsWith(`.${a}`);
  });
}

class RedirectTracker {
  constructor({ trackingHosts = [] } = {}) {
    this.trackingHosts = trackingHosts;
    this.hops = [];
    this.storeHit = null;
    this._seen = new Set();
    this._waiters = [];
  }

  get chain() {
    return this.hops.slice();
  }

  /** ストア到達を待つ Promise（タイムアウトは呼び出し側で race する） */
  waitForStore() {
    if (this.storeHit) return Promise.resolve(this.storeHit);
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  _push(hop) {
    // ストア遷移を abort した際に出る内部エラーページはチェーンに含めない
    if (/^(chrome-error|about|data|blob):/i.test(hop.url)) return;

    // 同一 (kind,url,status) の重複は落とす
    const key = `${hop.kind}|${hop.status || ''}|${hop.url}`;
    if (this._seen.has(key)) return;
    this._seen.add(key);

    hop.index = this.hops.length;
    hop.at = Date.now();
    hop.isTracking =
      this.trackingHosts.length > 0 && hostMatches(hostOf(hop.url), this.trackingHosts);
    this.hops.push(hop);

    if (!this.storeHit && isStoreUrl(hop.url)) {
      this.storeHit = hop;
      for (const resolve of this._waiters.splice(0)) resolve(hop);
    }
  }

  /**
   * ストア直前の hop（＝実際にアトリビューションを担っている最終トラッキングURL）を返す。
   * ストア未到達なら、記録済みの最後のトラッキングホスト hop にフォールバックする。
   */
  finalTrackingHop() {
    if (this.storeHit) {
      for (let i = this.storeHit.index - 1; i >= 0; i -= 1) {
        const hop = this.hops[i];
        if (!isStoreUrl(hop.url)) return hop;
      }
      return null;
    }
    const tracking = this.hops.filter((h) => h.isTracking);
    return tracking.length ? tracking[tracking.length - 1] : null;
  }

  /** BrowserContext と、そこで開かれる全 Page に listener を張る */
  attachContext(context) {
    context.on('page', (page) => this.attachPage(page));
    for (const page of context.pages()) this.attachPage(page);
  }

  attachPage(page) {
    // 1) HTTP 3xx: Location ヘッダを持つレスポンス
    page.on('response', (response) => {
      const status = response.status();
      if (status < 300 || status >= 400) return;
      const headers = response.headers();
      this._push({
        kind: 'http-redirect',
        status,
        url: response.url(),
        location: headers.location || headers.Location || null,
        resourceType: response.request().resourceType(),
      });
      const location = headers.location || headers.Location;
      if (location) {
        let absolute = location;
        try {
          absolute = new URL(location, response.url()).toString();
        } catch { /* 相対解決に失敗したら生値のまま扱う */ }
        this._push({ kind: 'redirect-target', status: null, url: absolute });
      }
    });

    // 2) リクエスト側からもチェーンを辿る（redirectedFrom で 3xx 連鎖が取れる）
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        this._push({
          kind: 'navigation-request',
          status: null,
          url: request.url(),
          method: request.method(),
        });
      }
    });

    // 3) meta refresh / JS による遷移
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!url || url === 'about:blank') return;
      this._push({ kind: 'frame-navigated', status: null, url });
    });

    // 4) popup（window.open でストアを開くLPがあるため）
    page.on('popup', (popup) => {
      this._push({ kind: 'popup', status: null, url: popup.url() });
      this.attachPage(popup);
    });
  }
}

module.exports = { RedirectTracker, isStoreUrl, hostOf, hostMatches, STORE_PATTERNS };

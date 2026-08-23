# mmp-link-check

自社プロモーションLPのCTAをクリックし、**MMP（AppsFlyer / Adjust / Branch / Kochava 等）のトラッキングURLを経由して App Store / Google Play へ正しくリダイレクトされるか**、およびその過程で**計測パラメータが欠落していないか**を自動検証する社内QAツールです。

## できること

- モバイルUA（iOS / Android）をエミュレートしてLPを開く
- 後から描画されるCTA（`<a>` / `<button>` / `<div role="button">` など）の表示を待ってクリック
- クリック後のリダイレクトチェーンを全ホップ記録
  - HTTP 3xx（`Location` ヘッダ付き）
  - `meta refresh` / JS による `location` 書き換え
  - `window.open` による popup 遷移
- **ストア直前の最終トラッキングURL**を抽出し、クエリパラメータを一覧表示
- 期待するパラメータの存在／値を検証し、NG なら exit code 1（CI に組み込み可能）
- ストアへの実遷移は `blockStoreNavigation` で中断（QAで実際にストアを開く必要はないため）

## セットアップ

```bash
npm install
npm run setup     # Chromium をダウンロード（= playwright install chromium）
```

必要なパッケージは `playwright` のみです（Node.js 18 以上）。
Puppeteer でも同等の実装は可能ですが、デバイスエミュレーション・待機処理・popup 追跡が扱いやすいため Playwright を採用しています。

CI コンテナ等でブラウザを固定したい場合は、以下のいずれかで実行ファイルを指定できます。

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium npm run check -- config/mycampaign.json
# もしくは config の "browserExecutablePath" / CLI の --executable-path
```

## 使い方

```bash
node src/mmp-link-check.js config/example.json
node src/mmp-link-check.js config/example.json --url https://lp.example.com/campaign/other --headed
```

### CLI オプション

| オプション | 説明 |
| --- | --- |
| `--url <URL>` | config の `targetUrl` を上書き |
| `--device <name>` | Playwright のデバイス名（例: `iPhone 13`, `Pixel 7`） |
| `--headed` | ブラウザを表示して実行（目視デバッグ用） |
| `--har <path>` | 通信を HAR ファイルに記録 |
| `--executable-path <path>` | Chromium 実行ファイルを指定 |
| `--json` | 結果を JSON でも出力 |

## 設定ファイル

`config/example.json` を参照。主要な項目:

| キー | 説明 |
| --- | --- |
| `targetUrl` | 検証対象のLP URL |
| `allowedHosts` | **必須。** 実行を許可するホストの列挙。ここに無いホストは実行前に拒否される |
| `trackingHosts` | 自社が使う MMP のホスト。チェーン上で `[tracking]` として表示される |
| `device` | エミュレートするデバイス。**MMP は User-Agent でストアを出し分けるため必須級** |
| `cta.selectors` | CTA の CSS セレクタ（`data-testid` 推奨） |
| `cta.texts` | CTA のテキスト（正規表現として解釈。セレクタが取れない場合のフォールバック） |
| `cta.nth` | 同一条件で複数ヒットした場合に何番目を使うか |
| `expectedParams` | 存在を必須とするパラメータ名（例: `pid`, `c`, `af_sub1`） |
| `expectedParamValues` | 値まで一致を要求するパラメータ |
| `blockStoreNavigation` | ストアへの実リクエストを中断するか（既定 `true`） |

`allowedHosts` は誤って別サイトへ実行してしまう事故を防ぐためのガードです。空だと起動しません。

### MMP 別の代表的な検証パラメータ

| MMP | 主な保持確認対象 |
| --- | --- |
| AppsFlyer (OneLink) | `pid`, `c`, `af_channel`, `af_siteid`, `af_sub1`〜`af_sub5`, `deep_link_value` |
| Adjust | `campaign`, `adgroup`, `creative`, `label`, `deep_link` |
| Branch | `~channel`, `~campaign`, `~feature`, `$deeplink_path` |
| Kochava | `network_id`, `campaign_id`, `site_id` |

## 出力例

```
=== リダイレクトチェーン ===
  #02 (navigation-request) [tracking] https://example.onelink.me/abcd?pid=owned_lp&c=spring2026&af_sub1=qa-run-1
  #03 (http-redirect 302) [tracking] https://example.onelink.me/abcd?...
        Location: https://apps.apple.com/jp/app/id000000?...
  #04 (redirect-target) [store] https://apps.apple.com/jp/app/id000000?...

=== ストア直前のトラッキングURL ===
  https://example.onelink.me/abcd?pid=owned_lp&c=spring2026&af_sub1=qa-run-1
  params:
    - pid = owned_lp
    - c = spring2026
    - af_sub1 = qa-run-1

✅ パラメータ検証 OK
✅ ストア到達を確認: https://apps.apple.com/jp/app/id000000?...
```

## テスト

ローカルのダミーLP + ダミーMMP（302 を 2 段挟んで `apps.apple.com` へ）に対してツール全体を通す
スモークテストが入っています。実LPやMMPに一切アクセスしません。

```bash
npm test
```

## 注意事項（重要）

このツールは **自社が保有するLPと、自社が発行したトラッキングリンクの検証** を前提としています。

`allowedHosts` に自社ドメイン以外を追加して、第三者のキャンペーンページや招待・リファラル報酬ページに対して
実行しないでください。他社の紹介報酬フローのCTAを自動クリックしてアトリビューションURLを収集する行為は、
インストール不正（インストールファーミング / リファラル不正）と技術的に区別がつかず、
各MMP・各ストアの規約違反にあたります。

また、実機・実ストアでの最終確認（ディープリンク復帰、`af_sub` の SDK 受け取り）は
本ツールの範囲外です。ステージング用の `pid` を使い、本番の計測数値を汚さないようにしてください。

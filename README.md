# A

## onelink-tool.html

MMP（AppsFlyer OneLink 形式）のトラッキングリンクに対して、パラメータの付与・上書きと
遅延リダイレクトの挙動を検証するための単一ファイルツール。依存ライブラリなし、外部通信なし。

### モード

`?to=` クエリの有無で 2 モードに分岐する。

| URL | モード | 動作 |
| --- | --- | --- |
| `onelink-tool.html` | ビルダー | パラメータ付与フォームと生成結果を表示 |
| `onelink-tool.html?to=<url>` | 中継 | 1.0〜2.0 秒のランダム遅延後に `to` へ遷移 |

### 付与されるパラメータ

- `af_ios_url` — iOS 向け遷移先（空欄なら変更しない）
- `af_android_url` — Android 向け遷移先（空欄なら変更しない）
- `af_dp` — 空文字で設定し、既定のカスタムスキーマ起動を無効化
- `is_retargeting` — `true`

入力 URL の他のパラメータ（`pid`、`c` など）は保持され、上記キーのみ上書きされる。

### エンコードについて

`URLSearchParams.set()` は `toString()` 時に自動でパーセントエンコードするため、
ストア URL は生値のまま渡すのが正しい。事前に `encodeURIComponent()` を適用すると
`%3A` → `%253A` の二重エンコードになり MMP 側で宛先が壊れるため、
既定では無効。二重エンコードを要求するパイプライン向けにトグルで切り替えられる。

### 制約

- 入力・遷移先ともに `http` / `https` のみ許可。`javascript:` 等は
  ビルダー・中継の双方で拒否され、`location.href` に到達しない。
- 中継モードは遷移先を画面に表示し、手動フォールバックリンクを常に提示する。
- `file://` では中継 URL が機能しないため、HTTP(S) 上に配置すること。

### 利用範囲

`is_retargeting` と `af_*_url` はアトリビューションの帰属先と遷移先を書き換える。
自社が管理権を持つリンクに対してのみ使用すること。第三者が発行したリンクの帰属を
書き換える行為はアトリビューション不正にあたり、各 MMP の利用規約に違反する。


## デプロイ（Cloud Run）

`server.js` が API と `index.html` の配信を兼ねる。`index.html` は同一オリジンで
配信されていればAPIを相対パスで呼び、そうでなければ絶対URLへフォールバックするため、
GitHub Pages に置いたままでも動作する。

### 必要な設定

| 項目 | 値 | 理由 |
| --- | --- | --- |
| メモリ | **1GiB 以上**（推奨 2GiB） | 既定の512MiBではChrome起動時にOOMで落ちる |
| タイムアウト | 60秒以上 | LP取得に時間がかかる |
| 未認証の呼び出し | **許可** | 無効だとCloud RunがExpressの手前で403を返し、CORSヘッダが付かないためブラウザから呼べない |

```
gcloud run deploy apiforurlgenerater \
  --source . --region asia-northeast1 \
  --memory 2Gi --timeout 60 --allow-unauthenticated
```

### 動作確認

```
curl -i https://<service-url>/healthz     # {"ok":true,"service":"tiktok-stealth-api","chrome":"/usr/bin/chromium"}
```

`/healthz` はPuppeteerを起動しないため、Cloud Runの認証・CORS設定だけを
スクレイパーとは独立に切り分けられる。ブラウザで開いて
「Sorry, this is just a placeholder…」が出る場合はビルドが失敗しており、
コードが一度もデプロイされていない。

### Dockerfile の注意点

ベースイメージ `ghcr.io/puppeteer/puppeteer` は最終行が `USER pptruser`（非root）。
`WORKDIR` を作ってそのまま `npm install` すると root 所有ディレクトリへの書き込みで
EACCES となりビルドが落ちるため、インストール中のみ `USER root` に戻している。
また Chrome の再ダウンロード抑止は v20 以降 `PUPPETEER_SKIP_DOWNLOAD` が正式名で、
旧名 `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` だけでは効かない。


## デプロイ方法A: Cloud Shell（設定不要・最速）

iPad などターミナルが無い環境向け。ブラウザだけで完結する。

1. Safari で `shell.cloud.google.com` を開く（Googleアカウントで認証済みの`gcloud`が使える）
2. 次を貼り付けて実行

```
git clone https://github.com/mnaoki20081106-afk/A.git ~/A 2>/dev/null; \
cd ~/A && git pull && \
gcloud run deploy apiforurlgenerater \
  --source . --project stealth-api-for-url-generater \
  --region asia-northeast1 \
  --memory 2Gi --timeout 60 --allow-unauthenticated
```

ビルドログがその場に流れるので、失敗した場合も原因がすぐ分かる。

## デプロイ方法B: GitHub Actions（初期設定後は自動）

`main` への push で `.github/workflows/deploy.yml` が動き、ビルド・デプロイ・
`/healthz` の疎通確認までを行う。ビルドログが GitHub Actions に残る。

`GCP_SA_KEY` シークレットが未設定の間はスキップされるだけで失敗はしない。

### 初期設定

**1. サービスアカウントを作る**

Cloud Console → IAM と管理 → サービス アカウント → 「サービス アカウントを作成」
名前は `github-deployer` など。次のロールを付与する。

| ロール | 用途 |
| --- | --- |
| Cloud Run 管理者 | サービスのデプロイ |
| Cloud Build 編集者 | イメージのビルド |
| Artifact Registry 管理者 | イメージの保存 |
| ストレージ管理者 | ビルドソースのアップロード |
| サービス アカウント ユーザー | 実行サービスアカウントの利用 |

**2. キーを発行する**

作成したサービスアカウント → 「キー」タブ → 「鍵を追加」→「新しい鍵を作成」→ **JSON**。
ダウンロードされた JSON の中身を全文コピーする。

**3. GitHub に登録する**

リポジトリ → Settings → Secrets and variables → Actions → 「New repository secret」

- Name: `GCP_SA_KEY`
- Secret: 上でコピーした JSON 全文

**4. 実行する**

Actions タブ → 「Deploy to Cloud Run」→ 「Run workflow」。
以降は `main` への push で自動的に走る。

> サービスアカウントキーは長期有効な認証情報のため、不要になったら
> Cloud Console から削除すること。より安全な方式が必要な場合は
> Workload Identity 連携に切り替える。


### サービスURLの確認

`index.html` の `API_HOST` は Cloud Run のサービスURLを直接埋め込んでいる。
Cloud Run は `SERVICE-HASH-REGION.a.run.app` 形式のURLを払い出すため、
プロジェクト番号から推測した形式のURLとは一致しないことがある。
正しいURLは次で確認する。

```
gcloud run services describe apiforurlgenerater \
  --project stealth-api-for-url-generater --region asia-northeast1 \
  --format='value(status.url)'
```

ここで得た値と `index.html` の `API_HOST` が一致していること。

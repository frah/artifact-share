# Artifact Share

[English](README.md) | 日本語

AI コーディングツールから HTML / Markdown を公開する、社内用の軽量共有サーバーです。Go 製の単一バイナリに画面と描画ライブラリを組み込みます。実行時に Node.js や外部 CDN は不要です。

## 起動

初回だけ管理者ユーザーを作成します。既存 DB がある場合、環境変数を変えても管理者パスワードは変更しません。

```sh
# Go 1.25 以上。生成済み web/app.js を同梱しているので npm は不要。
go build -o artifact-share .
ADMIN_PASSWORD='your-initial-password' ./artifact-share
# http://localhost:8080 → admin でログイン
```

管理画面でユーザーを作成し、各ユーザーが API キーを発行します。「新しく公開」から内容を入力・ファイル読込・編集・削除できます。管理者は全コンテンツを閲覧・編集・削除し、ユーザー作成とパスワード再設定を行えます。

| 設定 | 初期値 | 内容 |
| --- | --- | --- |
| `PORT` | `8080` | 待受ポート |
| `DATABASE_URL` | `file:artifacts.db` | SQLite ファイルまたは PostgreSQL 接続 URL |
| `BASE_PATH` | 空 | `/artifacts` のようなサブパス。末尾 `/` 不要 |
| `ADMIN_USER` | `admin` | 初回管理者名 |
| `ADMIN_PASSWORD` | なし | 初回のみ必須、8〜72 バイト |
| `ALLOW_SIGNUP` | `false` | `true` で一般ユーザーの自己登録を許可 |
| `COOKIE_SECURE` | `false` | HTTPS 運用時は `true` |

```sh
DATABASE_URL='postgres://user:password@db:5432/artifactshare?sslmode=require' \
BASE_PATH=/artifacts COOKIE_SECURE=true ADMIN_PASSWORD='your-initial-password' \
./artifact-share
```

PostgreSQL は事前に空の DB を作成し、ユーザーにテーブル・インデックスの作成権限を付与してください。テーブルは起動時に作成します。初回起動は 1 インスタンスで実施し、その後 PostgreSQL では複数レプリカを使用できます。セッション・API キー・コンテンツは DB に保存します。

## エージェント用 skill

[skills](https://skills.sh/) を使って、同梱の skill を Claude Code にインストールできます。

```sh
npx skills add frah/artifact-share --skill artifact-share --agent claude-code
# プロジェクト単位ではなく、グローバルにインストールする場合:
npx skills add frah/artifact-share --skill artifact-share --agent claude-code --global
```

Codex では `--agent claude-code` を `--agent codex` に変更してください。skill と補助スクリプトが一緒にインストールされるため、利用時にサーバーのリポジトリを clone する必要はありません。

サーバー画面で API キーを作成し、サービス URL（サブパスを含む）とキーを環境変数に設定して、その環境からコーディングツールを起動してください。

```sh
export ARTIFACT_SHARE_URL='https://intranet.example.com/artifacts'
export ARTIFACT_SHARE_KEY='ash_...'
```

Windows PowerShell の場合:

```powershell
$env:ARTIFACT_SHARE_URL = 'https://intranet.example.com/artifacts'
$env:ARTIFACT_SHARE_KEY = 'ash_...'
```

「report.md を Artifact Share で公開してリンクを教えて」「report.html を alice と bob だけに共有して」のように依頼できます。公開、同じ URL での更新、一覧、内容取得、削除に対応しています。変更を指定しない更新では、既存のタイトルと共有設定を維持します。

補助スクリプトは Node.js 18 以上で動作し、追加パッケージは不要です。API キーを環境変数から読み込み、ユーザー名から共有先を解決し、絶対 URL を返します。社内 CA とプロキシ設定は [skill の説明](skills/artifact-share/SKILL.md) を参照してください。API キーをコミットしたり、チャットに貼り付けたりしないでください。

## 公開 API / Claude Code

標準の `Authorization: Bearer <APIキー>` と、要件の `Authentication: Bearer <APIキー>` のどちらも利用できます。キーの権限は発行ユーザーの権限と同じです。JSON の上限は 10 MiB です。

```sh
export ARTIFACT_SHARE_URL='https://intranet.example.com/artifacts'
export ARTIFACT_SHARE_KEY='ash_...'
./scripts/publish.sh examples/report.md '設計レポート'
# 指定ユーザー共有: 第4引数にユーザーIDをカンマ区切りで指定
./scripts/publish.sh examples/report.md '限定レポート' users 'USER_ID_1,USER_ID_2'
```

スクリプトには `curl` と `jq` が必要です。直接 curl を使う場合:

```sh
jq -n --rawfile content report.md \
 '{title:"レポート",kind:"md",content:$content,visibility:"link",users:[]}' |
curl --fail-with-body -sS "$ARTIFACT_SHARE_URL/api/artifacts" \
 -H "Authorization: Bearer $ARTIFACT_SHARE_KEY" \
 -H 'Content-Type: application/json' --data-binary @-
```

応答には `id` と `url` が含まれます。`url` はサブパスを含む相対パスなので、ブラウザで開くときはサーバーの origin（例 `https://intranet.example.com`）を前置してください。

Claude Code のプロジェクト `CLAUDE.md` に、例えば次を記載できます:

> 成果物を共有するときは、HTML または Markdown のファイルを作り、`scripts/publish.sh FILE TITLE` を実行してください。サーバー URL と API キーは `ARTIFACT_SHARE_URL` / `ARTIFACT_SHARE_KEY` 環境変数に設定済みです。応答の url に origin を前置したリンクをユーザーに伝えてください。キーをファイルや会話へ出力しないでください。

### エンドポイント

すべて `BASE_PATH` の下にあります。詳細なリクエスト形式は [docs/api.md](docs/api.md) を参照してください。

| メソッド / パス | 動作 |
| --- | --- |
| `POST /api/artifacts` | 公開。title, kind (`html` / `md`), content, visibility (`link` / `users`), users (ユーザー ID 配列) |
| `GET /api/artifacts` | 自分の一覧 |
| `GET /api/artifacts/{id}` | 自分または管理者が編集用内容を取得 |
| `PUT /api/artifacts/{id}` | 内容・公開範囲を更新、共有 URL は維持 |
| `DELETE /api/artifacts/{id}` | 削除 |
| `GET /api/users` | 共有先を選ぶユーザー一覧 |
| `GET /api/share?id={id}` | 閲覧権限のあるコンテンツを取得 |
| `GET /s/{id}` | 閲覧画面 |
| `GET /api/keys`, `POST /api/keys` | 自分のキー一覧・発行 |
| `DELETE /api/keys/{id}` | 自分のキーを失効 |
| `GET /api/admin/users`, `POST /api/admin/users` | 管理者による一覧・作成 |
| `PATCH /api/admin/users/{id}` | パスワード再設定、既存セッション失効 |
| `GET /api/admin/artifacts` | 管理者の全コンテンツ一覧 |
| `GET /healthz` | DB 接続を含むヘルスチェック。サブパスの外に固定 |

## 共有と描画

- **リンク共有**: ランダムな URL を知っている人はログインなしで閲覧できます。
- **ユーザー指定共有**: 指定したユーザー、作成者、管理者だけが閲覧できます。指定ユーザーはログインしてください。URL だけでは閲覧できません。
- **Markdown**: marked + DOMPurify で描画し、`mermaid` コードブロックを図にします。
- **Markdown のリンク**: 有効な `http://` または `https://` から始まる完全な URL のみリンクにします。相対パス、ルート相対パス、`//` 始まりの URL、フラグメント、その他のスキームはリンクにせず、リンクテキストの装飾を保って通常の内容として表示します。
- **HTML**: JavaScript が動作する sandbox iframe で表示します。自己完結した HTML を推奨します。相対パスの付属ファイルアップロードには対応していません。外部 URL の画像・スクリプト等は端末のネットワーク到達性に依存します。

イントラネットを前提に、bcrypt のパスワード、ハッシュ化した API キー／セッション、所有者の区別、Cookie の SameSite、画面操作の CSRF トークンを実装しています。WAF、MFA、監査基盤などは組み込んでいません。HTML の sandbox はホスト画面への干渉を抑えますが、ネットワーク隔離の仕組みではありません。

認証は `CredentialAuthenticator` インターフェースと `LocalAuthenticator` に分離しています。将来の LDAP アダプターは認証後にローカル DB の User を返し、所有者・共有先 ID を維持する構成です。LDAP 接続自体は未実装です。

## コンテナ / Kubernetes / ECS

```sh
docker build -t artifact-share:latest .
# bind mount の /data は UID 65532 が書き込めるように準備してください。
docker run --rm -p 8080:8080 -e ADMIN_PASSWORD='your-initial-password' \
 -v artifact-data:/data artifact-share:latest
```

- [deploy/kubernetes.yaml](deploy/kubernetes.yaml): SQLite + PVC、1 レプリカ、internal ALB の例。イメージ、証明書 ARN、ホスト名、初期パスワードを変更してください。PostgreSQL を使う場合は `DATABASE_URL` を Secret に追加し、PVC と volumeMount を削除できます。
- [deploy/ecs-task.json](deploy/ecs-task.json): Fargate + 外部 PostgreSQL のタスク定義。ARN・イメージ・ロググループを置き換え、実行ロールに SSM パラメータ読み取りを許可してください。サービスをプライベートサブネットに配置し、internal ALB から `/artifacts` と `/artifacts/*` をパス変換なしで転送します。ターゲットポートは 8080、ヘルスチェックは `/healthz`。SQLite の Fargate エフェメラルストレージ運用は永続化されないため推奨しません。
- ALB / ELB のプロキシはプレフィックスを削らずに転送してください。`BASE_PATH=/artifacts` なら UI、アセット、API、共有リンクがすべてその配下で動作します。
- SQLite は WAL を使い、1 レプリカとローカル永続ボリュームで運用してください。SQLite ファイルを EFS などで複数タスクから共有しないでください。
- SQLite バックアップは停止後に DB ファイルをコピー、または SQLite のオンラインバックアップ機能を使います。稼働中に DB ファイルだけをコピーすると WAL 内の変更を取りこぼします。PostgreSQL は `pg_dump` 等を使います。

## 開発と検証

```sh
go test ./...
# 外部 PostgreSQL の実DBテスト。テスト用 DB、CREATE SCHEMA 権限が必要。
TEST_DATABASE_URL='postgres://postgres:test-password@localhost:55432/artifactshare?sslmode=disable' go test ./...
# UI を編集したときのみ。生成済み web/app.js も更新する。
npm ci && npm run build
CGO_ENABLED=0 go build -trimpath -o bin/artifact-share .
# skill 補助スクリプトの実サーバー統合テスト（上記バイナリが必要）。
node --test tests/skill.test.mjs
```

共有範囲、第三者の編集拒否、削除、API キー失効、管理者権限、CSRF、パスワード再設定によるログイン失効、サブパスをテストします。

ブラウザの操作・描画検証も `tests/browser.cjs` に含みます。使い捨ての SQLite DB でサーバーを起動し、別ターミナルから実行してください。

```sh
ADMIN_PASSWORD=initial-password BASE_PATH=/artifacts PORT=18080 \
DATABASE_URL=file:/tmp/artifact-share-ui-test.db ./bin/artifact-share
# 別ターミナル。Chromium のパスは環境に合わせて変更。
npm ci
CHROMIUM_PATH=/usr/bin/chromium node tests/browser.cjs
```

画面例: [コンテンツ管理](docs/dashboard.png)、[Markdown / Mermaid 閲覧](docs/markdown.png)。

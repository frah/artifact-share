# API リファレンス

パスに `BASE_PATH` を前置してください。JSON リクエストには `Content-Type: application/json` を指定します。認証が必要な操作は `Authorization: Bearer ash_...`（`Authentication` ヘッダも可）を指定します。Cookie セッションでは状態変更時に `X-CSRF-Token` が必要です。`POST /api/login`、`GET /api/me` の応答から取得できます。

## コンテンツ

`POST /api/artifacts` → 201、`PUT /api/artifacts/{id}` → 200:

```json
{
  "title": "設計レポート",
  "kind": "md",
  "source_path": "docs/report.md",
  "content": "# 概要\n\n```mermaid\ngraph LR\nA --> B\n```",
  "visibility": "users",
  "users": ["共有先のユーザーID"]
}
```

`kind`: `md` / `html`。`visibility`: `link` / `users`。リンク共有時は `users: []`。ユーザーIDは `GET /api/users` で取得します。PUT は全フィールドを再送してください。タイトル必須、リクエスト最大 10 MiB。共有先の存在も検証します。`source_path` は任意で、ドキュメントルートからの相対パス（例 `docs/report.md`）を指定します。絶対パスやルートの外へ出るパスは受け付けません。PUT で省略した場合は既存のパスを維持し、空文字を指定すると消去します。

応答:

```json
{
  "id": "ランダムID",
  "owner": "所有者ID",
  "owner_name": "alice",
  "source_path": "docs/report.md",
  "title": "設計レポート",
  "kind": "md",
  "content": "...",
  "visibility": "users",
  "users": ["共有先のユーザーID"],
  "updated": "2026-10-06T00:00:00Z",
  "url": "/artifacts/s/ランダムID"
}
```

- `GET /api/artifacts`: 所有コンテンツのメタデータ配列（content は省略相当の空文字）。
- `GET /api/artifacts/{id}`: 所有者／管理者向けの全内容。
- `DELETE /api/artifacts/{id}`: 所有者／管理者が削除。`{"ok":true}`。
- `GET /api/share?id={id}`: 閲覧者向けの全内容。リンク共有は認証不要。ユーザー指定は認証必須。
- `GET /s/{id}`: ブラウザ画面。`GET /s/{id}/raw`: sandbox 用 HTML レスポンス。

## Markdown の相対リンク

`GET /api/resolve?id={表示中のartifact ID}&href={URLエンコードした相対リンク}` は、表示中の artifact の `source_path` を基準にリンク先を解決し、`{"url":"/artifacts/s/リンク先ID"}` を返します。`../`、URL エンコードされたファイル名、クエリ文字列、フラグメントに対応します。

例: `docs/index.md` の `./hoge/piyo.md` は同じオーナーの `docs/hoge/piyo.md` にリンクします。同じパスの複数の artifact がある場合は、パスが明示されたものを優先し、その中で最新のものを選びます。元とリンク先の両方に閲覧権限が必要です。未公開・権限なし・ルート外は 404 です。新しい非公開 artifact を閲覧できない場合に、古い公開版へフォールバックしません。

既存データは `source_path` が空のまま移行されます。パス情報がない場合はタイトルを元パスとして使い、リンク先もタイトルがパスと一致する既存 artifact を検索できます。それ以外は管理画面で元ファイルのパスを設定してください。

閲覧画面は外部 URL、`/` 始まりの URL、`#` 始まりのページ内リンクを変更しません。解決できない相対リンクをクリックすると案内を表示し、存在しないサービス内 URL への遷移を抑えます。相対パスの画像・添付ファイルアップロードには対応していません。

## 認証

- `POST /api/login`: `{"name":"alice","password":"..."}` → セッション Cookie と `{"csrf":"..."}`。24時間有効。
- `POST /api/logout`: セッションを失効。`{"ok":true}`。
- `POST /api/signup`: `ALLOW_SIGNUP=true` 時のみ。`{"name":"alice","password":"..."}`。一般ユーザーのみ作成、201。
- `GET /api/me`: `{"user":{"id":"...","name":"alice","admin":false},"csrf":"..."}`。
- `GET /api/config`: `{"signup":false,"base":"/artifacts"}`。

ユーザー名は 1〜80 バイト、パスワードは 8〜72 バイト。管理者によるパスワード変更は既存ログインを失効します。API キーは独立して有効なので、必要なら該当ユーザーとしてキーを失効してください。

## API キー

- `GET /api/keys`: `[{"id":"...","name":"Claude Code","created":"..."}]`。キー自体は返しません。
- `POST /api/keys`: `{"name":"Claude Code"}` → 201 `{"id":"...","key":"ash_..."}`。キーはこの応答でだけ取得可能。
- `DELETE /api/keys/{id}`: 自分のキーを失効。`{"ok":true}`。

## 管理

- `GET /api/users`: 認証済みユーザーが共有先を選ぶための一覧。
- `GET /api/admin/users`: 管理者のユーザー一覧。
- `POST /api/admin/users`: `{"name":"alice","password":"...","admin":false}` → 201。
- `PATCH /api/admin/users/{id}`: `{"password":"..."}` → 200、既存ログイン失効。
- `GET /api/admin/artifacts`: 全体のメタデータ一覧。

ユーザー一覧の応答は `[{"id":"...","name":"alice","admin":false}]`。管理者は通常のコンテンツ API で全コンテンツの編集・削除ができます。

## エラー

`{"error":"理由"}`。400: 入力不正、401: 認証なし／キー無効、403: 操作権限なし／CSRF、404: 見つからない／共有閲覧権限なし、500: DB 等の内部エラー。`GET /healthz` は DB が利用可能なら 200 `{"status":"ok"}`、障害時 503。

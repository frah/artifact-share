# API リファレンス

パスに `BASE_PATH` を前置してください。JSON リクエストには `Content-Type: application/json` を指定します。認証が必要な操作は `Authorization: Bearer ash_...`（`Authentication` ヘッダも可）を指定します。Cookie セッションでは状態変更時に `X-CSRF-Token` が必要です。`POST /api/login`、`GET /api/me` の応答から取得できます。

## コンテンツ

`POST /api/artifacts` → 201、`PUT /api/artifacts/{id}` → 200:

```json
{
  "title": "設計レポート",
  "kind": "md",
  "content": "# 概要\n\n```mermaid\ngraph LR\nA --> B\n```",
  "visibility": "users",
  "users": ["共有先のユーザーID"]
}
```

`kind`: `md` / `html`。`visibility`: `link` / `users`。リンク共有時は `users: []`。ユーザーIDは `GET /api/users` で取得します。PUT は全フィールドを再送してください。タイトル必須、リクエスト最大 10 MiB。共有先の存在も検証します。

応答:

```json
{
  "id": "ランダムID",
  "owner": "所有者ID",
  "owner_name": "alice",
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

## Markdown のリンク

閲覧画面では、有効な `http://` または `https://` から始まる完全な URL だけをリンクとして表示します。相対パス、`/` 始まりのパス、`//` 始まりの URL、ページ内フラグメント、その他のスキームはリンクにせず、リンクテキストの装飾を保って通常の内容として表示します。

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

# 検証結果

2026-10-06 の実行環境で以下を確認しました。

- Go 1.25.3、SQLite: `go test ./...` 成功。
- PostgreSQL 17（実コンテナ）: `TEST_DATABASE_URL=... go test -count=1 ./...` 成功。
- `go test -race ./...` と `go vet ./...` 成功。
- Chromium / Playwright: ログイン、管理者によるユーザー作成、API キー発行、画面から公開、Mermaid の SVG 描画、HTML の JavaScript 実行、匿名ユーザーの限定公開拒否、指定ユーザーのログイン後 HTML 閲覧を確認。
- `scripts/publish.sh` による実際の curl 公開と共有 URL の応答を確認。
- Dockerfile ビルド成功。nonroot コンテナで SQLite を名前付きボリュームへ保存し、再起動後のコンテンツと API キーの永続性、サブパスの動作を確認。
- Linux amd64 バイナリは CGO 無効、静的リンク。UI と描画ライブラリを埋め込み済み。

Kubernetes / ECS の定義は配置例です。AWS アカウント、クラスター、社内 DNS、証明書、レジストリへの実配置は行っていません。LDAP アダプターは未実装です。

## Issue #1 の検証

SQLite と PostgreSQL 17 の実DBで、オーナー名、相対リンクの同一オーナー内解決、親ディレクトリ、URL エンコードされたファイル名、クエリ・フラグメント、公開範囲、既存DBの列追加とデータ維持を検証しました。Chromium で通常・管理者の表形式一覧、画面からの編集、ドキュメント名を含むタブタイトル、オーナー表示、相対リンクの遷移、未公開・権限なしのリンク案内を確認しています。skill の統合テストには元パスの保存と更新時の維持を追加しました。

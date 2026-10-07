# Windows 版

Windows amd64（x64）用の単一バイナリです。画面、Markdown / Mermaid 描画ライブラリ、SQLite ドライバーを内蔵し、Go や Node.js のインストールは不要です。

ZIP を書き込み可能なフォルダーへ展開し、そのフォルダーで PowerShell を開いて実行します。

```powershell
$env:ADMIN_PASSWORD = 'your-initial-password'
.\artifact-share.exe
```

`http://localhost:8080` にアクセスし、ユーザー名 `admin` と設定したパスワードでログインしてください。初回起動で管理者を作成します。SQLite の `artifacts.db` は作業フォルダーに保存します。終了は Ctrl+C です。

ポート・サブパス・保存先を指定する場合:

```powershell
$env:PORT = '8080'
$env:BASE_PATH = '/artifacts'
$env:DATABASE_URL = 'file:C:/ArtifactShare/data/artifacts.db'
.\artifact-share.exe
# http://localhost:8080/artifacts/
```

保存先ディレクトリは事前に作成してください。その他の設定は同梱 README.md を参照してください。

この配布物はクロスコンパイルと Windows PE 形式の確認を実施しています。Windows 実機での起動試験とコード署名は実施していません。

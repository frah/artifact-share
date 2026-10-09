# Artifact Share

English | [日本語](README_ja.md)

A lightweight sharing server for publishing HTML and Markdown from AI coding tools within your organization. The Go application embeds its UI and rendering libraries in a single binary. Node.js and external CDNs are not required at runtime.

## Getting started

An administrator account is created on the first start only. If a database already exists, changing the environment variables does not change the administrator's password.

```sh
# Requires Go 1.25 or later. The generated web/app.js is included, so npm is not needed.
go build -o artifact-share .
ADMIN_PASSWORD='your-initial-password' ./artifact-share
# Open http://localhost:8080 and sign in as admin.
```

Create users in the admin interface, then let each user issue their own API keys. Use the “新しく公開” (Publish new) button to enter content or load a file, and manage existing content by editing or deleting it. Administrators can view, edit, and delete all content, create users, and reset passwords.

| Setting | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Listening port |
| `DATABASE_URL` | `file:artifacts.db` | SQLite file or PostgreSQL connection URL |
| `BASE_PATH` | Empty | Subpath such as `/artifacts`; no trailing `/` needed |
| `ADMIN_USER` | `admin` | Initial administrator username |
| `ADMIN_PASSWORD` | None | Required on first start only; 8–72 bytes |
| `ALLOW_SIGNUP` | `false` | Set to `true` to allow users to register themselves |
| `COOKIE_SECURE` | `false` | Set to `true` when serving over HTTPS |

```sh
DATABASE_URL='postgres://user:password@db:5432/artifactshare?sslmode=require' \
BASE_PATH=/artifacts COOKIE_SECURE=true ADMIN_PASSWORD='your-initial-password' \
./artifact-share
```

For PostgreSQL, create an empty database in advance and grant the database user permission to create tables and indexes. Tables are created at startup. Perform the first start with a single instance; afterward, multiple replicas can be used with PostgreSQL. Sessions, API keys, and content are stored in the database.

## Agent skill

Install the bundled skill with [skills](https://skills.sh/) for Claude Code:

```sh
npx skills add frah/artifact-share --skill artifact-share --agent claude-code
# Install globally instead of in the current project:
npx skills add frah/artifact-share --skill artifact-share --agent claude-code --global
```

For Codex, replace `--agent claude-code` with `--agent codex`. The skill and its helper are installed together; cloning this server repository is not required to use the skill.

Create an API key in the server UI, configure the service URL (including any base path) and key in the environment, and start your coding tool from that environment:

```sh
export ARTIFACT_SHARE_URL='https://intranet.example.com/artifacts'
export ARTIFACT_SHARE_KEY='ash_...'
```

On Windows PowerShell:

```powershell
$env:ARTIFACT_SHARE_URL = 'https://intranet.example.com/artifacts'
$env:ARTIFACT_SHARE_KEY = 'ash_...'
```

Ask your agent to “Publish report.md through Artifact Share and give me the link” or “Share report.html only with alice and bob.” The skill supports publishing, updating an artifact at the same URL, listing, fetching, and deleting content. Updates preserve the existing title and sharing settings unless you request a change.

The helper requires Node.js 18+ and no additional packages. It reads the API key from the environment, resolves exact usernames, and returns absolute share URLs. For corporate CA and proxy settings, see [the skill instructions](skills/artifact-share/SKILL.md). API keys should not be committed or pasted into chat.

## Publishing API / Claude Code

Both the standard `Authorization: Bearer <API key>` header and the `Authentication: Bearer <API key>` header are supported. An API key has the same permissions as the user who issued it. JSON request bodies are limited to 10 MiB.

```sh
export ARTIFACT_SHARE_URL='https://intranet.example.com/artifacts'
export ARTIFACT_SHARE_KEY='ash_...'
./scripts/publish.sh examples/report.md 'Design report'
# Share with specific users: pass comma-separated user IDs as the fourth argument.
./scripts/publish.sh examples/report.md 'Restricted report' users 'USER_ID_1,USER_ID_2'
```

The script requires `curl` and `jq`. To publish directly with curl:

```sh
jq -n --rawfile content report.md \
 '{title:"Report",kind:"md",content:$content,visibility:"link",users:[]}' |
curl --fail-with-body -sS "$ARTIFACT_SHARE_URL/api/artifacts" \
 -H "Authorization: Bearer $ARTIFACT_SHARE_KEY" \
 -H 'Content-Type: application/json' --data-binary @-
```

The response includes `id` and `url`. The `url` is a relative path that includes the configured subpath. Prepend the server's origin, such as `https://intranet.example.com`, to open it in a browser.

For example, add the following to your project's `CLAUDE.md` for Claude Code:

> When sharing an artifact, create an HTML or Markdown file and run `scripts/publish.sh FILE TITLE`. The server URL and API key are already set in the `ARTIFACT_SHARE_URL` and `ARTIFACT_SHARE_KEY` environment variables. Give the user a link formed by prepending the server's origin to the url in the response. Do not write the API key to files or display it in the conversation.

### Endpoints

All application endpoints are under `BASE_PATH`. See [docs/api.md](docs/api.md) for detailed request formats (in Japanese). The health check is the exception, as noted below.

| Method / path | Action |
| --- | --- |
| `POST /api/artifacts` | Publish: title, kind (`html` / `md`), content, visibility (`link` / `users`), users (array of user IDs) |
| `GET /api/artifacts` | List your own content |
| `GET /api/artifacts/{id}` | Retrieve content for editing as its owner or an administrator |
| `PUT /api/artifacts/{id}` | Update content and sharing settings while keeping the same share URL |
| `DELETE /api/artifacts/{id}` | Delete content |
| `GET /api/users` | List users to select sharing recipients |
| `GET /api/share?id={id}` | Retrieve content you have permission to view |
| `GET /s/{id}` | Browser viewing page |
| `GET /api/keys`, `POST /api/keys` | List or issue your own API keys |
| `DELETE /api/keys/{id}` | Revoke your own API key |
| `GET /api/admin/users`, `POST /api/admin/users` | List or create users as an administrator |
| `PATCH /api/admin/users/{id}` | Reset a password and invalidate existing sessions |
| `GET /api/admin/artifacts` | List all content as an administrator |
| `GET /healthz` | Health check including database connectivity; fixed outside the configured subpath |

## Sharing and rendering

- **Link sharing**: Anyone who knows the randomly generated URL can view the content without signing in.
- **Sharing with specific users**: Only the selected users, the content owner, and administrators can view the content. Selected users must sign in; knowing the URL alone does not grant access.
- **Markdown**: Rendered with marked and DOMPurify. `mermaid` code blocks are rendered as diagrams.
- **Markdown links**: Only valid, fully qualified `http://` or `https://` URLs become links. Relative paths, root-relative paths, protocol-relative URLs, fragments, and other schemes are displayed as ordinary content, preserving the formatting of the link text.
- **HTML**: Displayed in a sandboxed iframe with JavaScript enabled. Self-contained HTML is recommended. Uploading accompanying files referenced by relative paths is not supported. Images, scripts, and other resources at external URLs depend on network access from the viewer's device.

Designed for intranet use, the application implements bcrypt password hashing, hashed API keys and session tokens, ownership checks, SameSite cookies, and CSRF tokens for UI actions. It does not include a WAF, MFA, or an audit infrastructure. The HTML sandbox limits interference with the host page, but does not provide network isolation.

Authentication is separated into the `CredentialAuthenticator` interface and `LocalAuthenticator` implementation. A future LDAP adapter should return a User from the local database after authentication, preserving the IDs used for ownership and sharing recipients. LDAP connectivity itself is not implemented yet.

## Containers / Kubernetes / ECS

```sh
docker build -t artifact-share:latest .
# When using a bind mount for /data, ensure it is writable by UID 65532.
docker run --rm -p 8080:8080 -e ADMIN_PASSWORD='your-initial-password' \
 -v artifact-data:/data artifact-share:latest
```

- [deploy/kubernetes.yaml](deploy/kubernetes.yaml): Example using SQLite, a PVC, one replica, and an internal ALB. Replace the image, certificate ARN, hostname, and initial password. For PostgreSQL, add `DATABASE_URL` to the Secret and remove the PVC and its volume mount.
- [deploy/ecs-task.json](deploy/ecs-task.json): Task definition for Fargate with external PostgreSQL. Replace the ARNs, image, and log group, and grant the execution role permission to read the SSM parameters. Place the service in private subnets and forward `/artifacts` and `/artifacts/*` from an internal ALB without rewriting the paths. The target port is 8080, and the health check path is `/healthz`. SQLite on Fargate ephemeral storage is not recommended because data is not persistent.
- Configure ALB / ELB proxies to forward requests without stripping the prefix. With `BASE_PATH=/artifacts`, the UI, assets, API, and share links all operate under that path.
- SQLite uses WAL. Run it with one replica and a local persistent volume. Do not share a SQLite file among multiple tasks through EFS or similar storage.
- To back up SQLite, stop the application before copying the database file, or use SQLite's online backup facility. Copying only the database file while the application is running can miss changes stored in the WAL. For PostgreSQL, use `pg_dump` or an equivalent tool.

## Development and verification

```sh
go test ./...
# Integration tests against an external PostgreSQL database.
# Requires a test database and permission to CREATE SCHEMA.
TEST_DATABASE_URL='postgres://postgres:test-password@localhost:55432/artifactshare?sslmode=disable' go test ./...
# Only needed when editing the UI. Update the generated web/app.js as well.
npm ci && npm run build
CGO_ENABLED=0 go build -trimpath -o bin/artifact-share .
# Integration test for the skill helper (requires the server binary above).
node --test tests/skill.test.mjs
```

Tests cover sharing permissions, rejection of edits by other users, deletion, API key revocation, administrator permissions, CSRF, session invalidation after a password reset, and subpath support.

Browser interaction and rendering checks are included in `tests/browser.cjs`. Start the server with a disposable SQLite database, then run the checks from another terminal.

```sh
ADMIN_PASSWORD=initial-password BASE_PATH=/artifacts PORT=18080 \
DATABASE_URL=file:/tmp/artifact-share-ui-test.db ./bin/artifact-share
# In another terminal. Adjust the Chromium path for your environment.
npm ci
CHROMIUM_PATH=/usr/bin/chromium node tests/browser.cjs
```

Screenshots: [Content management](docs/dashboard.png), [Markdown / Mermaid viewer](docs/markdown.png).

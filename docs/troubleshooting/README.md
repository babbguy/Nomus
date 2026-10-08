# Nomus Troubleshooting

Common problems when running Nomus from source, with Docker Compose, or under PM2. Every environment variable named here is defined in `engine/src/config/env.ts`; the commented reference file is `engine/.env.example`.

Related docs: [Deployment guide](../admin-guide/deployment.md), [Operations guide](../admin-guide/operations.md), [Auth reference](../api-reference/auth.md), [Health endpoints](../api-reference/health.md).

For anything not covered here, open an issue at https://github.com/babbguy/Nomus/issues.

---

## Contents

- [Startup and configuration](#startup-and-configuration)
- [Docker Compose](#docker-compose)
- [Reverse proxy](#reverse-proxy)
- [Login and API keys](#login-and-api-keys)
- [Scanner, GitHub Action and editor extension](#scanner-github-action-and-editor-extension)
- [LLM providers](#llm-providers)
- [Database](#database)
- [Webhooks and GitHub App](#webhooks-and-github-app)
- [Reporting a problem](#reporting-a-problem)

---

## Startup and configuration

### The engine exits immediately

Run it in the foreground to see the error:

```bash
npm run build:packages
npm run dev:engine            # tsx watch, http://localhost:3100
# or, for a production build:
npm run build:engine && node engine/dist/index.js
```

Likely causes:

1. **Production configuration is incomplete.** When `NOMUS_ENV=production` (or `NODE_ENV=production`, which the Docker image sets), the engine refuses to start unless all of these are set:
   - `NOMUS_SIGNING_KEY_SECRET` (at least 32 characters)
   - `NOMUS_ADMIN_BOOTSTRAP_KEY` (at least 10 characters)
   - `NOMUS_ADMIN_PASSWORD` (at least 12 characters)
   - `NOMUS_CORS_ORIGIN`
   - `NOMUS_ADMIN_EMAIL`, set to something other than the shipped `admin@example.com`

   The engine prints `[Nomus] FATAL: Missing required configuration for production:` followed by one line per problem. In development the same checks only print `[Nomus] WARNING: ...` and the engine continues with the missing or short values (it does not substitute safe defaults).

2. **A value has the wrong type or is not an allowed choice.** For example `NOMUS_PORT=abc` or `NOMUS_LOG_LEVEL=verbose`. The engine prints `[Nomus] Invalid environment configuration:` with the variable name and reason.

3. **The port is taken.** `NOMUS_PORT` defaults to 3100. Find the other process (`lsof -i :3100` on Linux/macOS, `netstat -ano | findstr 3100` on Windows) or change `NOMUS_PORT`.

4. **Wrong Node.js version.** Node.js 20.19+ or 22.12+ is required to build everything (`node --version`); the dashboard's Vite 8 build rejects older 20.x releases.

5. **The database file cannot be created.** `NOMUS_DB_PATH` defaults to `./data/nomus.db`; the directory must exist or be creatable, and be writable by the user running the engine.

Generate secrets with, for example, `openssl rand -hex 32`.

### Checking that the engine is healthy

```bash
curl http://localhost:3100/health
# {"status":"ok","service":"nomus-engine","version":"...","notice":"...","timestamp":"..."}

curl http://localhost:3100/ready
# {"status":"ready","checks":{"database":"ok","signing":"ok"},...}   (HTTP 503 if not ready)
```

`/ready` returns 503 with `"status":"not_ready"` when the database is unreachable or the signing key could not be initialised.

### Cron variables

`NOMUS_SCRAPE_CRON` (default `0 2 * * *`) and `NOMUS_SCOUT_CRON` (default `0 */6 * * *`) are standard five-field cron expressions. Surrounding single or double quotes in `.env` are stripped automatically, so either of these works:

```bash
NOMUS_SCRAPE_CRON=0 2 * * *
NOMUS_SCRAPE_CRON="0 2 * * *"
```

### PM2 (running without Docker)

The repository ships `ecosystem.config.cjs` (and an `/opt/nomus` variant at `infra/ecosystem.cjs`). The engine uses SQLite, so run exactly one instance in `fork` mode, never cluster mode.

```bash
npm run build:all
pm2 start ecosystem.config.cjs
pm2 logs nomus-engine --lines 50
```

The process name is `nomus-engine`. Secrets are not in the ecosystem file; put them in `.env` or export them in the environment PM2 starts from.

---

## Docker Compose

Quickstart:

```bash
cp engine/.env.example engine/.env     # then edit the secrets
docker compose up --build
```

The dashboard is on http://localhost:8080 and the engine API on http://localhost:3100. The dashboard container is an nginx that serves the React app and proxies `/api/` to the engine, so browser calls are same-origin.

| Problem | Check |
|---------|-------|
| Engine container restarts or is "unhealthy" | `docker compose logs engine`. The healthcheck calls `http://localhost:3100/health` inside the container. Most failures are the production configuration errors listed above, because the image sets `NODE_ENV=production`. |
| Dashboard container never starts | It waits for the engine healthcheck (`depends_on: service_healthy`). Fix the engine first. |
| Data disappears after rebuild | Data lives in the named volume `nomus-data`, mounted at `/app/data`. `docker compose down -v` deletes it. |
| Login works but you are bounced back to the login page over plain HTTP | The session cookie is marked `Secure` when `NOMUS_ENV=production`. Use HTTPS (see the TLS profile in `docker-compose.yml` and the [deployment guide](../admin-guide/deployment.md)), or keep `NOMUS_ENV=development` for a local try-out. |

---

## Reverse proxy

If you put your own nginx in front of the engine (the repo's examples are `infra/nginx.conf`, `infra/nginx-dashboard.conf` and `infra/nginx-tls.conf.template`):

- **502 Bad Gateway**: the engine is not running or `proxy_pass` points at the wrong host/port. Test `curl http://localhost:3100/health` from the proxy host. On SELinux systems you may need `setsebool -P httpd_can_network_connect 1`.
- **Dashboard live updates stall or never arrive**: the Server-Sent Events endpoint `/api/v1/stream` must not be buffered. `infra/nginx-dashboard.conf` shows the settings used (`proxy_http_version 1.1`, `proxy_buffering off`, long `proxy_read_timeout`).
- **Large uploads rejected (413)**: raise `client_max_body_size` (the example config uses 25m for `/api/`).
- **Browser reports a CORS error**: `NOMUS_CORS_ORIGIN` must equal the exact origin the browser loads the dashboard from, including scheme and port (for example `http://localhost:5173` for `npm run dev:dashboard`, or `https://nomus.example.com`). It is a single value, not a list. If the dashboard and API share an origin through the proxy, CORS is not involved.

---

## Login and API keys

### Cannot log in to the dashboard

The first admin account is created automatically at startup from `NOMUS_ADMIN_EMAIL` and `NOMUS_ADMIN_PASSWORD` (see `engine/src/db/seed.ts`). Log in with those values. The same first start also creates an API key from `NOMUS_ADMIN_BOOTSTRAP_KEY` (all scopes), usable as `Authorization: Bearer <value>` for scripts and the scanner. If you change these variables after the database already exists, the original account and key are unchanged.

Other things to check:

- The session cookie is named `nomus_session` (browser dev tools, Application, Cookies). If it is missing after a successful login, see the `Secure` cookie note under Docker Compose above.
- Login is rate limited per client; repeated failures return HTTP 429. Wait a minute and retry.
- An account flagged `mustChangePassword` is redirected to the change-password page before anything else works.
- `POST /api/v1/auth/forgot-password` sends mail through Resend when `NOMUS_RESEND_API_KEY` is set (sender: `NOMUS_FROM_EMAIL`); otherwise no email is sent and the reset link is not recorded anywhere, so an admin has to reset the password (`POST /api/v1/users/:id/reset-password`).

### Google or GitHub sign-in fails

Both are optional and enabled by setting their variables.

| Provider | Variables | Redirect (callback) URL to register with the provider |
|----------|-----------|--------------------------------------------------------|
| Google | `NOMUS_GOOGLE_CLIENT_ID`, `NOMUS_GOOGLE_CLIENT_SECRET` | `<NOMUS_CORS_ORIGIN>/api/v1/auth/oauth/google/callback` |
| GitHub | `NOMUS_GITHUB_CLIENT_ID`, `NOMUS_GITHUB_CLIENT_SECRET` | `<NOMUS_CORS_ORIGIN>/api/v1/auth/github/callback` |

The engine builds the redirect URL from `NOMUS_CORS_ORIGIN` (not from the request host or the engine port), so register exactly that origin plus the path above. A `redirect_uri_mismatch` (Google) or `redirect_uri` error (GitHub) means the registered URL differs from the one the engine sends. For `npm run dev:dashboard` with the default `NOMUS_CORS_ORIGIN=http://localhost:5173`, the URLs are `http://localhost:5173/api/v1/auth/...` (the Vite dev server proxies `/api` to the engine); under Docker Compose with `NOMUS_CORS_ORIGIN=http://localhost:8080` they start with `http://localhost:8080`.

The dashboard login page offers Google sign-in only. GitHub sign-in is reachable at `/api/v1/auth/github` but does not create accounts: the GitHub account's email must match an existing user, otherwise you are sent to `/login?error=no_account`.

### API key returns 401 or 403

Error bodies from the key middleware (`engine/src/server/middleware/auth.ts`):

| Status | Message | Meaning |
|--------|---------|---------|
| 401 | `Missing or invalid Authorization header` | Send `Authorization: Bearer nk_live_...` (the key the engine issued). |
| 401 | `Invalid or expired API key` | Key is unknown, revoked or expired. Create a new one. |
| 403 | `Insufficient permissions. Required: ...` | The key lacks a required scope. |
| 429 | `Rate limit exceeded. N requests per minute allowed.` | Raise `NOMUS_RATE_LIMIT_RPM` (default 600). |

Per-organization caps are `NOMUS_MAX_API_KEYS_PER_ORG` (default 100) and `NOMUS_MAX_SSE_CONNECTIONS_PER_ORG` (default 100). See the [auth reference](../api-reference/auth.md) for authentication details.

---

## Scanner, GitHub Action and editor extension

All three call the engine's `POST /api/v1/simulate` endpoint with an API key, and all three **fail closed**: if the engine cannot be reached or returns an unusable response, the result is "status unknown", never a silent pass.

### Scanner CLI

Build once, then run from a checkout (the packages are not published to npm):

```bash
npm run build:packages
node packages/scanner/dist/index.js ./my-project --fail-on=high
```

| Symptom | Cause and fix |
|---------|---------------|
| `No .nomus.yml found. Create one in your repository root.` | The scanner requires a `.nomus.yml` (also accepts `.nomus.yaml` or `.nomus.json`) in the scanned directory, with at least one entry under `jurisdictions`. See `packages/scanner/README.md`. |
| `No Nomus API key configured. Set NOMUS_API_KEY or provide api_key in .nomus.yml` | Export `NOMUS_API_KEY`, or set `api_key` in the config. |
| `Nomus API unreachable ... failing closed.` and exit code 3 | The engine at `api_url` (default `http://localhost:3100`) is down, the key is rejected, or the response was malformed. Check `curl <api_url>/health`. |
| `Nomus API unreachable` caused by a 401/403 | The key is wrong or lacks scopes (see the table above). |
| 0 findings | Either no AI SDK imports were found in supported files (`.ts .tsx .js .jsx .mjs .py .java .go`, minus the `ignore` globs), or none of the detected capabilities map to an active rule for your jurisdictions. 0 findings is not a compliance clearance. |
| Exit code 1 | Findings at or above `--fail-on` (default `critical`). Exit code 2 is an unexpected error such as an invalid config. |
| Out of memory on a very large repo | Run with `NODE_OPTIONS=--max-old-space-size=4096`, or add `ignore` globs in `.nomus.yml`, or scan subdirectories separately. |

### GitHub Action

- `api-url` defaults to `http://localhost:3100`, which a GitHub-hosted runner cannot reach. Set it to an engine URL the runner can access.
- PR comments need `pull-requests: write`, Check Runs need `checks: write`, SARIF upload needs `security-events: write`. Without `github-token` (or `GITHUB_TOKEN`) the action warns and skips PR comments, SARIF and the Check Run.
- A `.nomus.yml` must exist in `working-directory`.
- Uploading findings and fetching the score are best effort: failures there produce warnings, not a failed run.

### VS Code extension

- Set `nomus.apiUrl` (default `http://localhost:3100`), then use **Nomus: Sign In** or set `nomus.apiKey`.
- With no key, the extension runs in an offline mode that lists detected AI SDK imports as informational diagnostics only.

---

## LLM providers

Rule generation and the Scout feature call LLM providers. Configure at least one of `NOMUS_ANTHROPIC_API_KEY`, `NOMUS_GOOGLE_AI_KEY`, `NOMUS_OPENAI_API_KEY`.

- **Choosing providers and models**: `NOMUS_LLM_CLASSIFIER_PROVIDER` / `NOMUS_LLM_CLASSIFIER_MODEL`, `NOMUS_LLM_TRANSLATOR_PROVIDER` / `NOMUS_LLM_TRANSLATOR_MODEL`, and `NOMUS_LLM_FALLBACK_PROVIDER` (`anthropic`, `google`, `openai` or `none`, default `none`). The provider named must have its key set.
- **401 / invalid key / 404 model not found from the provider**: verify the key with the provider's own console or API, and confirm the model name in `*_MODEL` is available to your account.
- **429 from the provider**: you hit the provider's quota. Lower `NOMUS_SCOUT_LLM_BATCH_SIZE` (1 to 20, default 10), or set `NOMUS_LLM_FALLBACK_PROVIDER` to a second configured provider.
- **Scout is noisy or failing on the Congress.gov API**: `NOMUS_CONGRESS_GOV_API_KEY` defaults to the shared `DEMO_KEY`, which is heavily rate limited. Get a free key at https://api.congress.gov/sign-up/, or set `NOMUS_SCOUT_ENABLED=false`.

---

## Database

The engine uses SQLite through better-sqlite3 and Drizzle. It opens the database in WAL mode with a 5 second busy timeout, and sets up the schema automatically at startup.

- **`SQLITE_BUSY` / "database is locked"**: only one engine process should write to the file. Do not run two engines (or PM2 cluster mode) against the same `NOMUS_DB_PATH`, and do not open the file in another tool with an open write transaction.
- **`database disk image is malformed`**: stop the engine, run `sqlite3 data/nomus.db "PRAGMA integrity_check;"`, and restore from a backup. With WAL mode, copy the `-wal` and `-shm` files along with the main file when backing up, or use `sqlite3 data/nomus.db ".backup backup.db"`.
- **Schema errors at startup**: the engine creates tables (`CREATE TABLE IF NOT EXISTS`) and adds new columns (`ALTER TABLE ... ADD COLUMN`) itself on every start, in `engine/src/db/migrate.ts`; there are no migration files and no separate migration step. For a throwaway development database you can delete `data/nomus.db` and restart to rebuild it.
- **Raw snapshots keep growing**: by design, raw regulation snapshots are kept forever unless `NOMUS_RAW_SNAPSHOT_RETENTION_DAYS` is set. The newest snapshot per source is always kept.

---

## Webhooks and GitHub App

- **GitHub webhook (`POST /api/v1/github/webhook`)**: the webhook secret configured on the GitHub App must equal `NOMUS_GITHUB_WEBHOOK_SECRET`; requests with a bad signature are rejected. Also set `NOMUS_GITHUB_APP_ID` and `NOMUS_GITHUB_APP_PRIVATE_KEY` (the PEM, base64-encoded: `base64 -w0 key.pem`). GitHub must be able to reach your engine over the public internet, so a purely local engine cannot receive it.
- **GitHub App scans stop working after revoking the bootstrap key**: the webhook scanner calls the engine's own API with `NOMUS_ADMIN_BOOTSTRAP_KEY`, so that key must stay active and match the variable. It scans pull requests against the fixed jurisdictions EU, US-FED and UK.
- **Background tasks calling the engine's own API**: set `NOMUS_INTERNAL_API_URL` when the engine sits behind a proxy or in a multi-container setup; by default it uses loopback on `NOMUS_PORT`.
- **Outbound webhooks**: each delivery carries `X-Nomus-Signature-V2` (`sha256=` plus an HMAC-SHA256 over `<timestamp>.<body>`, with `X-Nomus-Timestamp`). While `NOMUS_WEBHOOK_LEGACY_SIGNATURE=true` (default) the older body-only `X-Nomus-Signature` is sent too. Verify V2 in your receiver, then set the variable to `false`.

---

## Reporting a problem

Open an issue at https://github.com/babbguy/Nomus/issues and include:

- What you did, what you expected, and what happened instead
- Nomus version (`version` in the `/health` response), Node.js version, OS, and how you run it (Docker Compose, PM2, from source)
- The relevant log lines (`docker compose logs engine` or `pm2 logs nomus-engine`)
- Your configuration with every secret removed (`API_KEY`, `SECRET`, `PASSWORD`, `PRIVATE_KEY`, `TOKEN`)

Do not post secrets or API keys. For security vulnerabilities, follow `SECURITY.md` in the repository root instead of opening a public issue.

---

Nomus output is regulatory applicability information. It is not legal advice or a compliance certification.

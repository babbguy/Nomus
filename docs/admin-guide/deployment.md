# Nomus Deployment Guide

How to run Nomus on your own machine or server. Nomus is self-hosted open-source software.

> Nomus is a regulatory applicability tool, not a compliance certification. Its output is not legal advice.

---

## Contents

1. [Requirements](#requirements)
2. [Docker Compose](#docker-compose)
3. [Optional TLS front proxy](#optional-tls-front-proxy)
4. [Bare metal (PM2 + Nginx)](#bare-metal-pm2--nginx)
5. [From source (development)](#from-source-development)
6. [Environment variables](#environment-variables)
7. [Database](#database)
8. [Security hardening](#security-hardening)
9. [Deployment checklist](#deployment-checklist)
10. [Troubleshooting](#troubleshooting)

---

## Requirements

- Linux, macOS or Windows host. The bare-metal example script targets Ubuntu 22.04 or newer.
- Docker with Compose v2 for container installs, or Node.js 20.19+ (or 22.12+) for source and bare-metal installs.
- A few GB of RAM and disk are enough for evaluation; size disk for your raw snapshots (kept forever unless you set a retention period).
- Outbound HTTPS to the regulation sources you enable and to your LLM provider.
- An LLM API key. Anthropic is the default provider; Google and OpenAI are supported (see [Environment variables](#environment-variables)).
- SQLite is embedded. No database server is needed.

---

## Docker Compose

The repository ships `docker-compose.yml`, `Dockerfile` (engine) and `Dockerfile.dashboard` (Nginx serving the React build).

```bash
git clone https://github.com/babbguy/Nomus.git
cd Nomus
cp engine/.env.example engine/.env
```

Edit `engine/.env` and replace every `REPLACE_ME` value:

- `NOMUS_SIGNING_KEY_SECRET` (32+ characters)
- `NOMUS_ADMIN_BOOTSTRAP_KEY` (10+ characters)
- `NOMUS_ADMIN_EMAIL` and `NOMUS_ADMIN_PASSWORD` (12+ characters)
- `NOMUS_ANTHROPIC_API_KEY` (or configure another provider)
- `NOMUS_CORS_ORIGIN=http://localhost:8080` (the example file points at the Vite dev server, `http://localhost:5173`)

The engine container runs with `NODE_ENV=production`, so it refuses to start if the required secrets are missing or too short. Generate secrets with:

```bash
openssl rand -hex 32   # NOMUS_SIGNING_KEY_SECRET
openssl rand -hex 16   # NOMUS_ADMIN_BOOTSTRAP_KEY
openssl rand -base64 18 # NOMUS_ADMIN_PASSWORD
```

Start the stack:

```bash
docker compose up --build
```

| Service | Container | Host port | Notes |
|---------|-----------|-----------|-------|
| Dashboard | `nomus-dashboard` | 8080 | Nginx; proxies `/api`, `/.well-known` and the SSE stream to the engine |
| Engine | `nomus-engine` | 3100 | `GET /health`; data in the `nomus-data` volume (`/app/data/nomus.db`) |

Open http://localhost:8080 and sign in with `NOMUS_ADMIN_EMAIL` / `NOMUS_ADMIN_PASSWORD`. Verify the engine:

```bash
curl http://localhost:3100/health
docker compose ps
docker compose logs -f engine
```

The engine service has a health check; the dashboard starts after it reports healthy. Add `-d` to `docker compose up` to run in the background.

The SQLite database lives in the named volume `nomus-data`. `docker compose down` keeps it; `docker compose down -v` deletes it.

---

## Optional TLS front proxy

Compose profile `tls` adds an Nginx proxy (`nomus-proxy`, ports 80 and 443) and a Certbot container that renews certificates. You need a domain whose DNS A record points at the host and ports 80 and 443 open. The Nginx config is rendered from `infra/nginx-tls.conf.template` using the `DOMAIN` variable.

```bash
export DOMAIN=nomus.example.com

# 1. Get the first certificate (standalone mode needs port 80 free)
docker compose --profile tls run --rm -p 80:80 --entrypoint certbot certbot \
  certonly --standalone -d "$DOMAIN" --email you@example.com --agree-tos

# 2. Start everything with the proxy
docker compose --profile tls up -d --build
```

Set `NOMUS_CORS_ORIGIN=https://nomus.example.com` in `engine/.env` before step 2. Certificates are stored under `infra/certbot/`, which is created on the host by the first command. Keep the `DOMAIN` variable exported (or in a `.env` file next to `docker-compose.yml`) for later `docker compose --profile tls` commands.

The `dashboard` service still publishes port 8080 and `engine` publishes 3100. On an internet-facing host, block those with a firewall so traffic goes through the proxy.

---

## Bare metal (PM2 + Nginx)

This path runs the engine under PM2 with Nginx serving the built dashboard. `infra/setup-vps.sh` automates it and is an example: read it before running, because it installs packages, enables the firewall and writes to `/etc/nginx`.

```bash
DOMAIN=nomus.example.com ADMIN_EMAIL=you@example.com bash infra/setup-vps.sh
```

Run it as root on a fresh Ubuntu 22.04+ host whose DNS record for `DOMAIN` already points at it. `DOMAIN` and `ADMIN_EMAIL` are required. `ADMIN_EMAIL` must be a mailbox you control. The script:

1. Installs Nginx, Certbot, UFW, sqlite3, Node.js 20 (NodeSource) and PM2
2. Configures UFW (allow SSH and Nginx; deny other inbound)
3. Clones the repository to `/opt/nomus` (override with `INSTALL_DIR`, `REPO_URL`) and builds packages, engine and dashboard
4. Creates `data/`, `logs/` and `backups/`
5. Generates secrets and writes `/opt/nomus/.env` (mode 600), printing the admin credentials once; save them
6. Installs `infra/nginx.conf` for your domain and requests a Let's Encrypt certificate
7. Starts the engine with `infra/ecosystem.cjs` under PM2
8. Writes `/opt/nomus/deploy.sh` (pull, build, restart) and a daily `sqlite3 .backup` cron job that keeps 30 days

Afterwards, add your LLM API key to `/opt/nomus/.env` and restart:

```bash
sudo nano /opt/nomus/.env      # set NOMUS_ANTHROPIC_API_KEY
pm2 restart nomus-engine
curl https://nomus.example.com/health
```

### Manual steps

If you prefer to do it by hand:

```bash
# Prerequisites: Node.js 20.19+ (or 22.12+), git, build tools, nginx, certbot, sqlite3, pm2
git clone https://github.com/babbguy/Nomus.git /opt/nomus
cd /opt/nomus
npm ci
npm run build:all
mkdir -p data logs backups
chmod 700 data backups
cp engine/.env.example .env     # then edit; see Environment variables
chmod 600 .env
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup                      # run the command it prints
```

Notes on the two PM2 configs:

- `ecosystem.config.cjs` (repository root) uses paths relative to the repository and a single fork-mode instance. Secrets are not in the file; the engine reads `.env` from its working directory (the repository root here).
- `infra/ecosystem.cjs` hard-codes `/opt/nomus` and is what `setup-vps.sh` uses.
- Keep `instances: 1`. SQLite allows a single writer; do not use PM2 cluster mode.

### Nginx

`infra/nginx.conf` is an example for a single hostname. Replace `nomus.example.com` (the setup script does this with `sed`), then install and test:

```bash
sudo cp infra/nginx.conf /etc/nginx/sites-available/nomus.conf
sudo sed -i 's/nomus\.example\.com/your.domain/g' /etc/nginx/sites-available/nomus.conf
sudo ln -s /etc/nginx/sites-available/nomus.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

What it does:

- Redirects HTTP to HTTPS and serves the ACME challenge path
- Proxies `/api/` and `/.well-known/` to the engine on `127.0.0.1:3100`, with a stricter rate-limit zone for `/api/v1/auth/`
- Proxies `/api/v1/stream` with buffering disabled and a 24-hour read timeout (server-sent events)
- Serves the dashboard from `/opt/nomus/dashboard/dist` with a single-page-app fallback
- Sets HSTS and other security headers, TLS 1.2/1.3 only

It requires certificates at `/etc/letsencrypt/live/<domain>/`. Obtain them with Certbot before enabling the HTTPS server block (the setup script uses a temporary HTTP-only config for this). Renewal is handled by the `certbot.timer` systemd unit; test it with `sudo certbot renew --dry-run`.

The Nginx rate-limit zones are independent of the engine's own limit (`NOMUS_RATE_LIMIT_RPM`).

---

## From source (development)

```bash
npm install
npm run build:all
cp engine/.env.example engine/.env
npm run dev:engine       # API on http://localhost:3100
npm run dev:dashboard    # dashboard on http://localhost:5173
```

The engine loads `.env` from its **working directory**. The npm workspace scripts start it from `engine/`, so `engine/.env` is the file it reads. If you start it from somewhere else, put `.env` there or export the variables.

Checks: `npm run test:engine`, `npm run test:extensions`, `npm run lint`.

---

## Environment variables

`engine/.env.example` is the annotated reference and `engine/src/config/env.ts` is the source of truth; values are validated at startup and the engine exits with an error on invalid configuration. In production (`NOMUS_ENV=production` or `NODE_ENV=production`) it also exits if a required secret is missing.

### Core

| Variable | Default | Notes |
|----------|---------|-------|
| `NOMUS_ENV` | `development` | `development`, `staging` or `production` |
| `NOMUS_PORT` | `3100` | API port |
| `NOMUS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `NOMUS_LOG_FORMAT` | `text` | `text` or `json` (use `json` in production) |
| `NOMUS_DB_PATH` | `./data/nomus.db` | SQLite file; relative to the working directory |
| `NOMUS_CORS_ORIGIN` | empty | Required in production; also the base of the password-reset links and the Google and GitHub OAuth redirect URLs. Your dashboard origin, for example `https://nomus.example.com`. Defaults to `http://localhost:5173` in development |

### Required secrets (production)

| Variable | Requirement |
|----------|-------------|
| `NOMUS_SIGNING_KEY_SECRET` | 32+ characters; protects the signing keys used for attestations |
| `NOMUS_ADMIN_BOOTSTRAP_KEY` | 10+ characters; becomes an admin-scope API key in the seeded `nomus-admin` organization |
| `NOMUS_ADMIN_EMAIL` | A real mailbox you control; the shipped `admin@example.com` is rejected in production |
| `NOMUS_ADMIN_PASSWORD` | 12+ characters; password for the first admin user |

The admin organization, bootstrap key and admin user are created on first start when the `nomus-admin` organization does not exist yet. Changing these variables later does not change existing records.

### LLM providers

| Variable | Default |
|----------|---------|
| `NOMUS_ANTHROPIC_API_KEY` | unset |
| `NOMUS_GOOGLE_AI_KEY` | unset |
| `NOMUS_OPENAI_API_KEY` | unset |
| `NOMUS_LLM_CLASSIFIER_PROVIDER` | `anthropic` (`anthropic`, `google`, `openai`) |
| `NOMUS_LLM_CLASSIFIER_MODEL` | `claude-haiku-4-5-20251001` |
| `NOMUS_LLM_TRANSLATOR_PROVIDER` | `anthropic` |
| `NOMUS_LLM_TRANSLATOR_MODEL` | `claude-haiku-4-5-20251001` |
| `NOMUS_LLM_FALLBACK_PROVIDER` | `none` (`anthropic`, `google`, `openai`, `none`) |

### Request limits

| Variable | Default | Meaning |
|----------|---------|---------|
| `NOMUS_RATE_LIMIT_RPM` | `600` | Requests per minute per organization; also the limit stamped onto newly created API keys (existing keys keep the value they were created with) |
| `NOMUS_MAX_API_KEYS_PER_ORG` | `100` | Maximum API keys per organization |
| `NOMUS_MAX_SSE_CONNECTIONS_PER_ORG` | `100` | Maximum concurrent SSE connections per organization |

### Scheduling, pipeline and Scout

| Variable | Default | Notes |
|----------|---------|-------|
| `NOMUS_SCRAPE_CRON` | `0 2 * * *` | Regulation scrape schedule |
| `NOMUS_RAW_SNAPSHOT_RETENTION_DAYS` | unset | Unset keeps raw snapshots forever. If set, older snapshots are purged weekly (each source keeps its latest) |
| `NOMUS_REQUIRE_RULE_APPROVAL` | `false` | Require manual approval of generated rules |
| `NOMUS_SCOUT_ENABLED` | `true` | Legislative tracking |
| `NOMUS_SCOUT_CRON` | `0 */6 * * *` | |
| `NOMUS_CONGRESS_GOV_API_KEY` | `DEMO_KEY` | Free key from https://api.congress.gov/sign-up/; `DEMO_KEY` is heavily rate-limited |
| `NOMUS_SCOUT_KEYWORD_THRESHOLD` | `0.15` | 0 to 1 |
| `NOMUS_SCOUT_AUTO_PROMOTE_THRESHOLD` | `0.85` | 0 to 1 |
| `NOMUS_SCOUT_LLM_BATCH_SIZE` | `10` | 1 to 20 |
| `NOMUS_HEADLESS_ENABLED` | `false` | Headless Chromium capture for sources that block bots or need JavaScript. Requires `npx playwright install chromium` (about 150 MB) on the host |
| `NOMUS_HEADLESS_PROXY` | unset | Optional proxy for the headless browser |

### Optional integrations

| Variable(s) | Purpose |
|-------------|---------|
| `NOMUS_GOOGLE_CLIENT_ID`, `NOMUS_GOOGLE_CLIENT_SECRET` | Google sign-in |
| `NOMUS_GITHUB_APP_ID`, `NOMUS_GITHUB_APP_PRIVATE_KEY`, `NOMUS_GITHUB_WEBHOOK_SECRET`, `NOMUS_GITHUB_CLIENT_ID`, `NOMUS_GITHUB_CLIENT_SECRET` | GitHub App and GitHub sign-in |
| `NOMUS_RESEND_API_KEY`, `NOMUS_FROM_EMAIL`, `NOMUS_NOTIFICATION_EMAIL` | Email (Resend) |
| `NOMUS_NTFY_URL`, `NOMUS_NTFY_TOPIC`, `NOMUS_NTFY_TOKEN` | ntfy push notifications |
| `NOMUS_SLACK_WEBHOOK_URL` | Slack notifications |
| `NOMUS_MODUS_API_URL`, `NOMUS_MODUS_API_KEY` | Modus integration |
| `NOMUS_WEBHOOK_LEGACY_SIGNATURE` | Default `true`: outbound webhooks carry both `X-Nomus-Signature` and the timestamp-bound `X-Nomus-Signature-V2`. Set `false` once consumers verify V2 |
| `NOMUS_SENTRY_DSN`, `NOMUS_SENTRY_TRACES_SAMPLE_RATE` | Error tracking. Unset (default) means nothing is sent |
| `NOMUS_INTERNAL_API_URL` | Base URL the GitHub integration uses to call the engine itself; defaults to `http://127.0.0.1:<NOMUS_PORT>` |
| `NOMUS_POLYGON_RPC_URL`, `NOMUS_POLYGON_PRIVATE_KEY`, `NOMUS_POLYGON_CONTRACT` | Optional on-chain anchoring of the rule-corpus state hash (see `packages/chain`). Read directly from the environment, not validated by the engine's config schema. All three must be set; a daily job at 06:00 (server local time) anchors the hash |

---

## Database

Nomus stores everything in one SQLite file at `NOMUS_DB_PATH` (opened in WAL mode). The schema is created and extended automatically each time the engine starts (`engine/src/db/migrate.ts`: `CREATE TABLE IF NOT EXISTS` plus additive `ALTER TABLE ... ADD COLUMN`); there are no migration files to run.

- One engine process per database. Background pipeline runs are serialized.
- Back up with `sqlite3 <db> ".backup <file>"` (see [Operations](./operations.md#backup-and-restore)). Copying only `nomus.db` while the engine runs can miss data in the `-wal` file.
- There is no external database option.

---

## Security hardening

- Use TLS for anything reachable from the internet, and keep `NOMUS_CORS_ORIGIN` set to your real origin.
- Keep `.env` out of version control and readable only by the service user: `chmod 600 .env`.
- Restrict the data directory: `chmod 700 data`.
- Run the engine as a non-root user where practical (the Docker image already runs as `node`).
- Firewall: allow SSH, 80 and 443; do not expose 3100 or 8080 directly when a proxy is in front.
- SSH: prefer key authentication and disable root login (`PasswordAuthentication no`, `PermitRootLogin no` in `/etc/ssh/sshd_config`) once you have key access working.
- Keep the OS and Docker images updated.
- Change the generated admin password after first login, and revoke or rotate the bootstrap API key if you do not need it (`DELETE /api/v1/tenants/:id/api-keys/:keyId`), but note that the GitHub App webhook scanner authenticates to the engine with `NOMUS_ADMIN_BOOTSTRAP_KEY`, so do not revoke that key (or change the variable) while you use the GitHub App.

---

## Deployment checklist

- [ ] `NOMUS_ENV=production`, all required secrets set to non-placeholder values
- [ ] `NOMUS_CORS_ORIGIN` matches the URL users open
- [ ] LLM provider key configured
- [ ] TLS in place for non-local use; certificate renewal verified
- [ ] `GET /health` returns 200 and `GET /ready` returns 200
- [ ] Dashboard loads and the admin login works
- [ ] Backup job configured and a restore tested
- [ ] Firewall rules applied
- [ ] Log rotation configured

---

## Troubleshooting

Engine exits immediately: read the first lines of the log. Startup validation prints exactly which variable is missing or invalid.

```bash
docker compose logs --tail 100 engine   # Docker
pm2 logs nomus-engine --lines 100       # PM2
```

Common causes: a required secret is missing or too short; `NOMUS_CORS_ORIGIN` is empty in production; `NOMUS_ADMIN_EMAIL` is still `admin@example.com`; port 3100 is already in use; the database is locked by a second engine process.

Dashboard cannot reach the API: check `NOMUS_CORS_ORIGIN` against the URL in your browser, and that the proxy forwards `/api/`.

Certificate errors: check that `/etc/letsencrypt/live/<domain>/` exists (or `infra/certbot/conf/live/<domain>/` for the Compose profile), run `sudo nginx -t`, and try `sudo certbot renew --dry-run`.

More: [Troubleshooting Guide](../troubleshooting/README.md).

---

## Related

- [Operations Guide](./operations.md)
- [Getting Started](../user-guide/getting-started.md)
- [Health endpoints](../api-reference/health.md)

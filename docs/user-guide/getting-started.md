# Getting Started with Nomus

Nomus is an open-source (Apache-2.0) AI regulatory applicability engine. It monitors regulatory
sources, stores them as signed rules, and tells you which obligations may apply to your AI systems
and code. It is a Hono engine, a React dashboard, and a SQLite database. You run it yourself.

Nomus output is regulatory applicability information. It is not legal advice and not a compliance
certification; have qualified counsel review anything you rely on.

---

## Contents

1. [Prerequisites](#prerequisites)
2. [Quickstart with Docker](#quickstart-with-docker)
3. [Running from source](#running-from-source)
4. [Configuration](#configuration)
5. [First login](#first-login)
6. [Dashboard tour](#dashboard-tour)
7. [Running your first scan](#running-your-first-scan)
8. [Quick reference](#quick-reference)
9. [Next steps](#next-steps)

---

## Prerequisites

- **Docker with Compose** for the Docker route, or **Node.js 20.19+ (or 22.12+)** and npm for running from source.
- **An LLM API key** (optional but needed for the pipeline's LLM steps): Anthropic by default;
  Google or OpenAI can be configured instead. Without one, the engine starts and serves the seeded
  rules, but LLM-assisted classification and translation of newly scraped regulations will not work.
- **A Resend API key** (optional) if you want password-reset and alert emails.
- No separate database server: Nomus uses an embedded SQLite file (`better-sqlite3`).

---

## Quickstart with Docker

```bash
git clone https://github.com/babbguy/Nomus.git
cd Nomus
cp engine/.env.example engine/.env      # then edit the secrets in it
docker compose up --build
```

Edit `engine/.env` before the first start. At minimum set:

```env
NOMUS_SIGNING_KEY_SECRET=<random string, 32+ characters>
NOMUS_ADMIN_BOOTSTRAP_KEY=<random string, 10+ characters>
NOMUS_ADMIN_EMAIL=you@example.com
NOMUS_ADMIN_PASSWORD=<12+ characters>
NOMUS_ANTHROPIC_API_KEY=<your key, optional>
NOMUS_CORS_ORIGIN=http://localhost:8080
```

Then open:

- Dashboard: http://localhost:8080
- Engine API: http://localhost:3100 (check with `curl http://localhost:3100/health`)

Compose starts two services, `engine` (port 3100, data in the `nomus-data` volume) and `dashboard`
(nginx serving the built UI on port 8080 and proxying `/api/` to the engine). A third `nginx` TLS
proxy exists behind the `tls` profile; see the
[deployment guide](../admin-guide/deployment.md).

---

## Running from source

```bash
git clone https://github.com/babbguy/Nomus.git
cd Nomus
npm install
npm run build:packages        # builds shared, scanner, chain and mcp-server (build:all also builds engine and dashboard)
cp engine/.env.example engine/.env   # then edit the secrets in it
```

Start both servers in separate terminals:

```bash
npm run dev:engine           # http://localhost:3100
npm run dev:dashboard        # http://localhost:5173 (Vite; proxies /api to the engine)
```

The engine reads `.env` from its working directory, which for `npm run dev:engine` is `engine/`.
Database tables are created automatically at startup; there is no separate migration step. The
default database path is `./data/nomus.db` relative to `engine/`.

For a production-style install on a server (PM2, nginx, Let's Encrypt), see the
[deployment guide](../admin-guide/deployment.md).

---

## Configuration

Configuration is environment variables, validated at startup (`engine/src/config/env.ts`).
`engine/.env.example` lists everything with comments.

### Secrets and admin account

| Variable | Notes |
|----------|-------|
| `NOMUS_SIGNING_KEY_SECRET` | Protects the Ed25519 rule-signing keys. 32+ characters. |
| `NOMUS_ADMIN_BOOTSTRAP_KEY` | Becomes an `admin`-scoped API key on first boot. 10+ characters. |
| `NOMUS_ADMIN_EMAIL` | Login of the first admin. Production refuses `admin@example.com`. |
| `NOMUS_ADMIN_PASSWORD` | Password of the first admin. 12+ characters. |

With `NOMUS_ENV=production` the engine refuses to start if these are missing or too short. In
`development` (the default) it only prints warnings and carries on with the missing or short
values, so do not expose a development instance to a network. Note that the Docker image sets
`NODE_ENV=production`, which also enables these checks; the placeholders in `engine/.env.example`
satisfy them, but replace them anyway.

### Common settings

| Variable | Default | Notes |
|----------|---------|-------|
| `NOMUS_ENV` | `development` | `development`, `staging` or `production` |
| `NOMUS_PORT` | `3100` | Engine port |
| `NOMUS_DB_PATH` | `./data/nomus.db` | SQLite file |
| `NOMUS_CORS_ORIGIN` | `http://localhost:5173` | Dashboard origin; also used to build password-reset links |
| `NOMUS_LOG_LEVEL` / `NOMUS_LOG_FORMAT` | `info` / `text` | `json` format for production |
| `NOMUS_RATE_LIMIT_RPM` | `600` | Requests per minute per organization |
| `NOMUS_MAX_API_KEYS_PER_ORG` | `100` | |
| `NOMUS_MAX_SSE_CONNECTIONS_PER_ORG` | `100` | |
| `NOMUS_RESEND_API_KEY`, `NOMUS_FROM_EMAIL` | unset | Enables email delivery |

### LLM providers

```env
NOMUS_ANTHROPIC_API_KEY=...
NOMUS_LLM_CLASSIFIER_PROVIDER=anthropic     # anthropic | google | openai
NOMUS_LLM_CLASSIFIER_MODEL=claude-haiku-4-5-20251001
NOMUS_LLM_TRANSLATOR_PROVIDER=anthropic
NOMUS_LLM_TRANSLATOR_MODEL=claude-haiku-4-5-20251001
# NOMUS_GOOGLE_AI_KEY=...   NOMUS_OPENAI_API_KEY=...   NOMUS_LLM_FALLBACK_PROVIDER=none
```

### Schedules

```env
NOMUS_SCRAPE_CRON=0 2 * * *        # regulatory source scraping, daily 02:00
NOMUS_SCOUT_ENABLED=true           # legislative tracking (Scout)
NOMUS_SCOUT_CRON=0 */6 * * *
NOMUS_CONGRESS_GOV_API_KEY=...     # get a real key at api.congress.gov; DEMO_KEY is heavily rate limited
```

Everything else (OAuth, GitHub App, Slack/ntfy notifications, Sentry, headless fetch, Modus) is
optional and documented in `engine/.env.example`.

---

## First login

On first boot the engine creates an admin organization (`nomus-admin`), an admin user from
`NOMUS_ADMIN_EMAIL` / `NOMUS_ADMIN_PASSWORD`, and an API key from `NOMUS_ADMIN_BOOTSTRAP_KEY`. It
also seeds the regulatory sources and rule sets.

1. Open the dashboard (http://localhost:8080 with Docker, http://localhost:5173 from source).
2. Sign in with the admin email and password. Admins land on Admin, Dashboard.
3. Optional: confirm the LLM provider works under Admin, LLM Providers, or with the API:

   ```bash
   curl -X POST http://localhost:3100/api/v1/settings/llm/test \
     -H "Authorization: Bearer $NOMUS_ADMIN_BOOTSTRAP_KEY" \
     -H "Content-Type: application/json" \
     -d '{"provider":"anthropic","model":"claude-haiku-4-5-20251001"}'
   ```

   A working provider answers `{"ok": true, "response": "OK", ...}`; a failure returns `400` with
   `{"ok": false, "error": "..."}`.

The bootstrap value is a real admin credential. Create a key of your own for day-to-day use and
revoke the bootstrap key (see [API keys](../api-reference/auth.md#api-keys)).

---

## Dashboard tour

The sidebar differs by role.

**Platform admins** (the account created at first boot) see the administration pages: Dashboard,
Users, Tenants (organizations and their API keys), Sources and source audits, Pipeline history,
Integrity checks, Feedback review, Radar, Ontology, Scans, LLM Providers, Notifications, System
status, Scout feeds and review, the Modus integration, and the public Ledger.

**Organization users** see the applicability pages:

- **Compliance:** Policies (the rule set), Attestations, Simulator and Simulations (what applies for a
  given set of capabilities and markets), Radar and Bill Tracker (pending legislation), Graph (the
  regulatory knowledge graph), AI-BOM, Posture, Templates.
- **Scanner:** Scans (findings uploaded by scanners, by repository), Clause Map, Benchmarks.
- **Account:** Feedback, Audit Log export, Badge, Team, Profile, Settings (organization details, API
  keys, diagnostics), and the public Ledger. Team is a read-only list of your organization's
  users; platform administrators add and change users under Admin, Users.

Public pages that need no login: `/ledger`, `/transparency` and `/verify/:verifyId`.

---

## Running your first scan

Scans are performed by the scanner, which reads your code locally and asks the engine which rules
apply to the AI capabilities it finds. Only capability signals are sent to the engine, not source
code.

### 1. Create an API key

You create your own keys; no administrator is needed. Sign in, open **Settings, API Keys**, enter a
label, choose the scopes (`evaluate`, plus `read:policies` if you also want to read rules; `stream`
only for live change events) and press Generate. The key is shown once with a Copy button, so store
it (a repository secret, a password manager) before leaving the page. Revoke it from the same list at
any time. Members can grant `read:policies`, `evaluate` and `stream`; the `admin` scope is only for
platform administrators, who can also manage any organization's keys under Admin, Tenants.

The same operations are available over the API as
[`/api/v1/org/api-keys`](../api-reference/org.md#api-keys) (signed-in session) and, for
administrators, [`/api/v1/tenants/:orgId/api-keys`](../api-reference/auth.md#api-keys).

### 2. Add a config file to the project you want to scan

`.nomus.yml` in the root of that project:

```yaml
nomus:
  api_url: http://localhost:3100
  jurisdictions: [EU, US-FED]
```

### 3. Run the CLI

The scanner is a private workspace package (not on npm). From your Nomus checkout, after
`npm run build:packages`:

```bash
export NOMUS_API_KEY=nk_live_...
node packages/scanner/dist/index.js /path/to/your/project
node packages/scanner/dist/index.js /path/to/your/project --json
node packages/scanner/dist/index.js /path/to/your/project --sarif --fail-on=high
```

Exit code `0` means the findings are below the `--fail-on` threshold (default `critical`), `1` means
at or above, `2` is an error and `3` means the engine was unreachable (the scanner never reports a
clean result when it could not reach the engine). Details: [scan reference](../api-reference/scan.md).

### 4. Other ways to check applicability

- Ask the engine directly: `POST /api/v1/simulate` with `capabilities`, `targetMarkets`,
  optional `dataTypes`, `modelType` and `sector`, or use the Simulator page.
- In CI, use the GitHub Action at `packages/github-action` (inputs and example in the
  [scan reference](../api-reference/scan.md#github-action)); it also uploads findings so they show
  on the Scans page.
- In your editor, use the [MCP server](./mcp-server.md).

---

## Quick reference

```bash
# Docker
docker compose up --build         # build and start (add -d to detach)
docker compose logs -f engine     # engine logs
docker compose down               # stop (data volume is kept)

# PM2 (bare-metal installs; app name from ecosystem.config.cjs)
pm2 start ecosystem.config.cjs
pm2 logs nomus-engine
pm2 restart nomus-engine

# Development
npm run dev:engine
npm run dev:dashboard
npm run build:all
npm run test:engine
npm run test:scanner

# Health
curl http://localhost:3100/health
curl http://localhost:3100/ready
```

| Service | Port |
|---------|------|
| Engine API | 3100 |
| Dashboard (Vite dev) | 5173 |
| Dashboard (Docker Compose) | 8080 |
| TLS proxy (optional `tls` profile) | 80 / 443 |

| File | Purpose |
|------|---------|
| `engine/.env` (from `engine/.env.example`) | Engine configuration |
| `docker-compose.yml` | Docker services |
| `ecosystem.config.cjs` | PM2 process config |
| `infra/` | nginx configs and `setup-vps.sh` |

---

## Next steps

- [Documentation index](../README.md)
- [API reference](../api-reference/README.md)
- [Admin guide](../admin-guide/README.md): deployment and operations
- [Troubleshooting](../troubleshooting/README.md)
- [MCP server](./mcp-server.md): use Nomus from Claude Code, VS Code or Cursor

Questions and bug reports: https://github.com/babbguy/Nomus/issues

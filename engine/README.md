# Nomus Engine

The backend API server for Nomus (Hono, SQLite via Drizzle ORM). It handles regulatory monitoring, rule generation, code scan matching, attestations, and all API endpoints.

## Quick Start

```bash
# From the repository root
npm install
npm run build:packages     # build shared packages first
cp engine/.env.example engine/.env    # then edit the secrets
npm run dev:engine         # starts on http://localhost:3100
```

Check it is up:

```bash
curl http://localhost:3100/health     # liveness
curl http://localhost:3100/ready      # database + signing key readiness (503 if not ready)
```

To run the engine and dashboard together in containers instead:

```bash
cp engine/.env.example engine/.env
docker compose up --build             # dashboard http://localhost:8080, engine http://localhost:3100
```

See the [deployment guide](../docs/admin-guide/deployment.md) and the [troubleshooting guide](../docs/troubleshooting/README.md).

## Configuration

Environment variables are validated at startup (`src/config/env.ts`); `.env.example` is the full reference. In development, missing secrets only produce warnings (the engine keeps running with the empty or short values). In production (`NOMUS_ENV=production` or `NODE_ENV=production`) the engine refuses to start unless these are set:

| Variable | Description |
|----------|-------------|
| `NOMUS_SIGNING_KEY_SECRET` | Ed25519 signing key seed (min 32 chars) |
| `NOMUS_ADMIN_BOOTSTRAP_KEY` | Bootstrap admin API key, created on first start with all scopes (min 10 chars) |
| `NOMUS_ADMIN_EMAIL` | Admin account email (not the `admin@example.com` placeholder) |
| `NOMUS_ADMIN_PASSWORD` | Admin account password (min 12 chars) |
| `NOMUS_CORS_ORIGIN` | Exact origin of the dashboard |

**LLM providers.** Configure at least one for rule generation:

| Variable | Provider |
|----------|----------|
| `NOMUS_ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `NOMUS_OPENAI_API_KEY` | OpenAI (GPT) |
| `NOMUS_GOOGLE_AI_KEY` | Google (Gemini) |

**Request limits** (optional): `NOMUS_RATE_LIMIT_RPM` (default 600), `NOMUS_MAX_API_KEYS_PER_ORG` (default 100), `NOMUS_MAX_SSE_CONNECTIONS_PER_ORG` (default 100).

## Build & Test

```bash
npm run build -w engine    # tsc, output in engine/dist
npm run test:engine        # vitest (from the repository root)
npm run test:watch -w engine
npm run start -w engine    # node dist/index.js
```

## Database

SQLite (better-sqlite3) via Drizzle ORM, WAL mode. The database file (`NOMUS_DB_PATH`, default `./data/nomus.db`) is created on startup, and the engine creates missing tables and adds missing columns itself (`src/db/migrate.ts`). Use a single engine process per database file.

```bash
npm run db:generate -w engine    # drizzle-kit: generate SQL files into engine/drizzle (not used at runtime)
npm run db:migrate -w engine     # drizzle-kit: apply those files (the repo ships none; normal runs do not need this)
```

## API

The engine exposes a REST API on `NOMUS_PORT` (default 3100). Main endpoint groups (see `src/server/app.ts` for the full list):

- `/health`, `/ready` -- liveness and readiness
- `/api/v1/auth/*` -- authentication
- `/api/v1/sources/*` -- regulatory source management
- `/api/v1/policies/*` -- compliance rules and policy bundles
- `/api/v1/simulate` -- applicability simulation (used by the scanner, GitHub Action, editor extension and MCP server)
- `/api/v1/scan/*` -- code scan findings
- `/api/v1/scout/*` -- regulatory prediction
- `/api/v1/benchmarks/*` -- AI model benchmarking
- `/api/v1/dashboard/*` -- dashboard data

Reference documentation: [docs/api-reference](../docs/api-reference/README.md).

Nomus output is regulatory applicability information, not legal advice or a compliance certification.

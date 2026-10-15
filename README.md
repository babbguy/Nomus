# Nomus

[![CI](https://github.com/babbguy/Nomus/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/babbguy/Nomus/actions/workflows/ci.yml?query=branch%3Adevelop)
[![Release](https://img.shields.io/github/v/release/babbguy/Nomus)](https://github.com/babbguy/Nomus/releases/latest)
[![npm](https://img.shields.io/npm/v/nomus-scan)](https://www.npmjs.com/package/nomus-scan)
[![License: FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-blue)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/babbguy/Nomus/badge)](https://scorecard.dev/viewer/?uri=github.com/babbguy/Nomus)

**An AI regulatory applicability engine.**

Nomus answers one question: *which AI regulations apply to this system?* It keeps a
structured, source-traceable rule base built from primary legal texts (EU AI Act, GDPR,
NIST AI RMF, HIPAA, state AI laws and more), detects what your code actually does (AI SDK
usage, model capabilities, data handling), and maps those capabilities to the obligations
that may apply, with citations back to the source text.

> Nomus is an applicability tool, not a compliance certification tool. Its output is
> information to help you scope a compliance review. It is not legal advice, and a signed
> attestation from Nomus is evidence of what the tool evaluated, not a statement that a
> system is compliant.

This is a portfolio project, licensed under FSL-1.1-ALv2 from v1.2.0 (see [License](#license)).
It is not offered as a hosted service. Run it yourself with Docker or from source.

## Quick start

Nomus is an engine you run (API and dashboard) and clients that ask it which rules apply to
your code.

**1. Start the engine and dashboard:**

```bash
git clone https://github.com/babbguy/Nomus.git && cd Nomus
cp engine/.env.example engine/.env    # replace the placeholder secrets before real use
docker compose up
```

Open http://localhost:8080, sign in with `NOMUS_ADMIN_EMAIL` and `NOMUS_ADMIN_PASSWORD` from
`engine/.env`, and create an API key under Settings, API Keys.

**2. Scan code** with any client. Each one uses the engine at `http://localhost:3100` by default
and the API key from step 1:

| Client | Start with | Setup |
|--------|------------|-------|
| CLI | `npx nomus-scan .` | `NOMUS_API_KEY` and a [`.nomus.yml`](packages/scanner/README.md#configuration) |
| VS Code | `code --install-extension babbguy.nomus` | [Extension README](packages/vscode-extension/README.md) |
| GitHub Actions | `uses: babbguy/nomus-action@v1` | [Clients](#clients) (the engine must be reachable from the runner) |
| MCP server for AI coding agents | `npx -y nomus-mcp` | [Clients](#clients) |

> The images, the npm packages, the extension and the Action's `v1` tag are first published by
> the v1.2.0 release. Until then, `docker compose up --build` builds the images from the
> checkout, and the clients run from source (see [From source](#from-source) and each package
> README).

## What it does

- **Regulation ingestion ("Hunter").** Scheduled scraping and parsing of 35 regulatory
  sources across 15 jurisdiction and standards-body codes (EU, US federal and state, UK,
  China, Japan, ISO, NIST and others), with raw-snapshot hashing so stored text can be checked
  against what the publisher served. Manual document upload is a separate processing path
  for sources that block automated access.
- **Admin-managed regulations and rules.** Administrators can add a new regulation as a source,
  edit or retire built-in ones, and create, correct, retire or restore individual rules from the
  dashboard or API. Edits are signed and versioned, survive restarts and re-extraction, and
  retiring a source stops its rules from applying.
- **Rule extraction.** LLM-assisted conversion of regulatory text into structured rules, with
  validation, scoring, merge/diff handling and an optional human approval step. Anthropic,
  OpenAI and Google providers are supported.
- **Code scanning.** The scanner detects AI SDK imports and usage, model capabilities, PHI
  patterns and transparency-related features, then asks the engine which rules apply.
  Available as a CLI, a GitHub Action, a VS Code extension, an MCP server for AI coding
  agents, and a GitHub App integration in the engine.
- **Signed attestations.** Ed25519-signed, timestamped records of an evaluation, with
  lifecycle states (valid, expired, revoked, superseded), a public verification page, and optional
  anchoring of a state hash to the Polygon network (an EVM chain).
- **Scout.** Tracks legislative signals and bills, scores passage likelihood, and records
  outcomes so prediction accuracy can be reviewed.
- **Analysis tools.** Compliance posture scoring, AI bill of materials, COMPL-AI style model
  benchmark definitions, regulatory impact simulation, a knowledge graph of regulations and
  obligations, and a clause map from detected capabilities to legal clauses.
- **Dashboard.** A React app for administrators (sources, pipeline, review queues, users,
  tenants, LLM and notification settings) and for end users (policies, attestations,
  scans, radar, simulator, reports).
- **Optional Modus integration.** Off by default. Set `NOMUS_MODUS_API_URL` to connect to
  [Modus](https://github.com/babbguy/Modus), the sister project for AI cost
  governance.

## Architecture

```
Nomus/
├── engine/                 Hono API server, SQLite (Drizzle), scheduler, pipelines
├── dashboard/              React 19 + Vite + Tailwind web app
├── packages/
│   ├── shared/             Types, Zod schemas, constants shared across packages
│   ├── scanner/            Code scanner and CLI (nomus-scan)
│   ├── chain/              Optional Polygon (EVM) state-hash anchoring (ethers)
│   ├── mcp-server/         MCP server exposing applicability checks to AI agents
│   ├── github-action/      GitHub Action (committed dist/index.js bundle)
│   └── vscode-extension/   VS Code extension
├── infra/                  Example Nginx, PM2 and server setup files
├── docs/                   Admin, API and user documentation
├── Dockerfile              Engine image
├── Dockerfile.dashboard    Dashboard image (Nginx)
└── docker-compose.yml      Engine + dashboard (+ optional TLS proxy)
```

The engine is a single Node.js process (Hono + better-sqlite3). The dashboard talks to it
on the same origin under `/api/v1`. The scanner, GitHub Action, VS Code extension and MCP
server are clients of a running engine: they detect capabilities locally and ask the
engine which rules apply.

## Clients

Each release publishes the scanner CLI ([`nomus-scan`](https://www.npmjs.com/package/nomus-scan))
and the MCP server ([`nomus-mcp`](https://www.npmjs.com/package/nomus-mcp)) to npm, the VS Code
extension `babbguy.nomus` to the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=babbguy.nomus) and
[Open VSX](https://open-vsx.org/extension/babbguy/nomus), and the GitHub Action to
[babbguy/nomus-action](https://github.com/babbguy/nomus-action).

The scanner, the MCP server and the extension need Node.js 20.19 or later and talk to a Nomus
engine you run, with an API key from the dashboard (Settings, API Keys). The scanner reads the
engine URL from `.nomus.yml` in the scanned directory (see the
[scanner README](packages/scanner/README.md)) and the key from `NOMUS_API_KEY`.

MCP client configuration (VS Code `.vscode/mcp.json` shown; see the
[MCP server guide](docs/user-guide/mcp-server.md) for other clients):

```json
{
  "servers": {
    "nomus": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "nomus-mcp"],
      "env": {
        "NOMUS_API_URL": "http://localhost:3100",
        "NOMUS_API_KEY": "nk_live_your_key_here"
      }
    }
  }
}
```

GitHub Action:

```yaml
- uses: babbguy/nomus-action@v1
  with:
    api-key: ${{ secrets.NOMUS_API_KEY }}
    api-url: https://nomus.example.com
```

## Running the engine

### Docker

The [Quick start](#quick-start) runs the published images with `docker compose up`
(`docker compose up --build` builds them from the checkout instead):

- Dashboard: http://localhost:8080
- Engine API: http://localhost:3100 (`GET /health`)

Each release publishes `ghcr.io/babbguy/nomus-engine` and `ghcr.io/babbguy/nomus-dashboard`
(linux/amd64 and linux/arm64), signed with cosign and with SBOMs and build provenance (see
[Verifying releases](SECURITY.md#verifying-releases)). Set `NOMUS_VERSION` (for example
`NOMUS_VERSION=1.2.0`) to pin a release; the default is `latest`.

`engine/.env.example` sets `NOMUS_ENV=development` and ships placeholder secrets so you can
look around. The engine image also sets `NODE_ENV=production`, which turns on the production
startup checks inside the container; the placeholders in the example file happen to satisfy
them, so replace them with real values. For anything beyond local use, set
`NOMUS_ENV=production` and `NOMUS_CORS_ORIGIN` to the URL you open the dashboard at (for
example `http://localhost:8080` under Docker Compose); the engine refuses to start in
production without real secrets. An optional TLS reverse
proxy (Nginx + certbot) is available under the `tls` compose profile, see
[docs/admin-guide/deployment.md](docs/admin-guide/deployment.md).

### From source

Requires Node.js 20.19 or newer (or 22.12+), the minimum for the dashboard's Vite 8 build. CI
runs Node 22 and the Docker images use Node 22.

```bash
git clone https://github.com/babbguy/Nomus.git
cd Nomus
npm install
npm run build:all
cp engine/.env.example engine/.env     # then edit

npm run dev:engine                     # API on http://localhost:3100
npm run dev:dashboard                  # dashboard on http://localhost:5173
```

On first start the engine creates the SQLite database, seeds the source registry and rule
sets, and creates an admin account from `NOMUS_ADMIN_EMAIL` and `NOMUS_ADMIN_PASSWORD`.
The engine reads `.env` from its working directory, which is `engine/` when started
through the npm scripts.

## Configuration

Copy `engine/.env.example` to `engine/.env`. The full, commented list lives in that file.
The essentials:

| Variable | Purpose |
|----------|---------|
| `NOMUS_ENV` | `development`, `staging` or `production` |
| `NOMUS_SIGNING_KEY_SECRET` | Secret protecting the attestation signing key (32+ characters) |
| `NOMUS_ADMIN_BOOTSTRAP_KEY` | Bootstrap admin API key (10+ characters) |
| `NOMUS_ADMIN_EMAIL`, `NOMUS_ADMIN_PASSWORD` | First admin login (password 12+ characters) |
| `NOMUS_CORS_ORIGIN` | Dashboard origin (required in production) |
| `NOMUS_ANTHROPIC_API_KEY`, `NOMUS_OPENAI_API_KEY`, `NOMUS_GOOGLE_AI_KEY` | LLM provider keys; at least one is needed for rule extraction and classification |
| `NOMUS_DB_PATH` | SQLite file (default `./data/nomus.db`) |
| `NOMUS_RATE_LIMIT_RPM`, `NOMUS_MAX_API_KEYS_PER_ORG`, `NOMUS_MAX_SSE_CONNECTIONS_PER_ORG` | Request limits (defaults 600 / 100 / 100) |

Optional integrations (email via Resend, ntfy and Slack notifications, GitHub App, Google
sign-in, Congress.gov API key for Scout, headless browser fetching, Sentry, Modus) are
documented in `engine/.env.example`. The optional Polygon anchoring variables
(`NOMUS_POLYGON_RPC_URL`, `NOMUS_POLYGON_PRIVATE_KEY`, `NOMUS_POLYGON_CONTRACT`) are read by
`packages/chain` rather than the engine's config schema.

## Testing

```bash
npm run lint              # lint all workspaces
npm run build:all         # build packages, extensions, engine and dashboard
npm run test:engine       # engine tests (Vitest)
npm run test:extensions   # scanner, GitHub Action, VS Code extension, MCP server tests
npm run test:dashboard    # dashboard tests (Vitest)
```

The engine tests use in-memory SQLite and mocked LLM calls, so they need no LLM API keys.

## Documentation

- [docs/README.md](docs/README.md): documentation index
- [Admin guide](docs/admin-guide/README.md): deployment and operations
- [API reference](docs/api-reference/README.md)
- [User guide](docs/user-guide/getting-started.md) and [MCP server](docs/user-guide/mcp-server.md)
- [Troubleshooting](docs/troubleshooting/README.md)
- Package READMEs: [scanner](packages/scanner/README.md),
  [GitHub Action](packages/github-action/README.md),
  [VS Code extension](packages/vscode-extension/README.md),
  [MCP server](packages/mcp-server/README.md)

## Status and limitations

- This is a portfolio project maintained on a best-effort basis. It is not a hosted
  service, and there is no support commitment.
- Rule extraction uses LLMs. Extracted rules are checked against the source text and can be
  routed through a human approval step (`NOMUS_REQUIRE_RULE_APPROVAL`), but they can still
  be wrong or incomplete. Verify anything that matters against the primary source.
- Coverage is limited to the bundled sources and rule sets. A missing finding does not mean
  an obligation does not apply.
- Nomus does not track the legal status of a source (amendment, repeal, revocation). The
  source registry was last reviewed in October 2026; check the current status of any law
  before relying on it.
- Regulation outputs are not legal advice.

## Related project

[Modus](https://github.com/babbguy/Modus) is a sister project for AI cost
governance (budgets, rate limits, model routing). Nomus can optionally sync policies with
it.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and
[SECURITY.md](SECURITY.md).

## License

Starting with v1.2.0, Nomus is licensed under the
[Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2).
Versions up to and including v1.1.0 remain under the Apache License, Version 2.0.

You may use, copy, modify and redistribute Nomus for any purpose other than a Competing Use.
The license defines a Competing Use as making the software available to others in a commercial
product or service that:

1. substitutes for the software;
2. substitutes for any other product or service we offer using the software that exists as of
   the date we make the software available; or
3. offers the same or substantially similar functionality as the software.

Internal use, non-commercial education, non-commercial research, and professional services you
provide to a licensee are expressly permitted. Each version also becomes available under the
Apache License, Version 2.0, on the second anniversary of the date it is made available. The
[LICENSE](LICENSE) file is the full and binding text.

For a commercial license, open a discussion titled "Commercial license" in this repository's
[Discussions](https://github.com/babbguy/Nomus/discussions).

See [NOTICE](NOTICE) for third-party attributions.

Copyright 2026 babbguy

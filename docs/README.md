# Nomus Documentation

**Nomus** is an open-source (Apache-2.0) AI regulatory applicability engine. It monitors AI-related regulations, keeps source-exact copies of them, scans codebases against generated rules, and produces signed attestations. You run it yourself.

> **Disclaimer.** Nomus is a regulatory applicability tool, not a compliance certification. Its output is not legal advice. Have qualified counsel review anything you rely on.

---

## Where to start

- **Trying it out?** [Getting Started](user-guide/getting-started.md)
- **Running it on a server?** [Admin Guide](admin-guide/README.md)
- **Building an integration?** [API Reference](api-reference/README.md)
- **Something broke?** [Troubleshooting](troubleshooting/README.md)

---

## Documentation map

### User guide

- [Getting Started](user-guide/getting-started.md): install, first run, first scan
- [MCP Server](user-guide/mcp-server.md): use Nomus tools from MCP clients such as Claude Code, VS Code and Cursor
- [Corporate Policies in the CLI and VS Code](user-guide/corporate-policies.md): your organization's policy findings in the scanner CLI and the VS Code extension

### API reference

- [API Overview](api-reference/README.md): authentication, rate limits, errors, pagination
- [Authentication](api-reference/auth.md): login, sessions, OAuth
- [Scan](api-reference/scan.md): code scanning and SARIF output
- [Sources and rules](api-reference/regulations.md): add, edit and retire regulations and rules
- [Health](api-reference/health.md): `/health`, `/ready` and status endpoints

### Admin guide

- [Admin Guide](admin-guide/README.md): overview, production checklist, architecture
- [Managing Regulations](admin-guide/regulations.md): add and edit sources, retire or correct rules, built-in vs custom sources, locked rules
- [Deployment](admin-guide/deployment.md): Docker Compose, optional TLS proxy, bare-metal example, environment variables
- [Operations](admin-guide/operations.md): organizations and users, monitoring, backups, logs, upgrades

### Troubleshooting

- [Troubleshooting Guide](troubleshooting/README.md)

---

## What is in the repository

| Path | Contents |
|------|----------|
| `engine/` | Hono API server, regulatory pipeline, scheduler, SQLite schema and migrations |
| `dashboard/` | React + Vite web UI |
| `packages/shared` | Types and schemas shared by the other packages |
| `packages/scanner` | Code scanner and the `nomus-scan` CLI |
| `packages/chain` | Optional Polygon (EVM) state-hash anchoring |
| `packages/mcp-server` | MCP server (`nomus-mcp`) |
| `packages/github-action` | GitHub Action |
| `packages/vscode-extension` | VS Code extension |
| `infra/` | Nginx configs and the example bare-metal setup script |
| `Dockerfile`, `Dockerfile.dashboard`, `docker-compose.yml` | Container build and local stack |
| `ecosystem.config.cjs` | PM2 config for running the engine without Docker |

---

## Quick start

With Docker:

```bash
cp engine/.env.example engine/.env   # edit the secrets in it
docker compose up --build
```

- Dashboard: http://localhost:8080
- Engine API: http://localhost:3100 (`GET /health`)

From source (Node.js 20.19+ or 22.12+):

```bash
npm install
npm run build:all
cp engine/.env.example engine/.env
npm run dev:engine      # API on http://localhost:3100
npm run dev:dashboard   # dashboard on http://localhost:5173
```

Tests and lint: `npm run test:engine`, `npm run test:extensions`, `npm run lint`.

---

## System requirements

- Node.js 20.19+ or 22.12+ for source installs (the dashboard build uses Vite 8; CI runs Node 22, the Docker images use Node 20)
- Docker with Compose v2 (for container installs)
- SQLite is embedded (better-sqlite3); no separate database server
- An LLM API key (Anthropic by default; Google and OpenAI providers are supported) for classification and translation features

---

## Tech stack

- **Backend:** Hono, TypeScript, SQLite (better-sqlite3 with Drizzle ORM), node-cron
- **Frontend:** React 19, Vite, Tailwind CSS
- **LLM providers:** Anthropic, Google, OpenAI (configurable)
- **Deployment:** Docker Compose, or PM2 with Nginx and Let's Encrypt

---

## Project links

- Repository: https://github.com/babbguy/Nomus
- Issues: https://github.com/babbguy/Nomus/issues
- Contributions are welcome: fork, branch, and open a pull request. Run `npm run lint` and the tests first.

## License

Apache-2.0. See the `LICENSE` and `NOTICE` files in the repository root.

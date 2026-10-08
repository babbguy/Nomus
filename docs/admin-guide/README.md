# Nomus Admin Guide

How to run your own Nomus instance. Nomus is self-hosted open-source software.

> Nomus is a regulatory applicability tool, not a compliance certification. Its output is not legal advice.

---

## Contents

- **[Managing Regulations](./regulations.md)**: add, edit and retire regulations (sources) and correct individual rules; built-in vs customized vs custom sources; locked rules
- **[Deployment](./deployment.md)**: Docker Compose, optional TLS proxy, bare-metal example, environment variables, hardening
- **[Operations](./operations.md)**: organizations and users, monitoring, backups, logs, scheduled jobs, upgrades

---

## Deployment options

| Method | Best for | Documentation |
|--------|----------|---------------|
| Docker Compose | Local use, evaluation, small single-host installs | [Docker Compose](./deployment.md#docker-compose) |
| Docker Compose with TLS profile | Internet-facing single host with your own domain | [TLS front proxy](./deployment.md#optional-tls-front-proxy) |
| Bare metal (PM2 + Nginx) | Running directly on a Linux server | [Bare-metal example](./deployment.md#bare-metal-pm2--nginx) |

---

## Architecture

```
            browser / API client
                    |
        +-----------+-----------+
        |  nginx (dashboard)    |   serves the React build,
        |  :8080 (compose)      |   proxies /api, /.well-known and SSE
        +-----------+-----------+
                    |
        +-----------+-----------+
        |  engine (Hono API)    |   :3100
        |  scheduler, pipeline  |
        +-----+-----------+-----+
              |           |
        +-----+----+  +---+----------------+
        |  SQLite  |  | LLM providers and  |
        | (1 file) |  | regulation sources |
        +----------+  +--------------------+
```

- **Engine**: REST API, server-sent events, regulatory pipeline and cron scheduler. Runs as a single process because SQLite has a single writer; do not run multiple engine instances against the same database.
- **Dashboard**: static React build served by Nginx. It calls the API on its own origin.
- **Database**: one SQLite file (`NOMUS_DB_PATH`). The schema is created and extended automatically at engine startup.

---

## Production checklist

Security

- [ ] `NOMUS_ENV=production` and all required secrets set (see [Environment variables](./deployment.md#environment-variables)); the engine refuses to start in production without them
- [ ] TLS in front of the engine and dashboard
- [ ] `NOMUS_CORS_ORIGIN` set to your dashboard origin
- [ ] `engine/.env` (or `.env`) not world-readable and never committed
- [ ] Admin password changed after first login; the bootstrap key stored somewhere safe, or revoked once you no longer need it (not if you use the GitHub App: its webhook scanner uses that key)
- [ ] Firewall allows only SSH, 80 and 443 (the engine port 3100 does not need to be public when a proxy is in front)

Reliability

- [ ] Process supervision (Docker `restart: unless-stopped`, or PM2 with `pm2 startup`)
- [ ] Regular backups with `sqlite3 .backup`, and a restore actually tested
- [ ] Something polls `GET /health` or `GET /ready`
- [ ] Log rotation configured

Data

- [ ] Decide on `NOMUS_RAW_SNAPSHOT_RETENTION_DAYS`. Unset (default) keeps raw snapshots forever, which preserves the byte-exact provenance record.

---

## Health and status endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /health` | none | Process is up |
| `GET /ready` | none | Database reachable and signing keys initialized; `503` otherwise |
| `GET /api/v1/status` | none | Service summary and recent pipeline success rate |
| `GET /api/v1/admin/status` | admin | Deeper diagnostics |

See [Health endpoints](../api-reference/health.md) for response shapes.

---

## Quick diagnostics

```bash
# Docker Compose
docker compose ps
docker compose logs --tail 100 engine
curl http://localhost:3100/health

# Bare metal with PM2
pm2 status
pm2 logs nomus-engine --lines 100
du -h data/nomus.db
sudo nginx -t
```

More in the [Troubleshooting Guide](../troubleshooting/README.md).

---

## Changes between versions

See `CHANGELOG.md` and the GitHub releases page: https://github.com/babbguy/Nomus/releases

## Getting help

Open an issue: https://github.com/babbguy/Nomus/issues. This is a personal open-source project maintained on a best-effort basis; there is no support contract.

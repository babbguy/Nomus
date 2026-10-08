# Nomus Operations Guide

Day-to-day tasks for running a self-hosted Nomus instance. Examples use `http://localhost:3100`; substitute your own URL (for example `https://nomus.example.com`). Paths such as `/opt/nomus` match the bare-metal example in the [Deployment Guide](./deployment.md); for Docker Compose use `docker compose` commands instead of PM2.

> Nomus is a regulatory applicability tool, not a compliance certification. Its output is not legal advice.

---

## Contents

1. [Organizations and users](#organizations-and-users)
2. [Monitoring](#monitoring)
3. [Backup and restore](#backup-and-restore)
4. [Logs](#logs)
5. [Database maintenance](#database-maintenance)
6. [Scheduled jobs](#scheduled-jobs)
7. [Upgrading](#upgrading)
8. [Recovering a server](#recovering-a-server)

---

## Organizations and users

Nomus supports multiple organizations on one instance, each with its own data. All features are available to every organization. Org and user administration uses these endpoints (also available in the dashboard under **Admin**, in the **Tenants** and **Users** pages):

| Action | Endpoint | Auth |
|--------|----------|------|
| List / create organizations | `GET`, `POST /api/v1/tenants` | admin API key or admin session |
| Get / update an organization | `GET`, `PATCH /api/v1/tenants/:id` | admin |
| List / create / revoke API keys | `GET`, `POST /api/v1/tenants/:id/api-keys`, `DELETE /api/v1/tenants/:id/api-keys/:keyId` | admin |
| Per-org request usage | `GET /api/v1/tenants/:id/usage?since=<ISO-8601>` | admin |
| List / create users | `GET`, `POST /api/v1/users` | `platform_admin` session |
| Get / update / deactivate a user | `GET`, `PATCH`, `DELETE /api/v1/users/:id` | `platform_admin` session |
| Reset a user's password | `POST /api/v1/users/:id/reset-password` | `platform_admin` session |

On first start the engine creates a `nomus-admin` organization, an admin API key from `NOMUS_ADMIN_BOOTSTRAP_KEY`, and an admin user from `NOMUS_ADMIN_EMAIL` / `NOMUS_ADMIN_PASSWORD`. API keys are sent as `Authorization: Bearer <key>`.

### Create an organization

```bash
curl -X POST http://localhost:3100/api/v1/tenants \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Example Org", "slug": "example-org"}'
```

The response contains the new organization's `id`, `name`, `slug` and `createdAt`. A duplicate slug returns `409`.

### Deactivate or reactivate an organization

```bash
curl -X PATCH http://localhost:3100/api/v1/tenants/$ORG_ID \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"isActive": false}'
```

Set `isActive` back to `true` to reactivate. There is no endpoint that deletes an organization.

### Request limits

Limits are instance-wide configuration: `NOMUS_RATE_LIMIT_RPM` (default 600), `NOMUS_MAX_API_KEYS_PER_ORG` (default 100) and `NOMUS_MAX_SSE_CONNECTIONS_PER_ORG` (default 100). Responses on rate-limited routes include `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; exceeding the limit returns `429`. See the [API overview](../api-reference/README.md).

### Create a user

Users are created by a `platform_admin` signed in to the dashboard (**Admin > Users**) or via the API with a session cookie:

```json
POST /api/v1/users
{ "email": "jane@example.com", "name": "Jane Doe", "orgId": "<org uuid>", "role": "member" }
```

Roles are `platform_admin` (instance administration) and `member` (default). If `password` is omitted, a temporary one is generated and returned once in the response as `tempPassword`; the user must change it at first sign-in. The invitation email is sent only when `NOMUS_RESEND_API_KEY` is configured; otherwise pass the temporary password to the user yourself.

### Change a role, deactivate, reset a password

```bash
# Update (role, name, isActive, orgId): PATCH /api/v1/users/:id
# Deactivate (data is kept): DELETE /api/v1/users/:id
# Reset: POST /api/v1/users/:id/reset-password   (optional body {"password": "..."}; response contains newPassword)
```

Users can also reset their own password through the sign-in page (`/forgot-password`), which requires email to be configured.

---

## Monitoring

| Endpoint | Auth | Meaning |
|----------|------|---------|
| `GET /health` | none | Process is running |
| `GET /ready` | none | Database reachable and signing keys initialized, else `503` |
| `GET /api/v1/status` | none | Service summary, connected SSE clients, last pipeline run, and the share of non-failed pipeline runs in the last 30 days |
| `GET /api/v1/admin/status` | admin | Deeper diagnostics, including per-source health |

```bash
curl http://localhost:3100/health
curl http://localhost:3100/ready
curl http://localhost:3100/api/v1/admin/status -H "Authorization: Bearer $ADMIN_API_KEY"
```

Point any uptime checker you like (your own cron plus `curl`, Uptime Kuma, a cloud monitor) at `/health` and `/ready`. The Docker image and Compose file already include a container health check on `/health`.

Process level:

```bash
docker compose ps                 # Docker
pm2 status && pm2 monit           # PM2
```

The dashboard has **Admin > System** and **Admin > Pipeline** pages for runtime and pipeline status. Error reporting to Sentry is off unless `NOMUS_SENTRY_DSN` is set.

---

## Backup and restore

All state is in the SQLite database (plus your `.env`, which holds the secrets needed to run it). The engine uses WAL mode, so use SQLite's online backup rather than copying the file:

```bash
mkdir -p /opt/nomus/backups
sqlite3 /opt/nomus/data/nomus.db ".backup '/opt/nomus/backups/nomus-$(date +%Y%m%d).db'"
```

Schedule it with cron (note the escaped `%`) and prune old copies:

```bash
0 3 * * * /usr/bin/sqlite3 /opt/nomus/data/nomus.db ".backup '/opt/nomus/backups/nomus-$(date +\%Y\%m\%d).db'" && find /opt/nomus/backups -name 'nomus-*.db' -mtime +30 -delete
```

`infra/setup-vps.sh` installs this job. Also back up `.env` separately, store it somewhere more restricted than the database backups, and copy backups off the host.

Docker Compose: the database is in the `nomus-data` volume. Back it up from inside the engine container image or the volume, for example:

```bash
docker compose exec engine node -e "const D=require('better-sqlite3');new D('/app/data/nomus.db').backup('/app/data/backup.db').then(()=>console.log('ok'))"
docker compose cp engine:/app/data/backup.db ./nomus-backup.db
```

### Restore

```bash
pm2 stop nomus-engine                       # or: docker compose stop engine
cp /opt/nomus/backups/nomus-20260101.db /opt/nomus/data/nomus.db
rm -f /opt/nomus/data/nomus.db-wal /opt/nomus/data/nomus.db-shm
pm2 start nomus-engine
curl http://localhost:3100/ready
```

Use the same `NOMUS_SIGNING_KEY_SECRET` as the instance that produced the backup. Test restores periodically.

---

## Logs

| Log | Location |
|-----|----------|
| Engine stdout / stderr (PM2, bare metal) | `/opt/nomus/logs/engine-out.log`, `/opt/nomus/logs/engine-error.log` (repo-root `ecosystem.config.cjs`: `./logs/`) |
| PM2 | `~/.pm2/logs/` |
| Docker | `docker compose logs engine` |
| Nginx | `/var/log/nginx/access.log`, `/var/log/nginx/error.log` |

Format follows `NOMUS_LOG_FORMAT` (`text` or `json`) and verbosity follows `NOMUS_LOG_LEVEL` (`debug`, `info`, `warn`, `error`).

```bash
pm2 logs nomus-engine --lines 100
tail -f /opt/nomus/logs/engine-out.log | jq      # json format
```

Rotation: `pm2 install pm2-logrotate` (then `pm2 set pm2-logrotate:max_size 100M`, `pm2 set pm2-logrotate:retain 7`), and Nginx logs are rotated by the system `logrotate`. For Docker, configure a `json-file` log driver size limit in your Compose override if the default grows too large.

---

## Database maintenance

```bash
sqlite3 /opt/nomus/data/nomus.db "PRAGMA integrity_check;"
sqlite3 /opt/nomus/data/nomus.db "VACUUM;"      # reclaim space; stop the engine first
sqlite3 /opt/nomus/data/nomus.db "ANALYZE;"
```

Raw regulation snapshots are the provenance record behind the source-exact guarantee, so by default they are kept forever and the database only grows. If disk usage matters, set `NOMUS_RAW_SNAPSHOT_RETENTION_DAYS`; snapshots older than that are purged weekly, and each source always keeps its latest snapshot. Purged snapshots can no longer be used to prove stored text matches the publisher's bytes.

---

## Scheduled jobs

The engine schedules its own jobs with node-cron in the process's local time zone (UTC in the Docker image; the host's time zone elsewhere unless `TZ` is set). The schedules you can change are configured by environment variables:

| Job | Variable | Default |
|-----|----------|---------|
| Regulation scrape pipeline | `NOMUS_SCRAPE_CRON` | `0 2 * * *` |
| Scout legislative tracking | `NOMUS_SCOUT_ENABLED`, `NOMUS_SCOUT_CRON` | `true`, `0 */6 * * *` |
| Raw snapshot cleanup (only if retention is set) | `NOMUS_RAW_SNAPSHOT_RETENTION_DAYS` | unset |

Manual triggers (admin auth):

```bash
curl -X POST http://localhost:3100/api/v1/admin/scrape-all     -H "Authorization: Bearer $ADMIN_API_KEY"
curl -X POST http://localhost:3100/api/v1/admin/scrape/$SOURCE_ID -H "Authorization: Bearer $ADMIN_API_KEY"
curl -X POST http://localhost:3100/api/v1/scout/trigger          -H "Authorization: Bearer $ADMIN_API_KEY"
```

Set `NOMUS_REQUIRE_RULE_APPROVAL=true` if generated rules should wait for a human to approve them in the dashboard before they are used. Restart the engine after changing any variable.

---

## Upgrading

The schema is created and extended automatically when the engine starts (additive changes only), so there is no separate migration step.

Docker Compose:

```bash
git pull
docker compose up -d --build
curl http://localhost:3100/ready
```

Bare metal (`/opt/nomus/deploy.sh` does the same):

```bash
sqlite3 /opt/nomus/data/nomus.db ".backup '/opt/nomus/backups/pre-upgrade.db'"
cd /opt/nomus
git pull origin main        # or: git fetch --tags && git checkout <tag>
npm ci
npm run build:all
pm2 restart nomus-engine
pm2 logs nomus-engine --lines 50
curl http://localhost:3100/ready
```

Read `CHANGELOG.md` and the release notes before upgrading.

### Rolling back

Schema changes are applied automatically and are not reversible. To roll back, stop the engine, restore the pre-upgrade database backup, check out the previous version, rebuild and start:

```bash
pm2 stop nomus-engine
cp /opt/nomus/backups/pre-upgrade.db /opt/nomus/data/nomus.db
rm -f /opt/nomus/data/nomus.db-wal /opt/nomus/data/nomus.db-shm
git checkout <previous-tag>
npm ci && npm run build:all
pm2 start nomus-engine
```

---

## Recovering a server

1. Provision a host and follow the [Deployment Guide](./deployment.md).
2. Before first start, restore `.env` and the database backup into `data/` (or the `nomus-data` volume).
3. Point DNS at the new host and obtain a TLS certificate.
4. Check `GET /ready`, sign in, and run a manual scrape to confirm the pipeline works.

Recovery point is the age of your latest backup. Nomus runs a single writer per database, so there is no built-in clustering or failover; if you need a standby, ship backup files to it.

---

## Related

- [Deployment Guide](./deployment.md)
- [Troubleshooting](../troubleshooting/README.md)
- [API Reference](../api-reference/README.md)

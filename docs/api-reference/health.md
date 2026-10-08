# Health and Status Endpoints

Source: `engine/src/server/routes/health.ts`. Examples use the local engine at
`http://localhost:3100`. The probes are served at the root, **not** under `/api/v1`.

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /health` | none | Liveness |
| `GET /ready` | none | Readiness (database and signing keys) |
| `GET /api/v1/status` | none | Pipeline and service summary |
| `GET /api/v1/admin/status` | `admin` scope | Per-source health, recent errors, server stats |

---

## GET /health

```bash
curl http://localhost:3100/health
```

```json
{
  "status": "ok",
  "service": "nomus-engine",
  "version": "1.0.0",
  "notice": "Nomus is a regulatory monitoring tool. It does not provide legal advice.",
  "timestamp": "2026-04-04T10:00:00.000Z"
}
```

Always `200` while the process is serving requests. The Docker Compose healthcheck uses this
endpoint.

---

## GET /ready

Reports whether the database is reachable and the signing keys are initialized. Rule promotion
needs the signing keys, so the engine is not ready without them.

`200`:

```json
{
  "status": "ready",
  "checks": { "database": "ok", "signing": "ok" },
  "version": "1.0.0",
  "timestamp": "2026-04-04T10:00:00.000Z"
}
```

`503` has `"status": "not_ready"` and `"error"` as the value of each failing entry in `checks`.

---

## GET /api/v1/status

Summary of services and the last pipeline run.

```json
{
  "status": "operational",
  "services": {
    "api": { "status": "ok", "latencyMs": 2 },
    "database": { "status": "ok" },
    "sse": { "status": "ok", "connectedClients": 3 }
  },
  "recentPipeline": {
    "status": "completed",
    "completedAt": "2026-04-04T09:00:00.000Z",
    "sourceName": "EUR-Lex AI Act"
  },
  "uptime": 100,
  "timestamp": "2026-04-04T10:00:00.000Z"
}
```

- `status` is `operational`, or `degraded` when more than 30% of pipeline runs in the last 30 days
  ended in `error`. If the database check throws, the endpoint returns `503` with `status: "down"`.
- `uptime` is not process uptime: it is the percentage of non-error pipeline runs in the last
  30 days (100 when there were none).
- `recentPipeline` is `null` when no pipeline run exists. `latencyMs` is the time of a `SELECT 1`.

---

## GET /api/v1/admin/status

Requires an `admin`-scoped API key or an admin session.

```bash
curl http://localhost:3100/api/v1/admin/status \
  -H "Authorization: Bearer $NOMUS_ADMIN_KEY"
```

```json
{
  "sources": [
    {
      "id": "....",
      "name": "EUR-Lex AI Act",
      "jurisdiction": "EU",
      "lastScrapedAt": "2026-04-04T02:00:00.000Z",
      "scrapeFrequencyHours": 24,
      "isActive": true,
      "lastRunStatus": "completed",
      "lastRunAt": "2026-04-04T02:15:00.000Z",
      "lastError": null,
      "lastDurationMs": 45000
    }
  ],
  "recentErrors": [
    {
      "sourceId": "....",
      "sourceName": "Example Source",
      "errorMessage": "HTTP 503",
      "stepReached": "fetch",
      "completedAt": "2026-04-03T22:30:00.000Z"
    }
  ],
  "sseClients": [
    { "id": "....", "orgId": "....", "jurisdictions": [], "connectedAt": "2026-04-04T09:45:00.000Z" }
  ],
  "server": {
    "uptimeSeconds": 345600,
    "memoryMB": { "rss": 512, "heapUsed": 256, "heapTotal": 384 },
    "nodeVersion": "v20.11.0"
  },
  "timestamp": "2026-04-04T10:00:00.000Z"
}
```

`lastRunStatus` is `never` for a source that has not run. `recentErrors` holds the 20 most recent
failed pipeline runs. The dashboard shows the same data under Admin, System.

---

## Using the probes

Docker Compose already wires `/health` into the engine container's healthcheck. For other setups:

```bash
curl -fsS http://localhost:3100/health
curl -fsS http://localhost:3100/ready
```

On the dashboard port (`http://localhost:8080`), `/health` is answered by the dashboard's nginx with
a plain-text `ok`; it does not reach the engine. Probe the engine on port 3100, or route
`/health` and `/ready` to it in your own proxy.

For operational guidance see the [admin guide](../admin-guide/operations.md) and
[troubleshooting](../troubleshooting/README.md).

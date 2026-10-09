# Nomus API Reference

The Nomus engine is a Hono HTTP server. Every endpoint described here is implemented in
`engine/src/server/routes/`; when this page and the code disagree, the code wins.

| Environment | Base URL |
|-------------|----------|
| Local engine | `http://localhost:3100` |
| Example production domain | `https://nomus.example.com` (behind your own reverse proxy) |

Versioned endpoints live under `/api/v1/`. The liveness and readiness probes (`/health`, `/ready`)
are unversioned. The dashboard calls the API same-origin at `/api/v1`.

## Pages in this reference

- [Authentication](./auth.md) - login, sessions, OAuth, device flow, API keys
- [Health and status](./health.md) - `/health`, `/ready`, `/api/v1/status`, `/api/v1/admin/status`
- [Your organization](./org.md) - profile, self-service API keys, member list
- [Governance](./governance.md) - roles, permissions, org users and grants, teams, governance settings and audit log (`/api/v1/cpg`)
- [Policy registry](./policy-registry.md) - review boards, the approval quorum, compiling and approving corporate policies, the signed policy bundle and the policy-log export (`/api/v1/cpg`)
- [Review cases](./review-cases.md) - request review, justifications, comments and change requests, reviewer context and closing a case (`/api/v1/cpg/cases`)
- [CI gate](./ci-gate.md) - the server's signed pass or fail verdict on a CI scan, closing a case with its pull request, and recorded CI runs (`/api/v1/cpg/ci`)
- [Integrations](./integrations.md) - email, Jira and signed webhook notifications, the delivery log and retries (`/api/v1/cpg/integrations`, `/api/v1/cpg/deliveries`)
- [Approvals](./approvals.md) - snippet and bulk proposals, votes, quorum and signed decisions (`/api/v1/cpg/proposals`, `/api/v1/cpg/decisions`)
- [Scan findings](./scan.md) - upload and query scanner findings
- [Sources and rules](./regulations.md) - add, edit and retire regulations and rules (admin)

Nomus provides regulatory applicability information, not legal advice or a compliance certification.
Responses from the rule and findings endpoints carry a `_disclaimer` field.

---

## Authentication

Protected endpoints accept either of two credentials (see [auth.md](./auth.md)):

1. **Session cookie** `nomus_session` (set by `POST /api/v1/auth/login`, 7 day TTL), used by the dashboard.
2. **API key** sent as `Authorization: Bearer <key>`. Keys created by the engine start with `nk_live_`.

Each API key carries a list of scopes. The scopes that exist are:

| Scope | Grants |
|-------|--------|
| `read:policies` | Read rules, graph, radar, templates, attestations, benchmarks, compliance posture |
| `evaluate` | Evaluate/simulate, scan findings, AI-BOM |
| `stream` | Server-sent event stream |
| `admin` | Tenants and API keys, sources, scout, admin and dashboard routes |

Dashboard sessions are granted `read:policies`, `stream` and `evaluate`, plus `admin` for
`platform_admin` users.

---

## Rate limiting

Most authenticated route groups apply a per-organization limit with a one-minute window (for example `/policies`, `/evaluate`, `/simulate`, `/scan`, `/admin`, `/scout`, `/stream`); a few, such as `/tenants`, `/users`, `/sources` and `/settings`, do not. The limit is plain configuration: each API key stores a requests-per-minute value copied from `NOMUS_RATE_LIMIT_RPM` (default
`600`) when the key is created; sessions use `NOMUS_RATE_LIMIT_RPM` directly. Rate-limited
responses include:

```
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 585
X-RateLimit-Reset: 1712232000      (Unix seconds)
```

When the limit is exceeded the engine returns `429`:

```json
{ "error": "Rate limit exceeded. 600 requests per minute allowed.", "status": 429 }
```

Related settings (all in `engine/.env`, see `engine/.env.example`):

| Variable | Default | Meaning |
|----------|---------|---------|
| `NOMUS_RATE_LIMIT_RPM` | `600` | Requests per minute per organization |
| `NOMUS_MAX_API_KEYS_PER_ORG` | `100` | Maximum active API keys per organization |
| `NOMUS_MAX_SSE_CONNECTIONS_PER_ORG` | `100` | Maximum concurrent SSE connections per organization |
| `NOMUS_CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin (credentials enabled) |

The login, forgot-password and reset-password endpoints additionally have a per-IP limit (see
[auth.md](./auth.md)).

---

## Errors

Errors are JSON. Most carry an `error` string; errors raised by middleware (authentication,
scopes, rate limit) also carry the numeric `status`. Request-body validation failures return `400`
with the validation issues in `details`.

```json
{ "error": "Invalid input", "details": [ { "path": ["findings"], "message": "Required" } ] }
```

| Status | When |
|--------|------|
| 400 | Invalid JSON or request body |
| 401 | Missing, invalid or expired API key or session |
| 403 | Authenticated, but the key or role lacks the required scope |
| 404 | Resource not found (or not in your organization) |
| 409 | Conflict, e.g. duplicate slug or email |
| 429 | Rate limit exceeded |
| 500 | Unhandled error (`{"error":"Internal server error","status":500}`) |
| 503 | Readiness or status check failed |

There are no machine-readable error `code` values; match on the HTTP status.

---

## Endpoint groups

All paths are prefixed with `/api/v1`. "Scope" is the API-key scope required.

| Prefix | Scope / access | Purpose |
|--------|----------------|---------|
| `/auth` | public / session | Login, logout, profile, password reset, Google and GitHub OAuth, device auth |
| `/org` | session (any signed-in user) | Your own organization: profile, API keys, read-only members (see [org.md](./org.md)) |
| `/tenants` | `admin` | Organizations, API keys, per-org usage (platform administration) |
| `/policies` | `read:policies` | Regulatory rules (`GET /`, `/industries`, `/bundle`, `/hash`, `/impact-map`, `/:id`) |
| `/evaluate` | `evaluate` | Evaluate capabilities against rules |
| `/simulate` | `evaluate` | Applicability simulation for capabilities, data types and target markets |
| `/simulations` | `read:policies` | Saved regulatory-impact simulations |
| `/audit-export` | `read:policies` | Audit log of attestations, scan findings and score snapshots (also `/csv` and `/json` exports) |
| `/scan` | `evaluate` | Scanner findings (see [scan.md](./scan.md)) |
| `/attestations` | `read:policies` | Attestations |
| `/graph` | `read:policies` | Regulatory knowledge graph |
| `/radar`, `/radar/v2` | `read:policies` | Regulation and pending-bill radar |
| `/templates` | `read:policies` | Compliance framework templates |
| `/compliance` | `read:policies` | Compliance posture |
| `/clause-map` | `evaluate` | Clause-to-code mapping |
| `/benchmarks` | `read:policies` | Model benchmark definitions and runs |
| `/ai-bom` | `evaluate` | AI bill of materials |
| `/stream` | `stream` | Server-sent events for regulatory changes |
| `/feedback` | `evaluate` | Rule feedback |
| `/sources`, `/scout`, `/dashboard` | `admin` | Source management (see [regulations.md](./regulations.md)), legislative scouting, admin dashboard data |
| `/admin/rules` | `admin` | Create, edit, retire and reactivate rules (see [regulations.md](./regulations.md)) |
| `/admin` (incl. `/admin/diffs`, `/admin/ontology`, `/admin/source-health`, `/admin/forge`, `/admin/modus`) | `admin` | Administration |
| `/users` | `platform_admin` session | User administration |
| `/settings` | `admin` | LLM, scout API-key and notification settings |
| `/github` | GitHub signature | GitHub App webhook receiver (`POST /webhook`) |
| `/badge`, `/transparency`, `/ledger`, `/chain`, `/verify` | public (badge config routes need `read:policies`) | Badge, public transparency and ledger data, attestation verification |
| `/modus` | `platform_admin` session | Proxy to the optional Modus cost-tracking integration |

Only `/auth`, [org](./org.md), [health](./health.md) and [scan](./scan.md) are documented in detail here. For the
other groups, read the route file named after the prefix in `engine/src/server/routes/`.

---

## Conventions

- Request and response bodies are JSON. Timestamps are ISO-8601 UTC.
- Pagination is not uniform. List endpoints take a `limit` query parameter with their own default
  and cap (for example `/policies`: default 500, max 1000; `/scan/findings`: default 100, max 500;
  `/tenants` also takes `offset`). There is no cursor pagination.
- `GET /policies` filters: `jurisdiction`, `category`, `industry`, `since` (ISO-8601, matches
  `updatedAt`), `limit`.

### Example

```bash
curl "http://localhost:3100/api/v1/policies?jurisdiction=EU&limit=5" \
  -H "Authorization: Bearer $NOMUS_API_KEY"
```

```json
{
  "count": 5,
  "policies": [ { "ruleKey": "...", "severity": "high", "conditions": [], "industries": ["all"] } ],
  "_disclaimer": "..."
}
```

---

## Help

Open an issue at https://github.com/babbguy/Nomus/issues.

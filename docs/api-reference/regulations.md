# Source and Rule Management Endpoints

Endpoints for adding, editing and retiring regulations (sources) and their rules. Sources are in
`engine/src/server/routes/sources.ts`, rules in `engine/src/server/routes/admin-rules.ts`. For
the concepts (built-in vs customized vs custom sources, locked rules) read the
[Managing Regulations](../admin-guide/regulations.md) guide first.

All endpoints require the `admin` scope (API key) or a `platform_admin` dashboard session; a
missing credential returns `401` and a key without `admin` returns `403`. The rule endpoints are
rate limited per organization (see the [overview](./README.md#rate-limiting)); the source endpoints
are not. Examples use `http://localhost:3100`. Validation failures return `400` with the issues in
`details`, as described in [Errors](./README.md#errors).

---

## Sources

Only the endpoints that manage a source's configuration and ownership are described here. The
same router also serves scrape-content, upload and audit endpoints (`/:id/content`,
`/:id/rules`, `/upload-content/:id`, ...); read `sources.ts` for those.

### Source object

| Field | Type | Notes |
|-------|------|-------|
| `id` | string (UUID) | |
| `name` | string | Unique, case-insensitive |
| `jurisdiction` | string | Upper-case code, 1 to 16 characters of `A-Z`, `0-9`, `-` |
| `url` | string | `http` or `https` |
| `parserType` | `html` \| `pdf` | |
| `selectorConfig` | object | `contentSelector`, `removeSelectors`, `pageRange`, ... |
| `scrapeFrequencyHours` | integer | 0 to 8760 |
| `ingestionMode` | `auto` \| `manual` | |
| `category` | string | e.g. `ai_regulation` |
| `tier` | integer | 1 to 4 |
| `needsHeadless` | boolean | |
| `isActive` | boolean | Inactive sources are not scraped and their rules do not apply |
| `origin` | `registry` \| `customized` \| `custom` \| `null` | Owner. `null` only on a row the next start has not classified yet |
| `registryKey` | string \| `null` | Lower-cased built-in name this row came from; `null` for custom sources |

`GET /api/v1/sources` returns `{ count, sources }` with these fields plus operational ones
(`lastScrapedAt`, `consecutiveFailures`, `auditResult`, ...).

### POST /api/v1/sources

Create a **custom** source (`origin: "custom"`, active). The startup sync never modifies it. Returns
`201` with the source object.

```bash
curl -X POST http://localhost:3100/api/v1/sources \
  -H "Authorization: Bearer $NOMUS_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Example AI Act (draft)",
    "jurisdiction": "xa",
    "url": "https://example.com/example-ai-act",
    "category": "ai_regulation",
    "tier": 2
  }'
```

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `name` | string, 1 to 200 | yes | |
| `jurisdiction` | string | yes | Trimmed and upper-cased; any code matching the pattern above |
| `url` | URL | yes | Checked for SSRF (private, loopback, link-local and metadata hosts are refused) |
| `parserType` | `html` \| `pdf` | no | `html` |
| `selectorConfig` | object | no | `{}` |
| `scrapeFrequencyHours` | integer | no | `24` |
| `ingestionMode` | `auto` \| `manual` | no | `auto` |
| `category` | string (`a-z0-9_`, up to 64) | no | `ai_regulation` |
| `tier` | integer 1 to 4 | no | `1` |
| `needsHeadless` | boolean | no | `false` |

Errors: `400` invalid input or rejected URL; `409` a source with that name already exists.

### PATCH /api/v1/sources/:id

Partial update. Accepts `name`, `jurisdiction`, `url`, `parserType`, `selectorConfig`,
`scrapeFrequencyHours`, `ingestionMode`, `category`, `tier`, `needsHeadless` (same rules as create)
and `isActive`. Returns `200` with the **updated source object**.

- If the source is `origin: "registry"` and a request changes the value of `name`, `jurisdiction`,
  `url`, `parserType`, `selectorConfig`, `category`, `tier`, `ingestionMode` or `needsHeadless`,
  it becomes `origin: "customized"`. Sending a value equal to the current one (including a
  `selectorConfig` with the same content in a different key order) changes nothing.
  `scrapeFrequencyHours` and `isActive` never change `origin`.
- Setting `isActive` to `false` on an active source **retires all of its active rules**; the
  response then includes `rulesRetired` (count). Setting it to `true` on an inactive source
  restores exactly the rules that deactivation retired and adds `rulesRestored`.
- A changed `url` is checked for SSRF.

Errors: `400`, `404` source not found, `409` name already used.

### POST /api/v1/sources/:id/restore-defaults

Re-apply the built-in registry values (name, URL, jurisdiction, parser, selectors, category, tier,
ingestion mode, headless) to a built-in source and set `origin: "registry"` so the startup sync
manages it again. `isActive` and `scrapeFrequencyHours` are left as they are. No body. Returns
`200` with the source object.

Errors: `404` source not found; `409` the source has no built-in registry entry (custom sources,
and built-ins that have since been removed from the registry), or another source already uses the
built-in name.

### DELETE /api/v1/sources/:id

Soft delete: deactivates the source and retires its active rules. Nothing is removed.
Returns `200`:

```json
{ "message": "Source deactivated", "rulesRetired": 12 }
```

Reactivate with `PATCH { "isActive": true }`. Errors: `404`.

---

## Rules

A rule is the unit that evaluation and the policy bundle serve. Rules created or edited through
these endpoints are signed with the same function the integrity check verifies, bump their
`version` on every content change, and are `locked`: extraction from the source will not overwrite
them (see [Locked rules](../admin-guide/regulations.md#locked-rules-and-re-extraction)).

### Rule object

| Field | Type | Notes |
|-------|------|-------|
| `id` | string (UUID) | |
| `sourceId` | string | |
| `ruleKey` | string | Unique, immutable |
| `version` | integer | Starts at 1 |
| `jurisdiction`, `category`, `effect`, `severity` | string | See the create table |
| `conditions` | object | `{ key: "value" }`; every key must equal the same-named value in the evaluated context |
| `humanSummary`, `legalReference` | string | |
| `effectiveDate`, `expiresAt` | string \| `null` | `YYYY-MM-DD` or ISO-8601 datetime |
| `industries` | string[] | |
| `industryScope`, `industryNotes` | string | |
| `isActive` | boolean | Retired rules are `false` |
| `locked` | boolean | `true` once created or edited by a person |
| `signature` | string | Ed25519 signature over the signed fields |
| `createdAt`, `updatedAt` | string | UTC ISO-8601 |

### GET /api/v1/admin/rules

List rules, ordered by `ruleKey`, each with `sourceName`.

| Query | Meaning |
|-------|---------|
| `sourceId` | Only this source's rules |
| `jurisdiction` | Exact code match |
| `includeInactive` | `true` to include retired rules; default `false` |
| `limit` | 1 to 500, default 100 |
| `offset` | Default 0 |

```json
{ "count": 2, "total": 2, "limit": 100, "offset": 0, "rules": [ { "id": "...", "ruleKey": "...", "sourceName": "...", "...": "..." } ] }
```

### GET /api/v1/admin/rules/:id

One rule plus its `policy_events` history, newest first. `404` if it does not exist.

```json
{
  "id": "...", "ruleKey": "acme.art5.transparency", "version": 2, "locked": true, "sourceName": "...",
  "history": [
    { "id": "...", "eventType": "policy.updated", "sequence": 412, "createdAt": "2026-10-07T12:00:00.000Z",
      "payload": { "version": 2, "previousVersion": 1, "changedFields": ["severity"], "actor": "user:...", "manual": true } },
    { "id": "...", "eventType": "policy.created", "sequence": 411, "createdAt": "2026-10-07T11:50:00.000Z",
      "payload": { "version": 1, "actor": "user:...", "manual": true } }
  ]
}
```

### POST /api/v1/admin/rules

Create a rule. Returns `201` with the rule object (`version: 1`, `isActive: true`, `locked: true`).

```bash
curl -X POST http://localhost:3100/api/v1/admin/rules \
  -H "Authorization: Bearer $NOMUS_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceId": "SOURCE_UUID",
    "ruleKey": "acme.art5.transparency",
    "category": "transparency",
    "conditions": { "action": "text_generation", "sector": "healthcare" },
    "effect": "require_disclosure",
    "severity": "high",
    "humanSummary": "Users must be told they are interacting with an AI system.",
    "legalReference": "Acme AI Act, Article 5(1)",
    "effectiveDate": "2026-08-01"
  }'
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `sourceId` | string | yes | Must exist and be active |
| `ruleKey` | string | yes | `^[a-z][a-z0-9_.]{2,127}$`; unique across all rules |
| `jurisdiction` | string | no | Defaults to the source's jurisdiction; same format as for sources |
| `category` | enum | yes | `data_governance`, `transparency`, `risk_assessment`, `human_oversight`, `accountability`, `fairness`, `privacy`, `safety`, `security`, `intellectual_property` |
| `conditions` | object | yes | 1 to 20 keys; keys are identifiers; values are non-empty strings (max 256) |
| `effect` | enum | yes | `deny`, `allow_with_audit`, `require_disclosure`, `flag` |
| `severity` | enum | yes | `critical`, `high`, `medium`, `low` |
| `humanSummary` | string | yes | 10 to 2000 characters |
| `legalReference` | string | yes | 3 to 500 characters |
| `effectiveDate` | string | yes | `YYYY-MM-DD` or ISO-8601 datetime |
| `expiresAt` | string \| `null` | no | Must be after `effectiveDate` |
| `industries` | string[] | no | Default `["all"]`; at least one entry if given |
| `industryScope` | enum | no | `global` (default), `sector_specific`, `subsector_specific` |
| `industryNotes` | string | no | Default empty |

Unknown fields are rejected. Errors: `400` validation (also an unknown `sourceId`, reported at
`details[].path = ["sourceId"]`), `409` duplicate `ruleKey` or inactive source.

Writes a `policy.created` event.

### PATCH /api/v1/admin/rules/:id

Partial update of the content fields above (not `ruleKey` or `sourceId`). If anything changes, the
rule gets `version + 1`, is re-signed, becomes `locked`, and a `policy.updated` event is written
whose payload lists `changedFields`. Returns the rule object plus `changed` (`false` and no new
version if every supplied value already matched).

`{ "locked": false }` **on its own** hands the rule back to the extraction pipeline: no version
bump and no event. `{ "locked": true }` on its own locks without editing. `locked: false` combined
with other fields is a `400`.

Errors: `400`, `404`, and `409` when the rule's stored signature does not verify (it is not
re-signed over a mismatch; run the integrity check).

### POST /api/v1/admin/rules/:id/retire

Set `isActive` to `false`. The rule disappears from `/api/v1/policies`, `/policies/bundle`,
`/policies/hash`, evaluation and the integrity check. No version change. Writes a
`policy.revoked` event with `reason: "manual"`. Returns the rule object plus `changed`; retiring an
already retired rule is a no-op (`changed: false`). `404` if unknown.

### POST /api/v1/admin/rules/:id/reactivate

Set `isActive` to `true`; writes a `policy.updated` event with `reactivated: true`. Same response
shape and idempotency. `409` if the rule's source is inactive. `404` if unknown.

---

## Effects on the rest of the API

After any successful source or rule change above:

- `GET /api/v1/policies`, `/policies/bundle` (cache invalidated) and `/policies/hash` reflect it
  immediately; only active rules are served, and `ruleCount` and `stateHash` change.
- `POST /api/v1/evaluate` evaluates against the current active rules for the requested
  jurisdiction (exact match). A rule applies when every one of its conditions equals the
  request context; the jurisdiction supplies `region` when the context does not set it, and
  `sector` / `data_type` accept the same aliases as `/simulate` (`fintech`, `phi`, `pii`).
- Rule events are appended to `policy_events` with the next sequence number and broadcast to
  `GET /api/v1/stream` subscribers (`policy.created`, `policy.updated`, `policy.revoked`); clients
  reconnecting with `Last-Event-ID` receive the ones they missed. The payload includes `actor`
  (`user:<id>` for a dashboard session, `apikey:<id>` for a key, `system:registry-sync` for the
  startup sync) and, for retirements, `reason` (`manual` or `source_deactivated`).
- `POST /api/v1/admin/verify-integrity` verifies edited rules like any other.

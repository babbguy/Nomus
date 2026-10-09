# Your organization (`/api/v1/org`)

Self-service endpoints for the organization you are signed in to. Nobody needs a platform
administrator to create the API keys that the scanner, GitHub Action, VS Code extension and MCP
server use.

Since v1.2.0 each route except `GET /api/v1/org` requires a permission from your organization's
[roles](../admin-guide/roles-and-permissions.md): `org.profile.update` for `PATCH /org`,
`org.api_keys.manage` for the `/org/api-keys` routes and `org.members.read` for `/org/members`.
Every member holds them through the Developer role (legacy grants), so behaviour is unchanged
unless an Org Admin removes them. Without the permission the route answers
`403 {"error": "...", "code": "forbidden", "details": {"permission": "..."}}`. A platform admin
session keeps its v1.1.0 access to these routes.

- **Session only.** These routes read the `nomus_session` cookie. An API key cannot call them, so a
  key cannot be used to mint more keys.
- **No ids in the path.** Every route acts on the organization of the session. There is no way to
  address another organization; a key id from another organization returns `404`.
- Platform admins calling these routes get their own (admin) organization. Managing other
  organizations is done with [`/api/v1/tenants`](./auth.md#api-keys) and `/api/v1/users`.
- Rate limited like the other authenticated groups (`NOMUS_RATE_LIMIT_RPM` per organization).

| Method and path | Purpose |
|-----------------|---------|
| `GET /api/v1/org` | Your organization and its profile |
| `PATCH /api/v1/org` | Update the profile fields you may self-manage |
| `GET /api/v1/org/api-keys` | List your organization's API keys (never the key itself) |
| `POST /api/v1/org/api-keys` | Create a key; the raw key is returned once |
| `DELETE /api/v1/org/api-keys/:keyId` | Revoke a key |
| `GET /api/v1/org/members` | Read-only list of users in your organization |

| Method and path | Permission (v1.2.0) |
|-----------------|---------------------|
| `GET /api/v1/org` | none (any signed-in user) |
| `PATCH /api/v1/org` | `org.profile.update` |
| `GET`, `POST /api/v1/org/api-keys`, `DELETE /api/v1/org/api-keys/:keyId` | `org.api_keys.manage` |
| `GET /api/v1/org/members` | `org.members.read` |

---

## GET /api/v1/org

```json
{
  "id": "6f1c...",
  "name": "Acme Health",
  "slug": "acme-health",
  "industry": "healthcare",
  "subIndustry": "Clinical trials",
  "jurisdictionAccess": ["EU", "US-FED"],
  "showOrgOnPublicVerify": false,
  "createdAt": "2026-10-07T12:00:00.000Z",
  "updatedAt": "2026-10-07T12:30:00.000Z"
}
```

## PATCH /api/v1/org

Send any of these fields; at least one is required.

| Field | Type | Notes |
|-------|------|-------|
| `industry` | string up to 100, or `null` | An empty string clears it. The dashboard uses rule industry tags such as `healthcare`, `finance`, `education`, `government`, `media`; the Regulation Impact panel on the dashboard filters by it |
| `subIndustry` | string up to 100, or `null` | Free text |
| `jurisdictionAccess` | array of jurisdiction codes | Each must be a known code (for example `EU`, `US-FED`, `UK`); duplicates are removed |
| `showOrgOnPublicVerify` | boolean | Show the organization name on the public attestation verification page (off by default) |

Any other field (`name`, `slug`, `isActive`, `id`, ...) is rejected with `400`; those are changed by
a platform administrator through `PATCH /api/v1/tenants/:id`. Returns the updated organization.

## API keys

### POST /api/v1/org/api-keys

```bash
curl -X POST http://localhost:3100/api/v1/org/api-keys \
  -b "nomus_session=$SESSION" \
  -H "Content-Type: application/json" \
  -d '{"label":"CI scanner","scopes":["read:policies","evaluate"]}'
```

| Field | Type | Notes |
|-------|------|-------|
| `label` | string, 1-100 | required |
| `scopes` | array, at least 1 of `read:policies`, `evaluate`, `stream` | required. `admin` is refused with `403` |
| `expiresAt` | ISO-8601 datetime with offset, or `null` | optional |

Response `201`. This is the only time the raw key is shown; store it now.

```json
{
  "id": "....",
  "key": "nk_live_...",
  "prefix": "nk_live_xxxx",
  "label": "CI scanner",
  "scopes": ["read:policies", "evaluate"],
  "rateLimitRpm": 600,
  "message": "Store this key securely — it cannot be retrieved again."
}
```

Keys are the same as keys an administrator creates: `nk_live_` prefix, stored hashed, and limited
to `NOMUS_RATE_LIMIT_RPM` requests per minute. Errors: `400` invalid input or
`{"error":"API key limit reached (100)"}` (see `NOMUS_MAX_API_KEYS_PER_ORG`; revoked keys do not
count), `403` the `admin` scope was requested.

### GET /api/v1/org/api-keys

```json
{
  "count": 1,
  "keys": [
    {
      "id": "....",
      "keyPrefix": "nk_live_xxxx",
      "label": "CI scanner",
      "scopes": ["read:policies", "evaluate"],
      "isActive": true,
      "lastUsedAt": null,
      "createdAt": "2026-10-07T12:00:00.000Z",
      "expiresAt": null
    }
  ]
}
```

Revoked keys stay in the list with `isActive: false`. The key and its hash are never returned.

### DELETE /api/v1/org/api-keys/:keyId

Revokes the key immediately: `{"message":"API key revoked"}`. `404` if the id does not belong to
your organization. Key creation and revocation are written to the engine log with the acting user.

## GET /api/v1/org/members

```json
{
  "count": 2,
  "members": [
    { "id": "....", "name": "Ada", "email": "ada@example.com", "role": "member", "isActive": true, "createdAt": "..." }
  ]
}
```

Read-only. Platform administrators manage users with `/api/v1/users` (dashboard Admin, Users; see
the [admin guide](../admin-guide/operations.md)); since v1.2.0 an Org Admin can also invite and
deactivate users of their own organization with [`/api/v1/cpg/users`](./governance.md#users-and-grants).
No password hashes or tokens are ever included.

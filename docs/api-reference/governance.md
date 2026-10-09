# Governance: roles, users, settings and audit (`/api/v1/cpg`)

Endpoints for corporate policy governance (CPG) access control in your organization. For the
model behind them (roles, permissions, scopes, who gets what on upgrade) read
[Roles and permissions](../admin-guide/roles-and-permissions.md) first. Boards, the approval
quorum, the policy log and the signed policy bundle are on the
[policy registry](./policy-registry.md) page.

Every route acts on the organization of the caller. There is no organization id in the path, and
an id that belongs to another organization always answers `404`, never `403`.

## Authentication

| Credential | Accepted by |
|------------|-------------|
| Session cookie (`nomus_session`) | every endpoint on this page |
| User-bound API key (the key the VS Code extension receives at sign-in) | `GET /cpg/me` and `GET /cpg/settings` on this page (and the registry reads listed on the [policy registry](./policy-registry.md) page); it acts as its user |
| Organization API key (created under `/api/v1/org/api-keys` or by an administrator) | none: `403 user_identity_required`, because the key carries no user |

A session or user-bound key whose user still has a temporary password gets
`403 password_change_required` on every endpoint here, before any permission check. Rate limits
are the usual per-organization limits (`NOMUS_RATE_LIMIT_RPM`).

## Conventions

- Request bodies are JSON and strictly validated: an unknown field is rejected with `400`.
- Ids are UUIDs with hyphens. Times are UTC ISO-8601 with milliseconds, for example
  `2026-10-08T12:00:00.000Z`.
- Lists are returned as `{ "items": [...] }`.
- Errors use one envelope:

  ```json
  { "error": "Missing permission rbac.roles.manage", "code": "forbidden", "details": { "permission": "rbac.roles.manage" } }
  ```

| HTTP | `code` | When |
|------|--------|------|
| 400 | `invalid_json` | The body is not JSON |
| 400 | `invalid_input` | Validation failed; zod issues (or the offending values) in `details` |
| 401 | `unauthenticated` | No valid session or key (middleware may answer `{ "error", "status" }`) |
| 403 | `password_change_required` | The user must change a temporary password first |
| 403 | `user_identity_required` | An organization API key was used |
| 403 | `forbidden` | The permission in `details.permission` is missing; or `details.reason` is `session_required` (a user-bound key on a session-only endpoint), `system_role` or `platform_admin` |
| 404 | `not_found` | Unknown id, or an id of another organization |
| 409 | `role_key_taken`, `team_key_taken`, `email_in_use` | The key or email already exists |
| 409 | `role_archived`, `team_archived` | Archived roles cannot be edited or granted; archived teams cannot scope a grant |
| 409 | `grant_already_revoked` | A grant is revoked only once |
| 409 | `cannot_deactivate_self` | You cannot deactivate your own account |
| 409 | `last_org_admin` | The change would leave the organization without an active Org Admin, or remove `rbac.users.manage` / `rbac.roles.manage` from the Org Admin role |
| 422 | `role_not_scopable` | A role with org-only permissions was granted per team or repository, or such a permission was added to a role that has scoped grants |
| 422 | `invalid_repo` | `scopeId` is not a canonical lowercase repository id |
| 422 | `invalid_glob` | A team repository pattern is invalid (`details.errors`) |

## Endpoints

| Method and path | Permission | Purpose |
|-----------------|------------|---------|
| `GET /api/v1/cpg/me` | any user | Who you are, your permissions, whether governance is enabled |
| `GET /api/v1/cpg/permissions` | `org.members.read` | The permission catalog |
| `GET /api/v1/cpg/roles` | `org.members.read` | Roles with their permissions |
| `POST /api/v1/cpg/roles` | `rbac.roles.manage` | Create a custom role |
| `PATCH /api/v1/cpg/roles/:id` | `rbac.roles.manage` | Rename, describe or change the permissions of a role |
| `POST /api/v1/cpg/roles/:id/archive` | `rbac.roles.manage` | Archive a custom role |
| `GET /api/v1/cpg/users` | `org.members.read` | Organization users with their active grants |
| `POST /api/v1/cpg/users` | `rbac.users.manage` | Invite a user with a temporary password |
| `PATCH /api/v1/cpg/users/:id` | `rbac.users.manage` | Rename, deactivate or reactivate a user |
| `POST /api/v1/cpg/users/:id/grants` | `rbac.users.manage` | Grant a role |
| `POST /api/v1/cpg/grants/:id/revoke` | `rbac.users.manage` | Revoke a grant |
| `GET /api/v1/cpg/teams` | `org.members.read` | Teams and their repository patterns |
| `POST /api/v1/cpg/teams` | `rbac.teams.manage` | Create a team |
| `PATCH /api/v1/cpg/teams/:id` | `rbac.teams.manage` | Rename, change patterns, archive or unarchive a team |
| `GET /api/v1/cpg/settings` | `policy.read` | Governance settings |
| `PATCH /api/v1/cpg/settings` | `org.settings.manage` | Enable governance; switch reviewer-context generation |
| `GET /api/v1/cpg/audit` | `audit.read` | The hash-chained audit log |
| `POST /api/v1/tenants/:id/org-admins` | platform admin session or `admin` API key | Grant Org Admin to a user of an organization (recovery) |

---

### GET /api/v1/cpg/me

```json
{
  "user": { "id": "0b6c…", "name": "Ada", "email": "ada@example.com" },
  "orgId": "6f1c…",
  "cpgEnabled": false,
  "isPlatformAdmin": false,
  "permissions": [
    { "key": "case.read", "scope": "org", "scopeId": null },
    { "key": "case.review", "scope": "repo", "scopeId": "acme/payments-api" }
  ],
  "boards": [{ "id": "1a2b…", "name": "AI Review Board" }],
  "roles": [
    { "id": "3e9f…", "key": "developer", "name": "Developer", "isSystem": true },
    { "id": "2d8e…", "key": "org_admin", "name": "Org Admin", "isSystem": true }
  ],
  "identity": "session"
}
```

`boards` lists the active review boards the user is a member of. `roles` lists the roles behind
the user's active grants at any scope (archived roles excluded), sorted by key; it is empty for a
platform administrator.

`identity` is `session` or `user_key`. A platform administrator gets `200` with
`"isPlatformAdmin": true` and no permissions. A team- or repository-scoped grant lists only its
scopable permissions, because only those apply per scope.

### GET /api/v1/cpg/permissions

```json
{ "items": [ { "key": "case.review", "category": "case", "scopable": true, "description": "Propose snippet or bulk decisions, vote and request changes" } ] }
```

### Roles

`GET /api/v1/cpg/roles` returns `{ "items": [Role] }`, system roles first:

```json
{
  "id": "4d0e…",
  "key": "developer",
  "name": "Developer",
  "description": "Requests reviews and justifies findings. …",
  "isSystem": true,
  "permissions": ["case.comment", "case.create", "case.read", "ci.read", "org.api_keys.manage", "org.members.read", "org.profile.update", "policy.read"],
  "createdAt": "2026-10-08T12:00:00.000Z",
  "createdBy": "system:seed",
  "archivedAt": null,
  "archivedBy": null
}
```

`POST /api/v1/cpg/roles` creates a custom role and returns it with `201`:

| Field | Type | Notes |
|-------|------|-------|
| `key` | string | required; lowercase letters, digits and `_`, starting with a letter, at most 50; unique in the organization (`409 role_key_taken`) |
| `name` | string, 1 to 100, single line | required |
| `description` | string up to 500 | optional |
| `permissions` | array of permission keys, no repeats | required (may be empty) |

`PATCH /api/v1/cpg/roles/:id` takes any of `name`, `description`, `permissions` (the full new set)
and returns the role. System roles can be edited, except that the Org Admin role must keep
`rbac.users.manage` and `rbac.roles.manage`.

`POST /api/v1/cpg/roles/:id/archive` with `{}` archives a custom role and returns it. Archiving an
archived role returns it unchanged. System roles answer `403` (`details.reason: "system_role"`).

### Users and grants

`GET /api/v1/cpg/users` returns `{ "items": [OrgUser] }`:

```json
{
  "id": "0b6c…",
  "name": "Ada",
  "email": "ada@example.com",
  "isActive": true,
  "mustChangePassword": false,
  "grants": [
    {
      "id": "9a51…", "userId": "0b6c…", "roleId": "4d0e…", "roleKey": "developer", "roleName": "Developer",
      "scopeType": "org", "scopeId": null, "grantedBy": "system:rbac-migration", "grantedAt": "2026-10-08T12:00:00.000Z",
      "revokedAt": null, "revokedBy": null, "revokeReason": null
    }
  ],
  "boards": [{ "id": "1a2b…", "name": "AI Review Board" }]
}
```

`POST /api/v1/cpg/users` invites a user into your organization:

```json
{ "email": "lin@example.com", "name": "Lin", "roleKeys": ["policy_author"] }
```

The response (`201`) is `{ "user": OrgUser, "tempPassword": "nomus-…" }`. The temporary password is
returned once; when email is configured (`NOMUS_RESEND_API_KEY`) the invitation is also emailed.
The user gets Developer plus the roles in `roleKeys` (unknown or archived keys: `400` with
`details.roleKeys`) and must change the password at first sign-in. A password cannot be chosen for
the user.

`PATCH /api/v1/cpg/users/:id` takes `name` and/or `isActive` and returns the user. You cannot
deactivate yourself (`409 cannot_deactivate_self`), the last active Org Admin
(`409 last_org_admin`) or a platform administrator (`403`, `details.reason: "platform_admin"`).

`POST /api/v1/cpg/users/:id/grants` grants a role:

| Field | Type | Notes |
|-------|------|-------|
| `roleId` | UUID | a non-archived role of your organization |
| `scopeType` | `org`, `team` or `repo` | |
| `scopeId` | string | omit for `org`; a team id for `team`; a canonical repository id such as `acme/api` for `repo` |

Returns the grant with `201`. If the user already holds the same role with the same scope, the
existing grant is returned with `200` instead of creating a duplicate.

`POST /api/v1/cpg/grants/:id/revoke` with `{ "reason": "…" }` (1 to 500 characters) revokes a grant
and returns it with `revokedAt`, `revokedBy` and `revokeReason` set. Revocations cannot be undone or
edited; grant the role again instead.

### Teams

`POST /api/v1/cpg/teams`:

```json
{ "key": "payments", "name": "Payments", "repoPatterns": ["acme/payments-*", "acme/ledger"] }
```

Returns `201` with `{ "id", "key", "name", "repoPatterns", "createdAt", "createdBy", "archivedAt" }`.
`PATCH /api/v1/cpg/teams/:id` takes any of `name`, `repoPatterns` (the full new list) and
`archived` (`true` or `false`). Pattern rules are in the
[admin guide](../admin-guide/roles-and-permissions.md#team-repository-patterns).

### Settings

`GET /api/v1/cpg/settings`:

```json
{
  "orgId": "6f1c…",
  "enabled": false,
  "reviewerContextLlm": true,
  "llmProviderConfigured": true,
  "rbacMigratedAt": "2026-10-08T12:00:00.000Z",
  "updatedAt": "2026-10-08T12:00:00.000Z",
  "updatedBy": "system:seed"
}
```

`PATCH /api/v1/cpg/settings` takes `enabled` and/or `reviewerContextLlm` (booleans) and returns the
settings. When `reviewerContextLlm` is on, flagged snippets are sent to this instance's configured
LLM provider to generate reviewer context; `llmProviderConfigured` tells you whether one is set up.

### GET /api/v1/cpg/audit

Query parameters, all optional: `action` (exact match, for example `grant.created`), `since` and
`until` (ISO-8601), `limit` (1 to 200, default 50) and `cursor` (the `nextCursor` of the previous
page).

```json
{
  "items": [
    {
      "id": "c2a7…",
      "seq": 12,
      "actor": "user:0b6c…",
      "action": "role.permissions_changed",
      "targetType": "role",
      "targetId": "4d0e…",
      "payload": { "key": "developer", "before": ["…"], "after": ["…"], "added": [], "removed": ["org.api_keys.manage"] },
      "prevHash": "5f3e…",
      "hash": "a91d…",
      "createdAt": "2026-10-08T12:10:00.000Z"
    }
  ],
  "nextCursor": "c2VxOjEy",
  "chainValid": true
}
```

Events are newest first. `hash` is
`sha256(prevHash + canonicalJSON({id, org_id, seq, actor, action, target_type, target_id, payload, created_at}))`,
where canonical JSON sorts object keys at every level; the first event of an organization chains
from 64 zeros. `chainValid` re-verifies the whole chain on every call.

Actions recorded in this release: `settings.initialized`, `rbac.roles_seeded`, `rbac.migrated`,
`role.created`, `role.updated`, `role.permissions_changed`, `role.archived`, `user.invited`,
`user.updated`, `grant.created`, `grant.revoked`, `team.created`, `team.updated`,
`settings.updated`; and, for the policy registry, `board.created`, `board.updated`,
`board.archived`, `board.member_added`, `board.member_removed`, `quorum.version_created`,
`policy.version_proposed`, `policy.retirement_proposed`, `policy.vote_cast`, `policy.activated`,
`policy.retired`, `policy.version_rejected`, `policy.version_withdrawn` and
`policy.proposal_expired`. Payloads carry identifiers, hashes and settings, never source code.

### POST /api/v1/tenants/:id/org-admins

Platform administrators only (session or `admin` API key). Body `{ "userId": "<uuid>" }`; the user
must belong to organization `:id`. Grants Org Admin org-wide and returns the grant (`201`, or `200`
if the user already holds it). Use it to recover an organization that has no Org Admin.

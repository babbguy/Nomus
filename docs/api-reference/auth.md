# Authentication Endpoints

Endpoints under `/api/v1/auth/` (source: `engine/src/server/routes/auth.ts`, `oauth.ts`,
`github-oauth.ts`, `device-auth.ts`). Examples use the local engine, `http://localhost:3100`.

There is no self-service registration endpoint. The first admin account is created from
`NOMUS_ADMIN_EMAIL` / `NOMUS_ADMIN_PASSWORD` on first boot; further users are added by an admin in
the dashboard (Users / Team pages).

---

## Credentials at a glance

| Credential | How you get it | How you send it |
|------------|----------------|-----------------|
| Session | `POST /api/v1/auth/login` | `nomus_session` cookie (httpOnly, `SameSite=Lax`, `Secure` when `NOMUS_ENV=production`, 7 day TTL) |
| API key | Dashboard Settings, API Keys, or `POST /api/v1/org/api-keys` (any signed-in user, for their own organization); `POST /api/v1/tenants/:id/api-keys` or Admin, Tenants (platform admins, any organization) | `Authorization: Bearer nk_live_...` |
| Bootstrap key | The value of `NOMUS_ADMIN_BOOTSTRAP_KEY`, stored hashed as an `admin`-scoped key on first boot | `Authorization: Bearer <that value>` |

Session-only endpoints (`/me`, `/logout`, `/profile`, `/force-change-password`) read the cookie and
ignore the `Authorization` header.

---

## POST /api/v1/auth/login

Email and password login. Sets the `nomus_session` cookie.

**Rate limit:** 10 requests/minute per IP (`429` `{"error":"Too many requests. Try again later."}`).

```bash
curl -i -X POST http://localhost:3100/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"your-password"}'
```

Response `200`:

```json
{
  "user": {
    "id": "0b6c1c0e-....",
    "email": "you@example.com",
    "name": "Platform Admin",
    "role": "platform_admin",
    "mustChangePassword": false
  },
  "org": { "id": "5d1f....", "name": "Nomus Admin", "slug": "nomus-admin" }
}
```

| Status | Body |
|--------|------|
| 400 | `{"error":"Email and password are required"}` |
| 401 | `{"error":"Invalid email or password"}` (response time is padded to blunt user enumeration) |
| 429 | per-IP limit exceeded |

If `mustChangePassword` is `true` the dashboard routes the user to `/change-password`. The API enforces this too: until the password is changed, the session may only call `GET /auth/me`, `POST /auth/force-change-password` and `POST /auth/logout`. Every other session-authenticated endpoint (including `PATCH /auth/profile`, the `/org` routes, and the VS Code device sign-in callback) answers `403` with `{ "error": "...", "status": 403, "code": "password_change_required" }`. Organization API keys are not affected; a user-bound key (the VS Code extension key) is refused in the same way until its user has changed the password.

---

## POST /api/v1/auth/logout

Deletes the server-side session and clears the cookie.

```json
{ "message": "Logged out" }
```

---

## GET /api/v1/auth/me

Returns the current session user.

Response `200` has the same `user` and `org` objects as login. `401` with
`{"error":"Not authenticated"}`, `{"error":"Session expired"}` or `{"error":"User not found"}`
otherwise.

---

## PATCH /api/v1/auth/profile

Update your own profile (session required).

| Field | Type | Notes |
|-------|------|-------|
| `name` | string, 1-200 | optional |
| `email` | string, valid email | optional; requires `currentPassword`; `409` if already in use |
| `currentPassword` | string | required with `email` or `newPassword` |
| `newPassword` | string, 8-256 | optional; requires `currentPassword` |

Response `200`: `{"message":"Profile updated"}`. `400` for validation failures, a wrong current
password, or OAuth-only accounts (no local password).

---

## POST /api/v1/auth/force-change-password

For accounts flagged `mustChangePassword` (session required).

```json
{ "password": "a-new-password-of-8-or-more-chars" }
```

Response `200`: `{"message":"Password changed successfully"}`. `400` if no change is required or
the password is shorter than 8 characters.

---

## POST /api/v1/auth/forgot-password

**Rate limit:** 3 requests/minute per IP.

```json
{ "email": "you@example.com" }
```

Always responds `200` with `{"message":"If that email exists, a reset link has been sent."}` to
avoid revealing which addresses have accounts. The reset token is valid for 1 hour. An email is
sent only if `NOMUS_RESEND_API_KEY` (and `NOMUS_FROM_EMAIL`) are configured; otherwise no email goes
out and the link is not delivered anywhere, so an admin must reset the password another way.

---

## POST /api/v1/auth/reset-password

**Rate limit:** 5 requests/minute per IP.

```json
{ "token": "<token from the reset link>", "password": "a-new-password" }
```

| Status | Body |
|--------|------|
| 200 | `{"message":"Password reset successfully. You can now login."}` (all existing sessions for the user are deleted) |
| 400 | `{"error":"Token and password required"}`, `{"error":"Password must be at least 8 characters"}` or `{"error":"Invalid or expired reset token"}` |

---

## OAuth

### Google: GET /api/v1/auth/oauth/google

Redirects to Google. Requires `NOMUS_GOOGLE_CLIENT_ID` and `NOMUS_GOOGLE_CLIENT_SECRET`; returns
`503 {"error":"Google OAuth not configured"}` otherwise. The callback is
`/api/v1/auth/oauth/google/callback`; the redirect URI registered with Google must be
`<NOMUS_CORS_ORIGIN>/api/v1/auth/oauth/google/callback` (for example `http://localhost:5173/...` for `npm run dev:dashboard`, which proxies `/api` to the engine). On failure the browser is sent to
`/login?error=google_auth_failed`.

### GitHub: GET /api/v1/auth/github

Redirects to GitHub. Requires `NOMUS_GITHUB_CLIENT_ID` and `NOMUS_GITHUB_CLIENT_SECRET`; returns
`503 {"error":"GitHub OAuth not configured"}` otherwise. The engine sends GitHub the redirect URI
`<NOMUS_CORS_ORIGIN>/api/v1/auth/github/callback`, which the bundled dashboard and nginx configs
proxy to the engine. Register that URL as the callback in your GitHub OAuth app.

### GitHub: GET /api/v1/auth/github/callback

Handles the redirect from GitHub (`code` and `state` query parameters; `400` if either is
missing or the state is invalid or expired). Accounts are not created on sign-in: the GitHub
account's email must match an existing user, otherwise the browser is sent to
`/login?error=no_account`. The dashboard login page currently offers Google sign-in only, so
GitHub sign-in is reached by linking to `/api/v1/auth/github` directly.

---

## Device auth (VS Code extension)

A three-step flow that lets the VS Code extension obtain an API key through a browser login. The
callback URI must use the `vscode://` scheme.

1. `GET /api/v1/auth/device/authorize?state=<random>&callback_uri=vscode://...` stores the state and
   redirects to `<NOMUS_CORS_ORIGIN>/login?device_state=<state>`.
2. After the user logs in, `GET /api/v1/auth/device/callback?device_state=<state>` (session cookie
   required) redirects to `callback_uri?code=<code>&state=<state>`. The code is single use and lives
   60 seconds.
3. `POST /api/v1/auth/device/token` with `{"code":"<code>"}` returns:

   ```json
   { "apiKey": "nk_live_...", "orgName": "Nomus Admin", "userEmail": "you@example.com" }
   ```

   The key is labeled "VS Code Extension" with scopes `read:policies`, `evaluate`, `stream`, and is
   **bound to the user who signed in**: it acts as that user, stops working when the user is
   deactivated or moved to another organization, and gets `403 password_change_required` while the
   user has a temporary password. Signing in again revokes only that user's earlier extension key;
   other users' keys are not affected. (Before v1.2.0 the key was organization-wide and any earlier
   "VS Code Extension" key in the organization was revoked.)

Errors are `400` (missing or invalid state or code), `401` (not logged in), `429` (too many pending
requests).

---

## API keys

Signed-in users create and revoke keys for their own organization with the self-service
[`/api/v1/org/api-keys`](./org.md#api-keys) endpoints (scopes `read:policies`, `evaluate`, `stream`;
never `admin`). The `/tenants` endpoints below manage keys for any organization and require an
`admin`-scoped credential (an admin session or an admin key).

### Create: POST /api/v1/tenants/:orgId/api-keys

```bash
curl -X POST http://localhost:3100/api/v1/tenants/<orgId>/api-keys \
  -H "Authorization: Bearer $NOMUS_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label":"CI scanner","scopes":["evaluate","read:policies"],"expiresAt":"2027-01-01T00:00:00Z"}'
```

| Field | Type | Notes |
|-------|------|-------|
| `label` | string, 1-100 | required |
| `scopes` | array, at least 1 of `read:policies`, `stream`, `evaluate`, `admin` | required |
| `expiresAt` | ISO-8601 datetime with offset, or `null` | optional |

Response `201` (the raw key is shown once and cannot be retrieved again):

```json
{
  "id": "....",
  "key": "nk_live_...",
  "prefix": "nk_live_xxxx",
  "label": "CI scanner",
  "scopes": ["evaluate", "read:policies"],
  "rateLimitRpm": 600,
  "message": "Store this key securely - it cannot be retrieved again."
}
```

Errors: `400` invalid input or `{"error":"API key limit reached (100)"}` (see
`NOMUS_MAX_API_KEYS_PER_ORG`), `404` organization not found.

### List and revoke

- `GET /api/v1/tenants/:orgId/api-keys` lists keys (the hash is never returned).
- `DELETE /api/v1/tenants/:orgId/api-keys/:keyId` revokes a key: `{"message":"API key revoked"}`.

The dashboard exposes the same operations under Settings, API Keys.

---

## Security notes

- Keys and tokens are stored as SHA-256 hashes; passwords as bcrypt hashes.
- The bootstrap key is an `admin`-scoped API key created once, on first boot. Editing the value in `.env`
  later does not change the stored key; to retire it, revoke it with `DELETE /api/v1/tenants/:orgId/api-keys/:keyId`
  after creating a key of your own.
- The GitHub App webhook scanner calls the engine with the bootstrap key, so revoking it breaks GitHub App scans.
- The per-IP limits read `X-Forwarded-For` / `X-Real-IP`; only deploy behind a reverse proxy that
  overwrites those headers.
- Use the narrowest scopes a key needs and give integrations their own keys.

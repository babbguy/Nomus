# Governance: integrations (`/api/v1/cpg/integrations`, `/api/v1/cpg/deliveries`)

Integrations send review-case notifications by email (through the instance's Resend account), to
Jira Cloud, and to any HTTPS endpoint as a signed JSON webhook. Authentication, the error envelope
and the general conventions are the same as on the [Governance](./governance.md) page. Every
endpoint needs a browser session.

**No code leaves Nomus.** A notification carries a summary (case reference, repository, branch,
pull request, board, counts and the policies involved) and a link into Nomus. It never carries
source code, snippets, justifications, comments, reviewer context, policy text or file paths. The
payload is built from a fixed, allow-listed summary, and anything else is rejected before sending.

## Endpoints

| Method and path | Permission | Purpose |
|-----------------|------------|---------|
| `GET /api/v1/cpg/integrations` | `integrations.manage` | `{items: Integration[]}`; secrets appear only as `secretLast4` |
| `POST /api/v1/cpg/integrations` | `integrations.manage` | Create; `201 {integration, secret?}`. A webhook's signing secret is in this response only |
| `PATCH /api/v1/cpg/integrations/:id` | `integrations.manage` | Change `name`, `boardIds`, `events`, `enabled` or the whole `config` |
| `POST /api/v1/cpg/integrations/:id/rotate-secret` | `integrations.manage` | Jira: `{apiToken}`; webhook: `{}` (a new secret is generated and returned once) |
| `POST /api/v1/cpg/integrations/:id/test` | `integrations.manage` | `{}`; sends an `integration.test` notification now and returns the delivery (`201`) |
| `GET /api/v1/cpg/deliveries` | `integrations.manage` or `audit.read` | The delivery log, newest first, with every attempt (`?integrationId`, `?caseId`, `?status`, `?limit` 1–200, `?cursor`) |
| `POST /api/v1/cpg/deliveries/:id/retry` | `integrations.manage` | `{}`; sends a `failed` delivery again as a new delivery naming it in `retryOf` (`201`); anything else is `409 delivery_not_failed` |

Every create, change and rotation is written to the audit log (`integration.created`,
`integration.updated`, `integration.secret_rotated`, `delivery.retried`) without the secret. A
delivery that fails for good writes `delivery.failed`.

## Creating an integration

Common fields: `name` (1–100 characters), `events` (at least one of the events below), `boardIds`
(board ids; `[]` means every board) and `enabled` (default `true`).

```json
{ "kind": "email", "name": "Governance email", "events": ["case.review_requested", "case.changes_requested"],
  "config": { "includeBoardMembers": true, "notifyDevelopers": true, "extraRecipients": ["governance@example.com"] } }

{ "kind": "jira", "name": "Jira GOV", "events": ["case.review_requested", "case.changes_requested", "decision.recorded", "case.closed"],
  "apiToken": "<Atlassian API token>",
  "config": { "baseUrl": "https://example.atlassian.net", "accountEmail": "nomus-bot@example.com", "projectKey": "GOV",
              "issueType": "Task", "labels": ["nomus"] } }

{ "kind": "webhook", "name": "Chat bridge", "events": ["case.review_requested", "case.closed"],
  "config": { "url": "https://hooks.example.com/nomus" } }
```

Jira and webhook URLs must be HTTPS and must not point at a private, loopback, link-local or cloud
metadata address (`400 invalid_input`); they are checked again before every send, and redirects
are not followed. `NOMUS_CPG_ALLOW_PRIVATE_TARGETS=true` lifts this for test environments only.

## Events

| Event | When | Routed to | Email recipients by default | Jira |
|-------|------|-----------|-----------------------------|------|
| `case.review_requested` | Review is requested with new findings, or the case is resubmitted | Each lane (owning board) with a blocking finding | The board's active members | Creates the lane's issue, or comments |
| `case.changes_requested` | A board member requests changes | That board's lane | The case opener and the justification authors | Comment |
| `case.replied` | A reply on the case | The change request's lane, or every lane | The board's active members | Comment |
| `decision.recorded` | A snippet or bulk decision is finalized | The lanes of the policy's owning boards | none | Comment |
| `case.closed` | The case is closed | Every lane it notified | none | Comment |
| `exception.expiring` / `exception.expired` | The daily sweep finds an approval or standing exception within 7 days of, or past, its expiry | The policy's owning boards | The board's active members | none |
| `integration.test` | `POST …/test` | - | The caller | A test issue |

A case whose findings belong to several boards is split: each board gets its own notification and,
in Jira, its own issue. `extraRecipients` receive every event the email integration subscribes to.
Recipients are resolved when the event happens and stored with the delivery.

## Jira

Nomus uses Jira Cloud REST v3 with HTTP Basic authentication (`accountEmail:apiToken`). The first
notification of a lane creates one issue (`POST /rest/api/3/issue`) labelled
`nomus-cpg-<ref>-<board>`; every later one adds a comment (`POST /rest/api/3/issue/{key}/comment`).
Before creating, Nomus searches for that label (`GET /rest/api/3/search/jql`), so a lane never gets
a second issue, even after a crash. Nomus does not transition issues.

## Webhook

```http
POST https://hooks.example.com/nomus
Content-Type: application/json
User-Agent: Nomus/1.2
X-Nomus-Event: case.review_requested
X-Nomus-Delivery-Id: 6f1c2b8e-0d4a-4c7e-9a51-2f7d3e8b1c90
X-Nomus-Timestamp: 2026-10-08T12:00:00.000Z
X-Nomus-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>
X-Nomus-Signature-V2: sha256=<the same value>
```

```json
{
  "event": "case.review_requested",
  "deliveryId": "6f1c2b8e-0d4a-4c7e-9a51-2f7d3e8b1c90",
  "occurredAt": "2026-10-08T11:59:59.512Z",
  "org": { "id": "0b6d1c55-3f1e-4f43-8f0e-6a2c4d9e7b11", "slug": "example", "name": "Example Org" },
  "case": {
    "id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "ref": "CPG-1A2B3C4D", "repo": "example/payments", "branch": "feat/llm-gateway",
    "prNumber": 42, "state": "in_review", "revision": 1, "url": "https://nomus.example.com/governance/cases/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
  },
  "board": { "id": "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f", "name": "AI Review Board" },
  "counts": { "blocking": 2, "advisory": 0, "approved": 0, "rejected": 0, "excepted": 0,
              "byTier": { "review-required": 1, "prohibited": 1 }, "files": 2 },
  "policies": [ { "key": "corp.no-direct-openai", "version": 2, "title": "Call OpenAI only through the gateway", "tier": "prohibited" } ],
  "decision": null,
  "link": "https://nomus.example.com/governance/cases/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
}
```

`case`, `board` and `counts` are `null` when the event has none (an expiring standing exception, a
test); `decision` is set for `decision.recorded` and the exception events. `files` is a count: file
paths are never sent.

**Verifying a delivery.** Compute HMAC-SHA256 with your secret over the exact
`X-Nomus-Timestamp` value, a `.`, and the raw request body; compare `sha256=<hex>` with
`X-Nomus-Signature` in constant time; reject the request when the timestamp is more than 300 seconds
from your clock; and ignore a `X-Nomus-Delivery-Id` you have already processed. Every attempt is
signed afresh with a new timestamp; the delivery id stays the same.

```js
import crypto from 'node:crypto';

function verify(req, rawBody, secret) {
  const ts = req.headers['x-nomus-timestamp'];
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`;
  const given = String(req.headers['x-nomus-signature'] ?? '');
  const fresh = Math.abs(Date.now() - Date.parse(ts)) <= 300_000;
  return fresh && given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

Test vector: secret `whsec_test_0123456789abcdef`, timestamp `2026-10-08T12:00:00.000Z`, body
`{"event":"case.opened"}` gives
`sha256=ec3cfbb8f700616d43cc5930536aa63d8864e4de224a88f97519144da18911d1`.

After a secret rotation, deliveries are signed with the new secret at their next attempt: accept
both secrets while you switch.

## Deliveries and retries

A notification is queued in the same database transaction as the change that caused it, so it is
never lost and never sent for a change that was rolled back, and it never delays or fails that
change. A worker sends due deliveries in the background. Each attempt is recorded with its HTTP
status, duration, error and the first 500 characters of the response.

Network errors, timeouts (10 s), `5xx`, `408` and `429` (honouring `Retry-After` up to an hour) are
retried after 10 s, 1 min, 5 min, 30 min, 2 h, 6 h and 12 h: 8 attempts over about 21 hours. The
schedule is stored, so it survives restarts. Any other response, including a redirect, fails at
once: it means the configuration is wrong. A delivery that fails for good is logged at error level
and audited; fix the integration, then retry it.

```json
{
  "id": "6f1c2b8e-0d4a-4c7e-9a51-2f7d3e8b1c90", "integrationId": "…", "channel": "webhook", "event": "case.review_requested",
  "caseId": "…", "boardId": "…", "payload": { "summary": { "…": "the summary above" } }, "payloadSha256": "…", "retryOf": null,
  "status": "delivered", "attempts": 2, "nextAttemptAt": null, "createdAt": "…", "updatedAt": "…",
  "attemptHistory": [
    { "attempt": 1, "startedAt": "…", "durationMs": 31, "httpStatus": 503, "error": "HTTP 503", "responseExcerpt": "unavailable" },
    { "attempt": 2, "startedAt": "…", "durationMs": 12, "httpStatus": 200, "error": null, "responseExcerpt": "ok" }
  ]
}
```

`status` is `pending`, `delivered`, `failed` or `cancelled` (the integration was disabled before
the delivery was sent). An email delivery's `payload` also lists its `recipients`.

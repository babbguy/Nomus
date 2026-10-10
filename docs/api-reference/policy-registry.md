# Governance: boards, quorum and the corporate policy registry (`/api/v1/cpg`)

Endpoints for review boards, the approval quorum, the policy compile step, the corporate policy
log and the signed policy bundle that scanners download. For the workflow behind them read
[Corporate policies](../admin-guide/corporate-policies.md). Authentication, the error envelope
and the general conventions are the same as on the [Governance](./governance.md) page.

Every route acts on the organization of the caller. An id that belongs to another organization
answers `404`, never `403`.

## Authentication

| Credential | Accepted by |
|------------|-------------|
| Session cookie (`nomus_session`) | every endpoint on this page |
| User-bound API key (VS Code sign-in) | the reads `GET /cpg/boards`, `GET /cpg/policies`, `GET /cpg/policies/:id` and `GET /cpg/bundle`; it acts as its user |
| Organization API key with `read:policies` | `GET /cpg/bundle` only (scanners and CI); every other endpoint answers `403 user_identity_required` |

A session or user-bound key whose user has a temporary password gets
`403 password_change_required` first, on every endpoint.

## Endpoints

| Method and path | Permission | Purpose |
|-----------------|------------|---------|
| `GET /api/v1/cpg/boards` | `policy.read` | Review boards (members included for `boards.manage` holders) |
| `POST /api/v1/cpg/boards` | `boards.manage` | Create a board |
| `PATCH /api/v1/cpg/boards/:id` | `boards.manage` | Rename or describe a board |
| `POST /api/v1/cpg/boards/:id/archive` | `boards.manage` | Archive a board (refused while it owns an active or pending policy version) |
| `POST /api/v1/cpg/boards/:id/members` | `boards.manage` | Add a member |
| `POST /api/v1/cpg/boards/:id/members/:userId/remove` | `boards.manage` | Remove a member |
| `GET /api/v1/cpg/quorum` | `policy.read` | The quorum configuration in force (signed) |
| `PUT /api/v1/cpg/quorum` | `quorum.manage` | Create a new quorum version |
| `GET /api/v1/cpg/quorum/versions` | `audit.read` or `quorum.manage` | Version history |
| `GET /api/v1/cpg/quorum/versions/:version` | `audit.read` or `quorum.manage` | One version, exactly as it applied |
| `POST /api/v1/cpg/compile` | `policy.author` | Compile plain English into a rule (always recorded) |
| `GET /api/v1/cpg/compile/:id` | `policy.author` or `policy.approve` | A compile record |
| `GET /api/v1/cpg/policies` | `policy.read` | The policy log (`?state=draft\|proposed\|active\|retired`) |
| `POST /api/v1/cpg/policies` | `policy.author` | Propose a new policy from a compiled record |
| `GET /api/v1/cpg/policies/:id` | `policy.read` | A policy with every version, event and vote |
| `POST /api/v1/cpg/policies/:id/versions` | `policy.author` | Propose a new version |
| `POST /api/v1/cpg/policies/:id/retire` | `policy.author` | Propose retiring an active policy |
| `POST /api/v1/cpg/policy-versions/:id/votes` | `policy.approve`, and not the author or compile requester | Approve or reject a pending version |
| `POST /api/v1/cpg/policy-versions/:id/withdraw` | the author of the version | Withdraw a pending proposal |
| `GET /api/v1/cpg/bundle` | API key or session with `read:policies` | The signed corporate policy bundle |
| `GET /api/v1/cpg/policies/export` | `audit.export` | A signed export of the whole policy log |

Error codes added by these endpoints, besides those on the [Governance](./governance.md) page:

| HTTP | `code` | When |
|------|--------|------|
| 403 | `self_approval_forbidden` | The version's author or the compile requester tried to vote |
| 409 | `board_key_taken`, `policy_key_taken` | The key already exists in the organization |
| 409 | `board_archived`, `already_member`, `user_inactive` | Board membership changes that cannot apply |
| 409 | `board_in_use` | Archiving a board that owns an active or pending version (`details.policyKeys`) |
| 409 | `version_pending` | The policy already has a pending version |
| 409 | `proposal_not_pending` | Voting on or withdrawing a version that is not pending (`details.reason: "lapsed"` when it just expired) |
| 409 | `already_voted` | You already voted on this version |
| 409 | `compile_record_used` | A compile record backs at most one version |
| 409 | `policy_retired`, `policy_not_active` | A retired policy takes no new version; only an active policy can be retired |
| 422 | `compile_not_successful` | The compile record's status is not `compiled` |
| 422 | `compile_policy_mismatch` | The compile record was made for another policy |
| 422 | `rule_validation_failed` | An edited rule fails validation (`details.reasons`) |
| 422 | `rule_examples_failed` | An edited rule fails the compile record's examples (`details.exampleResults`) |
| 422 | `unknown_board` | An owning or extra board is not an active board of the organization |
| 422 | `unknown_policy`, `bulk_forbidden_on_prohibited` | Quorum overrides name an unknown policy, or enable bulk decisions on a prohibited one |
| 422 | `enforce_from_in_past` | `enforceFrom` is in the past |
| 503 | `signing_unavailable` | The instance signing key is not initialized |

---

## Boards

```json
{
  "id": "1a2b…", "key": "ai-review", "name": "AI Review Board", "kind": "ai", "description": "",
  "createdAt": "2026-10-08T09:00:00.000Z", "createdBy": "user:0b6c…", "archivedAt": null, "archivedBy": null,
  "memberCount": 2,
  "members": [{ "id": "…", "boardId": "1a2b…", "userId": "…", "userName": "…", "userEmail": "…", "addedAt": "…", "addedBy": "user:…", "removedAt": null, "removedBy": null }]
}
```

`POST /cpg/boards` takes `{ "key", "name", "kind", "description"? }`. `key` is lowercase letters,
digits, `_` and `-`, starting with a letter; `kind` is `governance`, `legal`, `ai`, `security` or
`custom`. `members` is `null` for callers without `boards.manage`. `GET /cpg/me` and
`GET /cpg/users` list each user's active boards.

## Quorum

`GET /cpg/quorum` and `GET /cpg/quorum/versions/:version` return:

```json
{
  "version": 2,
  "config": { "schemaVersion": 1, "tiers": { "advisory": { "blocking": false }, "review-required": { … }, "prohibited": { … } },
              "policyOverrides": {}, "policyApproval": { "approvals": 1 },
              "standingExceptions": { "maxExpiryDays": 90, "defaultExpiryDays": 30, "allowOrgWideRepoPatterns": false },
              "gracePeriod": { "newPolicyDefaultDays": 14, "newVersionDefaultDays": 0 }, "proposalLapseDays": 30 },
  "configHash": "<sha256 of the canonical config>",
  "changeNote": "Longer proposal window",
  "createdAt": "2026-10-08T09:00:00.000Z",
  "createdBy": "user:0b6c…",
  "signature": "<Ed25519, base64>"
}
```

`PUT /cpg/quorum` takes `{ "config": <the whole config>, "changeNote": "…" }` and answers `201`
with the new version. A change is always a new version; to roll back, put an old config again.
The signature covers
`canonicalJSON({ kind: "nomus.cpg-quorum.v1", orgId, version, configHash, createdAt })` and
verifies against the key at `/.well-known/nomus-keys`. Version 1 is created by `system:seed` the
first time the organization's quorum is needed.

The schema refuses bulk decisions on the `prohibited` tier, advisory findings that block, and any
setting that would let a person approve their own proposal. The field-by-field reference is in
[Corporate policies](../admin-guide/corporate-policies.md#the-approval-quorum).

## Compile

`POST /cpg/compile`:

```json
{
  "plainText": "Do not call OpenAI directly; use the approved LLM gateway.",
  "policyId": "<optional: compiling a new version of this policy>",
  "examples": {
    "violating": [{ "path": "src/app/chat.ts", "code": "…" }],
    "compliant": [{ "path": "src/llm/gateway/client.ts", "code": "…" }]
  }
}
```

At least one violating example is required; at most 10 of each, 16 KiB each. Only `plainText` is
sent to the LLM provider. The examples stay on the server and are checked with the same
deterministic matcher the scanner runs.

The answer is always `201` with the compile record, whatever the outcome, including a provider
failure:

| `status` | Meaning |
|----------|---------|
| `compiled` | A valid rule that passes every example; it can be proposed |
| `rejected_unexpressible` | The policy cannot be decided deterministically; `rejection.reasons[0]` says why |
| `rejected_schema` | The model's answer was not the expected JSON |
| `rejected_validation` | The rule breaks the vocabulary, regex-safety or glob rules (every reason listed) |
| `rejected_examples` | The rule misses a violating example or flags a compliant one (`exampleResults`) |
| `llm_error` | The provider failed or none is configured; nothing was compiled |

```json
{
  "id": "…", "policyId": null, "requestedBy": "user:…", "status": "compiled",
  "inputText": "…", "inputHash": "…", "promptVersion": 1, "provider": "openai", "model": "…",
  "rejection": null,
  "suggestion": { "expressible": true, "suggestedKey": "corp.no-direct-openai", "title": "No direct OpenAI calls",
                  "suggestedTier": "prohibited", "rationale": "…", "limitations": ["…"] },
  "compiledRule": { "schemaVersion": 1, "match": { … }, "files": { … }, "snippet": { … }, "message": "…" },
  "compiledRuleHash": "…",
  "examples": { "violating": [ … ], "compliant": [ … ] },
  "exampleResults": [{ "kind": "violating", "index": 0, "path": "src/app/chat.ts", "expected": "finding", "findings": 1, "lines": [4], "passed": true, "note": null }],
  "tokensIn": 1450, "tokensOut": 220, "createdAt": "…"
}
```

## The policy log

`POST /cpg/policies`:

```json
{
  "compileRecordId": "…",
  "policyKey": "corp.no-direct-openai",
  "title": "No direct OpenAI calls",
  "tier": "prohibited",
  "owningBoardIds": ["…", "…"],
  "rule": { "optional": "an edited rule" },
  "graceDays": 0
}
```

`policyKey` is `corp.` followed by lowercase letters, digits, `.`, `_` or `-`. Give `graceDays`
(0 to 365) or `enforceFrom` (an ISO-8601 instant, not in the past), not both; without either the
quorum's grace defaults apply. An edited `rule` is validated again and must still pass the compile
record's examples; the version then has `editedFromCompile: true` and the `proposed` event holds
the diff. `POST /cpg/policies/:id/versions` takes the same body without `policyKey`.
`POST /cpg/policies/:id/retire` takes `{ "reason": "…" }`.

These three answer `201` with the policy detail:

```json
{
  "policy": {
    "policyId": "…", "policyKey": "corp.no-direct-openai", "state": "active", "title": "…", "tier": "prohibited",
    "owningBoards": [{ "id": "…", "name": "AI Review Board" }], "activeVersion": 1,
    "enforceFrom": "2026-10-08T09:00:00.000Z", "inGracePeriod": false,
    "pendingVersionId": null, "pendingVersion": null, "pendingVersionKind": null, "latestVersion": 1,
    "createdAt": "…", "createdBy": "user:…", "updatedAt": "…"
  },
  "versions": [{ "id": "…", "version": 1, "kind": "define", "status": "active", "title": "…", "plainText": "…", "tier": "prohibited",
                 "owningBoards": [ … ], "rule": { … }, "ruleHash": "…", "compileRecordId": "…", "editedFromCompile": false,
                 "graceDays": 0, "enforceFromRequested": null, "enforceFrom": "…", "activatedAt": "…", "signature": "…",
                 "createdBy": "user:…", "createdAt": "…" }],
  "events": [{ "id": "…", "versionId": "…", "version": 1, "event": "proposed", "actor": "user:…", "details": { … }, "createdAt": "…" }],
  "votes": [{ "id": "…", "versionId": "…", "voterUserId": "…", "voterName": "…", "vote": "approve", "comment": "…", "quorumConfigVersion": 2, "createdAt": "…" }],
  "compileRecords": [{ "id": "…", "status": "compiled", "requestedBy": "user:…", "createdAt": "…" }],
  "requiredApprovals": 1
}
```

Policy `state` is `draft` (no active version and nothing pending), `proposed`, `active` or
`retired`. `pendingVersionKind` is `define` or `retire` for a pending version (a
retirement proposal is a `retire` version), and `null` when nothing is pending. Version `status` is `pending`, `active`, `superseded`, `rejected`, `withdrawn`,
`expired` (the proposal lapsed) or `retired`. Version events are `proposed`, `approved`,
`activated`, `superseded`, `rejected`, `withdrawn`, `expired_proposal` and `retired`.

`POST /cpg/policy-versions/:id/votes` takes `{ "vote": "approve" | "reject", "comment"? }` and
answers `201` with `{ "vote": { … }, "versionState": "pending" | "active" | "rejected" | "retired" }`.
One reject rejects the version. When the quorum's `policyApproval.approvals` approvals are in,
the version is activated in the same transaction and signed. The activation signature covers
`canonicalJSON({ kind: "nomus.cpg-policy.v1", orgId, policyId, policyKey, version, title, tier, owningBoardIds, ruleHash, enforceFrom, activatedAt })`.

## The bundle

`GET /cpg/bundle` is what the CLI, the GitHub Action and the VS Code extension download:

```json
{
  "kind": "nomus.cpg-bundle.v1",
  "enabled": true,
  "orgId": "…",
  "generatedAt": "…",
  "bundleHash": "<sha256>",
  "policies": [{ "policyId": "…", "policyKey": "corp.no-direct-openai", "version": 1, "title": "…", "tier": "prohibited",
                 "owningBoards": [{ "id": "…", "name": "…" }], "enforceFrom": "…", "activatedAt": "…",
                 "rule": { … }, "ruleHash": "…", "activationSignature": "…" }],
  "minScannerVersion": "1.2.0",
  "signature": "<Ed25519 over canonicalJSON({kind, orgId, enabled, bundleHash, generatedAt})>"
}
```

- `policies` holds every active policy, sorted by `policyKey`, including those still in their
  grace period (their `enforceFrom` is in the future). It is empty while governance is disabled.
- `bundleHash` is `sha256(canonicalJSON({ policies }))` over the sorted policies without their
  `activationSignature`.
- The response has a strong `ETag`; send it back in `If-None-Match` to get `304 Not Modified`.
- An engine without corporate policy governance answers `404`; clients treat that as "no
  corporate policies" rather than as an error.

`@nomus/scanner/corporate` exports `fetchCorporateBundle` and `verifyCorporateBundle`, which check
the contract, the bundle signature, the bundle hash, every rule hash and every activation
signature, and fail closed on any mismatch.

## Export

`GET /cpg/policies/export?format=json` (only `json` is supported):

```json
{
  "kind": "nomus.cpg-policy-export.v1",
  "orgId": "…",
  "exportedAt": "…",
  "content": {
    "policies": [{ "policyId": "…", "policyKey": "…", "createdAt": "…", "createdBy": "…", "versions": [ … ], "events": [ … ], "votes": [ … ] }],
    "quorumVersions": [{ "version": 1, "configHash": "…", "changeNote": "…", "createdAt": "…", "createdBy": "system:seed", "signature": "…" }]
  },
  "contentHash": "<sha256(canonicalJSON(content))>",
  "signature": "<Ed25519 over canonicalJSON({kind, orgId, exportedAt, contentHash})>"
}
```

To verify offline: recompute `contentHash` from `content`, then verify `signature` with the public
key from `/.well-known/nomus-keys` (`keys[0].spki`, base64 SPKI DER). Each activation signature in
`events[].details.signature` and each quorum signature verifies the same way.

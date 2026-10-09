# Governance: approvals (`/api/v1/cpg/proposals`, `/api/v1/cpg/decisions`)

Reviewers decide the blocking findings of a [review case](./review-cases.md) by proposal and vote.
A **snippet** proposal decides one finding; a **bulk** proposal decides 2 to 500 findings of the
same policy version at once (each finding still gets its own decision and audit entry). Bulk is
never allowed on the `prohibited` tier, whatever the quorum configuration says. Authentication, the
error envelope and the general conventions are the same as on the [Governance](./governance.md)
page.

Proposing and voting need a browser session (API keys never vote) and corporate policies enabled.
Permissions are checked on the case's repository; an id of another organization answers `404`.

## Endpoints

| Method and path | Credential | Permission | Purpose |
|-----------------|------------|------------|---------|
| `POST /api/v1/cpg/proposals` | session | `case.review`, and an eligible voter | Propose a snippet or bulk decision; the proposer's vote is recorded with it |
| `GET /api/v1/cpg/proposals?caseId=` | session | `case.read` | The case's proposals, oldest first (`?scope`, `?status`) |
| `GET /api/v1/cpg/proposals?scope=standing` | session | `case.read` | Without `caseId`: the standing exception proposals whose repositories you can read, including those made outside a case (`?status`) |
| `GET /api/v1/cpg/proposals/:id` | session | `case.read` | One proposal: requirement, votes, derived status, and whether you may vote |
| `POST /api/v1/cpg/proposals/:id/votes` | session | `case.review`, and an eligible voter | Vote `approve` or `reject` |
| `GET /api/v1/cpg/decisions/:id` | session or user-bound key | `case.read` | A decision with its signed payload |
| `POST /api/v1/cpg/decisions/:id/revoke` | session | `decision.revoke` | Revoke a decision or standing exception |
| `GET /api/v1/cpg/exceptions` | session or user-bound key | `case.read` | Standing exceptions (`?active=true\|false`, `?repo`, `?policyKey`) |

## Proposing

```json
{
  "caseId": "<uuid>",
  "scope": "snippet",
  "outcome": "approve",
  "fingerprints": ["<sha256>:corp.no-direct-openai:1"],
  "expiresAt": "2026-11-08T12:00:00.000Z",
  "rationale": "Why the exception is acceptable and until when."
}
```

The fingerprints must be findings of the case's latest revision. An approval needs `expiresAt`,
after now and at most the configured maximum ahead (by default 180 days for `review-required` and
90 for `prohibited`); a rejection has no `expiresAt` and never expires. The answer is `201` with the
proposal: `{ "id", "status", "required", "quorumConfigVersionAtCreation", "votes", "decisionIds",
"invalidation", "revocations", "viewer", ... }`. `revocations` lists each revoked decision of the
proposal: `{ "decisionId", "revokedByName", "reason", "revokedAt" }`.

`required` is the requirement under the quorum configuration in force at creation: `approvals`,
`boardCoverage` (`all_owning`: an approving member of every required board; `any_owning`: of any),
`boardIds` (the policy's owning boards plus any extra boards, without archived ones),
`requiredPermission` and `maxExpiryDays`.

## Voting and finalization

A vote counts only from an **eligible voter**: `case.review` on the repository, an active member of
a required board, and not someone who opened the case, wrote a justification in it or created one
of its revisions. Self-approval is refused (`403 self_approval_forbidden`) whatever roles the voter
holds and whatever the configuration, and the database refuses it too. The boards and permissions
that made the voter eligible are stored with the vote.

After every vote the proposal is evaluated against the quorum configuration **in force at that
moment**:

- one eligible `reject` vote on an approval proposal vetoes it (`vetoed`, no decision);
- a rejection proposal is final at once, carried by its proposer's own vote;
- when the approvals, board coverage and required permission are met, the proposal is `finalized`
  and one signed decision is written per finding;
- if the requirement no longer holds (the scope is no longer allowed, no active board owns the
  policy, the expiry is beyond the new maximum, or the policy has a newer active version), the
  proposal is `invalidated` (`invalidation.reason`) and has to be proposed again.

`POST /proposals/:id/votes` takes `{ "vote": "approve" | "reject", "comment"? }` and answers `201`
with `{ "vote", "proposalStatus", "decisionIds" }`. A proposal's status is derived, in this order:
`finalized`, `vetoed`, `invalidated`, `void` (the case is closed), `lapsed` (after the configured
`proposalLapseDays`), `pending`.

## Decisions

A decision applies to its repository and fingerprint across branches; the latest one wins, so only
a later approval lifts a rejection. `GET /decisions/:id` answers `{ "id", "proposalId", "caseId",
"scope", "outcome", "repo", "fingerprint", "batchId" (the proposal id, for bulk), "expiresAt",
"approverUserIds", "quorumConfigVersion", "quorumConfigHash", "finalizedAt", "signedPayload",
"signature", "signatureValid" }`. `quorumConfigVersion` is the configuration whose quorum the votes
met (the version at finalization); the proposal keeps `quorumConfigVersionAtCreation`.

`signedPayload` is canonical JSON (keys sorted, no whitespace) signed with the instance Ed25519 key,
so it can be verified offline against `/.well-known/nomus-keys`:

```json
{"approverUserIds":["…"],"caseId":"…","expiresAt":"…","finalizedAt":"…","fingerprint":"…","id":"…",
 "kind":"nomus.cpg-decision.v1","orgId":"…","outcome":"approve","pattern":null,"policyActivationSignatureSha256":"<hex>",
 "policyKey":"corp.no-direct-openai","policyVersion":1,"proposalId":"…","quorumConfigHash":"<hex>",
 "quorumConfigVersion":3,"repo":"github.com/gate-org/policy-repo","scope":"snippet"}
```

## Standing exceptions

A standing exception covers **future** findings that match a pattern, so nobody has to propose a
decision for each one. It is pinned to one policy version: when the policy gets a new version, the
exception no longer matches and has to be proposed again.

```json
{
  "scope": "standing",
  "caseId": "<uuid, optional: the case it was proposed from>",
  "pattern": {
    "repos": ["github.com/gate-org/policy-repo"],
    "teamIds": [],
    "paths": ["src/legacy/**"],
    "excludePaths": [],
    "policyKey": "corp.no-direct-openai",
    "policyVersion": 1,
    "conditions": { "branches": ["feat/*"], "languages": ["typescript"], "maxLinesPerFinding": 20,
                    "snippetMustMatch": { "source": "legacyClient", "flags": "" } }
  },
  "expiresAt": "2026-11-08T12:00:00.000Z",
  "rationale": "Why the exception is acceptable and until when."
}
```

- A standing exception is always an approval and always expires: at most the smaller of the tier's
  standing maximum and `standingExceptions.maxExpiryDays` (90 days by default).
- Proposing needs `exception.propose` on every repository the pattern can touch: each listed
  repository, or an organization-wide grant when the pattern has a repository glob or a team. The
  proposer does not vote, and cannot vote on it later (`403 self_approval_forbidden`).
- Voters need `case.review` or `exception.approve` on the same repositories, and the quorum's
  `requiredPermission` (by default `exception.approve`) must be held by one approving voter.
- Nobody may vote who opened, justified or revised the case the exception was proposed from, or
  any open case whose findings the pattern covers (`403 self_approval_forbidden`).
- Globs follow the corporate rule syntax (`*`, `?`, `**`, `{a,b}`; no character classes). Repository
  patterns are lowercase; a wildcard in the host part (`*`, `**`, `*/*`) is organization-wide and
  is refused unless `standingExceptions.allowOrgWideRepoPatterns` is on.

A finding is **excepted** when every occurrence of it on the branch matches the pattern: the
repository (or a repository of a listed team, resolved when the finding is checked), a `paths` glob
and no `excludePaths` glob, and each condition present. `snippetMustMatch` is tested against the
stored, normalized snippet; when the server does not have it, the condition fails. A fingerprint
that is not part of the branch's open case is never excepted.

Resolution order for a blocking finding: its latest snippet or bulk decision first (a rejection
blocks and beats any exception; an unexpired approval passes), then a matching standing exception
(`excepted`, reported with `exceptionDecisionId` and the exception's `expiresAt`), otherwise
`pending`, `expired`, `changes_requested` or `needs_review`.

`GET /exceptions` answers `{ "items": [{ "id", "proposalId", "caseId", "policyId", "policyKey",
"policyVersion", "pattern", "expiresAt", "finalizedAt", "approverUserIds", "status" ("active",
"expired", "revoked" or "lapsed": its policy version is no longer the active one), "revocation" }] }`,
listing only exceptions whose repositories you can read. `?active=true` leaves out lapsed exceptions.

## Revocation

`POST /decisions/:id/revoke` with `{ "reason": "10 to 2000 characters" }` revokes a snippet, bulk or
standing decision at once. It needs `decision.revoke` on the decision's repository (for a standing
exception, on every repository its pattern can touch) and answers `201` with `{ "id", "decisionId",
"revokedByUserId", "reason", "revokedAt", "signedPayload", "signature" }`. The payload
(`kind: "nomus.cpg-revocation.v1"`, with the SHA-256 of the decision's signature) is signed with the
instance key. Revocations are append-only and final: a second one is `409 already_revoked`, and
restoring an exception means proposing it again. The findings it settled return to review
immediately, and their cases are re-evaluated.

## Expiry sweep

A daily job (03:30 UTC) records an audit event `decision.expiry_notice` for each approval or
standing exception that expires within 7 days (`threshold: "7d"`), within 1 day (`"1d"`) or has
expired (`"expired"`), once per decision and threshold, and re-evaluates open cases: a case whose
approval expired leaves `decided`. Notifications for these events arrive with the integrations
release.

## Error codes

| HTTP | `code` | When |
|------|--------|------|
| 400 | `invalid_input` | For example a snippet proposal with more than one fingerprint, or an approval without `expiresAt` |
| 403 | `self_approval_forbidden` | The caller opened, justified or revised the case |
| 403 | `not_eligible_voter` | The caller is not an active member of a required board |
| 403 | `forbidden` | Missing `exception.propose`, `exception.approve` or `decision.revoke` on a repository the pattern or decision covers |
| 404 | `not_found` | The case, proposal or decision does not exist in your organization |
| 409 | `case_closed` | The case is closed |
| 409 | `proposal_not_pending`, `already_voted` | Voting on a decided, vetoed, invalidated, void or lapsed proposal, or twice |
| 409 | `proposal_pending` | A pending proposal already covers one of the findings |
| 409 | `already_revoked` | The decision is already revoked |
| 409 | `no_active_owning_board` | No active board owns the policy |
| 422 | `advisory_needs_no_decision` | The finding is advisory |
| 422 | `scope_not_allowed` | The configuration does not allow this scope on the policy's tier (bulk on `prohibited`, always) |
| 422 | `bulk_mixed_policies` | A bulk proposal spans more than one policy version |
| 422 | `expiry_out_of_range` | `expiresAt` is not after now or is beyond the maximum |
| 422 | `unknown_fingerprint`, `policy_version_not_active` | A fingerprint is not a finding of the latest revision, or its policy version is no longer active |
| 422 | `invalid_glob`, `invalid_regex`, `unknown_team` | A standing pattern has a bad glob, an unsafe `snippetMustMatch`, or a team that is not active in the organization |
| 422 | `org_wide_pattern_forbidden` | A repository pattern is organization-wide and the configuration does not allow it |
| 422 | `unknown_policy_version` | The pattern names a policy version the organization does not have |
| 503 | `signing_unavailable` | The instance signing key is not initialized |

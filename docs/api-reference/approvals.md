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
| `GET /api/v1/cpg/proposals/:id` | session | `case.read` | One proposal: requirement, votes, derived status, and whether you may vote |
| `POST /api/v1/cpg/proposals/:id/votes` | session | `case.review`, and an eligible voter | Vote `approve` or `reject` |
| `GET /api/v1/cpg/decisions/:id` | session or user-bound key | `case.read` | A decision with its signed payload |

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
"invalidation", "viewer", ... }`.

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

## Error codes

| HTTP | `code` | When |
|------|--------|------|
| 400 | `invalid_input` | For example a snippet proposal with more than one fingerprint, or an approval without `expiresAt` |
| 403 | `self_approval_forbidden` | The caller opened, justified or revised the case |
| 403 | `not_eligible_voter` | The caller is not an active member of a required board |
| 404 | `not_found` | The case, proposal or decision does not exist in your organization |
| 409 | `case_closed` | The case is closed |
| 409 | `proposal_not_pending`, `already_voted` | Voting on a decided, vetoed, invalidated, void or lapsed proposal, or twice |
| 409 | `proposal_pending` | A pending proposal already covers one of the findings |
| 409 | `no_active_owning_board` | No active board owns the policy |
| 422 | `advisory_needs_no_decision` | The finding is advisory |
| 422 | `scope_not_allowed` | The configuration does not allow this scope on the policy's tier (bulk on `prohibited`, always) |
| 422 | `bulk_mixed_policies` | A bulk proposal spans more than one policy version |
| 422 | `expiry_out_of_range` | `expiresAt` is not after now or is beyond the maximum |
| 422 | `unknown_fingerprint`, `policy_version_not_active` | A fingerprint is not a finding of the latest revision, or its policy version is no longer active |
| 503 | `signing_unavailable` | The instance signing key is not initialized |

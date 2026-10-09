# Governance: review cases (`/api/v1/cpg/cases`)

A review case bundles a branch's corporate policy findings, the developer's justifications, the
reviewers' comments and change requests, and generated reviewer context. There is one open case per
repository and branch; new findings on the branch add a revision to it instead of opening another
case. Authentication, the error envelope and the general conventions are the same as on the
[Governance](./governance.md) page.

Permissions are checked against the case's repository, so team- and repository-scoped grants apply.
An id that belongs to another organization answers `404`, never `403`. Writes need a user (an
organization API key answers `403 user_identity_required`) and an organization with corporate
policies enabled (`403 cpg_disabled` otherwise); with them disabled, the list is empty,
`by-branch` returns `null` and `findings/status` returns no items. `by-branch` and
`findings/status` also accept an organization API key with the `read:policies` scope, for CI.
Every write is recorded in the case history and the audit log.

## Endpoints

| Method and path | Credential | Permission | Purpose |
|-----------------|------------|------------|---------|
| `POST /api/v1/cpg/cases/request-review` | session or user-bound key | `case.create` on the repository | Find or open the branch's case, add a revision, record justifications |
| `GET /api/v1/cpg/cases` | session or user-bound key | `case.read` | Cases, newest first (`?state`, `?repo`, `?boardId` (cases with a lane for that board), `?mine=true`, `?limit` 1–200, `?cursor`) |
| `GET /api/v1/cpg/cases/by-branch` | session, user-bound key or org key (`read:policies`) | `case.read` (users) | The open case of `?repo&branch`, or `{"case": null}` |
| `POST /api/v1/cpg/findings/status` | session, user-bound key or org key (`read:policies`) | `case.read` (users) | The resolution of up to 1,000 fingerprints found on a branch |
| `GET /api/v1/cpg/cases/:id` | session or user-bound key | `case.read` | Case status, revisions, current justifications and comments |
| `GET /api/v1/cpg/cases/:id/revisions/:revision` | session or user-bound key | `case.read` | One revision's findings with snippet text and justification |
| `POST /api/v1/cpg/cases/:id/justifications` | session or user-bound key | `case.create` | Justify a finding of the latest revision |
| `POST /api/v1/cpg/cases/:id/comments` | session or user-bound key | `case.comment` | A comment, or a reply to a thread |
| `POST /api/v1/cpg/cases/:id/request-changes` | session | `case.review`, and a member of the lane's board | Ask for changes on findings of one lane |
| `POST /api/v1/cpg/cases/:id/resubmit` | session or user-bound key | `case.create` | Put the case back in review once every change request is resolved |
| `POST /api/v1/cpg/cases/:id/withdraw` | session or user-bound key | the opener, or `case.close` | Close the case as `withdrawn` |
| `POST /api/v1/cpg/cases/:id/close` | session | `case.close` | Close the case as `closed_by_reviewer` |
| `GET /api/v1/cpg/cases/:id/findings/:findingId/context` | session | `case.read` | Reviewer context, generated on first request when enabled |
| `POST /api/v1/cpg/cases/:id/findings/:findingId/context/retry` | session | `case.read` | Retry a failed reviewer context (at most 5 attempts) |

## Request review

```json
{
  "repo": "github.com/gate-org/policy-repo",
  "branch": "feat/payments",
  "headSha": null,
  "bundleHash": "<64 hex>",
  "findings": [
    { "fingerprint": "<sha256>:corp.no-direct-openai:1", "policyKey": "corp.no-direct-openai", "policyVersion": 1,
      "filePath": "src/chat.ts", "startLine": 7, "endLine": 10, "language": "typescript", "snippet": "<normalized lines 7-10>" }
  ],
  "justifications": [{ "fingerprint": "<sha256>:corp.no-direct-openai:1", "body": "Why the code is needed and how the risk is controlled." }]
}
```

`findings` is the full set of corporate findings on the branch (1–500). The server re-hashes every
snippet; a snippet may be left out only when the organization already stores it. The answer is
`201` when a case was opened and `200` otherwise:
`{ "created": true, "revisionCreated": true, "case": CaseStatus }`. Re-sending the same findings
adds no revision, and re-sending an unchanged justification adds nothing.

`GET /api/v1/cpg/cases` items also carry `openedBy` (`{ "actor": "user:<id>", "name" }`; `name`
is `null` for a non-user actor) and the case's `lanes`. The list is paged before cases in
repositories the caller cannot read are left out, so a page can hold fewer than `limit` items (even
none) while `nextCursor` is set; keep paging until `nextCursor` is `null`.

`GET /api/v1/cpg/cases/:id` answers `{ "case": CaseStatus, "openedAt", "openedBy", "closure",
"viewer", "revisions", "justifications", "comments" }`. `viewer` is
`{ "comment", "review", "close", "withdraw" }`: what the caller's permissions allow on the case's
repository (request changes also needs membership of the lane's board). `closure` is `null` until
the case closes, then `{ "reason", "note", "closedAt", "closedBy", "record", "signature",
"signatureValid" }`, where `record` is the signed closure record and `signatureValid` the result of
verifying it against the stored rows on this request. Each finding of
`GET /api/v1/cpg/cases/:id/revisions/:revision` also carries `policyId`, `policyTitle`,
`owningBoardIds` (the lanes it belongs to) and `contextStatus` (`none`, `generated` or `failed`: the
reviewer context stored for its snippet, if any).

`CaseStatus` carries the state (`open`, `in_review`, `changes_requested`, `decided`, `closed`), one
lane per owning board, the open change requests, and a resolution per finding (see
[Finding status](#finding-status); `enforceFrom` is `null` only for a retired policy). A lane is
`decided` once every blocking finding in it has a current decision, and the case is `decided` once
every blocking finding of the latest revision has one ([approvals](./approvals.md)).

## Change requests

A board member asks for changes with `{ "boardId", "body", "fingerprints" }`; the case moves to
`changes_requested`. The developer replies with
`{ "kind": "reply", "threadId": "<change request id>", "resolves": true, "body": "..." }` and then
calls `resubmit` (`{}`), which answers `409 change_requests_unresolved` while any request lacks a
resolving reply. A new revision with a different finding set also clears open change requests.

## Reviewer context

The organization setting `reviewerContextLlm` (on by default when an LLM provider is configured)
decides whether a snippet is sent to the configured provider. The answer is
`{ "status": "disabled" | "generated" | "failed", "label", "whatItDoes", "whyFlagged", "provider", "model", "attempt", "error", ... }`;
generated text is always labelled `Generated by <provider> <model>`. A failure is stored with its
error and returned as `failed`; `retry` makes the next attempt. A closed case is read-only: stored
context is still returned, but a request that would generate context, and every `retry`, answers
`409 case_closed`.

## Finding status

`POST /api/v1/cpg/findings/status` takes `{ "repo", "branch", "fingerprints": [...] }` and answers
`{ "items": [FindingResolution], "evaluatedAt" }`, one item per distinct fingerprint, in request
order. A finding of the active policy version is `advisory` or `grace` (before the policy's
enforce-from date) and does not block. Otherwise the latest decision on the repository and
fingerprint applies ([approvals](./approvals.md)): `rejected` blocks, and `approved` passes until
`expiresAt`; both carry `decisionId`. Without one, the finding blocks as `pending` (a pending
proposal on the branch's open case covers it), `expired` (its approval has expired),
`changes_requested` (named by an unresolved change request on the branch's open case) or
`needs_review`. A finding of a version that is no longer active is `expired` and blocks until the
branch is rescanned (unless the policy is retired). A fingerprint naming a policy version the
organization does not have is `422 unknown_policy`.

## Pull requests (GitHub App)

When the GitHub App is installed for an organization with corporate policies enabled, opening a
pull request attaches its number to the open case of the PR's head branch, and closing the pull
request closes that case as `merged` or `pr_closed_unmerged`. Organizations with corporate policies
switched off, and branches without an open case, are not touched.

## Closing

`close` and `withdraw` take `{ "reason": "..." }`. Closing appends the final case event and signs a
closure record (`kind: "nomus.cpg-case-closure.v1"`: case, repository, branch, pull request,
reason, times, every revision's findings digest, the ids of the case's decisions, and a digest of
the full case history) with the
instance key. The record is rebuilt from the stored rows, so it can be verified at any time. A
closed case accepts no further writes (`409 case_closed`); new activity on the branch opens a new
case.

## Error codes

| HTTP | `code` | When |
|------|--------|------|
| 403 | `not_eligible_voter` | Requesting changes without being a member of the lane's board |
| 404 | `not_found` | The case, revision, finding or reply thread does not exist in your organization |
| 409 | `case_closed` | The case is closed |
| 413 | `payload_too_large` | A review request body over 4 MiB |
| 409 | `invalid_transition` | The case cannot move there (for example, changes requested on an `open` case) |
| 409 | `change_requests_unresolved`, `no_change_requests` | Resubmitting too early, or with nothing to resubmit |
| 409 | `change_request_not_open` | `resolves: true` on a thread that is not an open change request |
| 409 | `context_not_failed`, `retry_limit_reached` | Retrying context that has not failed, or after 5 attempts |
| 422 | `snippet_hash_mismatch`, `snippet_required`, `snippet_too_long` | A snippet does not hash to its fingerprint, is missing, or exceeds 400 lines |
| 422 | `fingerprint_mismatch` | A fingerprint does not name the finding's policy key and version |
| 422 | `justification_required` | A review request with no justification |
| 422 | `unknown_fingerprint` | A fingerprint is not a finding of the latest revision (or of the lane) |
| 422 | `unknown_board` | The board owns no finding of the case |
| 422 | `unknown_policy` | `findings/status`: a fingerprint names a policy version the organization does not have |
| 422 | `unknown_policy_version`, `policy_version_not_active`, `duplicate_finding` | A finding names an unknown or inactive policy version, or appears twice at one location |
| 503 | `signing_unavailable` | The instance signing key is not initialized |

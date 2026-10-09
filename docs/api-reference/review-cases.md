# Governance: review cases (`/api/v1/cpg/cases`)

A review case bundles a branch's corporate policy findings, the developer's justifications, the
reviewers' comments and change requests, and generated reviewer context. There is one open case per
repository and branch; new findings on the branch add a revision to it instead of opening another
case. Authentication, the error envelope and the general conventions are the same as on the
[Governance](./governance.md) page.

Permissions are checked against the case's repository, so team- and repository-scoped grants apply.
An id that belongs to another organization answers `404`, never `403`. Writes need a user (an
organization API key answers `403 user_identity_required`) and an organization with corporate
policies enabled (`403 cpg_disabled` otherwise); with them disabled, the list is empty and
`by-branch` returns `null`. Every write is recorded in the case history and the audit log.

## Endpoints

| Method and path | Credential | Permission | Purpose |
|-----------------|------------|------------|---------|
| `POST /api/v1/cpg/cases/request-review` | session or user-bound key | `case.create` on the repository | Find or open the branch's case, add a revision, record justifications |
| `GET /api/v1/cpg/cases` | session or user-bound key | `case.read` | Cases, newest first (`?state`, `?repo`, `?mine=true`, `?limit` 1–200, `?cursor`) |
| `GET /api/v1/cpg/cases/by-branch` | session or user-bound key | `case.read` | The open case of `?repo&branch`, or `{"case": null}` |
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

`CaseStatus` carries the state (`open`, `in_review`, `changes_requested`, `decided`, `closed`), one
lane per owning board, the open change requests, and a resolution per finding (`advisory`, `grace`,
`needs_review`, `changes_requested`, or `expired` when the finding's policy version is no longer
active; `enforceFrom` is `null` only for a retired policy).

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
error and returned as `failed`; `retry` makes the next attempt.

## Closing

`close` and `withdraw` take `{ "reason": "..." }`. Closing appends the final case event and signs a
closure record (`kind: "nomus.cpg-case-closure.v1"`: case, repository, branch, pull request,
reason, times, every revision's findings digest, and a digest of the full case history) with the
instance key. The record is rebuilt from the stored rows, so it can be verified at any time. A
closed case accepts no further writes (`409 case_closed`); new activity on the branch opens a new
case.

## Error codes

| HTTP | `code` | When |
|------|--------|------|
| 403 | `not_eligible_voter` | Requesting changes without being a member of the lane's board |
| 404 | `not_found` | The case, revision, finding or reply thread does not exist in your organization |
| 409 | `case_closed` | The case is closed |
| 409 | `invalid_transition` | The case cannot move there (for example, changes requested on an `open` case) |
| 409 | `change_requests_unresolved`, `no_change_requests` | Resubmitting too early, or with nothing to resubmit |
| 409 | `change_request_not_open` | `resolves: true` on a thread that is not an open change request |
| 409 | `context_not_failed`, `retry_limit_reached` | Retrying context that has not failed, or after 5 attempts |
| 422 | `snippet_hash_mismatch`, `snippet_required`, `snippet_too_long` | A snippet does not hash to its fingerprint, is missing, or exceeds 400 lines |
| 422 | `fingerprint_mismatch` | A fingerprint does not name the finding's policy key and version |
| 422 | `justification_required` | A review request with no justification |
| 422 | `unknown_fingerprint` | A fingerprint is not a finding of the latest revision (or of the lane) |
| 422 | `unknown_board` | The board owns no finding of the case |
| 422 | `unknown_policy_version`, `policy_version_not_active`, `duplicate_finding` | A finding names an unknown or inactive policy version, or appears twice at one location |
| 503 | `signing_unavailable` | The instance signing key is not initialized |

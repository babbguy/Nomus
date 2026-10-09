# Governance: CI gate (`/api/v1/cpg/ci`)

The CI gate is where corporate policies are enforced: a pipeline scans the checkout, sends the
corporate findings, and the server decides whether the build passes. VS Code only advises. The
server's answer is signed with the instance key, so the pipeline can verify it offline. A pipeline
must fail when Nomus cannot be reached, answers with an error, or returns a verdict that does not
verify: no failure may turn the gate green. Authentication, the error envelope and the general
conventions are the same as on the [Governance](./governance.md) page.

`evaluate` and `pr-closed` take an organization API key with the `evaluate` scope, never a session
or a user-bound key (`403 forbidden`, `details.reason: "org_key_required"`), and need corporate
policies enabled (`403 cpg_disabled`). Every evaluation is recorded in the audit log. A `repo` in any
form names one repository and is stored canonical (see
[Repository identity](./review-cases.md)); the signed verdict carries the canonical id.

## Endpoints

| Method and path | Credential | Permission | Purpose |
|-----------------|------------|------------|---------|
| `POST /api/v1/cpg/ci/evaluate` | org key (`evaluate`) | - | The server's verdict on a CI scan |
| `POST /api/v1/cpg/ci/pr-closed` | org key (`evaluate`) | - | Close the branch's case when its pull request closes |
| `GET /api/v1/cpg/ci/runs` | session | `ci.read` on the repository | Recorded runs, newest first (`?caseId`, `?repo`, `?sha`, `?limit` 1–200, `?cursor`); without `caseId` or `repo`, `ci.read` must be organization-wide |

## Evaluate

```json
{
  "repo": "gate-org/policy-repo",
  "branch": "feature/chat",
  "prNumber": 42,
  "headSha": "<40 hex>",
  "eventName": "pull_request",
  "bundleHash": "<the bundleHash of the bundle the scan used>",
  "scannedFileCount": 118,
  "findings": [
    { "fingerprint": "<sha256>:corp.no-direct-openai:2", "policyKey": "corp.no-direct-openai", "policyVersion": 2,
      "filePath": "src/chat.ts", "startLine": 12, "endLine": 14, "language": "typescript", "snippet": "<normalized snippet>" }
  ]
}
```

At most 2,000 findings and 4 MiB. Send every finding's snippet: findings of a blocking tier
(`review-required`, `prohibited`) must carry it, and a finding written into a case revision needs
it unless the organization already stores it.

The server checks, in order:

| HTTP | `code` | When |
|------|--------|------|
| 409 | `bundle_stale` | `bundleHash` is not the organization's current bundle (`details.bundleHash` is the current one): fetch the bundle, rescan and retry once |
| 422 | `suspicious_empty_scan` | `scannedFileCount` is 0, but an earlier run on the repository scanned files |
| 422 | `fingerprint_mismatch` | A fingerprint does not name the finding's policy key and version, or the snippet does not hash to it |
| 422 | `unknown_fingerprint` | The finding's policy version is not in the current bundle |
| 422 | `snippet_required` | A finding of a blocking tier has no snippet |

A refused request records nothing. Otherwise each finding is resolved exactly as
[finding status](./review-cases.md#finding-status) resolves it, with the server's tier and
enforce-from date, and a standing exception is matched against the uploaded file locations. The
verdict is `fail` when any finding blocks, otherwise `pass`. In the same transaction:

- a failing scan finds or opens the branch's case; a passing scan uses the open case if there is one;
- the case gets the pull request number (`pr_attached`, or `pr_changed` when it differs) and a new
  revision when the findings changed, so a branch whose blocking findings were fixed moves its case
  to `decided`;
- the run is stored with its signed verdict, and a `ci_result` event is added to the case.

The answer (`200`):

```json
{
  "runId": "<uuid>",
  "verdict": "fail",
  "reasons": ["corp.no-direct-openai @ src/chat.ts:12: rejected"],
  "caseId": "<uuid or null>",
  "caseUrl": "https://nomus.example.org/governance/cases/<uuid>",
  "findings": [{ "fingerprint": "...", "status": "rejected", "blocking": true, "tier": "prohibited", "enforceFrom": "...",
                 "decisionId": "<uuid>", "exceptionDecisionId": null, "expiresAt": null,
                 "filePath": "src/chat.ts", "startLine": 12, "endLine": 14 }],
  "counts": { "blocking": 1, "pending": 0, "rejected": 1, "approved": 0, "excepted": 0, "advisory": 0 },
  "evaluatedAt": "2026-10-09T12:00:00.000Z",
  "signedPayload": "{...}",
  "signature": "<base64 Ed25519>"
}
```

`findings` has one item per uploaded finding, in upload order. `advisory` counts advisory and
grace-period findings.

### Verifying the verdict

`signedPayload` is the canonical JSON of

```json
{ "kind": "nomus.cpg-ci-run.v1", "runId", "orgId", "repo", "branch", "prNumber", "headSha", "bundleHash",
  "verdict", "counts", "findingsDigest", "evaluatedAt" }
```

where `findingsDigest` is the SHA-256 of the sorted uploaded fingerprints joined with newlines.
`signature` is Ed25519 over that text with the key published at `/.well-known/nomus-keys` (the key
that signs the policy bundle). Accept a verdict only when the signature verifies, the payload is
canonical, and its run, verdict and counts equal the response's and its organization, repository,
branch, pull request, commit and bundle hash equal the scan that was sent. `verifyCiVerdict()` in
`@nomus/scanner/corporate` does all of this.

## Pull request closed

`POST /api/v1/cpg/ci/pr-closed` takes `{ "repo", "branch", "prNumber", "merged", "mergeSha"? }`
and closes the branch's open case as `merged` or `pr_closed_unmerged`, the same way the
[GitHub App](./review-cases.md#pull-requests-github-app) does. It answers
`{ "caseId": "<uuid>", "closed": true }`, or `{ "caseId": null, "closed": false }` when the branch
has no open case or its case is attached to another pull request.

## Runs

`GET /api/v1/cpg/ci/runs` answers `{ "items": [CiRun], "nextCursor" }`. A run has the scan's
repository, branch, pull request, commit, event, bundle hash and file count, the verdict and
counts, its case, its findings (fingerprint, location, status and decision ids; never snippet
text), and `signedPayload`, `signature` and `signatureValid`. A case's closure record lists the ids
of its CI runs.

Branch protection makes the gate binding: require the job that runs the Nomus action as a status
check, and protect the workflow file with CODEOWNERS.

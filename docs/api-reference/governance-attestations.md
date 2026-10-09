# Governance: corporate policy records in attestations

An attestation (`POST /api/v1/evaluate`) can carry the corporate policy records in force for a
repository: approved exceptions, standing exceptions, a closed review case and its CI runs. They
are listed in a **governance manifest**, signed separately with the same instance key. The
attestation receipt and its signed payload are unchanged, so every receipt and evidence bundle
issued before v1.2.0 verifies exactly as before.

## Requesting a manifest

Add the optional `governance` object to the evaluate body. It is outside the attested
`context` and is not part of the receipt signature.

```json
{
  "action": "ai_user_interaction",
  "jurisdiction": "EU",
  "context": { "region": "EU" },
  "governance": { "repo": "acme/payments", "branch": "main", "caseId": "<closed case id>" }
}
```

| Field | Rules |
|---|---|
| `repo` | Required. Any form the scanner accepts (`acme/payments`, `github.com/acme/payments`); stored canonical. |
| `branch` | Optional, 1 to 255 characters. Standing exceptions limited to other branches are left out. |
| `caseId` | Optional. A **closed** review case of the same repository; adds its signed closure record and the CI runs it lists. |

The manifest lists, at the attestation instant:
- every active approval of the repository (snippet and bulk scopes): the latest decision of the
  finding approves, is unexpired and is not revoked;
- every standing exception that is unexpired, not revoked, on its policy's active version, and
  whose pattern covers the repository (and the branch, when given);
- the case closure record and its CI runs, when `caseId` is given.

Rejections are never listed. The response adds `"governance": { "manifest": true, "itemCount": 3 }`.
Without `governance`, the response is unchanged.

| Status | `code` | When |
|---|---|---|
| 400 | | `governance` is malformed or `repo` is not a repository reference |
| 403 | `cpg_disabled` | Corporate policies are not enabled for the organization |
| 404 | `not_found` | `caseId` is not a case of the organization |
| 409 | `case_open` | The case is not closed yet, so it has no closure record |
| 422 | `case_repo_mismatch` | The case belongs to another repository |

A refusal creates no attestation: the receipt and the manifest are written in one transaction.

## Evidence export

`GET /api/v1/attestations/:id/export?format=json|html`

- **Without a manifest**: `bundleVersion: 1`, byte for byte the v1.1.0 bundle.
- **With a manifest**: `bundleVersion: 2`, every v1 key unchanged, plus:

```json
"corporateGovernance": {
  "manifest": { "signedPayloadCanonicalJson": "…", "signature": "…" },
  "items": [
    { "type": "decision", "id": "…", "signedPayloadCanonicalJson": "…", "signature": "…",
      "statusAtGeneration": "active", "revocation": null },
    { "type": "case_closure", "id": "<caseId>", "signedPayloadCanonicalJson": "…", "signature": "…",
      "statusAtGeneration": "final", "revocation": null }
  ],
  "instructions": ["…"]
}
```

`statusAtGeneration` is `active`, `expired` or `revoked` for decisions, and `final` for closure
records and CI runs, which never change. A decision revoked after the attestation carries its
signed `revocation`. The HTML export adds section 5, "Corporate policy exceptions" (record, policy,
repository, expiry, approver count, status). No bundle contains code or snippets.

The manifest payload (`kind: "nomus.cpg-attestation-manifest.v1"`) is
`{attestationId, orgId, evaluatedAt, repo, branch, bundleHash, items}`, where each item is
`{type, id, signatureSha256}` sorted by type then id, and `evaluatedAt` is the receipt's instant.

## Verifying offline

Use only the bundle and the key published at `/.well-known/nomus-keys`:

1. Verify the attestation as for `bundleVersion: 1` (see `verification.instructions`).
2. Verify `manifest.signature` (Ed25519, base64) over the UTF-8 bytes of
   `manifest.signedPayloadCanonicalJson` with the same key. Its `attestationId`, `orgId` and
   `evaluatedAt` must equal the attestation's.
3. For each manifest item, verify the bundle item with the same type and id the same way, and
   check that the SHA-256 (hex) of the UTF-8 bytes of its base64 `signature` string equals the
   item's `signatureSha256`, and that its `orgId` is the manifest's. Kinds:
   `nomus.cpg-decision.v1` (`id`; `outcome` must be `approve`, `expiresAt` later than
   `evaluatedAt`), `nomus.cpg-case-closure.v1` (`caseId`), `nomus.cpg-ci-run.v1` (`runId`, listed in
   the closure's `ciRunIds`).
4. A `revocation` (`nomus.cpg-revocation.v1`, `decisionId` equal to the item id) dated after
   `evaluatedAt` means the exception was valid when attested and has been revoked since.

The `kind` field separates the domains: a decision or manifest signature can never be presented
as a receipt signature, or the reverse.

## Where else it shows

- `GET /api/v1/attestations` adds `corporateGovernance: {exceptions, caseClosures, ciRuns}` to
  attestations that have a manifest.
- The public `GET /api/v1/verify/:id` adds
  `corporateGovernance: {manifestSignatureValid, exceptions, revokedSince, caseClosures, ciRuns}`,
  counts only, never policy keys, repositories or code. Both keys are absent without a manifest.

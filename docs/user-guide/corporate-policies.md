# Corporate Policies in the CLI and VS Code

Your organization can define its own engineering policies in Nomus, for example "call OpenAI only
through the approved LLM gateway" or "no new code may use gpt-4-32k". An administrator writes each
policy in plain English, Nomus compiles it into a deterministic rule, and someone other than the
author approves it (see the [admin guide](../admin-guide/corporate-policies.md)).

This page covers what developers see: corporate policy findings in the scanner CLI and in the VS Code
extension.

## Contents

- [How it works](#how-it-works)
- [Scanner CLI](#scanner-cli)
- [VS Code extension](#vs-code-extension)
- [When the policy bundle cannot be used](#when-the-policy-bundle-cannot-be-used)
- [What is not in this release](#what-is-not-in-this-release)

## How it works

- **Opt-in.** Nothing changes until an Org Admin switches governance on for the organization. Until
  then, and for any scan without an API key, the CLI and the extension behave exactly as before.
- **A signed bundle.** Your organization's active policies are published as one bundle, signed with
  the instance's Ed25519 key. The CLI and the extension download it from
  `GET /api/v1/cpg/bundle` and check every signature and hash **before** any rule is used. A bundle
  that does not verify is never used.
- **Local and deterministic.** The rules run on your machine, on your files. No AI model is involved
  at scan time, and the same code and bundle always give the same findings and fingerprints.
- **No code leaves your machine.** The CLI and the extension only download the bundle. They do not
  upload your code.
- **Separate from regulatory findings.** Corporate findings are reported next to regulatory ones and
  clearly marked. They never change the regulatory findings, counts, status or exit code.
- **Not hidden by `.nomus.yml`.** The `ignore` list and the detector switches in `.nomus.yml` apply to
  regulatory scanning only. Corporate rules check every file in the repository except `.git`,
  `node_modules`, files over 2 MB and binary files, so a policy cannot be bypassed by editing the
  repository's own configuration.

Each finding has a **status**:

| Status | Meaning |
|---|---|
| `needs review` | The policy is enforced and the code needs a review decision. Blocking in CI (from the CI gate release). |
| `advisory; enforced from <date>` | The policy is in its grace period. Informational until that date. |
| `advisory` | An advisory policy. Always informational. |

Each finding also has a **fingerprint**: `sha256(snippet):policyKey:version`. The snippet is the
matched lines with line endings unified, trailing spaces removed and runs of blank lines collapsed.
Moving the code or changing line endings keeps the fingerprint; editing the code or a new policy
version changes it. Later releases use fingerprints to pin review decisions to exact code.

## Scanner CLI

The CLI checks corporate policies automatically when it has an API key
(`NOMUS_API_KEY` or `api_key` in `.nomus.yml`) and your organization has governance switched on.

```bash
export NOMUS_API_KEY=nk_live_...
node packages/scanner/dist/index.js .                 # console: regulatory report, then a "Corporate policies" section
node packages/scanner/dist/index.js . --json          # adds "corporate" and "corporateFindings" to the JSON
node packages/scanner/dist/index.js . --sarif         # adds a second SARIF run (category nomus-corporate/)
node packages/scanner/dist/index.js . --no-corporate  # regulatory scan only; the bundle is not fetched
```

The API key needs the `read:policies` scope (to download the bundle) as well as `evaluate`.

**Console.** After the regulatory report, a section lists each corporate finding. This is the real
output for a repository with four active policies: two blocking findings of a prohibited policy, one
of a review-required policy, one in its grace period and one advisory:

```
Corporate policies: 4 active policies, 6 files checked (bundle c3bd03d2ede9)
5 corporate policy finding(s), 3 blocking:

[REVIEW-REQUIRED] corp.no-pii-to-ai v1: No personal data in AI calls
   File:   app/summarize.py:8
   Policy: Personal data must not be sent to an AI model without a Legal review.
   Status: needs review (blocking)
   Owners: Legal Board
   Fingerprint: 834b371f44e8fdba3a71c1ceb6f5c4982d59bc81e548218174871fb88b979be0:corp.no-pii-to-ai:1

[PROHIBITED] corp.no-direct-openai v1: No direct OpenAI calls
   File:   src/chat.ts:7-10
   Policy: Call OpenAI only through the approved LLM gateway.
   Status: needs review (blocking)
   Owners: AI Review Board, Legal Board
   Fingerprint: b9886a809391f0c1277cf886e81c4603119589a01351196e6244195b0b20d639:corp.no-direct-openai:1

[PROHIBITED] corp.no-direct-openai v1: No direct OpenAI calls
   File:   src/legacy/old_chat.ts:7
   Policy: Call OpenAI only through the approved LLM gateway.
   Status: needs review (blocking)
   Owners: AI Review Board, Legal Board
   Fingerprint: 74d3b3dd2f4f68492c0c978a11938c4c6cc214d676f9cdbae904a564dfecfa7e:corp.no-direct-openai:1

[REVIEW-REQUIRED] corp.no-gpt-4-32k v1: Do not use gpt-4-32k
   File:   src/models.ts:3
   Policy: The gpt-4-32k model is retired for new code; use an approved model.
   Status: advisory; enforced from 2026-10-23
   Owners: AI Review Board
   Fingerprint: 156f0bd2f195ee16003b26391949bcc467968e30a6ad82d15de9ca7dafb63b43:corp.no-gpt-4-32k:1

[ADVISORY] corp.retired-model-notice v1: Retired model notice
   File:   src/models.ts:3
   Policy: The gpt-4-32k model is retired for new code; use an approved model.
   Status: advisory
   Owners: AI Review Board
   Fingerprint: 156f0bd2f195ee16003b26391949bcc467968e30a6ad82d15de9ca7dafb63b43:corp.retired-model-notice:1

Corporate policy findings never change the exit code of this command.
```

**JSON.** The regulatory fields are unchanged. Two fields are added when governance is on:

- `corporate`: the bundle hash, the number of active policies, files checked, skipped long lines
  and files, and the totals;
- `corporateFindings`: one entry per finding with `file`, `startLine`, `endLine`, `policyKey`,
  `policyVersion`, `title`, `tier`, `status`, `blocking`, `enforceFrom`, `message`, `owningBoards`,
  `fingerprint` and `snippetHash`. The code itself is not included.

**SARIF.** The regulatory run is unchanged. Corporate findings are a second run
(`automationDetails.id: nomus-corporate/`, tool `Nomus Corporate Policy`): blocking findings are
`error`, advisory and grace-period findings are `note`, each result carries the line range and
`partialFingerprints["nomusCorporate/v1"]`, and no code.

**Exit codes** are unchanged: `0`, `1` (regulatory findings at or above `--fail-on`), `2` and `3`.
Corporate findings never change the exit code. Two bundle problems are reported:

- **The bundle does not verify** (tampered, or signed with another key): exit code `3`, nothing is
  reported, and the message says which check failed:

  ```
  Nomus corporate policy bundle failed verification — compliance status UNKNOWN; failing closed. (The corporate policy bundle hash does not match its policies)
  No findings were reported. Check the Nomus server you are connected to, or run with --no-corporate to scan regulatory obligations only.
  ```

- **The bundle cannot be fetched** (no answer, or an HTTP error): the CLI warns on stderr and then
  runs the regulatory scan exactly as before, including its own exit code `3` when the API is
  needed and unreachable:

  ```
  Warning: corporate policies were NOT checked — the policy bundle could not be fetched (Could not reach the Nomus corporate policy bundle endpoint). Corporate policy status UNKNOWN.
  ```

Use `--no-corporate` to run the regulatory scan on its own.

## VS Code extension

After you sign in, the extension downloads and verifies your organization's bundle and checks each
file you save or open, and the whole workspace with **Nomus: Scan Workspace**.

**Diagnostics.** Corporate findings appear in the Problems panel and inline, next to regulatory
ones, and are easy to tell apart:

| | Regulatory | Corporate |
|---|---|---|
| Source | `Nomus` | `Nomus Policy` |
| Message | `[rule key] summary` | `[Policy · PROHIBITED] corp.no-direct-openai v1: <policy message> Status: needs review.` |
| Code | the rule key, linking to the docs | the policy key, linking to the policy page in the dashboard |
| Range | one line | every line of the match (a multi-line call is underlined in full) |
| Severity | from the rule's severity | blocking prohibited: Error; blocking review-required: Warning; advisory and grace period: Information |
| Related information | `Legal: …` | `Owned by: <boards>` |

**Corporate Policies view.** A new view in the Nomus sidebar shows:

- the findings, grouped as **Blocking: needs review** and **Advisory / grace period**, each row
  reading `policyKey · file:lines` (click to open the code);
- the repository and branch, read from `.git` (`Repository: acme/payments @ feat/x`);
- the bundle status row, for example `Policy bundle: 3 policies · verified 2026-10-09 09:41 UTC`.

**Refreshing.** The extension revalidates the bundle at most every 5 minutes, sending the bundle's
ETag (`If-None-Match`), so an unchanged bundle costs one small request. **Nomus: Refresh Corporate
Policies** (also the refresh button on the view) and **Nomus: Refresh All Views** revalidate at once.

**Settings.**

| Setting | Default | Description |
|---|---|---|
| `nomus.corporate.enabled` | `true` | Show corporate policy findings. Local and advisory: switching it off does not change what CI enforces. |
| `nomus.corporate.maxCacheAgeHours` | `72` | How long a verified, cached bundle may be used while the server is unreachable. |

## When the policy bundle cannot be used

The extension never shows "no violations" when it cannot check. Every problem is visible, in the
view's status row and as an error message:

| Situation | What you see |
|---|---|
| Server unreachable, cached bundle (re-verified) | Findings from the cache. Status row: `Policy bundle: offline (cached <time>)`. |
| Server unreachable, cache older than `nomus.corporate.maxCacheAgeHours` | No corporate findings. Status row: `Policy bundle expired …`, and an error message. |
| Server unreachable, no cache | No corporate findings. Status row: `Policy bundle unavailable`, and an error message once per session. |
| The bundle or the cached copy does not verify (tampered or corrupted) | The copy is deleted and never used. Corporate findings are cleared and an error message says so. |
| The server refuses the key (401 or 403) | No corporate findings; an error asks you to sign in again. |
| Governance switched off for your organization | `Corporate policies are not enabled for this organization`. No error. |
| A Nomus server without corporate policies | `This Nomus server does not support corporate policies`. No error. |

The CLI stops with exit code `3` when the bundle does not verify, and warns that corporate
policies were NOT checked when the bundle cannot be fetched (see [Exit codes](#scanner-cli)).

## What is not in this release

Requesting a review of a finding, review cases, approvals and exceptions, and the CI gate for
corporate findings come in later releases. In this release the CLI and the extension show findings
only.

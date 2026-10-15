# Corporate Policies in the CLI and VS Code

Your organization can define its own engineering policies in Nomus, for example "call OpenAI only
through the approved LLM gateway" or "no new code may use gpt-4-32k". An administrator writes each
policy in plain English, Nomus compiles it into a deterministic rule, and someone other than the
author approves it (see the [admin guide](../admin-guide/corporate-policies.md)).

This page covers what developers see: corporate policy findings in the scanner CLI and in the VS Code
extension, and requesting a review of a finding from VS Code.

## Contents

- [How it works](#how-it-works)
- [Scanner CLI](#scanner-cli)
- [VS Code extension](#vs-code-extension)
- [Requesting a review in VS Code](#requesting-a-review-in-vs-code)
- [Review cases in the dashboard](#review-cases-in-the-dashboard)
- [Deciding findings and voting](#deciding-findings-and-voting)
- [Standing exceptions](#standing-exceptions)
- [In attestations](#in-attestations)
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

**Console.** After the regulatory report, a section lists each corporate finding. The two file
counts differ on purpose: the regulatory scan reads source files (`Found 5 source files for the
regulatory scan`, honouring `.nomus.yml` `ignore`), while corporate policies check every repository
file in a policy's scope, of any type. This is the real output for a repository with four active
policies: two blocking findings of a prohibited policy, one of a review-required policy, one in its
grace period and one advisory:

```
Corporate policies: 4 active policies (bundle c3bd03d2ede9)
6 files checked for corporate policies (every repository file in a policy's scope, of any type)
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

## Requesting a review in VS Code

A blocking finding (needs review) can stay in your code if the board that owns the policy approves
it. You ask for that from VS Code, on your branch, before or after you open a pull request. Nomus
keeps one **review case** per repository and branch: requesting review again later updates the
same case with a new revision instead of opening another one.

**Request a review.** Run **Nomus: Request Policy Review** (also the pull-request button on the
Corporate Policies view). The extension:

1. checks that you are signed in as yourself (an organization API key in `nomus.apiKey` cannot
   request reviews) and that you have the Developer role;
2. reads the repository and branch from `.git` (a detached HEAD or a missing `origin` remote is
   reported, and nothing is sent);
3. scans the workspace with the verified policy bundle and asks Nomus which blocking findings
   still need review;
4. lists them, all selected, as `PROHIBITED · corp.no-direct-openai · src/chat.ts:12-14` with the
   policy title underneath; clear the ones you do not want to send;
5. asks for a justification for each one (20 to 4,000 characters): why the code is needed and how
   its risk is controlled. After the first one you can choose **Use this justification for the
   remaining findings** or **Write each one**;
6. sends the findings and justifications, and confirms, for example
   `Review case CPG-1A2B3C4D opened (revision 1). Sent to: AI Review Board, Legal Board.`, with an
   **Open case** button for the dashboard.

Every current corporate finding of the branch is sent with its code snippet, so the case is a full
snapshot; the snippets stay on your Nomus server and are never put in emails or tickets.

**Drafts.** Your justifications are saved as you type them and kept until Nomus accepts the
request. If you press Esc, or the request fails, the next **Request Policy Review** fills them in
again. Nothing is queued: a request that was not sent is never sent later without you.

| Situation | What you see |
|---|---|
| No blocking findings | `Nothing needs review: no blocking corporate policy findings in this workspace.` |
| Every blocking finding already approved or excepted | `Nothing needs review: every blocking finding is approved or excepted.` |
| Signed in with an organization API key | `Requesting review needs your Nomus sign-in (not an organization API key). Sign in again?` with **Sign in** |
| Esc during the justifications | `Review not requested. Your justifications are saved as a draft.` |
| Nomus unreachable | `Nomus is unreachable: the review request was not sent. Your justifications are saved as a draft.` |
| Nomus refuses the request | `The review request was not sent: <the reason>. Your justifications are saved as a draft.` |

**The case in the Corporate Policies view.** Above the findings, the view shows your branch's case
and what to do next:

```
Case CPG-1A2B3C4D · changes requested (revision 1)
  AI Review Board: changes requested
  Legal Board: needs review (1 blocking)
  Changes requested by Dana (AI Review Board): "Route this call through the approved gateway…"
  Open in dashboard
```

- Each board that owns one of your findings has a lane: `needs review (n blocking)`,
  `changes requested`, or `decided`.
- An open change request shows who asked and what they asked for. Click it (or use its reply
  button) to answer.
- With no case yet and blocking findings present, the view says
  `No review case for this branch: run "Nomus: Request Policy Review"`.

**Change requests.** When a reviewer asks for changes, the next refresh shows a warning,
`CPG-1A2B3C4D: Changes requested by Dana (AI Review Board): "…"`, with **Reply** and **Open case**.
To answer, run **Nomus: Reply to Change Request**, write your reply, and choose
**This resolves the request** or **Reply without resolving it**. Once every request is resolved,
the extension offers **Resubmit**, and the view shows `Every change request is resolved: resubmit
for review` (or run **Nomus: Resubmit Policy Review**). Changing the code and requesting review
again also puts the case back in review, with a new revision.

**Refreshing and notifications.** The case is refreshed when you sign in, with **Nomus: Refresh
Corporate Policies**, after each review command, and on save at most once a minute. Notifications
are only for the case of the branch you have checked out: a warning for each new change request,
and information when findings are decided or the case is closed (for example
`Review case CPG-1A2B3C4D is closed: the pull request was merged.`).

**Offline.** The view keeps the last case status it received, marked
`as of 2026-10-09 13:45 UTC (offline)`. Requests, replies and resubmissions are not sent while
offline, and the error says so; your text is kept as a draft.

## Review cases in the dashboard

**Governance > Cases** lists the review cases of the repositories you can read, newest first: the
case reference (`CPG-…`), repository @ branch, state, each board's lane with how many of its
blocking findings are decided (`decided/blocking`), who opened it and when, the last activity and the
pull request (a link for GitHub repositories). Times are relative (`3h ago`); hover for the exact
UTC time. Filter by state or by board, and page with **Previous** and **Next**. If your
access is limited to some repositories, you see only their cases, and every page is full except the
last.

Open a case to see:

- the state, repository and branch, pull request and everyone involved;
- the lanes, one per owning board;
- the revisions, with how many findings were new, carried over and resolved in each; select one to
  see its findings;
- each finding: its policy (linked to the policy page), tier and status, file and lines, the
  snippet exactly as the server stores it, and the developer's justification;
- **Show reviewer context**: a plain-English explanation of the snippet, generated by your
  organization's LLM provider on first request and kept. It is always labelled
  `Generated by <provider>/<model>, may be inaccurate.` If generating it failed, the reason is shown
  with **Try again** (up to five attempts); if an Org Admin switched it off, the panel says so;
- the change requests and comments, with their replies;
- the **CI runs** of the branch (with `ci.read`): each verdict, head commit, pull request, time and
  whether its signature verifies.

What you can do depends on your permissions on the case's repository: comment and reply
(`case.comment`); request changes on a lane, if you hold `case.review` and belong to that lane's
board (other reviewers are told which boards can); withdraw your own case, or close a case with
`case.close`. A closed case is read-only and shows its **closure record**, signed with the
instance's key and verified each time the page loads. Reviewer context generated before it closed
can still be shown; a closed case does not generate any more.

## Deciding findings and voting

Each blocking finding of the latest revision shows its **Decision**: the signed decision that
settles it (approved or rejected, the expiry, and **Signature verified**, checked when the page
loads), the standing exception that covers it, or a pending proposal with how many approvals it has
and which boards still need to approve.

If you hold `case.review` on the repository and belong to a board that owns the finding's policy,
you can **Propose approval** or **Propose rejection**:

- an approval needs an expiry, in days, at most the maximum the quorum allows for the policy's tier
  (by default 180 days for review-required and 90 for prohibited); the default is filled in;
- a rejection is final at once and never expires; only a later approval lifts it;
- your own vote is recorded with your proposal, so a policy that needs one approval is decided at
  once.

**Propose a bulk decision** (in the Decisions card) decides two or more open findings of one
review-required policy version together; each still gets its own signed decision. Prohibited
findings are always decided one at a time.

The **Decisions** card lists every proposal of the case, newest first, with its votes (and the boards
each voter approved for), vetoes, invalidations and revocations. On a pending proposal, eligible
reviewers **Approve** or **Reject**, with an optional comment. One eligible rejection vetoes an
approval. When you cannot vote, the card says why: you already voted, you are not on a required
board, or you opened, justified or revised the case. Nobody can decide on their own work, whatever
roles they hold, so those actions are never offered; if the server refuses one anyway, its message
is shown as it is. Holders of `decision.revoke` can **Revoke** a decision: it is immediate, signed
and final, and the finding needs review again.

## Standing exceptions

**Governance > Exceptions** lists the standing exceptions in the repositories you can read: their
patterns (repositories or teams, paths, excluded paths), conditions, policy and version, status,
expiry, proposer, votes and revocations. Filter by status (**Pending**, **Active**, **Expired**,
**Revoked**, **Lapsed (policy changed)**, **Not approved**) and by policy. Pending exceptions are
listed whether or not they were proposed from a case.

With `exception.propose`, **Propose an exception**: pick the policy (its active version), give
repository patterns or teams and path globs, optional branches, languages and a maximum finding
size, an expiry within the configured maximum (90 days by default) and a rationale. The form states
what approval it needs, for example two approvals covering every owning board, one of them by an
Exception Approver, for a prohibited policy. You do not vote on your own proposal. An exception
covers one policy version: when a new version is approved it **lapses**, and the new-version page
warns how many will.


The extension never shows "no violations" when it cannot check. Every problem is visible, in the
view's status row and as an error message. A scan reports everything in one error message: when
the server is unreachable it says that regulatory results are unavailable and whether the corporate
findings shown come from the cached bundle (with its time) or cannot be shown, and why:

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

## In CI

VS Code advises; CI enforces. When your organization runs the Nomus GitHub Action, your pull
request fails while any blocking finding has no valid decision. The check run **Nomus Corporate
Policy Gate** annotates each finding, and the pull request comment lists the blocking ones with a
link to the review case, named by its reference (`CPG-…`). Fix the code or request a review; once reviewers approve, or you remove
the flagged code, the next run passes and the case gains a new revision. Merging or closing the
pull request closes the case. Administrators: see [Enforcing in CI](../admin-guide/corporate-policies.md#enforcing-in-ci).

## In attestations

An attestation can carry the approved exceptions of a repository. Send `governance` with the
evaluate request (`{"repo": "acme/payments", "branch": "main"}`, plus `caseId` for a closed review
case). Nomus then signs a separate manifest listing every approval and standing exception in force
at that instant, and the case's closure record and CI runs. The attestation itself is signed
exactly as before.

- **Attestations** in the dashboard shows a "Corporate governance: N exceptions" badge.
- The public verification page shows how many exceptions, closed cases and CI runs the
  attestation carries, and whether the manifest signature is valid. It never shows policy names,
  repositories or code.
- The JSON evidence export (bundle version 2) holds every record as signed text. Your auditor
  verifies them offline with the key at `/.well-known/nomus-keys`; the steps are in the bundle's
  `corporateGovernance.instructions` and in [the API reference](../api-reference/governance-attestations.md#verifying-offline).
- An exception revoked after the attestation is shown as revoked, with its signed revocation.

## Exporting the governance audit trail

Auditors (`audit.export`) can download the whole trail from **Governance > Audit log** with
**Export signed audit (JSON)**: the hash-chained audit log from its first event, and every signed
decision, revocation, case closure record and CI verdict of the organization, under one signature.
It verifies offline with the key at `/.well-known/nomus-keys`; see
[the API reference](../api-reference/governance.md#get-apiv1cpgauditexport). The policy log has its own
signed export (`GET /api/v1/cpg/policies/export`).

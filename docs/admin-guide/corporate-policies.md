# Corporate policies

Corporate policy governance lets your organization write its own engineering policies in plain
English, turn each one into a deterministic rule, approve it with a second person, and distribute
the approved rules to every scanner (CLI, GitHub Action, VS Code extension) as a signed bundle.

This page covers review boards, the approval quorum, authoring and approving policies, the grace
period, and what a corporate policy can and cannot express. Roles and permissions are explained in
[Roles and permissions](./roles-and-permissions.md); the endpoints are in the
[policy registry API reference](../api-reference/policy-registry.md).

> Phase note: this release builds the policy registry and the signed bundle. Showing corporate
> findings in scans, the editor and CI, and review cases, arrive in the following releases. The
> dashboard pages for policies, boards and the quorum arrive in the next update; until then use the API.

## How it fits together

1. An Org Admin creates **review boards** (for example "AI Review Board" and "Legal Board") and
   adds their members.
2. A **Policy Author** writes a policy in plain English with at least one code example that
   violates it, and asks Nomus to **compile** it.
3. The configured LLM provider proposes a structured rule. Nomus validates it deterministically and
   checks it against the author's examples with the same matcher the scanner runs.
4. The author **proposes** the compiled rule as a policy (or a new version of one), choosing its
   tier, owning boards and grace period.
5. A **Policy Approver** who is neither the author nor the person who compiled it **approves** it.
   The version is activated, signed, and added to the organization's bundle.

Nothing an LLM produces is ever active on its own: a different person must approve it. Scans never
call an LLM; they evaluate the approved rules locally.

## Turning it on

Governance is off for every organization until an Org Admin turns it on in **Governance >
Settings** (`PATCH /api/v1/cpg/settings { "enabled": true }`). While it is off you can still create
boards, set the quorum, compile, propose and approve policies; the bundle stays empty
(`enabled: false`) so nothing reaches developers or CI. Turning it off again empties the bundle at
once.

## Review boards

A board is a group of reviewers who own policies. Every policy version names at least one owning
board; later releases route review cases to the owning boards.

| Field | Notes |
|-------|-------|
| `key` | Lowercase letters, digits, `_` and `-`; unique in the organization; cannot change |
| `name` | Shown to developers next to each policy in the bundle |
| `kind` | `governance`, `legal`, `ai`, `security` or `custom`; cannot change |

Board management needs `boards.manage` (Org Admin). Members are added and removed individually;
a removal is recorded once and never deleted. A board that owns an active or pending policy
version cannot be archived (`409 board_in_use`, with the policy keys); archive is final.

## The approval quorum

The quorum configuration decides how many approvals each kind of decision needs. It is versioned:
every change creates a new, signed version with a change note, and every decision records the
version that applied. Changing it needs `quorum.manage` (Org Admin). The history is readable with
`audit.read` or `quorum.manage`.

The first version is created automatically with these defaults:

| Setting | Default | Meaning |
|---------|---------|---------|
| `tiers.advisory` | `{ "blocking": false }` | Advisory findings never block and need no review (fixed) |
| `tiers.review-required.snippet` / `.bulk` | 1 approval from any owning board; expiry up to 180 days, default 90 | Used by review cases (later release) |
| `tiers.review-required.standing` | 1 approval, any owning board, an Exception Approver; up to 90 days, default 30 | Standing exceptions (later release) |
| `tiers.prohibited.snippet` | 2 approvals, one from each owning board; up to 90 days, default 30 | |
| `tiers.prohibited.bulk` | not allowed | Fixed: bulk decisions are never allowed on prohibited policies |
| `tiers.prohibited.standing` | 2 approvals, each owning board, an Exception Approver; up to 90 days, default 30 | |
| `policyApproval.approvals` | 1 | Approvals a policy version needs; the author and the compile requester never count |
| `standingExceptions` | max 90 days, default 30, no org-wide repository patterns | |
| `gracePeriod.newPolicyDefaultDays` | 14 | Days a new policy stays advisory after approval |
| `gracePeriod.newVersionDefaultDays` | 0 | Days a new version of an active policy stays advisory |
| `proposalLapseDays` | 30 | A proposal not decided within this many days expires |
| `policyOverrides` | none | Replace a tier's slot for one policy (whole slot, no field merging) |

There is no setting that allows self-approval. The schema refuses unknown fields, bulk on the
prohibited tier (also through `policyOverrides`, `422 bulk_forbidden_on_prohibited`), extra boards
that are not active boards of the organization (`422 unknown_board`) and overrides for unknown
policies (`422 unknown_policy`).

## Authoring a policy

Write one policy per request, in plain English, and give examples:

- **Violating examples (at least one, required):** code the policy must flag. Each needs a
  repository-relative path, because rules can be scoped by path.
- **Compliant examples (optional):** code that must not be flagged, such as the approved gateway.

Use realistic, non-test paths: the detectors skip test files (`*.test.ts`, `tests/`, …), so an
example under a test path never matches. The compile result tells you when that happens.

**Only the policy text is sent to the LLM provider.** The examples stay on your server and are
checked deterministically. Every compile attempt is recorded, whatever its outcome:

| Outcome | What to do |
|---------|------------|
| `compiled` | Review the rule and propose it |
| `rejected_unexpressible` | The policy needs judgement; narrow it (the record may suggest a narrower policy) or keep it outside Nomus |
| `rejected_examples` | The rule missed a violating example or flagged a compliant one; fix the examples or the wording |
| `rejected_validation` | The proposed rule broke a safety rule; rewording usually helps |
| `rejected_schema` | The model did not answer in the expected form; try again or reword |
| `llm_error` | No provider is configured, or it failed; nothing was compiled |

### Proposing

Propose a compiled record with a key (`corp.…`), title, tier, owning boards and, optionally, a
grace period (`graceDays`) or a fixed enforcement date (`enforceFrom`). You may edit the compiled
rule before proposing; an edited rule is validated again and must still pass the examples, and the
version records that it was edited, with the diff. A compile record backs at most one version.

A policy has at most one pending version at a time. The author can withdraw it.

### Tiers

| Tier | Effect once enforced |
|------|----------------------|
| `advisory` | Shown to developers; never blocks |
| `review-required` | Blocks CI until a reviewer approves the finding (later release) |
| `prohibited` | Blocks CI; only snippet-level approvals by two boards (later release) |

## Approving a policy (four-eyes)

Approvers need `policy.approve`. The person who proposed the version and the person who compiled
it can never vote on it, whatever roles they hold: Nomus refuses it (`403 self_approval_forbidden`)
and the database refuses it independently. One reject vote rejects the version. When the quorum's
number of approvals is reached, in one transaction the version is approved, activated with its
enforcement date, signed with the instance key, the previous version is marked superseded, and the
organization's bundle is rebuilt. Connected clients of the organization receive a
`cpg.bundle.changed` event on the stream (no other organization receives it).

Retiring a policy is also a proposal (`POST /cpg/policies/:id/retire`) with the same four-eyes
approval, because it weakens enforcement. Once approved, the policy leaves the bundle.

## Grace period

When a version is approved, its enforcement date is:

- the requested `enforceFrom`, or the approval time if that date has already passed; otherwise
- the approval time plus `graceDays`, or plus the quorum default (14 days for a new policy, 0 for a
  new version of an active policy).

Before that date the policy's findings are advisory everywhere. The bundle carries the date, so
every scanner applies it the same way.

## What a corporate policy can express

A rule combines up to four deterministic matchers on one file:

| Matcher | Finds |
|---------|-------|
| `sdk_call` | Calls of an AI SDK (`openai`, `anthropic`, `google-genai`, `cohere`, `aws-bedrock`, `huggingface`, `replicate`), optionally specific methods |
| `sdk_import` | Imports of those SDKs |
| `capability` | Behaviour a detector found: for example `pii_in_ai_call`, `logs_ai_output`, `emotion_recognition`, the EU AI Act high-risk categories |
| `data_pattern` | Personal, health or financial data patterns (`ssn`, `credit_card`, `email`, …) |
| `data_flow` | AI output reaching a log, a store, the user or a third party; user input reaching an AI call |
| `line_regex` | A safe regular expression on each source line |

with `withinLines` (how close the matches must be), `unless` (matches that excuse a finding, in a
window or anywhere in the file), and file scope (`include`/`exclude` globs, languages).

Policies that compile well:

- "Do not call OpenAI directly; use the gateway" (`sdk_call`, gateway excluded by path)
- "No Anthropic SDK in the frontend" (`sdk_import` scoped to `web/**`)
- "Never send personal data to an AI model" (`capability: pii_in_ai_call`)
- "Never log AI output" (`data_flow` to `logs_output`)
- "Do not use model X" (`line_regex` on the model name)
- "Every chat call needs a moderation call within 20 lines" (`unless` in a 20-line window)

Policies that cannot be expressed, and are rejected instead of being approximated:

- intent or quality judgements ("well tested", "fair", "appropriate prompts", "secure enough");
- data flow across files or functions;
- runtime behaviour or configuration loaded at runtime;
- facts outside the repository (vendor contracts, model cards, assessments on file);
- dependency or licence policies;
- "X must exist somewhere in the repository".

An unexpressible policy cannot enter the policy log, not even as advisory, because there is nothing
deterministic to scan.

### Regular expressions

Patterns run in every developer's editor and in CI, so they are limited: at most 200 characters;
flags `""` or `"i"`; no backreferences, lookaround or named groups; no quantifier on a group that
contains a quantifier or `|` (`(a+)+`); at most 10 quantifiers, at most 2 of them unbounded
(`*`, `+`, `{n,}`); bounded repeats up to `{100}`; and the pattern must not match an empty line.
Lines longer than 4,096 characters are skipped (and counted), never matched.

### Repository settings do not apply

The repository's `.nomus.yml` ignore list and detector switches do not affect corporate rules, so a
developer cannot hide a violation by editing a file they own. Only the rule's own file scope
applies, plus fixed exclusions: `.git` and `node_modules` directories, files over 2 MB and binary
files.

## Audit and export

Every board, quorum and policy change is written to the organization's hash-chained audit log
(`board.created`, `board.member_added`, `quorum.version_created`, `policy.version_proposed`,
`policy.vote_cast`, `policy.activated`, `policy.version_rejected`, `policy.version_withdrawn`,
`policy.proposal_expired`, `policy.retirement_proposed`, `policy.retired`, …). Policy versions,
their lifecycle events and votes are append-only in the database.

An Auditor (`audit.export`) can download the whole policy log, with every version, event, vote,
activation signature and quorum version, as one signed export (`GET /api/v1/cpg/policies/export`).
The [API reference](../api-reference/policy-registry.md#export) explains how to verify it offline.

# Corporate policies

Corporate policy governance lets your organization write its own engineering policies in plain
English, turn each one into a deterministic rule, approve it with a second person, and distribute
the approved rules to every scanner (CLI, GitHub Action, VS Code extension) as a signed bundle.

This page covers review boards, the approval quorum, authoring and approving policies, the grace
period, and what a corporate policy can and cannot express. Roles and permissions are explained in
[Roles and permissions](./roles-and-permissions.md); the endpoints are in the
[policy registry API reference](../api-reference/policy-registry.md).

> Phase note: this release builds the policy registry, the signed bundle and their dashboard
> pages (Governance > Policies, Boards and Quorum), corporate findings in the CLI and VS Code, and
> review cases (requested from VS Code, shown in Governance > Cases), reviewers' decisions,
> standing exceptions (Governance > Exceptions) and the CI gate in the GitHub Action.

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

### Boards in the dashboard

**Governance > Boards** lists the active boards with their members and the policies each one owns
(archived boards are listed separately). With `boards.manage`:

- **New board** asks for the key, kind, name and an optional description;
- **Edit** renames a board or changes its description (the bundle carries the new name);
- **Add** puts an active organization user on the board; the cross next to a member removes them;
- **Archive** is refused while the board owns an active or pending version, and the message names
  those policies.

Without `boards.manage` the page is read-only and shows member counts instead of names.

## The approval quorum

The quorum configuration decides how many approvals each kind of decision needs. It is versioned:
every change creates a new, signed version with a change note, and every decision records the
version that applied. Changing it needs `quorum.manage` (Org Admin). The history is readable with
`audit.read` or `quorum.manage`.

The first version is created automatically with these defaults:

| Setting | Default | Meaning |
|---------|---------|---------|
| `tiers.advisory` | `{ "blocking": false }` | Advisory findings never block and need no review (fixed) |
| `tiers.review-required.snippet` / `.bulk` | 1 approval from any owning board; expiry up to 180 days, default 90 | Decisions on review-case findings |
| `tiers.review-required.standing` | 1 approval, any owning board, an Exception Approver; up to 90 days, default 30 | [Standing exceptions](#standing-exceptions-and-revocation) |
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

### Editing the quorum in the dashboard

**Governance > Quorum** shows the version in force (who saved it, when, the change note, the
configuration hash and signature), the rules no setting can change, and every tier and scope in a
table. Org Admins and Auditors also see the version history; **Changes** next to a version lists
what it changed compared with the version before.

With `quorum.manage`, **Edit** opens a form over the whole configuration: each tier's scopes
(allowed or not, approvals, board coverage, extra required boards, required permission, maximum
and default expiry), policy approvals, standing-exception limits, grace periods, the proposal lapse
window, and per-policy overrides. The form checks the draft with the engine's own rules as you
type, shows each problem next to its field and in a summary, and lists exactly what will change.
**Save as version N** stays disabled until the draft is valid, differs from the version in force
and has a change note; nothing is sent before that. Bulk decisions on the prohibited tier, and bulk
overrides for a prohibited policy, are shown locked. There is no self-approval setting to show.

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
| `review-required` | Blocks CI until a reviewer approves the finding |
| `prohibited` | Blocks CI; only snippet-level approvals by two boards |

In the dashboard this is **Governance > Policies > New policy** (authors need `policy.author`):
the page compiles, shows the rule in plain English and as JSON with every rejection reason and
example result, labels everything the model produced as generated, and proposes the version. The
user guide walks through it: [Writing and approving a policy](../user-guide/getting-started.md#writing-and-approving-a-policy).

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

On a policy's page in the dashboard, Approve and Reject appear only for a Policy Approver who did
not propose or compile the pending version and has not voted on it yet; everyone else sees the
reason (the server enforces the same rules on every vote). The page shows the approvals so far
against the number required, the votes with their comments, when the proposal lapses, and every
version with its votes, activation signature and enforcement date.

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

## Review cases in the dashboard

**Governance > Cases** shows every review case of the repositories a user can read (`case.read`,
including team- and repository-scoped grants). The case page shows lanes, revisions, findings with
their snippets and justifications, reviewer context, change requests and comments; the user guide
describes it. Points for admins:

- **Who can do what.** Commenting needs `case.comment`; requesting changes needs `case.review` and
  membership of the lane's board (add reviewers to boards on the Boards page); closing needs
  `case.close`; the developer who opened a case can always withdraw it. The server decides these
  per repository, and re-checks every action.
- **Governance off.** While governance is switched off, the case list is empty and cases cannot be
  changed; open cases stay readable by their link.
- **Reviewer context** is generated only when someone selects **Show reviewer context**, once per
  snippet and policy version, so viewing a case sends nothing to the LLM provider by itself. Switch
  it off in Governance > Settings.
- **Closed cases** cannot change. The case page verifies the signed closure record on every load
  and shows **Signature does not verify** if the stored history no longer matches it.

## Decisions and voting in the dashboard

Reviewers decide findings on the case page (the user guide describes it). Points for admins:

- **Who can propose and vote:** `case.review` on the repository and membership of a required board
  (the policy's owning boards plus any extra boards of the quorum). Add reviewers to boards on the
  Boards page; a reviewer outside them is told which boards can decide.
- **Expiry limits** come from the quorum in force for the policy's tier (or its override), and are
  checked again when a proposal is finalized. Rejections never expire.
- **Bulk decisions** are offered only for review-required policies; prohibited findings are always
  decided one at a time, whatever the quorum says.
- **Four-eyes:** whoever opened, justified or revised a case can never propose or vote on its
  findings, and the proposer of a standing exception cannot vote on it. The pages hide these
  actions and say why; the server refuses them too.
- **Revocation** needs `decision.revoke` (Exception Approvers); it is shown in the proposal's
  history with who revoked it, when and why.

## Standing exceptions and revocation

A standing exception lets code that matches a pattern pass without a decision per finding, for
example a legacy directory that is being retired. Anyone with `exception.propose` (Case Reviewers
and Exception Approvers) proposes one on **Governance > Exceptions** or with `POST /api/v1/cpg/proposals` (see the
[API reference](../api-reference/approvals.md#standing-exceptions)). The page lists every
exception, including pending ones proposed outside a case, with filters by status and policy.

- **What it covers:** repositories (or teams, whose repositories are looked up each time a finding
  is checked), path globs with exclusions, one policy version, and optional conditions (branches,
  languages, a maximum finding size, a pattern the snippet must contain).
- **Who approves:** by default the same boards as the policy's snippet decisions, and at least one
  approver with `exception.approve` (the Exception Approver role); for prohibited policies, two
  approvals covering every owning board. Nobody involved in a case the exception covers can vote,
  and neither can the proposer.
- **How long:** an expiry is required, at most `standingExceptions.maxExpiryDays` (90 days by
  default). A new version of the policy ends the exception early: it shows as **Lapsed**, and the
  new-version page warns authors how many exceptions their version will lapse.
- **Precedence:** a rejection of a finding always wins over an exception; an unexpired approval is
  reported instead of the exception; an expired approval falls back to a matching exception.

Revoking (`decision.revoke`, held by Exception Approvers) ends a decision or exception at once and
is recorded as a signed, append-only revocation with its reason. It cannot be undone: propose
again to restore it. Affected findings return to review and their cases are re-evaluated.

A daily sweep at 03:30 UTC records an audit event when an approval or exception is 7 days and 1
day from expiry and when it has expired, once each, and moves any case whose approvals expired out
of `decided`. Integrations subscribed to `exception.expiring` and `exception.expired` are notified.

## Enforcing in CI

VS Code advises; CI enforces. The Nomus GitHub Action runs the corporate policy gate after its
regulatory scan whenever corporate policies are on for the organization of its API key (the key
needs the `read:policies` and `evaluate` scopes). It scans the whole checkout, whatever
`working-directory` says, sends every finding to the server, and verifies the server's signed
verdict. The job fails unless every blocking finding has a valid decision; the check run
**Nomus Corporate Policy Gate**, a `<!-- nomus-cpg -->` pull request comment (the case link, the
counts and one row per blocking finding; never code) and a Code Scanning upload with the category
`nomus-corporate/` show why. See the [Action README](../../packages/github-action/README.md#corporate-policy-gate).

The gate fails closed: if the server cannot be reached, answers an error, or sends anything that
does not verify, the job fails with `corporate-status=unknown`. A workflow cannot switch the gate
off: `corporate-gate: false` fails the job while the organization enforces corporate policies.

The workflow file lives in the repository, so the gate is only as strong as its protection.
Before relying on it:

1. **Require the check.** In the repository's branch protection (or ruleset) for the default
   branch, require the status check of the Nomus job, so a pull request cannot merge while it
   fails, is missing or is still running.
2. **Protect the workflow.** Add the workflow file to `CODEOWNERS` with your governance team as
   owners, and require code-owner review, so nobody can remove or weaken the job in the same pull
   request it would block:

   ```
   /.github/workflows/nomus.yml  @your-org/governance
   ```

3. **Run it on every pull request event**, including `closed`, so a merged pull request closes its
   review case: `on: pull_request: types: [opened, synchronize, reopened, closed]`.

## Integrations: email, Jira and webhooks

Nomus can tell people and other systems when a case needs them. An Org Admin (or anyone with
`integrations.manage`) configures integrations with `POST /api/v1/cpg/integrations`; the
dashboard page arrives in a later release. Each integration chooses its events and, optionally, the
boards it serves (`boardIds`; empty means every board). A case whose findings belong to several
boards is split: each board gets its own email, webhook call and Jira issue.

**Notifications never contain code.** They carry the case reference, repository, branch, pull
request, board, finding counts and the policies involved, plus a link to the case in Nomus. Code,
snippets, justifications, comments and file paths stay in Nomus, behind sign-in and permissions.

1. **Email** goes through the instance's Resend account: a platform admin sets the Resend API key
   on the Notifications settings page first. By default a review request emails the active members
   of each board involved, and a change request emails the developer who opened the case and the
   authors of its justifications (`includeBoardMembers`, `notifyDevelopers`); `extraRecipients`
   receive every subscribed event.
2. **Jira Cloud**: give the site URL, the account email and an API token of a bot account that can
   create issues in the project (`projectKey`). Nomus creates one issue per case and board and
   comments on it for later events. It never moves the issue through your workflow.
3. **Webhook**: give an HTTPS URL. Nomus returns the signing secret once, when you create the
   webhook or rotate its secret; store it in your receiver. Each call is a JSON POST signed with
   `X-Nomus-Signature: sha256=…` over the timestamp and body. Verify it as shown in the
   [API reference](../api-reference/integrations.md#webhook), reject timestamps older than five
   minutes, and deduplicate on `X-Nomus-Delivery-Id`. Use the webhook for Slack, Teams, Trello,
   Linear or any other tool through a small bridge.

Use `POST /api/v1/cpg/integrations/:id/test` to send a test notification. Secrets are stored
encrypted with the instance key (`NOMUS_SIGNING_KEY_SECRET`), shown only by their last four
characters, and never written to logs or the audit log. Jira and webhook targets must be public
HTTPS addresses; `NOMUS_CPG_ALLOW_PRIVATE_TARGETS=true` allows private addresses for test setups
only and logs a warning in production.

Deliveries are queued with the change that caused them and sent in the background, so a slow or
broken receiver never delays a reviewer. Failed sends are retried for about 21 hours (the schedule
survives restarts). A delivery that fails for good, or at once on a response such as `401` or
`404` that retrying cannot fix, is logged at error level and audited as `delivery.failed`. Check
`GET /api/v1/cpg/deliveries?status=failed`, fix the integration, then retry the delivery.

## Audit and export

Every board, quorum and policy change is written to the organization's hash-chained audit log
(`board.created`, `board.member_added`, `quorum.version_created`, `policy.version_proposed`,
`policy.vote_cast`, `policy.activated`, `policy.version_rejected`, `policy.version_withdrawn`,
`policy.proposal_expired`, `policy.retirement_proposed`, `policy.retired`, …). Policy versions,
their lifecycle events and votes are append-only in the database.

An Auditor (`audit.export`) can download the whole policy log, with every version, event, vote,
activation signature and quorum version, as one signed export (`GET /api/v1/cpg/policies/export`).
The [API reference](../api-reference/policy-registry.md#export) explains how to verify it offline.

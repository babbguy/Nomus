# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Corporate policy governance, phase 4 (review cases, engine core): the review case store, with
  one open case per organization, repository and branch, and revisions that snapshot the branch's
  corporate findings (no new revision when nothing changed; new, carried and resolved counts). The
  derived case state follows the review state machine, and findings split into one lane per owning
  board. A closed case and everything attached to it can no longer be changed, which the database
  enforces. No API or UI yet.
- Corporate policy governance, phase 3 (scanner CLI and VS Code): corporate policy findings where
  developers work. The CLI fetches the organization's signed policy bundle, verifies every signature
  and hash before using any rule, and evaluates the rules locally and deterministically (no LLM, no
  code uploaded). Findings carry their line range, status (needs review, or advisory during a grace
  period) and fingerprint, in a separate console section, in new JSON fields (`corporate`,
  `corporateFindings`) and in a second SARIF run (`nomus-corporate/`); the regulatory findings,
  counts, status, SARIF run and exit codes are unchanged, and an organization without corporate
  policies gets exactly the previous output. `--no-corporate` skips them. A bundle that does not
  verify fails the scan closed (exit code 3) and nothing is reported; a bundle that cannot be fetched
  is reported as "corporate policies were NOT checked" and the regulatory scan runs as before. The VS Code
  extension shows corporate findings as `Nomus Policy` diagnostics over the full matched range, with
  their own severity mapping and a link to the policy page, adds a **Corporate Policies** view
  (findings by group, repository and branch, bundle status), revalidates the bundle with its ETag,
  and makes every failure visible: offline it uses a re-verified cache and says so, an expired,
  missing, refused or tampered bundle clears corporate diagnostics and shows an error. New settings
  `nomus.corporate.enabled` and `nomus.corporate.maxCacheAgeHours`; new command
  `nomus.cpg.refresh`. See `docs/user-guide/corporate-policies.md`.
- Corporate policy governance, phase 2 (dashboard): the policy registry pages under
  **Governance**. Policies (`/governance/policies`: the policy log with state, tier, owning boards,
  active and pending versions, and the grace period or enforce-from date); New policy
  (`/governance/policies/new`: write a policy in plain English with violating and compliant code
  examples, compile it, read the rule both as plain English and as the exact JSON, see every
  rejection reason and each example's result, then propose it with a key, title, tier, owning
  boards and a grace period or enforce-from date, optionally editing the rule; compiled output is
  labelled as generated and the page states that nothing is active until someone other than the
  author approves it); a policy page (`/governance/policies/:id`: versions with their status,
  approval votes, activation signatures and supersede history, a diff between any two versions,
  the four-eyes status of a pending version with Approve and Reject only for eligible approvers and
  the reason for everyone else, withdraw, new version and proposed retirement); Boards
  (`/governance/boards`: create, rename, archive, add and remove members, and the policies each
  board owns); and Quorum (`/governance/quorum`: the signed configuration in force, an editor that
  validates with the engine's own rules as you type and lists every change before saving a new
  version with a change note, and the version history with the changes of each version). The
  rules no setting can change (no self-approval, no bulk decisions on the prohibited tier,
  advisory never blocks) are shown and cannot be configured.
- Corporate policy governance, phase 2 (scanner library): `@nomus/scanner/corporate`, the pure
  library the engine, the VS Code extension and the GitHub Action share for corporate policies: the
  rule schema and closed vocabularies, globs, regex safety, the deterministic matcher, the finding
  fingerprint, repository and language helpers, and the signed-bundle client. Scans stay
  deterministic: nothing in it calls an LLM. The SDK-usage detector now reports the last line of
  each call (`endLine`).
- Corporate policy governance, phase 2 (engine): the corporate policy registry. Review boards
  and their members; a versioned, signed approval quorum (defaults from the brief: 1 approver for
  review-required, 2 from each owning board for prohibited, no bulk decisions on prohibited, 14-day
  grace for new policies); a compile step that turns a plain-English policy into a deterministic
  rule with the configured LLM provider, sending only the policy text (never example code), then
  validating the rule and checking it against the author's examples, and recording every attempt;
  an append-only policy log where a version becomes active only after approval by someone other
  than its author and the person who compiled it (enforced in code and by the database), with a
  grace period, retirement through the same approval, and an Ed25519-signed activation; and a
  signed per-organization policy bundle (`GET /api/v1/cpg/bundle`, ETag) for scanners, plus a
  signed export of the whole log. Policies that cannot be decided deterministically are rejected
  with the reason. New endpoints under `/api/v1/cpg`: `/boards`, `/quorum`, `/compile`,
  `/policies`, `/policy-versions/:id/votes`, `/policy-versions/:id/withdraw`, `/bundle` and
  `/policies/export`. See `docs/admin-guide/corporate-policies.md` and
  `docs/api-reference/policy-registry.md`.
- Corporate policy governance, phase 1 (engine): per-organization role-based access control.
  Seven system roles (Org Admin, Policy Author, Policy Approver, Case Reviewer, Exception Approver,
  Developer, Auditor), custom roles, org-, team- and repository-scoped grants, teams with
  repository patterns, per-organization governance settings (off by default) and a hash-chained,
  append-only audit log. New endpoints under `/api/v1/cpg` (`/me`, `/permissions`, `/roles`,
  `/users`, `/grants/:id/revoke`, `/teams`, `/settings`, `/audit`) and
  `POST /api/v1/tenants/:id/org-admins` for platform administrators to restore an Org Admin. See
  `docs/admin-guide/roles-and-permissions.md` and `docs/api-reference/governance.md`.
- Corporate policy governance, phase 1 (dashboard): a **Governance** sidebar group with
  Overview (`/governance`: status, your permissions, why a page was not available), Access
  (`/governance/access`: invite users, grant roles org-wide or per team or repository, revoke with
  a reason, deactivate; a role permission matrix with a role editor; teams and their repository
  patterns), Audit log (`/governance/audit`: filterable, with the hash-chain verification result)
  and Settings (`/governance/settings`: turn governance on, and reviewer-context generation with a
  disclosure that flagged snippets are sent to the configured LLM provider). Pages and menu items
  follow the user's permissions from `GET /api/v1/cpg/me`, so they never call an endpoint the
  user may not use. Every governance response is validated against its contract in the browser.
- Numbered, checksummed database migrations for the new tables, with foreign keys, CHECK
  constraints and triggers that refuse updates and deletes on append-only tables. An edited
  migration stops the engine at startup instead of drifting.

### Changed
- Scanner CLI: exit codes are now set with `process.exitCode` instead of `process.exit()`, so the
  process ends after its output is flushed and its connections are closed (the codes themselves are
  unchanged). `.nomus.yml` `ignore` and detector settings apply to regulatory scanning only; corporate
  policies check every file except `.git`, `node_modules`, files over 2 MB and binary files.
- Live events can now be private to one organization: corporate-policy events (`cpg.bundle.changed`)
  reach only that organization's stream clients. Existing events are unchanged.
- `GET /api/v1/cpg/me` and `GET /api/v1/cpg/users` now list each user's review boards.
- `GET /api/v1/cpg/me` now lists the caller's active roles (`roles`), and the sidebar's user card
  shows the user's governance role (for example "Org Admin", or "Org Admin +1" with several roles)
  instead of "Member". Platform administrators and users without governance roles keep the
  previous label.
- The policy log (`GET /api/v1/cpg/policies` and the policy detail) now says whether a pending
  version defines the policy or retires it (`pendingVersionKind`).
- On upgrade, each organization's earliest member becomes Org Admin and every member becomes
  Developer; platform administrators get no organization role. Developer keeps the v1.1.0 member
  abilities (`PATCH /org`, organization API keys) as grants an Org Admin can remove.
- Settings shows API-key management only to users with `org.api_keys.manage`, and saves the
  organization profile only with `org.profile.update`, instead of failing with 403.
- `PATCH /api/v1/org`, `/api/v1/org/api-keys` and `GET /api/v1/org/members` now check the
  `org.profile.update`, `org.api_keys.manage` and `org.members.read` permissions. Members keep
  access through Developer, and platform administrator sessions keep v1.1.0 access.
- A new member created in an organization with no active Org Admin also becomes its Org Admin.
  Moving a user to another organization revokes their grants in the old one.
- The VS Code extension key from device sign-in is now bound to the user who signed in. It stops
  working when that user is deactivated or moved, and is refused with `password_change_required`
  while the user has a temporary password.

### Fixed
- A second developer signing in to VS Code in the same organization revoked the first
  developer's key. Signing in now replaces only your own extension key.
### Fixed
- Scanner: two scans of the same repository could list findings in a different order, because the
  file walk returns files in no guaranteed order. Files are now sorted before detection, so the
  console, JSON and SARIF output of identical trees is identical.
- The database migrator never created the indexes declared in the schema, so rule-key uniqueness was
  enforced only in application code and every lookup index was missing. It now creates every declared
  `index()` / `uniqueIndex()` on fresh and existing databases, deriving them from the schema. Before
  building a unique index it checks for existing duplicate keys and, if any exist, stops startup with an
  error naming the table, index and keys; no data is changed or dropped.
- The compliance score was served from a 30 s cache that only scan uploads cleared, so for up to
  30 s after a rule was created, edited, retired, approved or rejected, an AI system or benchmark
  changed, an organization's jurisdictions changed, or GitHub App findings landed, Posture, the
  dashboard, the public badge, the GitHub Action and the VS Code extension showed the old numbers
  as current. Every runtime write to those inputs now clears the cache after it commits, and a test
  fails if a new write path skips it.

## [1.1.0] - 2026-10-08

### Security
- A session still on its temporary password could call the whole API (read the organization,
  create API keys) and mint a VS Code extension key. Such sessions are now limited to changing
  the password, `GET /auth/me` and logging out. (#5)

### Fixed
- `/evaluate` used different applicability rules from `/simulate`: it ignored `INTL` rules,
  implied data types and industry scoping, and could sign PHI sent to an AI model as compliant.
  Both now share one implementation. (#11)
- End-to-end workflow fixes across the scanner, GitHub Action, MCP server, attestations, rule
  stream, regulation pipeline and dashboard, including: rule conditions matched only when all
  hold, scanner over-reporting (241 findings on the reference repo, 63 correct), a GitHub Action
  bundle that failed to load, SSE connections never released on disconnect, unchanged re-uploads
  re-signing every rule, and dashboard figures that disagreed between pages. (#3)
- Scanner: a repository checked out under a folder named `tests`, `fixtures` or similar skipped
  most detection; findings in files using two SDKs named the wrong SDK. (#6, #7)
- GitHub Action: inline review comments were posted again on every run. (#8)
- VS Code extension: the workspace `.nomus.yml` was ignored; the extension now packages out of
  the box. (#10, #1)
- `/simulations/run` for an organization with no AI systems omitted `overallRiskLevel`. (#9)
- `/.well-known/nomus-keys` now publishes an RFC 8037 OKP JWK that standard libraries accept. (#12)
- Public `/verify/:id`, `/transparency` and `/ledger` pages redirected signed-out visitors to the
  login page. (#13)
- Rules created by the regulation pipeline were not delivered to live subscribers, and non-policy
  events corrupted `Last-Event-ID` replay. (#14)

### Release gate
- `npm run gate` (`e2e/run-gate.mjs`) runs the built product the way users do and fails on
  anything a user would notice: the production engine on a fresh database with a deterministic
  fake LLM, the production dashboard build, the scanner CLI, the GitHub Action bundle against a
  fake GitHub API, the MCP server over stdio and the VS Code extension in a stub extension host.
  It checks bring-up and rule integrity, exact scanner findings and exit codes, SARIF validity,
  Action outputs and second-run updates, MCP tool results, the extension's sign-in and views,
  `/evaluate`-`/simulate` agreement, attestation lifecycle and offline verification, rule SSE
  events and replay, the manual-upload pipeline, a Playwright sweep of every dashboard route
  (console errors, failed calls, broken values, numbers that must agree across pages), server
  logs and peak memory. See `e2e/README.md`.
- New required CI check "Release gate" (`.github/workflows/release-gate.yml`) on pull requests
  to and pushes on `develop` and `main`; screenshots, logs and results are uploaded as an
  artifact and the PASS/FAIL table is written to the job summary.

## [1.0.0] - 2026-10-07

Initial public release under the Apache License 2.0.

### Engine
- Self-service organization endpoints under `/api/v1/org` for any signed-in user: read and
  update the organization profile (industry, jurisdictions, public-verify opt-in), create, list
  and revoke the organization's own API keys (`read:policies`, `evaluate`, `stream`; never
  `admin`), and list its members read-only. Key generation is shared with the platform-admin
  `/tenants` routes, and key creation and revocation are logged with the acting user.
- Hono API server with SQLite (Drizzle ORM) storage, API-key and session authentication,
  organizations and users, and configurable request limits
  (`NOMUS_RATE_LIMIT_RPM`, `NOMUS_MAX_API_KEYS_PER_ORG`, `NOMUS_MAX_SSE_CONNECTIONS_PER_ORG`).
- Regulation ingestion pipeline: a registry of 35 regulatory sources across 15 jurisdiction
  and standards-body codes, scheduled scraping with HTTP and optional headless-browser
  fallback, raw-snapshot hashing, content cleaning and verification, structured diffs, and
  a separate manual-upload path.
- Admin-managed regulations: sources are tracked as built-in, customized or custom, and the
  startup registry sync only refreshes untouched built-ins (it no longer deactivates sources an
  admin added or reverts edits to built-ins); sources can be added, edited, restored to the
  built-in values and deactivated, and deactivating a source retires its rules (reactivating it
  restores exactly those). Rules can be created, edited, retired and reactivated through
  `/api/v1/admin/rules` with signed, versioned changes and `policy_events` history; rules
  edited by a person are locked and the extraction pipeline and forge worker skip them.
- LLM-assisted rule extraction, classification, scoring and merging with Anthropic, OpenAI
  and Google providers, per-call cost tracking and an optional human approval step.
- Seeded rule sets for EU AI Act, GDPR, HIPAA, PCI DSS, NIST AI RMF, NIST CSF, ISO 27001,
  SOC 2, CCPA, FERPA, GLBA, FDA, DORA, NIS2 and AI TRiSM.
- Ed25519-signed attestations with lifecycle states (valid, expired, revoked, superseded),
  public verification endpoint, status-change subscriptions, and optional EVM state-hash
  anchoring.
- Scout: legislative signal and bill tracking with passage scoring and an accuracy ledger.
- Compliance posture scoring, AI bill of materials, benchmark definitions, regulatory
  impact simulation, knowledge graph, clause map and audit export.
- GitHub App and OAuth integration for repository scanning; Google sign-in; email, ntfy and
  Slack notifications.
- Optional Modus integration (off unless `NOMUS_MODUS_API_URL` is set).

### Dashboard
- Source ownership badges, restore-to-built-in, and a Rules area for creating, editing, retiring
  and reviewing the history of rules.
- React 19 / Vite / Tailwind single-page app with administrator and end-user areas and
  public attestation-verification and transparency pages. Route-level code splitting keeps
  the main bundle small.
- Member Settings lets users manage their own organization profile and API keys (shown once,
  with copy; revoke with confirmation); Team is a read-only member list; the member home page
  works against the real impact-map response.

### Packages
- `@nomus/scanner`: AI SDK, capability, PHI and transparency detection; CLI and
  programmatic API; JSON, text and SARIF output.
- `@nomus/github-action`: GitHub Action that scans pull requests and posts comments, SARIF
  and check runs.
- `@nomus/mcp-server`: MCP server exposing applicability checks to AI coding agents.
- VS Code extension, `@nomus/chain` and `@nomus/shared`.

### Deployment
- Dockerfiles for the engine and dashboard, a Docker Compose setup that runs both on
  localhost, an optional TLS proxy profile, and example Nginx/PM2 files under `infra/`.

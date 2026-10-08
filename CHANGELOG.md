# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

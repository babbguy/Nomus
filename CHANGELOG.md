# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

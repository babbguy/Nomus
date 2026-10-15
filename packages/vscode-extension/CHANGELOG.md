# Changelog

## [Unreleased]

### Added
- Corporate policy findings from your organization's signed policy bundle, evaluated locally on
  save, on open and with Scan Workspace. They appear as `Nomus Policy` diagnostics over the full
  matched range (`[Policy · PROHIBITED] corp.key v1: … Status: needs review.`), with Error, Warning
  or Information by tier and status, a link to the policy page and the owning boards. Regulatory
  diagnostics are unchanged.
- **Corporate Policies** view: findings grouped as blocking or advisory/grace period, the
  repository and branch (read from `.git`), and the bundle status.
- The bundle is cached per server, re-verified on every use and revalidated with its ETag at most
  every 5 minutes; **Nomus: Refresh Corporate Policies** revalidates now. Offline, a verified cache
  is used and marked offline; an expired, missing, refused or tampered bundle clears corporate
  diagnostics and shows an error, never an empty "no violations" state.
- Settings `nomus.corporate.enabled` and `nomus.corporate.maxCacheAgeHours`.

## [1.0.0] - 2026-10-07

Initial public release of the Nomus VS Code extension.

- Scan on save and on file open
- AI SDK detection across TypeScript, JavaScript, Python, Java, and Go
- Native VS Code diagnostics (errors, warnings, info) per file
- Compliance Status sidebar with score, jurisdiction breakdown, and key metrics
- Findings panel with severity, legal references, and suggested fixes
- AI Bill of Materials (AI-BOM) generation
- Regulatory Radar with upcoming legislative signals
- COMPL-AI benchmark runs created on the engine (the engine stores definitions and results; it does not run the benchmarks)
- Regulatory impact simulation
- AI-BOM export request (JSON or PDF)
- Sign in via browser device flow, or an API key setting
- Offline mode that lists detected AI SDK imports as informational diagnostics when no API key is set

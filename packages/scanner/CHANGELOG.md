# Changelog

## [Unreleased]

### Added
- Corporate policies in scans. `ScanOptions.corporate` (`{ mode: 'auto' | 'off', bundle?, now? }`,
  default off) fetches and verifies the org's signed bundle before any rule is used, then evaluates
  it locally over the repository (`runScan`) or the given files (`runScanFromContents`).
  `ScanResult` gains `corporateFindings` (`CorporateFinding`, `source: 'corporate'`, with range,
  tier, status, `blocking` and fingerprint) and `corporate` (what was evaluated); `findings`,
  `counts` and `status` are unchanged. New exports: `runCorporateScan`, `runCorporateScanOnDisk`,
  `corporateStatusOf`, `dashboardUrlFromApiUrl`, `CorporateBundleError`, `bundleFailureOf`.
- CLI: corporate findings in a separate console section, in the JSON report (`corporate`,
  `corporateFindings`) and as a second SARIF run (`formatCorporateSarifRun`, category
  `nomus-corporate/`), only when the organization has governance switched on. `--no-corporate`
  turns them off. A bundle that does not verify exits 3; a bundle that cannot be fetched gives a
  "corporate policies were NOT checked" warning and the regulatory scan runs as before.
- The bundle client classifies failures (`unreachable`, `http` with the status, `invalid`) and
  returns the key the bundle was verified with, so clients can re-verify a cached copy offline.
- `@nomus/scanner/corporate`: the corporate policy library shared by the engine, the VS Code
  extension and the GitHub Action. It holds the corporate rule schema and its closed vocabularies
  (SDK families, detector capabilities, data patterns, data flows), the glob engine, static regex
  safety checks, the deterministic matcher (`evaluateCorporateRules`, `evaluateRuleOnText`) over
  in-memory files, the finding fingerprint (`sha256(normalized snippet):policyKey:version`), the
  repository and language helpers, the bundle contract and a client that fetches the signed bundle
  and verifies every signature and hash, failing closed. The matcher never calls an LLM or the network.

### Changed
- The CLI sets its exit code with `process.exitCode` instead of calling `process.exit()`.
- The SDK-usage detector adds `endLine` (the last line of the call expression) to its signal metadata.
- `NomusApiError` moved to `src/errors.ts`; it is still exported from `@nomus/scanner` as before.

## [1.0.0] - 2026-10-07

Initial public release of the `@nomus/scanner` package.

- 19 AI SDK detection patterns across JavaScript/TypeScript, Python, Java, and Go
- Regulatory rule matching through a Nomus engine (`POST /api/v1/simulate`); fails closed if the engine is unreachable
- SARIF, JSON, and console output for CI integration
- CLI (`nomus-scan`) and programmatic API (`runScan`, `runScanFromContents`)
- Configurable `--fail-on` severity threshold and jurisdiction targeting via `.nomus.yml`
- Plugin-based detector architecture (import, SDK usage, PHI pattern, data flow, risk classifier, transparency)
- Remediation suggestions with legal references

# Changelog

## [Unreleased]

### Added
- `@nomus/scanner/corporate`: the corporate policy library shared by the engine, the VS Code
  extension and the GitHub Action. It holds the corporate rule schema and its closed vocabularies
  (SDK families, detector capabilities, data patterns, data flows), the glob engine, static regex
  safety checks, the deterministic matcher (`evaluateCorporateRules`, `evaluateRuleOnText`) over
  in-memory files, the finding fingerprint (`sha256(normalized snippet):policyKey:version`), the
  repository and language helpers, the bundle contract and a client that fetches the signed bundle
  and verifies every signature and hash, failing closed. The matcher never calls an LLM or the network.

### Changed
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

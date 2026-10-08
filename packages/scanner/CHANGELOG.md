# Changelog

## [1.0.0] - 2026-10-07

Initial public release of the `@nomus/scanner` package.

- 19 AI SDK detection patterns across JavaScript/TypeScript, Python, Java, and Go
- Regulatory rule matching through a Nomus engine (`POST /api/v1/simulate`); fails closed if the engine is unreachable
- SARIF, JSON, and console output for CI integration
- CLI (`nomus-scan`) and programmatic API (`runScan`, `runScanFromContents`)
- Configurable `--fail-on` severity threshold and jurisdiction targeting via `.nomus.yml`
- Plugin-based detector architecture (import, SDK usage, PHI pattern, data flow, risk classifier, transparency)
- Remediation suggestions with legal references

# @nomus/scanner

AI regulatory applicability engine. Scans codebases to detect AI SDK usage, identify AI capabilities, match applicable regulatory obligations, and produce findings with remediation suggestions.

Workspace-internal package (`private: true`, not published to npm). It provides a CLI binary, `nomus-scan` (`dist/index.js`), and a programmatic API.

The scanner detects AI SDK usage locally, then asks a running Nomus engine (`POST /api/v1/simulate`) which obligations apply. It needs an engine URL (default `http://localhost:3100`) and an API key. If the engine cannot be reached, the scan fails closed (CLI exit code 3) rather than reporting a pass.

## Quick Start

### CLI

From a source checkout:

```bash
npm install                      # repository root, once
npm run build:packages           # builds shared, scanner, chain, mcp-server

export NOMUS_API_KEY=nk_live_...                        # create one under Settings, API Keys in the dashboard
node packages/scanner/dist/index.js .                  # Scan current directory
node packages/scanner/dist/index.js ./src --json       # JSON output
node packages/scanner/dist/index.js ./src --sarif      # SARIF output (for CI integrations)
node packages/scanner/dist/index.js . --fail-on=high   # Fail on high+ severity findings
node packages/scanner/dist/index.js . --no-corporate   # Skip your organization's corporate policies
```

The path and flags may come in any order; `--help` prints usage and `--version` the version. Exit codes: `0` pass, `1` findings at or above `--fail-on` (default `critical`), `2` usage or configuration error (an unknown flag, or a missing `.nomus.yml`), `3` Nomus API unreachable or unusable. A scan that detects no AI SDK usage passes without contacting the engine.

A `.nomus.yml` (see below) is required in the scanned directory.

**Corporate policies.** When your organization has corporate policy governance switched on, the CLI
also downloads its signed policy bundle (the key needs `read:policies`), verifies every signature
before using any rule, and evaluates the rules locally: no LLM, no code uploaded. Corporate findings
appear in a separate console section, as `corporate` and `corporateFindings` in the JSON, and as a
second SARIF run (`automationDetails.id: nomus-corporate/`). They never change the regulatory
results or the exit code. A bundle that does not verify exits `3` with the reason; a bundle that
cannot be fetched is reported on stderr as NOT checked, and the regulatory scan runs as before.
`--no-corporate` skips corporate policies. Corporate rules ignore `.nomus.yml` `ignore`
and `detectors`. See [Corporate Policies in the CLI and VS Code](../../docs/user-guide/corporate-policies.md).

### Programmatic

```typescript
// from another workspace package that depends on @nomus/scanner
import { runScan } from '@nomus/scanner';

// Without a `config` option, runScan loads .nomus.yml from rootDir.
const result = await runScan({
  rootDir: './my-project',
  config: { jurisdictions: ['EU', 'US-FED'], api_key: process.env.NOMUS_API_KEY },
  failOn: 'high',
});

console.log(result.findings);   // Finding[]
console.log(result.status);     // 'pass' | 'fail'
console.log(result.counts);     // { critical, high, medium, low, total }

// Corporate policies are off unless asked for. 'auto' fetches and verifies the org bundle
// (it throws NomusApiError if the bundle cannot be fetched or does not verify).
const withPolicies = await runScan({ rootDir: './my-project', corporate: { mode: 'auto' } });
console.log(withPolicies.corporateFindings); // CorporateFinding[]: range, tier, status, blocking, fingerprint
console.log(withPolicies.corporate);         // { enabled, bundleHash, policyCount, scannedFileCount, ... }
```

## Configuration

Create a `.nomus.yml` in your project root:

```yaml
nomus:
  api_key: nk_live_...               # Optional here; NOMUS_API_KEY is used if omitted
  api_url: http://localhost:3100     # Default
  jurisdictions:                      # Required, at least one
    - EU
    - US-FED
  sector: finance                     # Optional: sector-specific rules (healthcare, finance, education, government, ...)
  data_types:                         # Optional: data types your app handles
    - personal_data
    - biometric
  ignore:                             # Glob patterns to skip (replaces the defaults)
    - node_modules/**
    - dist/**
```

The config file is standard YAML. A value written as `$NAME` is read from that environment variable, and the scan fails if it is unset. Invalid YAML or invalid values stop the scan with an error. `.nomus.yaml` and `.nomus.json` are also accepted. Default `ignore` globs are `node_modules/**`, `dist/**`, `.git/**`, `**/*.test.*` and `**/*.spec.*`.

## Architecture

```
src/
  scan.ts              Core scan orchestrator (runScan entry point)
  index.ts             CLI entry point (nomus-scan binary)
  config/
    loader.ts          Loads .nomus.yml configuration
    schema.ts          Zod schema for config validation
  detect/
    detector.ts        Detector plugin registry and signal merging
    import-detector.ts Built-in detector: AI SDK import detection
    imports.ts         Import pattern matching (known AI SDKs)
    capabilities.ts    AI capability inference from detected imports
    sdk-usage-detector.ts, phi-pattern-detector.ts, data-flow-detector.ts,
    risk-classifier.ts, transparency-detector.ts   Additional built-in detectors
    file-content.ts    File content helpers
  match/
    rule-matcher.ts    Matches regulatory rules to detected signals/capabilities
  fix/
    suggestions.ts     Generates remediation suggestions for findings
  output/
    reporter.ts        Console and JSON output formatters
    sarif.ts           SARIF format output (for GitHub Code Scanning, etc.)
```

### Scan Pipeline

1. **File Discovery** -- Glob for source files (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.py`, `.java`, `.go`)
2. **Detection** -- Run the built-in detectors (import, SDK usage, PHI pattern, data flow, risk classifier, transparency; each can be toggled under `detectors:` in `.nomus.yml`) plus any plugins you register
3. **Signal Merging** -- Merge signals from all detectors
4. **Rule Matching** -- Match regulatory rules against detected signals and capabilities
5. **Suggestion Generation** -- Produce remediation suggestions for each finding
6. **Output** -- Format as console report, JSON, or SARIF

### Supported Languages

TypeScript, JavaScript, Python, Java, Go.

### Package Exports

| Export | Description |
|--------|-------------|
| `@nomus/scanner` | Main `runScan` function |
| `@nomus/scanner/sarif` | SARIF report formatter |
| `@nomus/scanner/detect` | Import detection utilities |
| `@nomus/scanner/capabilities` | AI capability detection |
| `@nomus/scanner/reporter` | Console/JSON output formatters |
| `@nomus/scanner/detector` | Detector plugin registry |
| `@nomus/scanner/corporate` | Corporate policy library: rule schema and vocabularies, glob and regex safety, the deterministic matcher (`evaluateCorporateRules`), the finding fingerprint, repository and language helpers, and the signed-bundle client (`fetchCorporateBundle`, `verifyCorporateBundle`). Pure and LLM-free; only the bundle client uses the network |

## Build

```bash
npm run build -w packages/scanner    # tsc
npm run test -w packages/scanner     # vitest
```

The scanner reports regulatory applicability information. It is not legal advice or a compliance certification.

## Key Files

| File | Purpose |
|------|---------|
| `src/scan.ts` | Core `runScan()` function -- the main entry point |
| `src/index.ts` | CLI binary entry point |
| `src/detect/detector.ts` | `DetectorRegistry` plugin system and `DetectorSignal` types |
| `src/detect/import-detector.ts` | Built-in AI SDK import detector |
| `src/match/rule-matcher.ts` | Rule-to-signal matching logic |
| `src/output/sarif.ts` | SARIF output for CI/CD integration |
| `src/config/schema.ts` | `.nomus.yml` config schema |
| `src/corporate/` | Corporate policy library (`@nomus/scanner/corporate`), shared with the engine, the VS Code extension and the GitHub Action |

# Nomus Regulatory Scan

**Automated AI regulatory applicability mapping for your codebase.**

Nomus detects AI SDK usage in your code, asks a Nomus engine which regulatory obligations apply to the detected capabilities in your chosen jurisdictions, and reports them directly on your pull requests.

The action needs a Nomus engine that you run yourself and an API key for it (`api-key`, ideally stored as a repository secret). See the [deployment guide](../../docs/admin-guide/deployment.md) for running one; it must be reachable from the GitHub runner. This package is workspace-internal (`private: true`, not published to npm); the action is used straight from this repository with a committed `dist/index.js`.

## Features

- **19 AI SDK patterns** detected across JavaScript/TypeScript, Python, Java, and Go
- **SARIF output** for GitHub Code Scanning tab
- **Inline PR comments** on lines with applicable obligations and suggested actions
- **PR summary comment** with regulatory weight breakdown and compliance badge
- **Check Runs** with pass/fail status and annotations
- **Configurable threshold** — fail on critical, high, medium, or low

## Quick Start

```yaml
name: Regulatory Check
on: [pull_request]

jobs:
  nomus:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      checks: write
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: babbguy/Nomus/packages/github-action@main
        with:
          api-key: ${{ secrets.NOMUS_API_KEY }}
          api-url: https://nomus.example.com
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

The repository you scan needs a `.nomus.yml` (see [Configuration](#configuration)). Pin `@main` to a commit SHA for reproducible builds. To rebuild the bundled action after changing the source: `npm run build:github-action` from the repository root.

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `api-key` | Nomus API key | Yes | — |
| `api-url` | Nomus engine URL (must be reachable from the runner) | No | `http://localhost:3100` |
| `github-token` | GitHub token for PR comments, SARIF upload and the check run. Falls back to the `GITHUB_TOKEN` environment variable; without either, those steps are skipped with a warning | No | none |
| `fail-on` | Min regulatory weight to fail (`critical`, `high`, `medium`, `low`) | No | `critical` |
| `working-directory` | Directory to scan | No | `.` |
| `upload-sarif` | Upload SARIF to Code Scanning | No | `true` |
| `post-pr-comment` | Post obligations on PRs | No | `true` |
| `badge-embed` | Include the public Nomus badge in the PR comment (skipped when the organization has no public badge) | No | `true` |
| `badge-org` | Slug of your Nomus organization, for the badge | No | repository owner |

## Outputs

| Output | Description |
|--------|-------------|
| `total-findings` | Total applicable obligations identified |
| `critical-count` | Critical-weight obligations |
| `high-count` | High-weight obligations |
| `medium-count` | Medium-weight obligations |
| `low-count` | Low-weight obligations |
| `status` | `pass`, `fail`, or `unknown` (engine unreachable) |
| `compliance-score` | Regulatory exposure score (0–100) |
| `compliance-label` | Score label (`Excellent`, `Good`, `Fair`, `Needs Work`, `Critical`) |
| `sarif-file` | Path to the SARIF file; only set when findings exist, `github-token` is available and `upload-sarif` is on |

## Example: Scheduled Full Repo Scan

```yaml
name: Weekly Regulatory Audit
on:
  schedule:
    - cron: '0 9 * * 1'  # Monday 9am

jobs:
  audit:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      checks: write
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: babbguy/Nomus/packages/github-action@main
        with:
          api-key: ${{ secrets.NOMUS_API_KEY }}
          api-url: https://nomus.example.com
          github-token: ${{ secrets.GITHUB_TOKEN }}
          fail-on: low
          post-pr-comment: 'false'
```

## Example: Conditional Downstream Steps

```yaml
- uses: babbguy/Nomus/packages/github-action@main
  id: scan
  with:
    api-key: ${{ secrets.NOMUS_API_KEY }}
    api-url: https://nomus.example.com
    github-token: ${{ secrets.GITHUB_TOKEN }}

- name: Block deploy on critical obligations
  if: steps.scan.outputs.critical-count > 0
  run: |
    echo "Critical regulatory obligations identified. Deploy blocked."
    exit 1
```

## Configuration

Add a `.nomus.yml` to the scanned directory (required; the API key and URL come from the action inputs):

```yaml
nomus:
  jurisdictions: [EU, US-FED, UK]
  sector: finance
  data_types: [user_prompts, financial]
  ignore:
    - tests/**
    - "**/*.test.ts"
```

## Detected AI SDKs

| Language | SDKs |
|----------|------|
| **JS/TS** | @anthropic-ai/sdk, openai, @google/generative-ai, @aws-sdk/client-bedrock-runtime, @huggingface/inference, replicate, cohere-ai |
| **Python** | anthropic, openai, google.generativeai, boto3 bedrock, huggingface_hub, replicate, cohere |
| **Java** | com.anthropic, com.openai, aws-bedrock |
| **Go** | anthropic-sdk-go, openai-go |

## Regulations covered

Which obligations are reported depends on the active rules in the engine you point the action at, filtered by the `jurisdictions` in `.nomus.yml`. A scan that finds nothing is not a compliance clearance. The key needs the `evaluate` scope (and `read:policies` for the score lookup).

## Behavior on errors

If the engine is unreachable or returns an unusable response, the action fails closed: it sets `status` to `unknown` and fails the step instead of reporting a pass. Uploading findings and fetching the score are best effort and only produce warnings (if the score cannot be fetched it is computed from the scan findings alone).

## Links

- [Report issues](https://github.com/babbguy/Nomus/issues)
- [Scanner package](../scanner/README.md)

---

*Nomus provides regulatory applicability information. It is not legal advice or a compliance certification.*

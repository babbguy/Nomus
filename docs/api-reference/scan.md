# Scan Endpoints and Scanner

The engine does **not** run scans itself. Scanning is done by the `@nomus/scanner` package (CLI
`nomus-scan`, the GitHub Action, the VS Code extension, the MCP server). The engine provides
(a) the rules the scanner matches against and (b) the `/api/v1/scan/*` endpoints that store and
serve the findings a scanner uploads. Source: `engine/src/server/routes/scan.ts`.

Nomus reports which regulatory obligations may apply to code that uses AI. A finding is
applicability information, not legal advice or a compliance certification.

All endpoints below require the `evaluate` scope (API key) or a dashboard session, and are
rate limited per organization (see the [overview](./README.md#rate-limiting)). Examples use
`http://localhost:3100`.

---

## POST /api/v1/scan/findings

Upload findings from a scan. Returns `201`.

```bash
curl -X POST http://localhost:3100/api/v1/scan/findings \
  -H "Authorization: Bearer $NOMUS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "your-org/your-repo",
    "commitSha": "abc1234",
    "prNumber": 42,
    "findings": [
      {
        "file": "src/chat.ts",
        "line": 12,
        "ruleKey": "eu_ai_act.art50.1.chatbot_disclosure",
        "severity": "high",
        "sdk": "openai",
        "capability": "text_generation",
        "summary": "Users must be told they are interacting with an AI system.",
        "suggestion": "Add a visible AI disclosure to the chat UI.",
        "legalReference": "EU AI Act Art. 50(1)"
      }
    ]
  }'
```

### Body

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `findings` | array, at least 1 | yes | See below |
| `repo` | string | no | Default for findings without their own `repo`; stored as `unknown` if absent |
| `commitSha` | string | no | Same defaulting; `unknown` if absent |
| `prNumber` | integer | no | Same defaulting |

Each finding:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `file` | string (non-empty) | yes | Path of the file |
| `line` | integer | yes | Line number |
| `ruleKey` | string (non-empty) | yes | Rule identifier, e.g. from `GET /api/v1/policies` |
| `severity` | `critical` \| `high` \| `medium` \| `low` | yes | |
| `effect` | string | no | Defaults to `flag` |
| `sdk`, `capability` | string | no | Stored as the detected capability (`sdk` wins; default `unknown`) |
| `summary`, `suggestion`, `detectorSource`, `legalReference` | string | no | |
| `repo`, `commitSha`, `prNumber` | | no | Per-finding overrides |

### Response `201`

```json
{
  "created": 1,
  "clauseCorrelation": { "created": 1, "suppressed": 0, "evaluated": 1 },
  "clauseCorrelationError": null
}
```

After storing the findings the engine correlates them against the clause map. A correlation
failure never fails the upload: findings stay stored and the message is returned in
`clauseCorrelationError` (with `clauseCorrelation: null`).

Errors: `400` (`Invalid input` with `details`, or invalid JSON), `401`, `403`, `429`.

---

## GET /api/v1/scan/findings

List stored findings for your organization, newest first.

| Query | Default | Notes |
|-------|---------|-------|
| `repo` | all | Exact match |
| `severity` | all | `critical`, `high`, `medium`, `low` |
| `status` | `open` | `open`, `resolved`, `dismissed` |
| `limit` | 100 | Max 500 |

```json
{
  "count": 1,
  "findings": [
    {
      "id": "....",
      "orgId": "....",
      "repo": "your-org/your-repo",
      "prNumber": 42,
      "commitSha": "abc1234",
      "filePath": "src/chat.ts",
      "lineNumber": 12,
      "ruleKey": "eu_ai_act.art50.1.chatbot_disclosure",
      "severity": "high",
      "effect": "flag",
      "capabilityDetected": "openai",
      "humanSummary": "Users must be told they are interacting with an AI system.",
      "suggestion": "Add a visible AI disclosure to the chat UI.",
      "detectorSource": null,
      "legalReference": "EU AI Act Art. 50(1)",
      "status": "open",
      "scannedAt": "2026-04-04T10:00:00.000Z"
    }
  ],
  "_disclaimer": "..."
}
```

`count` is the total number of matching rows, which can exceed the number returned when `limit`
applies.

---

## GET /api/v1/scan/repos

Repositories that have findings, with counts.

```json
{
  "count": 1,
  "repos": [
    { "repo": "your-org/your-repo", "totalFindings": 7, "openFindings": 5, "lastScanned": "2026-04-04T10:00:00.000Z" }
  ]
}
```

---

## PATCH /api/v1/scan/findings/:id

Change a finding's status. Only findings in your organization can be changed.

```json
{ "status": "dismissed" }
```

`status` is `open`, `resolved` or `dismissed`. Response `200`: `{"message":"Finding updated"}`.
`404` `{"error":"Finding not found"}`, `400` for an invalid body.

---

## Running a scan

All scanner packages are private workspace packages in this repo (not published to npm). Build
them from a source checkout:

```bash
npm install
npm run build:packages        # builds shared, scanner, chain, mcp-server
```

### CLI

```bash
node packages/scanner/dist/index.js [<path>] [--json | --sarif] [--fail-on=<severity>]
```

- `<path>` defaults to `.`. Because the first argument is always read as the path, put it first when you also pass flags (`... . --json`, not `... --json`).
- The scanner command name is `nomus-scan` (the `bin` of `@nomus/scanner`); the package is not published to npm, so run it by path as shown, or link it yourself. Output is a console report by default, `--json` for JSON or `--sarif`
  for SARIF 2.1.0 on stdout.
- `--fail-on=critical|high|medium|low` (default `critical`) sets the severity at which the exit code
  becomes `1`.
- Exit codes: `0` pass, `1` findings at or above the threshold, `2` unexpected error (for example
  no `.nomus.yml`, or no API key once AI usage was found), `3` the Nomus API was unreachable or returned an error status. Exit
  `3` is deliberate: the scanner fails closed and never reports "no obligations" when it could not
  fetch rules. (The one case that passes without calling the engine is a scan that detects no AI
  SDK usage at all, since there is nothing to match.)

The scanner needs a `.nomus.yml` (or `.nomus.yaml` / `.nomus.json`) in the scanned directory. It
is standard YAML. A value written as `$NAME` (for example `api_key: $MY_KEY`) is read from that
environment variable, and the scan fails if the variable is unset. Invalid YAML or values that fail
validation stop the scan with an error that names the problem.


```yaml
nomus:
  api_url: http://localhost:3100     # default
  api_key: nk_live_...               # or set NOMUS_API_KEY
  jurisdictions: [EU, US-FED]        # required, at least one
  sector: finance                    # optional: healthcare, finance, education, government, ...
  data_types: [personal_data]        # optional
  ignore: [node_modules/**, dist/**] # optional glob list
```

The scanner calls `POST /api/v1/simulate`, so the key needs the `evaluate` scope. Only the derived
capabilities, plus the data types, jurisdictions and sector from your config, are sent to the
engine; source code stays on the machine running the scanner. When `ignore` is set it replaces the
default list (`node_modules/**`, `dist/**`, `.git/**`, `**/*.test.*`, `**/*.spec.*`). Supported languages:
TypeScript, JavaScript, Python, Java, Go. See `packages/scanner/README.md` for the programmatic API.

The CLI does not upload findings. To store findings in the engine (and see them on the dashboard
Scans page), post them to `POST /api/v1/scan/findings`, or use the GitHub Action, which does this
for you.

### GitHub Action

`packages/github-action/action.yml` defines the action. Reference it by path from your own
repository's workflow. It needs a running Nomus engine that the runner can reach and an API key
for it, and the scanned repository needs a `.nomus.yml` (see above):

```yaml
name: Regulatory scan
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
          api-url: https://nomus.example.com    # your engine; the default is http://localhost:3100
          github-token: ${{ secrets.GITHUB_TOKEN }}
          fail-on: high
```

Inputs: `api-key` (required), `api-url` (default `http://localhost:3100`, which a GitHub-provided runner
cannot reach, so set it), `github-token` (no default; without it, or a `GITHUB_TOKEN` environment
variable, the action skips PR comments, SARIF upload and the check run), `fail-on` (default `critical`), `working-directory`
(default `.`), `upload-sarif`, `post-pr-comment`, `badge-embed` (all default `true`).
Outputs: `total-findings`, `critical-count`, `high-count`, `medium-count`, `low-count`, `status`,
`compliance-score`, `compliance-label`, `sarif-file` (only set when a SARIF file was uploaded).
`status` is `pass`, `fail`, or `unknown` when the engine could not be reached. The engine must be
reachable from the runner. Findings are uploaded to this endpoint on a best-effort basis (an upload failure is a
warning, not a failed run).

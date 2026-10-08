# Release gate

`e2e/` is the automated release gate: one command that runs the **real, built
product** the way people use it and fails if anything a user would notice is
wrong. It complements the unit tests (`npm run test:engine`,
`npm run test:extensions`), which run each package in isolation with mocks.
Every bug class the gate targets was missed by those tests and found only by
running the product: rules matching differently on different endpoints, SSE
connections that never closed, a GitHub Action bundle that crashed on load,
scanner over-reporting, pipeline churn on re-upload, and dashboard numbers that
disagreed between pages.

```bash
npm ci
npx playwright-core install chromium   # once; the version is pinned by package-lock.json
npm run build:all
npm run gate                           # = node e2e/run-gate.mjs
```

`npm run gate` builds first if a build output is missing (`--build` forces a
rebuild, `--no-build` never builds). It prints a PASS/FAIL table, writes
`e2e/out/`, and exits non-zero if any check fails. It runs on Windows, macOS and
Linux; a run takes 2 to 4 minutes on a laptop after the build. CI runs it as the
required **Release gate** check (`.github/workflows/release-gate.yml`) on pull
requests to and pushes on `develop` and `main`, uploads `e2e/out/` as an artifact
and writes the table to the job summary. Before the gate, the CI job also checks
that the committed GitHub Action bundle (`packages/github-action/dist/index.js`)
is exactly what the source builds to, so the gate tests the bundle that ships.

## What runs

Everything is local: no LLM provider, GitHub or regulator website is contacted.

| Piece | What the gate uses |
|-------|--------------------|
| Engine | `engine/dist/index.js` in production mode (`NOMUS_ENV=production`, `NODE_ENV=production`) on a fresh SQLite database, with random secrets for each run |
| Dashboard | `dashboard/dist` served on its own origin with `/api` proxied to the engine, like `infra/nginx-dashboard.conf` |
| LLM | `lib/fake-llm.mjs`, an OpenAI-compatible server (`OPENAI_BASE_URL`) that recognises each Nomus prompt and answers deterministically from the text it is given |
| GitHub | `lib/fake-github.mjs`, a stateful fake of the REST endpoints the Action calls; it rejects what GitHub rejects (review comments outside the diff, too many annotations) |
| Slack | `lib/fake-sink.mjs` as the alert webhook, so alerting is configured and nothing leaves the machine |
| Browser | Chromium through `playwright-core` (the engine already depends on it) |
| Probe | `lib/engine-probe.mjs`, preloaded into the engine with `--import`: it samples memory and CPU and records every outbound HTTP request. It only observes |

Fixtures: `fixtures/sample-repo/` is a small repository with OpenAI and
Anthropic calls that handle patient data (Python and TypeScript);
`fixtures/il-aivia.html` is the text of the Illinois Artificial Intelligence
Video Interview Act (820 ILCS 42), used for the manual-upload pipeline.
`expectations.json` holds the checked-in expected results.

## What it proves

1. **Bring-up.** A fresh database starts, seeds the expected sources and rule
   sets, and every rule passes the signature integrity check. The admin from
   `NOMUS_ADMIN_EMAIL`/`NOMUS_ADMIN_PASSWORD` and the bootstrap API key work; an
   invited member must change the temporary password, and until then the API
   refuses the session.
2. **Scanner CLI.** On the fixture repository: the exact finding count, findings
   by severity and the rule ids per file from `expectations.json`; no rules for
   sectors or markets the repository did not declare; exit codes 0, 1, 2 and 3 as
   documented; `--help`, `--version`, unknown flags; valid SARIF 2.1.0 with
   relative paths; findings that do not depend on where the repository is
   checked out; findings that name the SDK actually called on their line.
3. **GitHub Action.** The committed `dist/index.js` loads and runs on a
   `pull_request` event: it uploads valid SARIF, posts review comments exactly on
   the finding lines inside the diff, posts the summary comment, creates the
   check run on the PR head commit and stores the findings in Nomus. A second
   run updates the stored findings and the summary comment instead of
   duplicating them, and does not repeat review comments.
4. **MCP server** over stdio: every tool returns a valid, non-error result with
   provenance for the live corpus; `scan_code` agrees with the CLI; with the
   engine unreachable the tools fail closed.
5. **VS Code extension.** The real `dist/extension.js` runs in a stub extension
   host (`lib/vscode-host.mjs`). Sign-in goes end to end: authorize, dashboard
   login in Chromium, the `vscode://` callback with a one-time code, and the
   extension's own token exchange. Its views and commands then run against the
   engine and must render without `undefined`/`NaN`, show the engine's numbers,
   and scan-on-save must agree with the CLI for the same workspace.
6. **Attestations.** `/evaluate` and `/simulate` select the same rules across the
   capability vocabulary; supersede, revoke and expiry behave; the evidence
   export verifies offline with a standard Ed25519 library against the published
   key; tampered bundles are rejected.
7. **Rules and SSE.** Admin create, update and retire reach subscribers as
   ordered `policy.*` events filtered by jurisdiction; the corpus hash returns to
   its original value after create-then-retire; reconnect replay honours the
   filter; the connected-client count returns to 0.
8. **Regulation pipeline.** Uploading the Illinois act produces the expected
   number of signed rules; an identical re-upload changes nothing (same corpus
   hash, same rule versions, no radar signal, no policy events); the upload never
   fetches the live source URL or touches its scrape health.
9. **Browser sweep** over every member, admin and public route: no console
   errors, no failed API calls except the commented allow-list in
   `checks/browser.mjs`, no `NaN`/`undefined`/`[object Object]`/`Invalid Date`/
   negative relative times, the data the gate created is shown, and the same
   number (rules, attestations, findings, AI systems, score) agrees across pages
   and with the API. A screenshot of every page is saved.
10. **Server logs.** No error-level log line, unhandled rejection, stack trace or
    5xx during the run (allow-list in `checks/server-logs.mjs`).
11. **Resources.** Peak RSS of the engine stays under 512 MiB; idle CPU is
    recorded (and must stay under 20 % of one core).

## Output

`e2e/out/` (git-ignored):

- `results.txt`, `summary.md`, `results.json`: the table, the Markdown summary and every row
- `screenshots/`: one full-page screenshot per route; `pages/`: the visible text of each page
- `engine.log`, `fake-llm.log`, `fake-github.log`, `slack-webhook.log`, `action-run-*.log`, `engine-probe.jsonl`, `log-findings.json`
- `scan.json`, `scan.sarif`, `vscode-views.txt`

## Options

| Option | Effect |
|--------|--------|
| `--build` / `--no-build` | Always / never run `npm run build:all` first |
| `--only=scanner,action` | Run only some areas (bring-up always runs); for debugging, not for release decisions |
| `--target=<dir>` | Test the build in another checkout (for example an older release) with this gate |
| `NOMUS_GATE_OUT=<dir>` | Write output somewhere other than `e2e/out/` |
| `NOMUS_GATE_CHROMIUM=<path>` | Use an existing Chrome/Chromium executable |

## Changing expectations

When a change legitimately alters results (a new rule set, a detector change),
update `expectations.json` in the same pull request and say why. Never relax a
check to make it pass; if a check is wrong, fix the check and explain it in the
pull request.

## Not covered

Real LLM providers, real GitHub, real email (Resend), ntfy and Slack delivery,
Google/GitHub sign-in, live scraping of regulator websites, Scout's news feeds,
on-chain anchoring, the Docker images and a real VS Code instance (the
extension runs in a stub host). Each of these depends on an external service or
an interactive application.

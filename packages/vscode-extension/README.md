# Nomus AI Compliance

![Nomus](media/logo-wide.png)

**Know where AI lives in your codebase and which regulatory obligations may apply.**

Nomus scans your code as you write it, detects AI SDK usage across every major provider, and maps findings against real regulatory frameworks such as the EU AI Act and NIST AI RMF, using the rule base of a Nomus engine you run.

Open a file and Nomus gets to work. Import detection runs locally in the editor; obligation matching is done by a Nomus engine that you run (default `http://localhost:3100`).

---

## What You Get

### Real-Time Compliance Scanning

Nomus runs automatically on save and on file open. Every AI SDK import is detected and checked against the rules your engine holds for the jurisdictions you select. Findings appear inline as native VS Code diagnostics — warnings, errors, and suggestions — right where you're writing code.

Supported languages: TypeScript, JavaScript, Python, Java, Go.

### Compliance Status Sidebar

A dedicated sidebar panel shows your live compliance posture:

- **Compliance Score** — a single regulatory-exposure number derived from applicable rules and your scan findings, updated as you scan
- **Active Rules** — the number of regulatory rules being checked
- **Open Findings** — total issues across your workspace
- **AI Systems** — detected AI integrations and their risk classification

### Findings Panel

Every finding includes:

- The specific rule violated and its severity (critical, high, medium, low)
- A plain-English explanation of the issue
- The legal reference (article, section, annex) from the source regulation
- A suggested fix when available

Click any finding to jump directly to the offending line.

### AI Bill of Materials (AI-BOM)

Generate a complete inventory of every AI system in your codebase — models used, providers, capabilities detected, and risk classifications. Useful as an inventory for legal and audit review.

### Regulatory Radar

Track upcoming regulatory changes that could impact your AI systems. Scout tracks legislative signals and surfaces those relevant to your detected AI usage before they become law.

### COMPL-AI Benchmarking

Start a COMPL-AI benchmark run for a model name and provider you enter. The engine stores the benchmark definitions and the run record (status `pending`); it does not execute the benchmarks itself, and this repository does not include a runner. Results appear on the dashboard Benchmarks page once something uploads them to the engine.

### Impact Simulation

Pick a regulatory signal from the Radar and run an impact simulation on the engine against your AI inventory (AI-BOM).

### Compliance Reports

The command asks for a format (JSON or PDF) and requests the AI-BOM export from the engine (`GET /api/v1/ai-bom/export/<format>`). The extension shows a confirmation message but does not save the result to disk.

---

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type `Nomus`:

| Command | Description |
|---------|-------------|
| **Scan Current File** | Run a compliance scan on the active file |
| **Scan Workspace** | Scan all supported files in the workspace |
| **Generate AI Bill of Materials** | Build an AI-BOM from scan findings |
| **Run COMPL-AI Benchmarks** | Create a pending benchmark run on the engine for a model and provider |
| **Simulate Regulatory Impact** | Simulate the effect of a pending regulation |
| **Export Compliance Report** | Request the AI-BOM export (JSON or PDF) from the engine |
| **Open Dashboard** | Open the Nomus web dashboard (`nomus.dashboardUrl`, or derived from `nomus.apiUrl`) |
| **Sign In / Sign Out** | Authenticate against your Nomus engine (browser device flow) |
| **Clear All Diagnostics** | Clear all Nomus findings from the editor |
| **Show Compliance Overview** | Focus the compliance status sidebar |
| **Refresh All Views** | Refresh all sidebar panels |

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `nomus.jurisdictions` | `["EU"]` | Jurisdictions to check against |
| `nomus.scanOnSave` | `true` | Scan files automatically on save |
| `nomus.scanOnOpen` | `true` | Scan files when opened in the editor |
| `nomus.failOn` | `medium` | Minimum severity to flag as an error |
| `nomus.apiUrl` | `http://localhost:3100` | Nomus engine API URL |
| `nomus.apiKey` | empty | Optional API key (an alternative to Sign In) |
| `nomus.dashboardUrl` | empty | Dashboard URL (derived from the API URL if empty) |

---

## Getting Started

This extension is not published to the VS Code Marketplace. Build and install it from a source checkout:

```bash
# from the repository root
npm install
npm run build:vscode-extension                   # bundles to packages/vscode-extension/dist
cd packages/vscode-extension
npm run package                                  # creates nomus-1.0.0.vsix (runs @vscode/vsce via npx)
code --install-extension nomus-1.0.0.vsix
```

You can also install the `.vsix` from VS Code: open the Extensions view, click the `...` menu,
choose **Install from VSIX...** and pick the file.

1. Start a Nomus engine (see the [deployment guide](../../docs/admin-guide/deployment.md); locally `npm run dev:engine` serves `http://localhost:3100`).
2. Set `nomus.apiUrl` if your engine is elsewhere, then run **Nomus: Sign In** (or set `nomus.apiKey`).
   With the Docker Compose setup the engine is `http://localhost:3100` and the dashboard is
   `http://localhost:8080`; set `nomus.dashboardUrl` to the dashboard URL so **Open Dashboard**
   goes there (without it the extension assumes the development server on port 5173).
3. Open a TypeScript, JavaScript, Python, Java or Go file that imports an AI SDK. Nomus scans on open and on save.

Without a key the extension runs in an offline mode: it lists detected AI SDK imports as informational diagnostics but cannot match regulatory rules. If the engine is configured but unreachable, the extension shows an error rather than a clean result.

---

## Links

- [Source code and issue tracker](https://github.com/babbguy/Nomus)
- [Report an issue](https://github.com/babbguy/Nomus/issues)

---

*Nomus provides regulatory applicability information. It is not legal advice or a compliance certification.*

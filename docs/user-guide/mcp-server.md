# Nomus MCP Server

Connect your Nomus engine to an AI coding agent. The Nomus MCP server (`@nomus/mcp-server`, binary
`nomus-mcp`) gives any [Model Context Protocol](https://modelcontextprotocol.io) client (Claude Code,
VS Code, Cursor, and other MCP-capable tools) provenance-cited regulatory applicability answers from
a Nomus engine you run.

Ask your coding agent things like:

- *"Does this file trigger EU AI Act obligations?"*
- *"What changed in the regulations Nomus tracks since last Monday?"*
- *"Show me the exact rule and legal citation for `eu_ai_act.art52.transparency`."*
- *"Which tracked bills over a 70% passage score could affect us in California?"*

---

## Setup

`@nomus/mcp-server` is a private workspace package: it is not published to npm, so `npx` will not
find it. Run it from a checkout of this repo.

### 1. Build it

```bash
npm install
npm run build:packages        # builds shared, scanner, chain and mcp-server
```

This produces `packages/mcp-server/dist/index.js`. Use its absolute path below
(`/path/to/nomus` is your checkout).

### 2. Get an API key

You need a running engine (for example `http://localhost:3100`, see
[Getting Started](./getting-started.md)) and an API key with the `read:policies` and `evaluate`
scopes. Create one yourself in the dashboard (Settings, API Keys; any signed-in user can, no administrator
needed) or with `POST /api/v1/org/api-keys` (see [org](../api-reference/org.md#api-keys));
platform admins can also use Admin, Tenants. Give the
MCP server its own key with only those two scopes. The engine issues `nk_live_` keys; the MCP server
accepts them and prints a stderr reminder that editor config files are often committed or synced, so
keep the key out of version control.

### Configuration

| Variable | Required | Meaning |
|----------|----------|---------|
| `NOMUS_API_URL` | yes | Engine base URL, e.g. `http://localhost:3100` |
| `NOMUS_API_KEY` | yes | API key with `read:policies` and `evaluate` |

### Claude Code

```bash
claude mcp add nomus   --env NOMUS_API_URL=http://localhost:3100   --env NOMUS_API_KEY=nk_live_your_key_here   -- node /path/to/nomus/packages/mcp-server/dist/index.js
```

### VS Code

Add to `.vscode/mcp.json` (do not commit the key):

```json
{
  "servers": {
    "nomus": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/nomus/packages/mcp-server/dist/index.js"],
      "env": {
        "NOMUS_API_URL": "http://localhost:3100",
        "NOMUS_API_KEY": "nk_live_your_key_here"
      }
    }
  }
}
```

### Cursor

Add the same block (without the `"type"` field) under `"mcpServers"` in `.cursor/mcp.json`.

---

## Tools

| Tool | Question it answers |
|---|---|
| `check_applicability` | Which obligations apply to these capabilities / this code, in these jurisdictions? |
| `get_rule` | What exactly does this rule require, and what law backs it? |
| `scan_code` | Full scanner pass over files: per-line findings with matched rules and fix suggestions |
| `list_frameworks` | Which compliance frameworks/templates does your engine cover? |
| `list_jurisdictions` | Which jurisdictions have active rules? |
| `regulatory_changes` | What changed in the law since a given timestamp? |
| `bill_radar` | Which pending bills are likely to become law? |

Every answer includes a **provenance stamp** (the corpus state hash — a SHA-256 fingerprint over
the Ed25519 signatures of every active rule — plus retrieval time and, per rule, signature /
legal reference / update time) and Nomus's **legal disclaimer** (the output is applicability information, not legal advice).

**Privacy:** code passed to `check_applicability` and `scan_code` is analyzed locally, in-process,
by the Nomus scanner detectors. Your source code is not sent to the engine; only derived
capability signals (like `text_generation`) are.

**Fail-closed:** if the Nomus API is unreachable, tools report *compliance status unknown* as
an explicit error. They never answer "no obligations" just because the backend was down.

For input schemas, the endpoint each tool calls, and development notes, see the package README: [`packages/mcp-server/README.md`](../../packages/mcp-server/README.md).

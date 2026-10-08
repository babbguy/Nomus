# @nomus/mcp-server

**Live, provenance-cited regulatory applicability for AI coding agents.**

`nomus-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that lets any
MCP-capable coding agent — Claude Code, VS Code, Cursor, or anything else that speaks MCP — ask
Nomus questions like *"which regulatory obligations does this code trigger, per current law?"*
and get answers backed by Nomus's live, source-exact regulatory corpus.

Unlike static-rules MCP servers, every answer here is served from the running Nomus engine:
rules update when the law does, and every response carries a verifiable provenance stamp and a
legal disclaimer.

- **Transport:** stdio (what `claude mcp add` and editors spawn)
- **Detection:** code you pass to `check_applicability` / `scan_code` is analyzed **in-process**
  by the `@nomus/scanner` detector plugins — your source code is never sent to the Nomus
  API. Only the derived capability signals (e.g. `text_generation`) go over the wire.
- **Fail-closed:** if the Nomus API is unreachable, tools return an explicit error stating
  that compliance status is **unknown**. They never return an empty "no obligations" success.

---

## Requirements

- Node.js 20.19+ (or 22.12+), the same as the rest of the repo
- A running Nomus engine (for local development `http://localhost:3100`; see the [deployment guide](../../docs/admin-guide/deployment.md))
- A source checkout built with `npm run build:packages` (this package is `private: true` and is not published to npm)
- A Nomus API key (the engine issues `nk_live_…` keys) with the `read:policies` and `evaluate` scopes

## Configuration

Two environment variables, both required and validated at startup:

| Variable | Meaning |
|---|---|
| `NOMUS_API_URL` | Base URL of the Nomus engine, e.g. `http://localhost:3100` or `https://nomus.example.com` |
| `NOMUS_API_KEY` | Nomus API key with `read:policies` + `evaluate` scopes |

Missing or malformed values fail startup with a message naming every problem. Startup diagnostics
go to stderr; stdout is reserved for the MCP protocol.

### Key scoping advice

Editor and agent config files are frequently committed, synced, or screen-shared. **Create a dedicated
key for the MCP server**, scoped to only `read:policies` and `evaluate`, and rotate it like any
other credential. The engine only issues `nk_live_` keys, and the server prints a stderr warning
whenever it sees one (it suggests an `nk_test_` key, which the engine has no way to create);
treat that warning as a reminder to keep the key out of version control.

---

## Client setup

The server is run from your checkout. Build it first, then point your client at the built entry point (replace `<repo>` with the absolute path of your checkout):

```bash
npm install
npm run build:packages     # produces packages/mcp-server/dist/index.js
```

### Claude Code

```bash
claude mcp add nomus \
  --env NOMUS_API_URL=http://localhost:3100 \
  --env NOMUS_API_KEY=nk_live_your_key_here \
  -- node <repo>/packages/mcp-server/dist/index.js
```

### VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "nomus": {
      "type": "stdio",
      "command": "node",
      "args": ["<repo>/packages/mcp-server/dist/index.js"],
      "env": {
        "NOMUS_API_URL": "http://localhost:3100",
        "NOMUS_API_KEY": "nk_live_your_key_here"
      }
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "nomus": {
      "command": "node",
      "args": ["<repo>/packages/mcp-server/dist/index.js"],
      "env": {
        "NOMUS_API_URL": "http://localhost:3100",
        "NOMUS_API_KEY": "nk_live_your_key_here"
      }
    }
  }
}
```

See also the [MCP server user guide](../../docs/user-guide/mcp-server.md).

---

## Tools

Every successful tool result is a JSON payload containing, in addition to the answer:

- `provenance` — `nomusApiUrl`, `retrievedAt`, and `corpus` = `{ stateHash, ruleCount,
  computedAt }` from `GET /api/v1/policies/hash`: a SHA-256 over the sorted Ed25519 signatures of
  every active rule — a verifiable fingerprint of the exact rule corpus that produced the answer.
  Where rule objects appear, their `signature`, `legalReference`, and `updatedAt` fields are
  per-rule provenance. (Per-snapshot raw-byte hashes for source regulations are
  stored engine-side.) If the hash
  endpoint fails, the provenance block says so explicitly rather than being omitted.
- `disclaimer` — the shared Nomus legal disclaimer. Nomus is not a law firm; nothing here
  is legal advice.

| Tool | What it does | Engine endpoint(s) |
|---|---|---|
| `check_applicability` | Which obligations apply for a set of AI capabilities and/or a code snippet, per jurisdiction. Code is analyzed in-process to derive capabilities. | `POST /api/v1/simulate` (+ `GET /api/v1/policies/hash`) |
| `get_rule` | Full detail of one rule by rule key or rule id, incl. conditions, legal reference, Ed25519 signature. | `GET /api/v1/policies/:id`, falling back to a rule-key search over `GET /api/v1/policies?limit=1000` |
| `scan_code` | Full Nomus scanner pass over provided file contents; findings in the scanner's JSON shape (file, line, evidence, matched rule, suggestion). | scanner → `POST /api/v1/simulate` |
| `list_frameworks` | Nomus compliance frameworks (curated rule templates: EU AI Act full coverage, NIST AI RMF, use-case packs) with live rule counts. | `GET /api/v1/templates` |
| `list_jurisdictions` | Jurisdictions with active rules, with display names and max severity. | `GET /api/v1/policies/impact-map` |
| `regulatory_changes` | Rules created/updated since a timestamp — "what changed in the law since my last session". | `GET /api/v1/policies?since=…` (per-jurisdiction when filtered) |
| `bill_radar` | Scout v2 signals: tracked bills with passage-probability scores. | `GET /api/v1/radar/v2/bills` |

### Tool inputs

```
check_applicability({ capabilities?, code?, language?, jurisdictions, sector?, dataTypes? })
get_rule({ ruleKey })
scan_code({ files: [{ path, content }], jurisdictions, sector? })
list_frameworks({})
list_jurisdictions({})
regulatory_changes({ since, jurisdictions? })
bill_radar({ jurisdictions?, minScore? })
```

- `jurisdictions` is required and non-empty for `check_applicability` and `scan_code`
  (e.g. `["EU", "US-CA", "US-FED"]` — discover codes with `list_jurisdictions`).
- `check_applicability` needs at least one of `capabilities` or `code`. Supported `language`
  values: `typescript` (default), `tsx`, `javascript`, `jsx`, `python`, `java`, `go`.
- `since` is an ISO-8601 timestamp; offsets are normalized to UTC before querying.

### Semantics worth knowing

- **`regulatory_changes`** is served by the policies list endpoint's updated-since filter. It
  covers creations and updates among *currently-active* rules (`changeType` distinguishes the
  two by `createdAt`); rule deactivations are not visible through this endpoint. Each query is
  capped at 1000 rules.
- **`get_rule`** resolves rule keys by searching the first 1000 active rules when the direct id
  lookup misses (the engine's detail route matches internal rule ids).
- **`check_applicability` with only non-AI code** returns an explicit `no_capabilities_detected`
  result that is labeled as *not* a compliance clearance — the only no-API-call answer, mirroring
  the scanner's zero-signal early exit.

---

## Fail-closed semantics

A compliance tool that fails open is worse than no tool. This server follows a fail-closed contract:

- **API unreachable / timeout / 5xx / unparseable response** → MCP error result:
  *"Nomus API unreachable — compliance status is UNKNOWN — do NOT treat this as 'no
  obligations apply'."* Never an empty success.
- **401** → "invalid or expired API key" with a pointer to `NOMUS_API_KEY` and required scopes.
- **403 (scopes)** → names the missing key scopes.
- **429** → bounded backoff honoring `Retry-After` (2 retries), then an explicit rate-limit error.

The same applies to `scan_code`: the underlying `@nomus/scanner` throws `NomusApiError` on
any backend problem, and that error is surfaced explicitly — a backend outage can never make a
scan look like a pass.

---

## Development

```bash
# from the repository root
npm install
npm run build:packages          # builds shared + scanner + chain + mcp-server

# in packages/mcp-server
npm test                        # vitest — no live network; a local stub engine on loopback
npm run dev                     # run the stdio server via tsx

# manual smoke against a local engine
NOMUS_API_URL=http://localhost:3100 NOMUS_API_KEY=nk_live_... node dist/index.js
```

Tests cover every tool's happy path, input-validation rejections, the in-process detection path
(golden test: an `@anthropic-ai/sdk` import fixture through detection → simulate → cited answer),
fail-closed behavior on network failure for both HTTP stacks (fetch and the scanner's axios), and
the 401/403/429 mappings.

---

## Disclaimer

Nomus is an automated regulatory monitoring tool, not a law firm or legal advisor. Output does
not constitute legal advice. Consult a qualified legal professional before making compliance
decisions. Every tool response embeds this disclaimer.

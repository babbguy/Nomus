/**
 * Nomus MCP server — tool definitions.
 *
 * Gives any MCP-capable coding agent live, provenance-cited regulatory
 * applicability answers backed by the Nomus engine.
 *
 * Behavior contract:
 *  - Every successful tool result carries `provenance` and `disclaimer`.
 *  - Fail-closed: if the Nomus API is unreachable or unusable, tools
 *    return an MCP error result stating compliance status is UNKNOWN —
 *    never an empty success.
 *  - 401 → "invalid API key"; 403 → missing key permissions;
 *    429 → bounded backoff then explicit rate-limit error.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { runScanFromContents, isNomusApiError, type ScanResult } from '@nomus/scanner';
import { LEGAL_DISCLAIMER, JURISDICTIONS } from '@nomus/shared';
import type { NomusMcpConfig } from './config.js';
import { NomusClient, NomusHttpError, FAIL_CLOSED_NOTE } from './api-client.js';
import { buildProvenance, type Provenance } from './provenance.js';
import { deriveCapabilitiesFromCode, SUPPORTED_LANGUAGES } from './detection.js';

export const SERVER_NAME = 'nomus';
export const SERVER_VERSION = '1.0.0';

// ─── Engine response shapes (fields we rely on) ─────────────────

interface SimulateRule {
  ruleKey: string;
  effect: string;
  severity: string;
  humanSummary: string;
  legalReference: string;
  matchedOn: string[];
}

interface SimulateResponse {
  input: unknown;
  markets: Record<string, {
    jurisdiction: string;
    totalRules: number;
    triggered: number;
    riskLevel: string;
    rules: SimulateRule[];
  }>;
  conflicts: unknown[];
  gapAnalysis: unknown;
  overallRisk: string;
  totalRulesTriggered: number;
}

/** Full policy rule row as served by /api/v1/policies (list + detail). */
interface PolicyRuleRow {
  id: string;
  sourceId: string;
  ruleKey: string;
  version: number;
  jurisdiction: string;
  category: string;
  conditions: unknown;
  effect: string;
  severity: string;
  humanSummary: string;
  legalReference: string;
  effectiveDate: string;
  expiresAt: string | null;
  industries: unknown;
  industryScope: string;
  industryNotes: string;
  isActive: boolean;
  signature: string;
  createdAt: string;
  updatedAt: string;
}

interface PoliciesListResponse {
  count: number;
  policies: PolicyRuleRow[];
}

interface TemplatesResponse {
  templates: Array<{
    id: string;
    name: string;
    description: string;
    useCase: string;
    jurisdictions: string[];
    icon?: string;
    ruleCount: number;
  }>;
}

interface ImpactMapResponse {
  matrix: Array<{ industry: string; jurisdiction: string; ruleCount: number; maxSeverity: string }>;
  industries: string[];
  jurisdictions: string[];
}

interface BillsResponse {
  bills: Array<Record<string, unknown>>;
  total: number;
  page: number;
  limit: number;
}

// ─── Result helpers ─────────────────────────────────────────────

function ok(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function toolError(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/**
 * Map any thrown error to an explicit MCP error result. Nomus API
 * failures never become empty successes (fail-closed).
 */
function mapError(err: unknown): CallToolResult {
  if (err instanceof NomusHttpError) {
    return toolError(err.message);
  }
  if (isNomusApiError(err)) {
    // Thrown by @nomus/scanner when its own call to /api/v1/simulate
    // failed. Inspect the underlying axios error for a status when present.
    const detail = err.detail as { response?: { status?: number; data?: unknown } } | undefined;
    const status = detail?.response?.status;
    if (status === 401) {
      return toolError(
        'Nomus API rejected the API key (401): invalid or expired API key. Check NOMUS_API_KEY.',
      );
    }
    if (status === 403) {
      return toolError(
        'Nomus API key lacks the required permissions (403). Issue a key with the required scopes.',
      );
    }
    if (status === 429) {
      return toolError(
        'Nomus API rate limit exceeded (429). Wait for your quota to reset and retry. ' + FAIL_CLOSED_NOTE,
      );
    }
    return toolError(`${err.message}. ${FAIL_CLOSED_NOTE}`);
  }
  const message = err instanceof Error ? err.message : String(err);
  return toolError(`Nomus MCP tool failed: ${message}. ${FAIL_CLOSED_NOTE}`);
}

// ─── Shared zod fragments ───────────────────────────────────────

const jurisdictionsRequired = z
  .array(z.string().min(1))
  .min(1)
  .describe(
    "Jurisdiction codes to evaluate against, e.g. ['EU', 'US-CA', 'US-FED']. Use list_jurisdictions for the full set.",
  );

const jurisdictionsOptional = z
  .array(z.string().min(1))
  .min(1)
  .optional()
  .describe("Optional jurisdiction filter, e.g. ['EU', 'US-CA'].");

// ─── Server ─────────────────────────────────────────────────────

export function buildNomusMcpServer(config: NomusMcpConfig): McpServer {
  const client = new NomusClient(config.apiUrl, config.apiKey);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // ── 1. check_applicability ────────────────────────────────────
  server.registerTool(
    'check_applicability',
    {
      title: 'Check regulatory applicability',
      description:
        'Determine which regulatory obligations apply, per current law in the Nomus corpus. ' +
        'Provide AI capabilities directly (e.g. ["text_generation"]) and/or a code snippet — code is ' +
        'analyzed in-process by the Nomus scanner detectors to derive capabilities, then matched ' +
        'against live rules via the Nomus engine. Every answer carries provenance (corpus state ' +
        'hash + retrieval time) and a legal disclaimer. Calls POST /api/v1/simulate.',
      inputSchema: {
        capabilities: z
          .array(z.string().min(1))
          .optional()
          .describe('AI capabilities to check, using the rule-condition vocabulary, e.g. ["text_generation", "ai_user_interaction", "phi_in_ai_call", "high_risk_biometric"]. Unknown names match no rule.'),
        code: z
          .string()
          .min(1)
          .optional()
          .describe('Source code to analyze in-process for AI capabilities (no code is sent to Nomus).'),
        language: z
          .enum(SUPPORTED_LANGUAGES as [string, ...string[]])
          .optional()
          .describe('Language of `code` (default: typescript).'),
        jurisdictions: jurisdictionsRequired,
        sector: z.string().min(1).optional().describe('Industry sector, e.g. "healthcare", "finance".'),
        dataTypes: z
          .array(z.string().min(1))
          .optional()
          .describe('Data types processed, e.g. ["health", "personal_data", "biometric"] ("phi" and "pii" are accepted as aliases).'),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const provided = args.capabilities ?? [];
        if (provided.length === 0 && !args.code) {
          return toolError(
            'check_applicability needs at least one of `capabilities` or `code`. ' +
            'Pass capability names directly, or a code snippet to analyze.',
          );
        }

        let detection: { capabilities: string[]; signals: unknown[] } | null = null;
        if (args.code) {
          detection = await deriveCapabilitiesFromCode(args.code, args.language, {
            jurisdictions: args.jurisdictions,
            sector: args.sector,
            dataTypes: args.dataTypes,
          });
        }

        const capabilities = [...new Set([...provided, ...(detection?.capabilities ?? [])])];

        if (capabilities.length === 0) {
          // Mirrors the scanner's zero-signal early exit: nothing AI-related
          // was detected, so there is nothing to match. This is the only
          // legitimate "no obligations" answer without an API round trip —
          // and it is labeled as such, not as a cleared compliance check.
          const provenance = await buildProvenance(client);
          return ok({
            result: 'no_capabilities_detected',
            summary:
              'No AI capabilities were provided and none were detected in the supplied code. ' +
              'No rules were matched. This is NOT a compliance clearance — if this code uses AI ' +
              'through mechanisms the detectors do not recognize, pass `capabilities` explicitly.',
            detection,
            provenance,
            disclaimer: LEGAL_DISCLAIMER,
          });
        }

        const simulation = await client.post<SimulateResponse>('/api/v1/simulate', {
          capabilities,
          dataTypes: args.dataTypes ?? [],
          targetMarkets: args.jurisdictions,
          sector: args.sector,
        });
        const provenance = await buildProvenance(client);

        return ok({
          input: {
            jurisdictions: args.jurisdictions,
            sector: args.sector,
            dataTypes: args.dataTypes ?? [],
            providedCapabilities: provided,
          },
          detection,
          capabilitiesEvaluated: capabilities,
          markets: simulation.markets,
          conflicts: simulation.conflicts,
          gapAnalysis: simulation.gapAnalysis,
          overallRisk: simulation.overallRisk,
          totalRulesTriggered: simulation.totalRulesTriggered,
          provenance,
          disclaimer: LEGAL_DISCLAIMER,
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );

  // ── 2. get_rule ───────────────────────────────────────────────
  server.registerTool(
    'get_rule',
    {
      title: 'Get a Nomus rule',
      description:
        'Fetch the full detail of one Nomus policy rule by its rule key (e.g. ' +
        '"eu_ai_act.art50.1.chatbot_disclosure") or internal rule id. Returns conditions, effect, severity, ' +
        'legal reference, and per-rule provenance (Ed25519 signature, timestamps). ' +
        'Calls GET /api/v1/policies/:id, falling back to a rule-key search over GET /api/v1/policies.',
      inputSchema: {
        ruleKey: z.string().min(1).describe('Rule key (or rule id) to look up.'),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        let rule: PolicyRuleRow | undefined;

        // The engine's detail route matches the internal rule id. Try it
        // first (cheap 404 when the caller passed a rule key), then search
        // the list endpoint for an exact ruleKey match.
        try {
          rule = await client.get<PolicyRuleRow>(
            `/api/v1/policies/${encodeURIComponent(args.ruleKey)}`,
          );
        } catch (err) {
          if (!(err instanceof NomusHttpError && err.kind === 'not_found')) throw err;
        }

        if (!rule) {
          const list = await client.get<PoliciesListResponse>('/api/v1/policies', { limit: 1000 });
          rule = list.policies.find((p) => p.ruleKey === args.ruleKey);
          if (!rule) {
            return toolError(
              `Rule "${args.ruleKey}" was not found. Searched the rule-id lookup and the first 1000 ` +
              'active rules (the customer API caps list queries at 1000). Verify the rule key with ' +
              'check_applicability or list_frameworks.',
            );
          }
        }

        const provenance = await buildProvenance(client);
        return ok({
          rule: {
            ruleKey: rule.ruleKey,
            id: rule.id,
            version: rule.version,
            jurisdiction: rule.jurisdiction,
            category: rule.category,
            conditions: rule.conditions,
            effect: rule.effect,
            severity: rule.severity,
            humanSummary: rule.humanSummary,
            legalReference: rule.legalReference,
            effectiveDate: rule.effectiveDate,
            expiresAt: rule.expiresAt,
            industries: rule.industries,
            industryScope: rule.industryScope,
            industryNotes: rule.industryNotes,
            isActive: rule.isActive,
            // Per-rule provenance: Ed25519 signature over the rule's
            // canonical JSON + lifecycle timestamps.
            signature: rule.signature,
            sourceId: rule.sourceId,
            createdAt: rule.createdAt,
            updatedAt: rule.updatedAt,
          },
          provenance,
          disclaimer: LEGAL_DISCLAIMER,
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );

  // ── 3. scan_code ──────────────────────────────────────────────
  server.registerTool(
    'scan_code',
    {
      title: 'Scan code for regulatory obligations',
      description:
        'Run the full Nomus scanner over a set of files (contents provided in-memory — nothing is ' +
        'written to disk and only derived capability signals are sent to the Nomus API, never your ' +
        'code). Returns findings in the scanner\'s JSON shape: per-file, per-line findings with the ' +
        'matched rule, severity, effect, legal reference, and fix suggestions. Fail-closed: if the ' +
        'Nomus API is unreachable, this errors — it never reports a false pass.',
      inputSchema: {
        files: z
          .array(
            z.object({
              path: z.string().min(1).describe('Relative file path, e.g. "src/llm.ts". The extension selects the language parser.'),
              content: z.string().describe('Full file contents.'),
            }),
          )
          .min(1)
          .max(500)
          .describe('Files to scan (1–500).'),
        jurisdictions: jurisdictionsRequired,
        sector: z.string().min(1).optional().describe('Industry sector, e.g. "healthcare".'),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const fileMap = new Map<string, string>();
        for (const f of args.files) {
          if (fileMap.has(f.path)) {
            return toolError(`Duplicate file path in input: "${f.path}". Each path must be unique.`);
          }
          fileMap.set(f.path, f.content);
        }

        const result: ScanResult = await runScanFromContents(fileMap, {
          rootDir: process.cwd(),
          config: {
            jurisdictions: args.jurisdictions,
            sector: args.sector,
            api_key: config.apiKey,
            api_url: config.apiUrl,
          },
        });

        const provenance = await buildProvenance(client);
        return ok({
          status: result.status,
          counts: result.counts,
          fileCount: result.fileCount,
          capabilities: result.capabilities,
          findings: result.findings,
          note:
            result.findings.length === 0 && result.capabilities.length === 0
              ? 'No AI-related signals were detected in the provided files, so no rules were matched. ' +
                'This is not a legal clearance — see the disclaimer.'
              : undefined,
          provenance,
          disclaimer: LEGAL_DISCLAIMER,
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );

  // ── 4a. list_frameworks ───────────────────────────────────────
  server.registerTool(
    'list_frameworks',
    {
      title: 'List compliance frameworks',
      description:
        'List Nomus compliance frameworks — curated rule templates (EU AI Act full coverage, ' +
        'NIST AI RMF, chatbot/biometrics/credit-scoring use-case packs, …) with live rule counts. ' +
        'Calls GET /api/v1/templates.',
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      try {
        const res = await client.get<TemplatesResponse>('/api/v1/templates');
        const provenance = await buildProvenance(client);
        return ok({
          frameworks: res.templates.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            useCase: t.useCase,
            jurisdictions: t.jurisdictions,
            ruleCount: t.ruleCount,
          })),
          note:
            'Frameworks are Nomus compliance templates: curated, keyword/jurisdiction-filtered views ' +
            'over the live rule corpus. ruleCount reflects currently active rules matching each template.',
          provenance,
          disclaimer: LEGAL_DISCLAIMER,
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );

  // ── 4b. list_jurisdictions ────────────────────────────────────
  server.registerTool(
    'list_jurisdictions',
    {
      title: 'List covered jurisdictions',
      description:
        'List the jurisdictions with active rules in the Nomus corpus, with display names. ' +
        'Calls GET /api/v1/policies/impact-map.',
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      try {
        const res = await client.get<ImpactMapResponse>('/api/v1/policies/impact-map');
        const names = JURISDICTIONS as Record<string, string>;
        const maxSeverityByJurisdiction = new Map<string, string>();
        const rank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
        for (const cell of res.matrix) {
          const current = maxSeverityByJurisdiction.get(cell.jurisdiction);
          if (!current || (rank[cell.maxSeverity] ?? 0) > (rank[current] ?? 0)) {
            maxSeverityByJurisdiction.set(cell.jurisdiction, cell.maxSeverity);
          }
        }
        const provenance = await buildProvenance(client);
        return ok({
          jurisdictions: res.jurisdictions.map((code) => ({
            code,
            name: names[code] ?? null,
            maxSeverity: maxSeverityByJurisdiction.get(code) ?? null,
          })),
          industries: res.industries,
          provenance,
          disclaimer: LEGAL_DISCLAIMER,
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );

  // ── 5. regulatory_changes ─────────────────────────────────────
  server.registerTool(
    'regulatory_changes',
    {
      title: 'What changed in the law',
      description:
        'List Nomus rules created or updated since a timestamp — "what changed in the law since my ' +
        'last session". Calls GET /api/v1/policies?since=… (the engine filters on each rule\'s ' +
        'updatedAt; a rule whose createdAt is also after `since` is reported as created, otherwise as ' +
        'updated). Only currently-active rules are returned — rule deactivations are not visible ' +
        'through this endpoint. Results cap at 1000 rules per jurisdiction query.',
      inputSchema: {
        since: z
          .string()
          .datetime({ offset: true })
          .describe('ISO-8601 timestamp, e.g. "2026-07-01T00:00:00Z". Rules updated at/after this time are returned.'),
        jurisdictions: jurisdictionsOptional,
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        // Normalize to UTC Z-form: the engine stores toISOString() values and
        // compares lexicographically, so an offset form like +02:00 would
        // compare incorrectly against stored "Z" timestamps.
        const sinceIso = new Date(args.since).toISOString();

        const queries: Array<Record<string, string | number | undefined>> =
          args.jurisdictions && args.jurisdictions.length > 0
            ? args.jurisdictions.map((j) => ({ since: sinceIso, jurisdiction: j, limit: 1000 }))
            : [{ since: sinceIso, limit: 1000 }];

        const responses = await Promise.all(
          queries.map((q) => client.get<PoliciesListResponse>('/api/v1/policies', q)),
        );

        const changes = responses
          .flatMap((r) => r.policies)
          .map((p) => ({
            ruleKey: p.ruleKey,
            jurisdiction: p.jurisdiction,
            category: p.category,
            severity: p.severity,
            effect: p.effect,
            humanSummary: p.humanSummary,
            legalReference: p.legalReference,
            changeType: p.createdAt >= sinceIso ? ('created' as const) : ('updated' as const),
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            signature: p.signature,
          }))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

        const provenance = await buildProvenance(client);
        return ok({
          since: sinceIso,
          jurisdictions: args.jurisdictions ?? 'all',
          changeCount: changes.length,
          changes,
          note:
            'Sourced from GET /api/v1/policies with the updated-since filter. Covers rule creations and ' +
            'updates among currently-active rules; deactivated rules do not appear. Each query is capped ' +
            'at 1000 rules — narrow `jurisdictions` or use a more recent `since` if you hit the cap.',
          provenance,
          disclaimer: LEGAL_DISCLAIMER,
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );

  // ── 6. bill_radar ─────────────────────────────────────────────
  server.registerTool(
    'bill_radar',
    {
      title: 'Legislative bill radar',
      description:
        'Scout v2 signals: tracked AI-related bills with passage-probability scores (0–100), current ' +
        'stage, and jurisdiction. Calls GET /api/v1/radar/v2/bills.',
      inputSchema: {
        jurisdictions: jurisdictionsOptional,
        minScore: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe('Only bills with passage score >= this value (0–100).'),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const queries: Array<Record<string, string | number | undefined>> =
          args.jurisdictions && args.jurisdictions.length > 0
            ? args.jurisdictions.map((j) => ({
                jurisdiction: j,
                minScore: args.minScore,
                limit: 100,
              }))
            : [{ minScore: args.minScore, limit: 100 }];

        const responses = await Promise.all(
          queries.map((q) => client.get<BillsResponse>('/api/v1/radar/v2/bills', q)),
        );

        const bills = responses
          .flatMap((r) => r.bills)
          .sort((a, b) => (Number(b.passageScore ?? 0)) - (Number(a.passageScore ?? 0)));
        const total = responses.reduce((sum, r) => sum + r.total, 0);

        const provenance = await buildProvenance(client);
        return ok({
          filters: { jurisdictions: args.jurisdictions ?? 'all', minScore: args.minScore ?? 0 },
          totalTracked: total,
          returned: bills.length,
          bills,
          note:
            'Passage scores are Nomus Scout model estimates of enactment probability, not predictions ' +
            'of legal effect. Bills are not law; consult get_rule / check_applicability for current obligations.',
          provenance,
          disclaimer: LEGAL_DISCLAIMER,
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );

  return server;
}

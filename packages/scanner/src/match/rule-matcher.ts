import axios from 'axios';
import type { DetectedImport } from '../detect/imports.js';
import type { DetectorSignal } from '../detect/detector.js';
import type { NomusConfig } from '../config/schema.js';

/**
 * Thrown when the Nomus API cannot be reached, returns a non-2xx status,
 * or returns a response the scanner cannot interpret.
 *
 * Consumers MUST treat this as "compliance status UNKNOWN" and fail closed —
 * never as an empty (passing) scan result. A backend outage must never turn
 * a CI compliance gate green.
 */
export class NomusApiError extends Error {
  /** Underlying error or offending response payload, for diagnostics. */
  readonly detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message, detail instanceof Error ? { cause: detail } : undefined);
    this.name = 'NomusApiError';
    this.detail = detail;
  }
}

/**
 * Type guard that survives module duplication (bundlers, npm-linked copies)
 * where `instanceof NomusApiError` may fail across realms.
 */
export function isNomusApiError(err: unknown): err is NomusApiError {
  return err instanceof Error && err.name === 'NomusApiError';
}

export interface MatchedRule {
  ruleKey: string;
  effect: string;
  severity: string;
  humanSummary: string;
  legalReference: string;
  matchedOn: string[];
  confidence: number; // 0-1, how well the detected capabilities match this rule's conditions
}

export interface Finding {
  file: string;
  line: number;
  sdk: string;
  /** Which detector produced the signal that triggered this finding */
  detectorSource: string;
  /** Evidence from the detector (import statement, AST node, etc.) */
  evidence: string;
  rule: MatchedRule;
  suggestion?: string;
}

/**
 * Query the Nomus API with detected capabilities to get matching rules,
 * then map them back to the specific code locations using detector signals.
 *
 * This is the primary matching function used by the plugin-based scan pipeline.
 */
export async function matchRulesToSignals(
  signals: DetectorSignal[],
  capabilities: string[],
  config: NomusConfig,
): Promise<Finding[]> {
  const apiKey = config.nomus.api_key;
  const apiUrl = config.nomus.api_url;

  if (!apiKey) {
    throw new Error('No Nomus API key configured. Set NOMUS_API_KEY or provide api_key in .nomus.yml');
  }

  // Query Nomus simulate endpoint for matching rules.
  // Fail CLOSED: any transport failure, non-2xx status (axios throws on those),
  // or unexpected response shape throws NomusApiError. Returning [] here
  // would make a backend outage look like a passing compliance scan.
  let data: { markets?: unknown };
  try {
    ({ data } = await axios.post(`${apiUrl}/api/v1/simulate`, {
      capabilities,
      dataTypes: config.nomus.data_types,
      targetMarkets: config.nomus.jurisdictions,
      sector: config.nomus.sector,
    }, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 15000,
    }));
  } catch (err) {
    throw new NomusApiError(
      `Nomus API request failed: ${(err as Error).message}`,
      err,
    );
  }

  if (!data || typeof data !== 'object' || !data.markets || typeof data.markets !== 'object') {
    throw new NomusApiError(
      'Nomus API returned an unexpected response shape (missing "markets" object)',
      data,
    );
  }
  const marketRules = data.markets as Record<string, { rules: MatchedRule[] }>;

  // Map rules back to code locations via signals
  const findings: Finding[] = [];

  for (const [jurisdiction, market] of Object.entries(marketRules)) {
    for (const rule of market.rules) {
      // Compute confidence: how many of the rule's matched conditions align with detected capabilities
      // The engine emits matched conditions as `capability: ${cap}` (with a
      // space after the colon) — see engine/src/server/routes/simulate.ts.
      // Take everything after the first colon and trim, so both
      // 'capability:text_generation' and 'capability: text_generation' parse.
      const relevantCaps = rule.matchedOn
        .filter((m) => m.startsWith('capability:'))
        .map((m) => m.split(':').slice(1).join(':').trim());

      const matchCount = relevantCaps.filter((cap) => capabilities.includes(cap)).length;
      const confidence = relevantCaps.length > 0
        ? Math.round((matchCount / relevantCaps.length) * 100) / 100
        : 0.5; // Default confidence when no capability matching possible

      const ruleWithConfidence = { ...rule, confidence };

      // Find which signals triggered this rule — use the highest-confidence signal per file
      const seenFiles = new Set<string>();
      for (const signal of signals) {
        if (seenFiles.has(signal.file)) continue;

        const signalMatchesCap = relevantCaps.length === 0 ||
          relevantCaps.some((cap) => signal.capabilities.includes(cap));

        if (signalMatchesCap) {
          // Factor signal confidence into rule confidence
          const combinedConfidence = Math.round(confidence * signal.confidence * 100) / 100;

          findings.push({
            file: signal.file,
            line: signal.line,
            sdk: signal.target,
            detectorSource: signal.source,
            evidence: signal.evidence,
            rule: { ...ruleWithConfidence, confidence: combinedConfidence },
          });
          seenFiles.add(signal.file);
        }
      }
    }
  }

  return findings;
}

/**
 * Legacy function — wraps matchRulesToSignals for backward compatibility.
 * Used by consumers that still pass DetectedImport[] directly.
 *
 * @deprecated Use matchRulesToSignals with DetectorSignal[] instead.
 */
export async function matchRulesToCode(
  imports: DetectedImport[],
  capabilities: string[],
  config: NomusConfig,
): Promise<Finding[]> {
  // Convert imports to signals
  const signals: DetectorSignal[] = imports.map((imp) => ({
    source: 'import-detector',
    file: imp.file,
    line: imp.line,
    target: imp.sdk,
    capabilities: [], // Will be matched via the capabilities param
    confidence: 1.0,
    evidence: imp.importStatement,
    metadata: { language: imp.language },
  }));

  // For legacy path, inject capabilities into signals so matching works
  for (const signal of signals) {
    signal.capabilities = [...capabilities]; // All caps apply in legacy mode
  }

  return matchRulesToSignals(signals, capabilities, config);
}

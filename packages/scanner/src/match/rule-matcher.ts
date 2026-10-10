import axios from 'axios';
import type { DetectedImport } from '../detect/imports.js';
import type { DetectorSignal } from '../detect/detector.js';
import type { NomusConfig } from '../config/schema.js';
import { NomusApiError, isNomusApiError } from '../errors.js';

// NomusApiError lives in ../errors.ts so the corporate bundle client can use it
// without importing this module's HTTP client; re-exported for existing importers.
export { NomusApiError, isNomusApiError };

/** The engine's generic action condition — satisfied by any AI capability. */
const GENERIC_AI_ACTION = 'ai_operation';

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

export type CorporateTier = 'advisory' | 'review-required' | 'prohibited';

/**
 * The status of a corporate finding as the scanner can know it, before any
 * review decision: `needs_review` (blocking), `grace` (a review-required or
 * prohibited policy before its enforce-from instant: advisory) or
 * `advisory` (an advisory policy).
 */
export type CorporateFindingStatus = 'needs_review' | 'grace' | 'advisory';

/**
 * A corporate policy finding (CPG, design spec §8.6, §16.3). Reported in
 * `ScanResult.corporateFindings`, never in `findings`, `counts` or `status`.
 */
export interface CorporateFinding {
  source: 'corporate';
  /** The file as the scan knows it (absolute for runScan, the caller's key for in-memory scans). */
  file: string;
  /** Repository-relative POSIX path. */
  filePath: string;
  language: 'typescript' | 'javascript' | 'python' | 'java' | 'go' | 'other';
  startLine: number;
  endLine: number;
  /** The line of the anchor hit (the rule's first matcher). */
  anchorLine: number;
  matchedBy: string;
  policyKey: string;
  policyVersion: number;
  tier: CorporateTier;
  status: CorporateFindingStatus;
  /** True when the finding needs a review decision (CI blocks on it from Phase 6). */
  blocking: boolean;
  /** ISO-8601 instant from which the policy is enforced (the end of its grace period). */
  enforceFrom: string;
  /** sha256(normalize(snippet)):policyKey:policyVersion (spec §6). */
  fingerprint: string;
  snippetHash: string;
  /** The normalized snippet the fingerprint hashes. Kept local: never written to reports or SARIF. */
  snippet: string;
  truncated: boolean;
  rule: {
    policyId: string;
    policyKey: string;
    version: number;
    title: string;
    tier: CorporateTier;
    message: string;
    owningBoards: Array<{ id: string; name: string }>;
    enforceFrom: string;
    activatedAt: string;
    policyReference: string;
  };
}

/** The SDK a signal is about, or undefined for signals that describe data, not an SDK. */
function sdkOfSignal(signal: DetectorSignal): string | undefined {
  if (signal.source === 'import-detector') return signal.target;
  if (signal.source === 'sdk-usage-detector') {
    const sdk = (signal.metadata as { sdk?: unknown } | undefined)?.sdk;
    return typeof sdk === 'string' ? sdk : signal.target.split('.')[0];
  }
  return undefined;
}

interface SdkSite { line: number; sdk: string }
interface SdkSignals { usage: SdkSite[]; imports: SdkSite[] }

/**
 * The SDK a non-SDK signal (PHI pattern, transparency, risk, data flow) belongs
 * to: the SDK call on the same line, else the closest SDK call in the file
 * (ties go to the earlier line). Import signals are only consulted when the
 * file has no SDK-usage signal at all.
 */
function nearestSdk(sites: SdkSignals | undefined, line: number): string | undefined {
  if (!sites) return undefined;
  const candidates = sites.usage.length > 0 ? sites.usage : sites.imports;
  let best: SdkSite | undefined;
  for (const site of candidates) {
    if (!best) { best = site; continue; }
    const d = Math.abs(site.line - line);
    const bd = Math.abs(best.line - line);
    if (d < bd || (d === bd && site.line < best.line)) best = site;
  }
  return best?.sdk;
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
    const status = (err as { response?: { status?: number } }).response?.status;
    const reason = status === 401
      ? 'the API key was rejected (401) — check NOMUS_API_KEY / api_key'
      : status === 403
        ? 'the API key lacks the "evaluate" scope (403)'
        : status
          ? `the engine returned HTTP ${status}`
          : `the engine at ${apiUrl} could not be reached (${(err as Error).message})`;
    throw new NomusApiError(`Nomus API request failed: ${reason}`, err);
  }

  if (!data || typeof data !== 'object' || !data.markets || typeof data.markets !== 'object') {
    throw new NomusApiError(
      'Nomus API returned an unexpected response shape (missing "markets" object)',
      data,
    );
  }
  const marketRules = data.markets as Record<string, { rules: MatchedRule[] }>;

  // Map rules back to code locations via signals.
  // INTL rules are returned under every requested market, so the same rule can
  // arrive more than once — report each (rule, file) pair once.
  const findings: Finding[] = [];
  const reported = new Set<string>();

  // SDK-naming signals grouped per file, used to attribute signals that do not
  // name an SDK themselves (see nearestSdk).
  const sdkSignalsByFile = new Map<string, SdkSignals>();
  for (const signal of signals) {
    const sdk = sdkOfSignal(signal);
    if (!sdk) continue;
    const entry = sdkSignalsByFile.get(signal.file) ?? { usage: [], imports: [] };
    (signal.source === 'sdk-usage-detector' ? entry.usage : entry.imports)
      .push({ line: signal.line, sdk });
    sdkSignalsByFile.set(signal.file, entry);
  }

  for (const market of Object.values(marketRules)) {
    for (const rule of market.rules) {
      // Compute confidence: how many of the rule's matched conditions align with detected capabilities
      // The engine emits matched conditions as `capability: ${cap}` (with a
      // space after the colon) — see engine/src/server/routes/simulate.ts.
      // Take everything after the first colon and trim, so both
      // 'capability:text_generation' and 'capability: text_generation' parse.
      // `ai_operation` is the engine's generic action: any AI signal carries it.
      const relevantCaps = rule.matchedOn
        .filter((m) => m.startsWith('capability:'))
        .map((m) => m.split(':').slice(1).join(':').trim())
        .filter((cap) => cap !== GENERIC_AI_ACTION);

      const matchCount = relevantCaps.filter((cap) => capabilities.includes(cap)).length;
      const confidence = relevantCaps.length > 0
        ? Math.round((matchCount / relevantCaps.length) * 100) / 100
        : 0.5; // Default confidence when no capability matching possible

      // Pick the highest-confidence signal per file that carries the capability.
      const bestByFile = new Map<string, DetectorSignal>();
      for (const signal of signals) {
        const signalMatchesCap = relevantCaps.length === 0 ||
          relevantCaps.some((cap) => signal.capabilities.includes(cap));
        if (!signalMatchesCap) continue;
        const incumbent = bestByFile.get(signal.file);
        if (!incumbent || signal.confidence > incumbent.confidence) {
          bestByFile.set(signal.file, signal);
        }
      }

      for (const [file, signal] of bestByFile) {
        const key = `${rule.ruleKey}::${file}`;
        if (reported.has(key)) continue;
        reported.add(key);

        // Factor signal confidence into rule confidence
        const combinedConfidence = Math.round(confidence * signal.confidence * 100) / 100;

        findings.push({
          file: signal.file,
          line: signal.line,
          sdk: sdkOfSignal(signal) ?? nearestSdk(sdkSignalsByFile.get(signal.file), signal.line) ?? 'unknown',
          detectorSource: signal.source,
          evidence: signal.evidence,
          rule: { ...rule, confidence: combinedConfidence },
        });
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

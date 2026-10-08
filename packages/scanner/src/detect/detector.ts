/**
 * Detector Plugin Interface — Phase 2
 *
 * All detection in Nomus flows through this interface.
 * Each detector plugin emits DetectorSignal[] which are unified
 * into the capability map before rule matching.
 *
 * Phase 3 detectors (AST, data flow, PHI patterns) will implement
 * this same interface and slot in without touching rule-matcher or output.
 */

/**
 * A single signal emitted by a detector plugin.
 * This is the universal unit of detection — every detector
 * (imports, AST, data flow, PHI) produces these.
 */
export interface DetectorSignal {
  /** Detector that produced this signal */
  source: string;
  /** Absolute file path */
  file: string;
  /** 1-indexed line number */
  line: number;
  /** What was detected (SDK name, data type, PHI pattern, etc.) */
  target: string;
  /** AI capabilities this detection implies */
  capabilities: string[];
  /** 0-1 confidence in this specific detection */
  confidence: number;
  /** Human-readable evidence for this detection */
  evidence: string;
  /** Optional metadata for detector-specific context */
  metadata?: Record<string, unknown>;
}

/**
 * Context passed to every detector plugin during a scan.
 */
export interface DetectorContext {
  /** Absolute path to the scan root */
  rootDir: string;
  /** File paths to scan (absolute) */
  files: string[];
  /** In-memory file contents (for content-based scans like GitHub webhook) */
  fileContents?: Map<string, string>;
  /** Loaded Nomus config */
  config: {
    jurisdictions: string[];
    sector?: string;
    data_types?: string[];
    ignore?: string[];
  };
}

/**
 * A detector plugin. Implement this interface to add a new
 * detection layer to Nomus.
 *
 * Built-in detectors:
 *   - ImportDetector (v1 — what ships today)
 *
 * Phase 3 detectors (plug in when ready):
 *   - SDKUsageDetector — TypeScript compiler AST, actual call-site analysis
 *     with intra-file data-flow proof into AI SDK calls (regex fallback
 *     for non-JS/TS files)
 *   - DataFlowDetector — taint tracking from AI SDK calls to sinks
 *   - PHIPatternDetector — regex + NER for PHI/PII in code
 *   - RiskClassificationDetector — AI Act Annex III auto-classification
 */
export interface DetectorPlugin {
  /** Unique identifier for this detector */
  readonly name: string;
  /** Human-readable description */
  readonly description: string;
  /** Detector version (semver) */
  readonly version: string;
  /** Run detection and return signals */
  detect(ctx: DetectorContext): Promise<DetectorSignal[]>;
}

/**
 * Registry for detector plugins. The scan pipeline queries this
 * to get all active detectors.
 */
export class DetectorRegistry {
  private detectors: DetectorPlugin[] = [];

  register(detector: DetectorPlugin): void {
    // Prevent duplicate registration
    if (this.detectors.some((d) => d.name === detector.name)) {
      throw new Error(`Detector "${detector.name}" is already registered`);
    }
    this.detectors.push(detector);
  }

  getAll(): readonly DetectorPlugin[] {
    return this.detectors;
  }

  get(name: string): DetectorPlugin | undefined {
    return this.detectors.find((d) => d.name === name);
  }
}

/**
 * Detector precision priority (higher = more precise).
 * Used by mergeSignals to decide which detector wins when the same
 * (file, line, capability) triple is reported by multiple sources.
 *
 * Higher-precision detectors should win because they have more context:
 *   data-flow knows the source AND sink (best signal)
 *   sdk-usage knows the actual method called
 *   phi-pattern knows the exact data class
 *   risk-classifier infers from domain vocabulary
 *   import-detector only knows "this SDK is in scope"
 */
const DETECTOR_PRIORITY: Record<string, number> = {
  'data-flow-detector': 5,
  'sdk-usage-detector': 4,
  'phi-pattern-detector': 3,
  'risk-classifier': 2,
  'import-detector': 1,
};

/**
 * The import detector names SDKs by package (`@anthropic-ai/sdk`,
 * `google.generativeai`, `cohere`); the SDK-usage detector by SDK family.
 * Map both to one key so the two can be compared.
 */
const SDK_FAMILY: Record<string, string> = {
  '@anthropic-ai/sdk': 'anthropic',
  'com.anthropic': 'anthropic',
  'anthropic-sdk-go': 'anthropic',
  'com.openai': 'openai',
  'openai-go': 'openai',
  'google.generativeai': '@google/generative-ai',
  'cohere': 'cohere-ai',
  'boto3-bedrock': '@aws-sdk/client-bedrock-runtime',
  'aws-bedrock': '@aws-sdk/client-bedrock-runtime',
};

function canonicalSdk(sdk: string): string {
  return SDK_FAMILY[sdk] ?? sdk;
}

function priorityOf(source: string): number {
  return DETECTOR_PRIORITY[source] ?? 0;
}

/**
 * Merge signals from multiple detectors into a unified capability map.
 * Deduplicates by (file, line, capability) — when multiple detectors report
 * the same capability at the same location, the higher-precision detector wins.
 */
export function mergeSignals(signals: DetectorSignal[]): {
  capabilities: string[];
  signalsByFile: Map<string, DetectorSignal[]>;
  dedupedSignals: DetectorSignal[];
} {
  const allCaps = new Set<string>();
  const signalsByFile = new Map<string, DetectorSignal[]>();

  // The import detector reports every capability an SDK *could* provide
  // (an `openai` import implies image generation, speech, vision, ...). Where
  // the SDK-usage detector found the actual calls for that SDK in the same
  // file, those calls are the evidence: the speculative import signal is
  // dropped so it cannot widen the capability set.
  const usedSdksByFile = new Set<string>();
  for (const signal of signals) {
    if (signal.source !== 'sdk-usage-detector') continue;
    const sdk = (signal.metadata as { sdk?: unknown } | undefined)?.sdk;
    if (typeof sdk === 'string') usedSdksByFile.add(`${signal.file}::${canonicalSdk(sdk)}`);
  }
  signals = signals.filter((signal) =>
    signal.source !== 'import-detector' ||
    !usedSdksByFile.has(`${signal.file}::${canonicalSdk(signal.target)}`));

  // Dedup key = file + line + capability
  // Value = winning signal
  const winnerByKey = new Map<string, DetectorSignal>();

  for (const signal of signals) {
    for (const cap of signal.capabilities) {
      allCaps.add(cap);
      const key = `${signal.file}::${signal.line}::${cap}`;
      const incumbent = winnerByKey.get(key);
      if (!incumbent || priorityOf(signal.source) > priorityOf(incumbent.source)) {
        winnerByKey.set(key, signal);
      }
    }
  }

  // Group surviving signals by file (one signal may carry multiple caps —
  // we keep its full identity for downstream consumers).
  const seenSignals = new Set<DetectorSignal>();
  const dedupedSignals: DetectorSignal[] = [];
  for (const winner of winnerByKey.values()) {
    if (seenSignals.has(winner)) continue;
    seenSignals.add(winner);
    dedupedSignals.push(winner);
    const existing = signalsByFile.get(winner.file) ?? [];
    existing.push(winner);
    signalsByFile.set(winner.file, existing);
  }

  return {
    capabilities: [...allCaps],
    signalsByFile,
    dedupedSignals,
  };
}

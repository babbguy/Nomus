/**
 * In-process capability detection for `check_applicability`.
 *
 * Runs the full @nomus/scanner detector registry (the same 6 plugins the
 * scan pipeline uses) over a single in-memory code snippet — no filesystem,
 * no network. The derived capabilities feed POST /api/v1/simulate.
 */

import {
  DetectorRegistry,
  ImportDetector,
  SdkUsageDetector,
  PhiPatternDetector,
  RiskClassifier,
  TransparencyDetector,
  DataFlowDetector,
  mergeSignals,
  type DetectorSignal,
} from '@nomus/scanner';

/** Languages the scanner's detectors understand, mapped to file extensions. */
const LANGUAGE_EXTENSIONS: Record<string, string> = {
  typescript: 'ts',
  tsx: 'tsx',
  javascript: 'js',
  jsx: 'jsx',
  python: 'py',
  java: 'java',
  go: 'go',
};

export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_EXTENSIONS);

export interface DetectionConfig {
  jurisdictions: string[];
  sector?: string;
  dataTypes?: string[];
}

export interface DetectionOutcome {
  /** Deduplicated capabilities derived from all detector signals. */
  capabilities: string[];
  /** Raw signals, for evidence lines in the tool answer. */
  signals: Array<{
    detector: string;
    line: number;
    target: string;
    capabilities: string[];
    confidence: number;
    evidence: string;
  }>;
}

function buildRegistry(): DetectorRegistry {
  const registry = new DetectorRegistry();
  registry.register(new ImportDetector());
  registry.register(new SdkUsageDetector());
  registry.register(new PhiPatternDetector());
  registry.register(new RiskClassifier());
  registry.register(new TransparencyDetector());
  registry.register(new DataFlowDetector({ maxTaintDepth: 3 }));
  return registry;
}

/**
 * Run all detectors over a single code snippet held in memory.
 * `language` defaults to typescript when not provided.
 */
export async function deriveCapabilitiesFromCode(
  code: string,
  language: string | undefined,
  config: DetectionConfig,
): Promise<DetectionOutcome> {
  const ext = LANGUAGE_EXTENSIONS[language ?? 'typescript'] ?? 'ts';
  const virtualPath = `snippet.${ext}`;
  const fileContents = new Map<string, string>([[virtualPath, code]]);

  const registry = buildRegistry();
  const allSignals: DetectorSignal[] = [];
  for (const detector of registry.getAll()) {
    const signals = await detector.detect({
      rootDir: process.cwd(),
      files: [virtualPath],
      fileContents,
      config: {
        jurisdictions: config.jurisdictions,
        sector: config.sector,
        data_types: config.dataTypes ?? [],
      },
    });
    allSignals.push(...signals);
  }

  if (allSignals.length === 0) {
    return { capabilities: [], signals: [] };
  }

  const { capabilities, dedupedSignals } = mergeSignals(allSignals);
  return {
    capabilities,
    signals: dedupedSignals.map((s) => ({
      detector: s.source,
      line: s.line,
      target: s.target,
      capabilities: s.capabilities,
      confidence: s.confidence,
      evidence: s.evidence,
    })),
  };
}

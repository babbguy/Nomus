import { resolve, relative } from 'node:path';
import { glob } from 'glob';
import { loadConfig } from './config/loader.js';
import type { NomusConfig } from './config/schema.js';
import { DetectorRegistry, mergeSignals, type DetectorSignal } from './detect/detector.js';
import { ImportDetector } from './detect/import-detector.js';
import { SdkUsageDetector } from './detect/sdk-usage-detector.js';
import { PhiPatternDetector } from './detect/phi-pattern-detector.js';
import { RiskClassifier } from './detect/risk-classifier.js';
import { TransparencyDetector } from './detect/transparency-detector.js';
import { DataFlowDetector } from './detect/data-flow-detector.js';
import { matchRulesToSignals, type CorporateFinding, type Finding } from './match/rule-matcher.js';
import { generateSuggestions } from './fix/suggestions.js';
import {
  corporateOff, resolveCorporateBundle, runCorporateScan, runCorporateScanOnDisk,
  type CorporateScanOptions, type CorporateScanSummary,
} from './scan-corporate.js';

export interface ScanOptions {
  rootDir: string;
  apiKey?: string;
  apiUrl?: string;
  failOn?: string;
  /** Override jurisdictions from config */
  jurisdictions?: string[];
  /** Direct config override — skips .nomus.yml loading */
  config?: { jurisdictions: string[]; api_key?: string; api_url?: string; sector?: string; data_types?: string[]; ignore?: string[] };
  /** Additional detector plugins to run alongside the built-in ImportDetector */
  detectors?: DetectorRegistry;
  /**
   * Corporate policies (CPG). Absent or `mode: 'off'`: not evaluated, and the
   * scan is exactly the v1.1.0 scan. `mode: 'auto'`: the org's signed bundle
   * is fetched and verified (or `bundle` is used), then evaluated locally.
   */
  corporate?: CorporateScanOptions;
}

export interface ScanResult {
  findings: Finding[];
  fileCount: number;
  importCount: number;
  capabilities: string[];
  /** All detector signals before rule matching (for downstream consumers) */
  signals: DetectorSignal[];
  status: 'pass' | 'fail';
  counts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
  /** Corporate policy findings; never counted in `findings`, `counts` or `status`. */
  corporateFindings: CorporateFinding[];
  /** What the corporate evaluation used: the bundle, its policies and the files checked. */
  corporate: CorporateScanSummary;
}

const SOURCE_PATTERNS = [
  '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs',
  '**/*.py',
  '**/*.java',
  '**/*.go',
];

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/**
 * Apply defaults to a partial config (used when callers pass `options.config`
 * directly instead of loading `.nomus.yml`). Keeps the type system honest.
 */
function fillConfigDefaults(partial: NonNullable<ScanOptions['config']>): NomusConfig {
  return {
    nomus: {
      api_key: partial.api_key,
      api_url: partial.api_url ?? 'http://localhost:3100',
      jurisdictions: partial.jurisdictions,
      sector: partial.sector,
      data_types: partial.data_types ?? [],
      ignore: partial.ignore ?? ['node_modules/**', 'dist/**', '.git/**'],
      detectors: {
        import: true,
        sdk_usage: true,
        phi_pattern: true,
        risk_classifier: true,
        data_flow: true,
        transparency: true,
      },
      max_taint_depth: 3,
    },
  };
}

/**
 * Build the detector registry with built-in + user-provided detectors.
 * Detector toggles come from `.nomus.yml` -> nomus.detectors.
 */
function buildRegistry(
  config: NomusConfig,
  userRegistry?: DetectorRegistry,
): DetectorRegistry {
  const registry = new DetectorRegistry();
  const toggles = config.nomus.detectors;
  const maxDepth = config.nomus.max_taint_depth;

  if (toggles.import) registry.register(new ImportDetector());
  if (toggles.sdk_usage) registry.register(new SdkUsageDetector());
  if (toggles.phi_pattern) registry.register(new PhiPatternDetector());
  if (toggles.risk_classifier) registry.register(new RiskClassifier());
  if (toggles.transparency) registry.register(new TransparencyDetector());
  if (toggles.data_flow) registry.register(new DataFlowDetector({ maxTaintDepth: maxDepth }));

  // Merge in any user-provided detectors (additional plugins)
  if (userRegistry) {
    for (const detector of userRegistry.getAll()) {
      // Skip duplicates — user registry may include the same default detector
      if (!registry.get(detector.name)) {
        registry.register(detector);
      }
    }
  }

  return registry;
}

/**
 * Run the Nomus scanner against a directory.
 * Core library function — no process.exit, no console output.
 *
 * Fail-closed contract: if the Nomus API is unreachable or returns an
 * unusable response, this function throws {@link NomusApiError} rather
 * than returning an empty (passing) result. Callers must surface that as
 * "compliance status UNKNOWN" — never as a pass. The only legitimate pass
 * without an API call is the zero-signals early exit below (nothing AI-related
 * was detected, so there is nothing to match).
 */
export async function runScan(options: ScanOptions): Promise<ScanResult> {
  const rootDir = resolve(options.rootDir);

  // Load config (may throw if missing)
  const config = options.config
    ? fillConfigDefaults(options.config)
    : loadConfig(rootDir);

  // Override config with explicit options
  if (options.apiKey) config.nomus.api_key = options.apiKey;
  if (options.apiUrl) config.nomus.api_url = options.apiUrl;
  if (options.jurisdictions) config.nomus.jurisdictions = options.jurisdictions;

  // Corporate policies: the bundle's signatures are verified before any of
  // its rules is used (a failure throws NomusApiError: fail closed), and the
  // rules run on the repository's files, whatever .nomus.yml ignores (D14).
  const bundle = await resolveCorporateBundle(options.corporate, config.nomus.api_url, config.nomus.api_key);
  const corporate = bundle
    ? await runCorporateScanOnDisk(rootDir, bundle, { now: options.corporate?.now })
    : { findings: [], summary: corporateOff() };

  // Find source files. glob walks directories concurrently and returns them
  // in no guaranteed order; detectors and findings follow this order, so sort
  // it to make every scan of the same tree produce identical output.
  const files = (await glob(SOURCE_PATTERNS, {
    cwd: rootDir,
    ignore: config.nomus.ignore,
    absolute: true,
    nodir: true,
  })).sort();

  // Build detector registry
  const registry = buildRegistry(config, options.detectors);

  // Run all detectors
  const allSignals: DetectorSignal[] = [];
  for (const detector of registry.getAll()) {
    const signals = await detector.detect({
      rootDir,
      files,
      config: {
        jurisdictions: config.nomus.jurisdictions,
        sector: config.nomus.sector,
        data_types: config.nomus.data_types,
        ignore: config.nomus.ignore,
      },
    });
    allSignals.push(...signals);
  }

  if (allSignals.length === 0) {
    return {
      findings: [],
      fileCount: files.length,
      importCount: 0,
      capabilities: [],
      signals: [],
      status: 'pass',
      counts: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
      corporateFindings: corporate.findings,
      corporate: corporate.summary,
    };
  }

  // Merge signals from all detectors (priority + dedup, M2/M3)
  const { capabilities, dedupedSignals } = mergeSignals(allSignals);

  // Match against Nomus rules using deduped signals
  const findings = await matchRulesToSignals(dedupedSignals, capabilities, config);

  // Generate fix suggestions
  const withSuggestions = generateSuggestions(findings);

  // Compute counts
  const counts = {
    critical: withSuggestions.filter((f) => f.rule.severity === 'critical').length,
    high: withSuggestions.filter((f) => f.rule.severity === 'high').length,
    medium: withSuggestions.filter((f) => f.rule.severity === 'medium').length,
    low: withSuggestions.filter((f) => f.rule.severity === 'low').length,
    total: withSuggestions.length,
  };

  // Determine pass/fail
  const failOn = options.failOn ?? 'critical';
  const failThreshold = SEVERITY_RANK[failOn] ?? 4;
  const maxSeverity = Math.max(...withSuggestions.map((f) => SEVERITY_RANK[f.rule.severity] ?? 0), 0);

  // importCount = signals from the import-detector specifically
  const importCount = allSignals.filter((s) => s.source === 'import-detector').length;

  return {
    findings: withSuggestions,
    fileCount: files.length,
    importCount,
    capabilities,
    signals: allSignals,
    status: maxSeverity >= failThreshold ? 'fail' : 'pass',
    counts,
    corporateFindings: corporate.findings,
    corporate: corporate.summary,
  };
}

/**
 * Run the scanner against in-memory file contents (no filesystem).
 * Used by the GitHub App webhook handler (Contents API).
 */
export async function runScanFromContents(
  files: Map<string, string>,
  options: ScanOptions,
): Promise<ScanResult> {
  const rootDir = resolve(options.rootDir);
  const config = options.config
    ? fillConfigDefaults(options.config)
    : loadConfig(rootDir);

  if (options.apiKey) config.nomus.api_key = options.apiKey;
  if (options.apiUrl) config.nomus.api_url = options.apiUrl;
  if (options.jurisdictions) config.nomus.jurisdictions = options.jurisdictions;

  // Corporate policies, as in runScan, over the given files only.
  const bundle = await resolveCorporateBundle(options.corporate, config.nomus.api_url, config.nomus.api_key);
  const corporate = bundle
    ? await runCorporateScan(files, rootDir, bundle, { now: options.corporate?.now })
    : { findings: [], summary: corporateOff() };

  // Build detector registry
  const registry = buildRegistry(config, options.detectors);

  // Run all detectors with in-memory contents
  const allSignals: DetectorSignal[] = [];
  for (const detector of registry.getAll()) {
    const signals = await detector.detect({
      rootDir,
      files: Array.from(files.keys()),
      fileContents: files,
      config: {
        jurisdictions: config.nomus.jurisdictions,
        sector: config.nomus.sector,
        data_types: config.nomus.data_types,
        ignore: config.nomus.ignore,
      },
    });
    allSignals.push(...signals);
  }

  if (allSignals.length === 0) {
    return {
      findings: [],
      fileCount: files.size,
      importCount: 0,
      capabilities: [],
      signals: [],
      status: 'pass',
      counts: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
      corporateFindings: corporate.findings,
      corporate: corporate.summary,
    };
  }

  // Same priority+dedup as runScan (M2/M3) — webhook path must not bypass it.
  const { capabilities, dedupedSignals } = mergeSignals(allSignals);
  const findings = await matchRulesToSignals(dedupedSignals, capabilities, config);
  const withSuggestions = generateSuggestions(findings);

  const counts = {
    critical: withSuggestions.filter((f) => f.rule.severity === 'critical').length,
    high: withSuggestions.filter((f) => f.rule.severity === 'high').length,
    medium: withSuggestions.filter((f) => f.rule.severity === 'medium').length,
    low: withSuggestions.filter((f) => f.rule.severity === 'low').length,
    total: withSuggestions.length,
  };

  const failOn = options.failOn ?? 'critical';
  const failThreshold = SEVERITY_RANK[failOn] ?? 4;
  const maxSeverity = Math.max(...withSuggestions.map((f) => SEVERITY_RANK[f.rule.severity] ?? 0), 0);

  const importCount = allSignals.filter((s) => s.source === 'import-detector').length;

  return {
    findings: withSuggestions,
    fileCount: files.size,
    importCount,
    capabilities,
    signals: allSignals,
    status: maxSeverity >= failThreshold ? 'fail' : 'pass',
    counts,
    corporateFindings: corporate.findings,
    corporate: corporate.summary,
  };
}

// Re-export types for consumers
export { NomusApiError, isNomusApiError } from './match/rule-matcher.js';
export type {
  Finding, MatchedRule, CorporateFinding, CorporateFindingStatus, CorporateTier,
} from './match/rule-matcher.js';
export {
  runCorporateScan, runCorporateScanOnDisk, corporateStatusOf, dashboardUrlFromApiUrl, resolveCorporateBundle,
  type CorporateMode, type CorporateScanOptions, type CorporateScanSummary, type CorporateScanOutcome,
} from './scan-corporate.js';
export { CorporateBundleError, bundleFailureOf, type BundleFailure } from './corporate/bundle-client.js';
export type { CorporateBundle, BundlePolicy } from './corporate/contracts.js';
export type { DetectedImport } from './detect/imports.js';
export type { DetectorPlugin, DetectorSignal, DetectorContext } from './detect/detector.js';
export { DetectorRegistry, mergeSignals } from './detect/detector.js';

// Re-export detector classes so engine + tests can import them directly
export { ImportDetector } from './detect/import-detector.js';
export { SdkUsageDetector } from './detect/sdk-usage-detector.js';
export { PhiPatternDetector } from './detect/phi-pattern-detector.js';
export { RiskClassifier } from './detect/risk-classifier.js';
export { TransparencyDetector } from './detect/transparency-detector.js';
export { DataFlowDetector } from './detect/data-flow-detector.js';

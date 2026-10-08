/**
 * The Forge — Type Definitions
 *
 * Types for the bulk regulatory document ingestion pipeline.
 * Covers harvesting, PVS processing, repair, and the Ledger.
 */

// ─── Harvester Types ─────────────────────────────────────────

export type HarvestStrategy = 'single_page' | 'multi_page' | 'github_repo';

export interface HarvestSource {
  /** URL to the regulation document or GitHub repo directory */
  url: string;
  /** Human-readable name */
  name: string;
  /** Jurisdiction code (e.g., 'EU', 'UK', 'US', 'US_CA') */
  jurisdiction: string;
  /** File type hint — auto-detected if omitted */
  fileType?: 'html' | 'pdf' | 'md';
  /** Strategy hint — auto-detected if omitted */
  strategy?: HarvestStrategy;
  /** CSS selectors for sidebar/nav detection override */
  navSelectors?: string[];
  /** Existing sourceId if this maps to a known regulatory source */
  sourceId?: string;
}

export interface HarvestResult {
  source: HarvestSource;
  status: 'fetched' | 'failed' | 'skipped';
  /** Path where the document was saved (relative to regulations dir) */
  savedPath?: string;
  /** Content hash of the fetched document */
  contentHash?: string;
  /** Number of pages/sections concatenated */
  pageCount?: number;
  /** Word count of the final combined document */
  wordCount?: number;
  /** Why it failed */
  error?: string;
  /** Strategy used */
  strategy?: HarvestStrategy;
  /** Duration in milliseconds */
  durationMs: number;
}

export interface HarvestManifest {
  harvestedAt: string;
  totalSources: number;
  fetched: number;
  failed: number;
  skipped: number;
  results: HarvestResult[];
}

// ─── Document Manifest (per-document metadata.json) ──────────

export interface DocumentManifest {
  sourceId?: string;
  name: string;
  jurisdiction: string;
  url?: string;
  fileType: 'html' | 'pdf' | 'md';
  fetchedAt: string;
  contentHash: string;
  wordCount: number;
  pageCount: number;
  strategy: HarvestStrategy;
}

// ─── Job Queue Types ─────────────────────────────────────────

export type ForgeJobStatus =
  | 'queued'
  | 'processing'
  | 'validating'
  | 'scoring'
  | 'committing'
  | 'completed'
  | 'error'
  | 'repairing'
  | 'unrepairable';

export type ForgeErrorCategory =
  | 'encoding'
  | 'parse_failure'
  | 'empty_extraction'
  | 'llm_error'
  | 'quality_rejected'
  | 'unknown';

export interface ForgeJob {
  id: string;
  documentPath: string;
  jurisdiction: string;
  sourceName: string;
  sourceId: string | null;
  status: ForgeJobStatus;
  attempt: number;
  maxAttempts: number;
  errorMessage: string | null;
  errorCategory: ForgeErrorCategory | null;
  repairStrategy: string | null;
  contentHash: string;
  fileType: 'html' | 'pdf' | 'md';
  qualityGrade: string | null;
  rulesExtracted: number;
  rulesAccepted: number;
  rulesRejected: number;
  rulesDuplicate: number;
  rulesFlagged: number;
  llmTokensIn: number;
  llmTokensOut: number;
  llmCostCents: number;
  durationMs: number;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

// ─── Pre-Commit Analyzer Types ───────────────────────────────

export interface AnalyzerRule {
  ruleKey: string;
  jurisdiction: string;
  category: string;
  conditions: Record<string, string>;
  effect: string;
  severity: string;
  humanSummary: string;
  legalReference: string;
  effectiveDate: string;
  expiresAt: string | null;
  industries: string[];
  industryScope: string;
  industryNotes: string;
}

export interface CommitDecision {
  approved: AnalyzerRule[];
  duplicates: AnalyzerRule[];
  flagged: AnalyzerRule[];
  rejected: AnalyzerRule[];
  stats: {
    total: number;
    approved: number;
    duplicates: number;
    flagged: number;
    rejected: number;
  };
}

// ─── Repair Agent Types ──────────────────────────────────────

export interface RepairAttempt {
  strategy: string;
  success: boolean;
  message: string;
  durationMs: number;
}

export interface RepairResult {
  jobId: string;
  repaired: boolean;
  attempts: RepairAttempt[];
  finalStrategy: string | null;
}

// ─── Forge Orchestrator Types ────────────────────────────────

export type ForgeState = 'idle' | 'harvesting' | 'processing' | 'stopping' | 'stopped';

export interface ForgeStatus {
  state: ForgeState;
  startedAt: string | null;
  jobsTotal: number;
  jobsCompleted: number;
  jobsProcessing: number;
  jobsError: number;
  jobsUnrepairable: number;
  jobsQueued: number;
  totalRulesCreated: number;
  totalLlmCostCents: number;
  elapsedMs: number;
}

export interface ForgeProgress {
  jobId: string;
  documentName: string;
  jurisdiction: string;
  phase: 'parse' | 'validate' | 'score' | 'analyze' | 'commit' | 'repair' | 'error';
  detail?: string;
  percentComplete?: number;
}

// ─── Ledger Types ────────────────────────────────────────────

export type LedgerStatus = 'verified' | 'flagged' | 'rejected';

export interface LedgerEntry {
  id: string;
  forgeJobId: string;
  documentHash: string;
  documentName: string;
  jurisdiction: string;
  sourceUrl: string | null;
  fileType: 'html' | 'pdf' | 'md';
  status: LedgerStatus;
  qualityGrade: string;
  rulesExtracted: number;
  rulesAccepted: number;
  rulesRejected: number;
  processingChain: string[];
  llmCostCents: number;
  durationMs: number;
  sourceId: string | null;
  signature: string;
  isPublished: boolean;
  verifiedAt: string;
}

/** Public ledger view — limited fields */
export interface LedgerPublicEntry {
  documentName: string;
  jurisdiction: string;
  status: LedgerStatus;
  rulesAccepted: number;
  verifiedAt: string;
}

/** Detailed ledger view — admin only */
export interface LedgerDetailEntry extends LedgerPublicEntry {
  documentHash: string;
  fileType: string;
  qualityGrade: string;
  rulesExtracted: number;
  rulesRejected: number;
  processingChain: string[];
  llmCostCents: number;
  durationMs: number;
  signature: string;
}

// ─── Navigation Detection Types ──────────────────────────────

export interface DetectedNavLink {
  /** Link text */
  text: string;
  /** Resolved absolute URL */
  href: string;
  /** Whether this is an anchor on the same page */
  isAnchor: boolean;
  /** Order in which it appeared */
  order: number;
}

export interface NavDetectionResult {
  /** Strategy determined */
  strategy: HarvestStrategy;
  /** Links found in the navigation structure */
  links: DetectedNavLink[];
  /** CSS selector that matched the nav container */
  matchedSelector?: string;
  /** Whether all content is on a single page */
  isSinglePage: boolean;
}

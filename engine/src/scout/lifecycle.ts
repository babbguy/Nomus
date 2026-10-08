/**
 * Scout v2 — Legislative Lifecycle Model
 *
 * 23-stage taxonomy for tracking bills through the legislative process.
 * Supports jurisdiction-specific stage mappings (US-FED, EU, UK).
 */

// ─── Phases ────────────────────────────────────────────────────

export const PHASES = [
  'pre_legislative',
  'drafting',
  'committee',
  'floor',
  'second_chamber',
  'executive',
  'implementation',
  'terminal',
] as const;

export type Phase = (typeof PHASES)[number];

// ─── Stage Definitions ─────────────────────────────────────────

export const LIFECYCLE_STAGES = [
  // Pre-Legislative (0-10)
  { id: 'rumor', label: 'Rumor / Discussion', progress: 5, phase: 'pre_legislative' },
  { id: 'executive_order', label: 'Executive Order', progress: 10, phase: 'pre_legislative' },
  // Drafting (10-20)
  { id: 'draft_circulated', label: 'Draft Circulated', progress: 15, phase: 'drafting' },
  { id: 'introduced', label: 'Introduced / Filed', progress: 20, phase: 'drafting' },
  // Committee (20-45)
  { id: 'committee_referred', label: 'Referred to Committee', progress: 25, phase: 'committee' },
  { id: 'committee_hearing', label: 'Committee Hearing', progress: 30, phase: 'committee' },
  { id: 'committee_markup', label: 'Committee Markup', progress: 35, phase: 'committee' },
  { id: 'committee_passed', label: 'Passed Committee', progress: 45, phase: 'committee' },
  // Floor (45-65)
  { id: 'floor_scheduled', label: 'Floor Vote Scheduled', progress: 50, phase: 'floor' },
  { id: 'floor_debate', label: 'Floor Debate', progress: 55, phase: 'floor' },
  { id: 'floor_vote', label: 'Floor Vote', progress: 60, phase: 'floor' },
  { id: 'passed_origin', label: 'Passed Origin Chamber', progress: 65, phase: 'floor' },
  // Second Chamber (65-80)
  { id: 'second_committee', label: 'Second Chamber Committee', progress: 70, phase: 'second_chamber' },
  { id: 'second_floor', label: 'Second Chamber Floor', progress: 75, phase: 'second_chamber' },
  { id: 'passed_second', label: 'Passed Second Chamber', progress: 78, phase: 'second_chamber' },
  { id: 'conference', label: 'Conference Committee', progress: 80, phase: 'second_chamber' },
  // Executive (80-95)
  { id: 'sent_to_executive', label: 'Sent to Executive', progress: 82, phase: 'executive' },
  { id: 'executive_review', label: 'Executive Review', progress: 85, phase: 'executive' },
  { id: 'signed', label: 'Signed into Law', progress: 95, phase: 'executive' },
  { id: 'vetoed', label: 'Vetoed', progress: 85, phase: 'executive' },
  { id: 'veto_override', label: 'Veto Override', progress: 95, phase: 'executive' },
  // Implementation (95-100)
  { id: 'awaiting_effective', label: 'Awaiting Effective Date', progress: 97, phase: 'implementation' },
  { id: 'in_force', label: 'In Force', progress: 100, phase: 'implementation' },
  // Terminal
  { id: 'repealed', label: 'Repealed', progress: 0, phase: 'terminal' },
  { id: 'died', label: 'Died / Failed', progress: 0, phase: 'terminal' },
  { id: 'stalled', label: 'Stalled', progress: 0, phase: 'terminal' },
] as const;

// ─── Types ─────────────────────────────────────────────────────

export type StageId = (typeof LIFECYCLE_STAGES)[number]['id'];

export interface LifecycleStage {
  readonly id: StageId;
  readonly label: string;
  readonly progress: number;
  readonly phase: Phase;
}

/** All valid stage IDs as a set for fast membership checks. */
const STAGE_IDS = new Set<string>(LIFECYCLE_STAGES.map((s) => s.id));

/** Stage lookup map (O(1) access). */
const STAGE_MAP = new Map<string, LifecycleStage>(
  LIFECYCLE_STAGES.map((s) => [s.id, s]),
);

/** Terminal stage IDs. */
const TERMINAL_IDS = new Set<string>(
  LIFECYCLE_STAGES.filter((s) => s.phase === 'terminal').map((s) => s.id),
);

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Look up a lifecycle stage by ID.
 * Returns undefined if the stage does not exist.
 */
export function getStage(id: string): LifecycleStage | undefined {
  return STAGE_MAP.get(id);
}

/**
 * Get the progress percentage for a stage.
 * Returns 0 if the stage ID is unknown.
 */
export function getProgress(stageId: string): number {
  return STAGE_MAP.get(stageId)?.progress ?? 0;
}

/**
 * Check whether a stage is a terminal state (died, stalled, repealed).
 */
export function isTerminal(stageId: string): boolean {
  return TERMINAL_IDS.has(stageId);
}

/**
 * Validate that a string is a known stage ID.
 */
export function isValidStageId(value: string): value is StageId {
  return STAGE_IDS.has(value);
}

/**
 * Get all stages belonging to a specific phase.
 */
export function getStagesByPhase(phase: Phase): readonly LifecycleStage[] {
  return LIFECYCLE_STAGES.filter((s) => s.phase === phase);
}

// ─── Jurisdiction Stage Mappings ───────────────────────────────

/**
 * Maps jurisdiction-specific procedural labels to our canonical stage IDs.
 * Each jurisdiction uses a subset of the 23-stage model, mapped to local
 * terminology. The key is a human-readable procedure label; the value is
 * the canonical StageId.
 */
export interface JurisdictionMapping {
  readonly jurisdiction: string;
  readonly label: string;
  /** Ordered list of [procedureLabel, canonicalStageId] tuples. */
  readonly stages: ReadonlyArray<readonly [string, StageId]>;
}

/**
 * US Federal (Congress) — uses the full 23-stage model.
 */
export const US_FED_MAPPING: JurisdictionMapping = {
  jurisdiction: 'US-FED',
  label: 'US Federal (Congress)',
  stages: [
    ['Rumor / Discussion', 'rumor'],
    ['Executive Order', 'executive_order'],
    ['Draft Circulated', 'draft_circulated'],
    ['Introduced / Filed', 'introduced'],
    ['Referred to Committee', 'committee_referred'],
    ['Committee Hearing', 'committee_hearing'],
    ['Committee Markup', 'committee_markup'],
    ['Passed Committee', 'committee_passed'],
    ['Floor Vote Scheduled', 'floor_scheduled'],
    ['Floor Debate', 'floor_debate'],
    ['Floor Vote', 'floor_vote'],
    ['Passed Origin Chamber', 'passed_origin'],
    ['Second Chamber Committee', 'second_committee'],
    ['Second Chamber Floor', 'second_floor'],
    ['Passed Second Chamber', 'passed_second'],
    ['Conference Committee', 'conference'],
    ['Sent to Executive', 'sent_to_executive'],
    ['Executive Review', 'executive_review'],
    ['Signed into Law', 'signed'],
    ['Vetoed', 'vetoed'],
    ['Veto Override', 'veto_override'],
    ['Awaiting Effective Date', 'awaiting_effective'],
    ['In Force', 'in_force'],
    ['Repealed', 'repealed'],
    ['Died / Failed', 'died'],
    ['Stalled', 'stalled'],
  ],
};

/**
 * European Union — Ordinary Legislative Procedure (co-decision).
 * Maps EU procedural stages to the nearest canonical stage.
 */
export const EU_MAPPING: JurisdictionMapping = {
  jurisdiction: 'EU',
  label: 'EU Ordinary Legislative Procedure',
  stages: [
    ['Commission Proposal', 'introduced'],
    ['EP Committee Referral', 'committee_referred'],
    ['EP Committee Report', 'committee_passed'],
    ['EP First Reading', 'floor_vote'],
    ['Council Position (First Reading)', 'second_committee'],
    ['EP Second Reading', 'second_floor'],
    ['Conciliation Committee', 'conference'],
    ['EP Third Reading (Joint Text)', 'passed_second'],
    ['Council Adoption', 'signed'],
    ['Published in Official Journal', 'awaiting_effective'],
    ['In Force', 'in_force'],
    ['Withdrawn', 'died'],
    ['Rejected', 'died'],
  ],
};

/**
 * United Kingdom — Parliamentary procedure (Commons + Lords + Royal Assent).
 * Maps UK stages to the nearest canonical stage.
 */
export const UK_MAPPING: JurisdictionMapping = {
  jurisdiction: 'UK',
  label: 'UK Parliamentary Procedure',
  stages: [
    ['First Reading', 'introduced'],
    ['Second Reading', 'committee_referred'],
    ['Committee Stage', 'committee_hearing'],
    ['Report Stage', 'committee_passed'],
    ['Third Reading', 'passed_origin'],
    ['Lords First Reading', 'second_committee'],
    ['Lords Second Reading', 'second_committee'],
    ['Lords Committee Stage', 'second_floor'],
    ['Lords Report Stage', 'second_floor'],
    ['Lords Third Reading', 'passed_second'],
    ['Ping Pong (Consideration of Amendments)', 'conference'],
    ['Royal Assent', 'signed'],
    ['Commenced', 'in_force'],
    ['Withdrawn', 'died'],
  ],
};

/** All jurisdiction mappings indexed by jurisdiction code. */
export const JURISDICTION_MAPPINGS: ReadonlyMap<string, JurisdictionMapping> = new Map([
  ['US-FED', US_FED_MAPPING],
  ['EU', EU_MAPPING],
  ['UK', UK_MAPPING],
]);

/**
 * Get the jurisdiction mapping for a given jurisdiction code.
 * Returns undefined if no mapping exists.
 */
export function getJurisdictionMapping(jurisdiction: string): JurisdictionMapping | undefined {
  return JURISDICTION_MAPPINGS.get(jurisdiction);
}

/**
 * Get the set of canonical stage IDs used by a jurisdiction.
 */
export function getJurisdictionStageIds(jurisdiction: string): ReadonlySet<StageId> {
  const mapping = JURISDICTION_MAPPINGS.get(jurisdiction);
  if (!mapping) return new Set();
  return new Set(mapping.stages.map(([, stageId]) => stageId));
}

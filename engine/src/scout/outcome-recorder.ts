/**
 * Scout Accuracy Ledger: Outcome Recorder
 *
 * Freezes a signed, immutable outcome record for every tracked bill that
 * reaches a terminal legislative outcome, so Nomus's passage-probability
 * predictions can be publicly audited against reality.
 *
 * ── Stage → outcome mapping (verified against src/scout/lifecycle.ts) ──
 *
 *   enacted:  'signed', 'veto_override', 'awaiting_effective', 'in_force',
 *             and 'repealed'. A repealed law WAS enacted — the passage
 *             prediction succeeded; repeal is a later, separate legislative
 *             event and must not be scored as a prediction failure.
 *   failed:   'died' only.
 *   vetoed:   NO outcome (pending). In the lifecycle model 'vetoed' is a
 *             non-terminal executive-phase stage that CAN be followed by
 *             'veto_override'. Freezing 'failed' at veto time could leave a
 *             permanently wrong Ed25519-signed record on the public ledger
 *             if an override later succeeds. A vetoed bill resolves when it transitions to
 *             'veto_override' (enacted), 'died' (failed), or — for US-FED —
 *             when the session-end sweep fails it at biennium adjournment.
 *   stalled:  NOT auto-failed. Although lifecycle.ts places 'stalled' in the
 *             'terminal' phase, a stalled bill can revive within its session.
 *             Stalled bills are only converted to 'failed' by the session-end
 *             job below (US-FED biennium adjournment), never on stage alone.
 *   withdrawn: reserved in the outcome enum for a future dedicated lifecycle
 *             stage. No current canonical stage maps to it (EU/UK "Withdrawn"
 *             procedural labels map to the canonical 'died' stage).
 *
 * ── Session-end scope (documented v1 boundary, not a stub) ──
 *
 *   Only US-FED has automated session-end failure detection: a congressional
 *   biennium ends at noon UTC on January 3 of odd-numbered years (20th
 *   Amendment — computable, no lookup table). Bills in any other jurisdiction
 *   receive outcomes ONLY when their stage transitions to a terminal-mapped
 *   stage; this explicitly includes non-US-FED vetoed and stalled bills,
 *   which remain pending until a terminal transition ('veto_override' or
 *   'died'). Per-jurisdiction session calendars (state sine die, EU/UK
 *   dissolution rules) are a future methodology version.
 *
 * ── Exactly-once guarantee ──
 *
 *   bill_outcomes.bill_id is UNIQUE and inserts use conflict-ignore. After
 *   every insert the row's existence is re-verified: if the insert was
 *   ignored because an outcome already exists that is success (idempotent);
 *   if the row is missing afterwards, or signing fails, this module THROWS —
 *   zero silent failures.
 *
 * ── Stage transitions ──
 *
 *   As of this writing no engine code path updates tracked_bills.current_stage
 *   (verified by grep — passage-score.ts only writes score columns). All
 *   future stage writers MUST go through updateBillStage() below, which is
 *   the canonical transition entry point and invokes the outcome recorder.
 *   As a defensive net, reconcileOutcomes() sweeps for terminal-stage bills
 *   missing an outcome row and runs from the nightly scheduler job.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lte, max } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { billOutcomes, billScoreHistory, billStageHistory, trackedBills } from '../db/schema.js';
import { signData, verifySignature } from '../core/signing.js';
import { canonicalJSON } from '../core/policy-compiler.js';
import { getStage, isValidStageId } from './lifecycle.js';
import { logger } from '../logger.js';

// ─── Constants ─────────────────────────────────────────────────

export const METHODOLOGY_VERSION = 1;

const DAY_MS = 86_400_000;

/** Stages whose entry means the bill's passage succeeded. */
const ENACTED_STAGES: ReadonlySet<string> = new Set([
  'signed',
  'veto_override',
  'awaiting_effective',
  'in_force',
  // A repealed law WAS enacted: passage prediction succeeded. Repeal is a
  // later legislative event, not a passage failure.
  'repealed',
]);

/**
 * Stages whose entry means the bill's passage failed.
 * 'vetoed' is deliberately ABSENT: it is a non-terminal stage that
 * 'veto_override' can follow — see module doc.
 */
const FAILED_STAGES: ReadonlySet<string> = new Set(['died']);

export type BillOutcome = 'enacted' | 'failed' | 'withdrawn';

// ─── Component snapshot schema (validated at the write boundary) ───

export const ComponentSnapshotSchema = z.object({
  /** 6-component breakdown of the score row used for scoreT30, or null when no T30 score exists. */
  componentsT30: z
    .object({
      momentum: z.number().nullable(),
      baseRate: z.number().nullable(),
      sponsorStrength: z.number().nullable(),
      sentiment: z.number().nullable(),
      political: z.number().nullable(),
      opposition: z.number().nullable(),
      computedAt: z.string(),
    })
    .nullable(),
  /** Present (true) only when the outcome was produced by the session-end job. */
  sessionEnd: z.literal(true).optional(),
});

export type ComponentSnapshot = z.infer<typeof ComponentSnapshotSchema>;

// ─── Mapping ───────────────────────────────────────────────────

/**
 * Map a canonical lifecycle stage to a frozen outcome, or null when the
 * stage does not (yet) determine an outcome. 'stalled' and 'vetoed'
 * deliberately map to null — see module doc.
 */
export function mapStageToOutcome(stageId: string): BillOutcome | null {
  if (ENACTED_STAGES.has(stageId)) return 'enacted';
  if (FAILED_STAGES.has(stageId)) return 'failed';
  return null;
}

// ─── Signature payload ─────────────────────────────────────────

interface OutcomeRecord {
  id: string;
  billId: string;
  finalStage: string;
  outcome: BillOutcome;
  outcomeAt: string;
  scoreAtOutcome: number | null;
  scoreT30: number | null;
  scoreT60: number | null;
  scoreT90: number | null;
  peakScore: number | null;
  componentSnapshot: string | null;
  recordedAt: string;
  methodologyVersion: number;
}

/**
 * Canonical signing payload: every stored column except `signature`.
 * componentSnapshot is signed as the exact stored JSON string so a verifier
 * can reproduce the payload directly from the row.
 */
function outcomeSignaturePayload(record: OutcomeRecord): string {
  return canonicalJSON({
    id: record.id,
    billId: record.billId,
    finalStage: record.finalStage,
    outcome: record.outcome,
    outcomeAt: record.outcomeAt,
    scoreAtOutcome: record.scoreAtOutcome,
    scoreT30: record.scoreT30,
    scoreT60: record.scoreT60,
    scoreT90: record.scoreT90,
    peakScore: record.peakScore,
    componentSnapshot: record.componentSnapshot,
    recordedAt: record.recordedAt,
    methodologyVersion: record.methodologyVersion,
  });
}

/**
 * Verify a stored bill_outcomes row against the Ed25519 public key.
 * Reproducible from the row alone.
 */
export function verifyOutcomeSignature(row: typeof billOutcomes.$inferSelect): boolean {
  const payload = outcomeSignaturePayload({
    id: row.id,
    billId: row.billId,
    finalStage: row.finalStage,
    outcome: row.outcome,
    outcomeAt: row.outcomeAt,
    scoreAtOutcome: row.scoreAtOutcome,
    scoreT30: row.scoreT30,
    scoreT60: row.scoreT60,
    scoreT90: row.scoreT90,
    peakScore: row.peakScore,
    componentSnapshot: row.componentSnapshot,
    recordedAt: row.recordedAt,
    methodologyVersion: row.methodologyVersion,
  });
  return verifySignature(payload, row.signature);
}

// ─── Score lookups ─────────────────────────────────────────────

interface ScoresAtOutcome {
  scoreAtOutcome: number | null;
  scoreT30: number | null;
  scoreT60: number | null;
  scoreT90: number | null;
  peakScore: number | null;
  componentsT30: ComponentSnapshot['componentsT30'];
}

/** Latest bill_score_history row computed at-or-before a cutoff, or null. */
function latestScoreRowAtOrBefore(
  db: BetterSQLite3Database<any>,
  billId: string,
  cutoffIso: string,
): typeof billScoreHistory.$inferSelect | null {
  const row = db
    .select()
    .from(billScoreHistory)
    .where(and(eq(billScoreHistory.billId, billId), lte(billScoreHistory.computedAt, cutoffIso)))
    .orderBy(desc(billScoreHistory.computedAt))
    .limit(1)
    .get();
  return row ?? null;
}

/**
 * Compute the frozen score fields for an outcome at `outcomeAt`:
 * scoreAtOutcome and scoreT30/T60/T90 are each the latest score computed
 * at-or-before outcomeAt minus 0/30/60/90 days (null when no history exists
 * before that cutoff); peakScore is the maximum score ever recorded.
 */
function computeScoresAtOutcome(
  db: BetterSQLite3Database<any>,
  billId: string,
  outcomeAtIso: string,
): ScoresAtOutcome {
  const outcomeMs = Date.parse(outcomeAtIso);
  if (Number.isNaN(outcomeMs)) {
    throw new Error(`outcome-recorder: outcomeAt is not a valid ISO-8601 timestamp: ${outcomeAtIso}`);
  }

  const cutoff = (daysBefore: number): string => new Date(outcomeMs - daysBefore * DAY_MS).toISOString();

  const atOutcome = latestScoreRowAtOrBefore(db, billId, cutoff(0));
  const t30 = latestScoreRowAtOrBefore(db, billId, cutoff(30));
  const t60 = latestScoreRowAtOrBefore(db, billId, cutoff(60));
  const t90 = latestScoreRowAtOrBefore(db, billId, cutoff(90));

  const peakRow = db
    .select({ peak: max(billScoreHistory.score) })
    .from(billScoreHistory)
    .where(eq(billScoreHistory.billId, billId))
    .get();

  return {
    scoreAtOutcome: atOutcome?.score ?? null,
    scoreT30: t30?.score ?? null,
    scoreT60: t60?.score ?? null,
    scoreT90: t90?.score ?? null,
    peakScore: peakRow?.peak ?? null,
    componentsT30: t30
      ? {
          momentum: t30.momentum,
          baseRate: t30.baseRate,
          sponsorStrength: t30.sponsorStrength,
          sentiment: t30.sentiment,
          political: t30.political,
          opposition: t30.opposition,
          computedAt: t30.computedAt,
        }
      : null,
  };
}

// ─── Core insert (exactly-once, zero silent failures) ──────────

export interface RecordOutcomeResult {
  /** True when this call inserted the outcome row. */
  recorded: boolean;
  /** True when an outcome row already existed (idempotent success). */
  alreadyExisted: boolean;
  /** The outcome row now in the database (freshly inserted or pre-existing). */
  row: typeof billOutcomes.$inferSelect;
}

/**
 * Build, sign, and insert an outcome row with conflict-ignore on billId,
 * then verify the row exists. Throws on signing failure, on invalid
 * componentSnapshot, and on a missing row after insert. An ignored insert
 * (row already present) is idempotent success.
 */
function insertOutcomeRow(
  db: BetterSQLite3Database<any>,
  params: {
    billId: string;
    finalStage: string;
    outcome: BillOutcome;
    outcomeAt: string;
    scores: ScoresAtOutcome;
    sessionEnd?: boolean;
    nowIso: string;
  },
): RecordOutcomeResult {
  const snapshotObj: ComponentSnapshot = {
    componentsT30: params.scores.componentsT30,
    ...(params.sessionEnd ? { sessionEnd: true as const } : {}),
  };
  // Validate at the boundary — a malformed snapshot must never be signed.
  const parsed = ComponentSnapshotSchema.safeParse(snapshotObj);
  if (!parsed.success) {
    throw new Error(`outcome-recorder: componentSnapshot failed validation: ${parsed.error.message}`);
  }

  const record: OutcomeRecord = {
    id: randomUUID(),
    billId: params.billId,
    finalStage: params.finalStage,
    outcome: params.outcome,
    outcomeAt: params.outcomeAt,
    scoreAtOutcome: params.scores.scoreAtOutcome,
    scoreT30: params.scores.scoreT30,
    scoreT60: params.scores.scoreT60,
    scoreT90: params.scores.scoreT90,
    peakScore: params.scores.peakScore,
    componentSnapshot: JSON.stringify(parsed.data),
    recordedAt: params.nowIso,
    methodologyVersion: METHODOLOGY_VERSION,
  };

  // Signing failure THROWS — an unsigned outcome row must never exist.
  const signature = signData(outcomeSignaturePayload(record));

  db.insert(billOutcomes)
    .values({ ...record, signature })
    .onConflictDoNothing()
    .run();

  // Exactly-once verification: the row MUST exist after the insert, whether
  // we won the race or an earlier recording did.
  const row = db.select().from(billOutcomes).where(eq(billOutcomes.billId, params.billId)).get();
  if (!row) {
    throw new Error(
      `outcome-recorder: bill_outcomes insert for bill ${params.billId} was silently dropped — row missing after conflict-ignore insert`,
    );
  }

  const inserted = row.id === record.id;
  logger.info(
    {
      billId: params.billId,
      outcome: params.outcome,
      finalStage: params.finalStage,
      outcomeAt: params.outcomeAt,
      inserted,
    },
    inserted
      ? 'Accuracy ledger: outcome recorded'
      : 'Accuracy ledger: outcome already recorded (idempotent)',
  );

  return { recorded: inserted, alreadyExisted: !inserted, row };
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Record the outcome for a bill if (and only if) its current stage maps to
 * a terminal outcome. Safe to call repeatedly — exactly-once on billId.
 *
 * outcomeAt resolution order (best available evidence of when the terminal
 * stage was entered): bill_stage_history.entered_at for the current stage →
 * tracked_bills.last_action_date → now.
 *
 * @returns null when the stage is non-terminal (no outcome applicable);
 *          otherwise a RecordOutcomeResult. Throws on unknown billId,
 *          signing failure, or insert verification failure.
 */
export function recordOutcomeIfTerminal(
  billId: string,
  db: BetterSQLite3Database<any> = getDb(),
): RecordOutcomeResult | null {
  const bill = db.select().from(trackedBills).where(eq(trackedBills.id, billId)).get();
  if (!bill) {
    throw new Error(`outcome-recorder: tracked bill not found: ${billId}`);
  }

  const outcome = mapStageToOutcome(bill.currentStage);
  if (outcome === null) return null;

  const nowIso = new Date().toISOString();

  const stageEntry = db
    .select()
    .from(billStageHistory)
    .where(and(eq(billStageHistory.billId, billId), eq(billStageHistory.stage, bill.currentStage)))
    .orderBy(desc(billStageHistory.enteredAt))
    .limit(1)
    .get();

  const outcomeAt = stageEntry?.enteredAt ?? bill.lastActionDate ?? nowIso;
  if (Number.isNaN(Date.parse(outcomeAt))) {
    throw new Error(
      `outcome-recorder: cannot resolve a valid outcomeAt for bill ${billId} (candidate: ${outcomeAt})`,
    );
  }

  const scores = computeScoresAtOutcome(db, billId, outcomeAt);

  return insertOutcomeRow(db, {
    billId,
    finalStage: bill.currentStage,
    outcome,
    outcomeAt,
    scores,
    nowIso,
  });
}

/**
 * Canonical stage-transition entry point. Updates tracked_bills.current_stage
 * and progress, closes the open bill_stage_history row, opens a new one, and
 * then invokes the outcome recorder. ALL future code that moves a bill
 * between lifecycle stages must call this — do not update current_stage
 * directly.
 *
 * The stage write is committed before outcome recording: if recording throws
 * (e.g. signing not initialized) the transition stands and the nightly
 * reconcileOutcomes() sweep re-attempts the outcome.
 */
export function updateBillStage(
  billId: string,
  newStage: string,
  source: string,
  db: BetterSQLite3Database<any> = getDb(),
): RecordOutcomeResult | null {
  if (!isValidStageId(newStage)) {
    throw new Error(`outcome-recorder: unknown lifecycle stage '${newStage}'`);
  }
  const bill = db.select().from(trackedBills).where(eq(trackedBills.id, billId)).get();
  if (!bill) {
    throw new Error(`outcome-recorder: tracked bill not found: ${billId}`);
  }

  const nowIso = new Date().toISOString();

  if (bill.currentStage !== newStage) {
    const stageDef = getStage(newStage);
    db.transaction((tx) => {
      // Close any open stage-history rows for this bill.
      tx.update(billStageHistory)
        .set({ exitedAt: nowIso })
        .where(and(eq(billStageHistory.billId, billId), isNull(billStageHistory.exitedAt)))
        .run();
      tx.insert(billStageHistory)
        .values({ billId, stage: newStage, enteredAt: nowIso, source })
        .run();
      tx.update(trackedBills)
        .set({
          currentStage: newStage,
          progressPercent: stageDef?.progress ?? 0,
          lastActionDate: nowIso,
          updatedAt: nowIso,
        })
        .where(eq(trackedBills.id, billId))
        .run();
    });
    logger.info({ billId, from: bill.currentStage, to: newStage, source }, 'Bill stage transition');
  }

  return recordOutcomeIfTerminal(billId, db);
}

/**
 * Defensive reconciliation sweep: record outcomes for every tracked bill
 * whose current stage maps to a terminal outcome but that has no
 * bill_outcomes row yet (e.g. a stage write that bypassed updateBillStage,
 * or an outcome recording that failed transiently). Runs nightly.
 *
 * @returns number of outcome rows newly recorded.
 */
export function reconcileOutcomes(db: BetterSQLite3Database<any> = getDb()): number {
  const terminalStages = [...ENACTED_STAGES, ...FAILED_STAGES];
  const bills = db
    .select({ id: trackedBills.id })
    .from(trackedBills)
    .where(inArray(trackedBills.currentStage, terminalStages))
    .all();

  let recorded = 0;
  for (const bill of bills) {
    const existing = db
      .select({ id: billOutcomes.id })
      .from(billOutcomes)
      .where(eq(billOutcomes.billId, bill.id))
      .get();
    if (existing) continue;

    const result = recordOutcomeIfTerminal(bill.id, db);
    if (result?.recorded) recorded++;
  }

  if (recorded > 0) {
    logger.info({ recorded }, 'Accuracy ledger: reconciliation sweep recorded missing outcomes');
  }
  return recorded;
}

// ─── Session-end job (US-FED only — documented v1 boundary) ────

/**
 * The most recent US federal biennium boundary at-or-before `now`:
 * noon UTC on January 3 of the most recent odd-numbered year
 * (20th Amendment, Section 1). Fully computable — no lookup table.
 */
export function usFedBienniumEnd(now: Date): Date {
  const year = now.getUTCFullYear();
  for (let y = year; y >= year - 2; y--) {
    if (y % 2 === 1) {
      const boundary = new Date(Date.UTC(y, 0, 3, 12, 0, 0, 0));
      if (boundary.getTime() <= now.getTime()) return boundary;
    }
  }
  // Unreachable: among {year, year-1, year-2} at least one odd-year Jan 3
  // noon lies at-or-before `now` for any date after 1789.
  throw new Error(`outcome-recorder: could not compute biennium end for ${now.toISOString()}`);
}

/**
 * Session-end failure sweep (nightly): US-FED bills that are still in a
 * non-outcome-mapped stage (including 'stalled') and whose last recorded
 * action predates the most recent biennium end died with that Congress.
 * Records outcome 'failed' with finalStage 'died', outcomeAt = the biennium
 * boundary, and a `sessionEnd: true` marker in the componentSnapshot, then
 * transitions the bill's stage to 'died'.
 *
 * Non-US-FED jurisdictions are untouched: their outcomes are recorded only
 * on terminal stage transitions (documented v1 scope boundary — see module
 * doc), because their session calendars are not yet modeled.
 *
 * @returns number of bills marked failed.
 */
export function recordSessionEndFailures(
  db: BetterSQLite3Database<any> = getDb(),
  nowIso: string = new Date().toISOString(),
): number {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) {
    throw new Error(`outcome-recorder: invalid nowIso passed to recordSessionEndFailures: ${nowIso}`);
  }
  const boundary = usFedBienniumEnd(now);
  const boundaryIso = boundary.toISOString();

  const bills = db.select().from(trackedBills).where(eq(trackedBills.jurisdiction, 'US-FED')).all();

  let failed = 0;
  for (const bill of bills) {
    // Bills already in an outcome-mapped stage are handled by the recorder /
    // reconciliation sweep, not the session-end rule.
    if (mapStageToOutcome(bill.currentStage) !== null) continue;

    if (!bill.lastActionDate) continue; // no action evidence — cannot attribute to a session
    const lastActionMs = Date.parse(bill.lastActionDate);
    if (Number.isNaN(lastActionMs)) {
      logger.warn(
        { billId: bill.id, lastActionDate: bill.lastActionDate },
        'Accuracy ledger: unparseable last_action_date — skipping session-end evaluation',
      );
      continue;
    }
    if (lastActionMs >= boundary.getTime()) continue; // active in the current biennium

    // Idempotency: skip bills that somehow already carry an outcome.
    const existing = db
      .select({ id: billOutcomes.id })
      .from(billOutcomes)
      .where(eq(billOutcomes.billId, bill.id))
      .get();
    if (existing) continue;

    // Freeze the outcome FIRST (with the sessionEnd marker and the boundary
    // as outcomeAt), then transition the stage; the transition's own
    // recorder call becomes an idempotent no-op.
    const scores = computeScoresAtOutcome(db, bill.id, boundaryIso);
    const result = insertOutcomeRow(db, {
      billId: bill.id,
      finalStage: 'died',
      outcome: 'failed',
      outcomeAt: boundaryIso,
      scores,
      sessionEnd: true,
      nowIso,
    });
    updateBillStage(bill.id, 'died', 'session_end', db);
    if (result.recorded) failed++;
  }

  if (failed > 0) {
    logger.info({ failed, boundary: boundaryIso }, 'Accuracy ledger: session-end sweep marked US-FED bills failed');
  }
  return failed;
}

/**
 * Human management of policy rules: create, edit, retire, reactivate, and the
 * source-deactivation cascade.
 *
 * Every write goes through `signRule` (core/rule-signing.ts), so a rule changed
 * here verifies in the integrity check exactly like one written by the
 * extraction pipeline. Every content change bumps the version, records a
 * `policy_events` row, invalidates the policy bundle cache and notifies SSE
 * subscribers. A rule written here is `locked`: extraction never overwrites it.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { CreateRuleInput, UpdateRuleInput } from '@nomus/shared';
import { getDb } from '../db/client.js';
import { policyEvents, policyRules, regulatorySources } from '../db/schema.js';
import { signRule, verifyRuleSignature } from './rule-signing.js';
import { sameJson } from './json-equal.js';
import { policyBundleCache } from './policy-cache.js';
import { broadcastEvent } from '../sse/manager.js';
import { logger } from '../logger.js';

type Db = ReturnType<typeof getDb>;
/** A database handle or an open transaction. */
export type DbHandle = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>;
export type RuleRow = typeof policyRules.$inferSelect;

export const SOURCE_DEACTIVATED_REASON = 'source_deactivated';

export class RuleManagementError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RuleManagementError';
  }
}

/** A policy event that was written and still has to be published after commit. */
export interface PendingRuleEvent {
  sequence: number;
  eventType: 'policy.created' | 'policy.updated' | 'policy.revoked';
  jurisdiction: string;
  payload: Record<string, unknown>;
}

export interface RuleChangeResult {
  rule: RuleRow;
  /** False when the request changed nothing (idempotent no-op). */
  changed: boolean;
}

function parseConditions(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function nextSequence(h: DbHandle): number {
  const last = h.select({ sequence: policyEvents.sequence })
    .from(policyEvents)
    .orderBy(desc(policyEvents.sequence))
    .limit(1)
    .get();
  return (last?.sequence ?? 0) + 1;
}

function eventPayload(rule: RuleRow, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ruleKey: rule.ruleKey,
    version: rule.version,
    jurisdiction: rule.jurisdiction,
    category: rule.category,
    conditions: parseConditions(rule.conditions),
    effect: rule.effect,
    severity: rule.severity,
    humanSummary: rule.humanSummary,
    legalReference: rule.legalReference,
    effectiveDate: rule.effectiveDate,
    expiresAt: rule.expiresAt,
    isActive: rule.isActive,
    locked: rule.locked,
    manual: true,
    ...extra,
  };
}

function writeEvent(
  h: DbHandle,
  eventType: PendingRuleEvent['eventType'],
  rule: RuleRow,
  extra: Record<string, unknown>,
  now: string,
): PendingRuleEvent {
  const sequence = nextSequence(h);
  const payload = eventPayload(rule, extra);
  h.insert(policyEvents).values({
    id: randomUUID(),
    eventType,
    ruleId: rule.id,
    payload: JSON.stringify(payload),
    payloadSignature: rule.signature,
    sequence,
    createdAt: now,
  }).run();
  return { sequence, eventType, jurisdiction: rule.jurisdiction, payload };
}

/**
 * Make committed rule changes visible to everything that serves policies:
 * drop the cached bundles and tell SSE subscribers. Call after the transaction
 * that wrote `events` has committed.
 */
export function publishRuleEvents(events: PendingRuleEvent[]): void {
  if (events.length === 0) return;
  policyBundleCache.invalidate();
  for (const e of events) {
    try {
      broadcastEvent({
        id: String(e.sequence),
        type: e.eventType,
        data: e.payload,
        jurisdiction: e.jurisdiction,
      });
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Failed to broadcast rule event');
    }
  }
}

function getRuleOrThrow(h: DbHandle, id: string): RuleRow {
  const rule = h.select().from(policyRules).where(eq(policyRules.id, id)).get();
  if (!rule) throw new RuleManagementError(404, 'Rule not found');
  return rule;
}

function signatureVerifies(rule: RuleRow): boolean {
  try {
    return verifyRuleSignature(rule);
  } catch {
    return false;
  }
}

// --- Create ---------------------------------------------------------

export function createRule(db: Db, input: CreateRuleInput, actor: string): RuleChangeResult {
  const pending: PendingRuleEvent[] = [];
  const rule = db.transaction((tx) => {
    const source = tx.select().from(regulatorySources)
      .where(eq(regulatorySources.id, input.sourceId)).get();
    if (!source) {
      throw new RuleManagementError(400, 'Invalid input', [
        { path: ['sourceId'], message: 'Source not found' },
      ]);
    }
    if (!source.isActive) {
      throw new RuleManagementError(409, 'Source is inactive; reactivate it before adding rules');
    }
    const dup = tx.select({ id: policyRules.id }).from(policyRules)
      .where(eq(policyRules.ruleKey, input.ruleKey)).get();
    if (dup) throw new RuleManagementError(409, `A rule with key "${input.ruleKey}" already exists`);

    const now = new Date().toISOString();
    const jurisdiction = input.jurisdiction ?? source.jurisdiction;
    const signature = signRule({
      ruleKey: input.ruleKey,
      version: 1,
      jurisdiction,
      category: input.category,
      conditions: input.conditions,
      effect: input.effect,
      severity: input.severity,
      humanSummary: input.humanSummary,
      legalReference: input.legalReference,
    });
    const id = randomUUID();
    tx.insert(policyRules).values({
      id,
      sourceId: source.id,
      ruleKey: input.ruleKey,
      version: 1,
      jurisdiction,
      category: input.category,
      conditions: JSON.stringify(input.conditions),
      effect: input.effect,
      severity: input.severity,
      humanSummary: input.humanSummary,
      legalReference: input.legalReference,
      effectiveDate: input.effectiveDate,
      expiresAt: input.expiresAt ?? null,
      industries: JSON.stringify(input.industries),
      industryScope: input.industryScope,
      industryNotes: input.industryNotes,
      isActive: true,
      locked: true,
      signature,
      createdAt: now,
      updatedAt: now,
    }).run();
    const created = getRuleOrThrow(tx, id);
    pending.push(writeEvent(tx, 'policy.created', created, { actor }, now));
    return created;
  });
  publishRuleEvents(pending);
  logger.info({ ruleId: rule.id, ruleKey: rule.ruleKey, actor }, 'Rule created by admin');
  return { rule, changed: true };
}

// --- Update ---------------------------------------------------------

const CONTENT_FIELDS = [
  'jurisdiction', 'category', 'conditions', 'effect', 'severity', 'humanSummary',
  'legalReference', 'effectiveDate', 'expiresAt', 'industries', 'industryScope', 'industryNotes',
] as const;

function storedValue(rule: RuleRow, field: (typeof CONTENT_FIELDS)[number]): unknown {
  if (field === 'conditions') return parseConditions(rule.conditions);
  if (field === 'industries') {
    try { return JSON.parse(rule.industries); } catch { return []; }
  }
  return rule[field];
}

export function updateRule(db: Db, id: string, input: UpdateRuleInput, actor: string): RuleChangeResult {
  const pending: PendingRuleEvent[] = [];
  const result = db.transaction((tx): RuleChangeResult => {
    const current = getRuleOrThrow(tx, id);
    const now = new Date().toISOString();

    const changedFields = CONTENT_FIELDS.filter(
      (f) => input[f] !== undefined && !sameJson(input[f], storedValue(current, f)),
    );

    // Lock-only requests (and no-op edits): no content change, no version bump.
    if (changedFields.length === 0) {
      if (input.locked !== undefined && input.locked !== current.locked) {
        tx.update(policyRules).set({ locked: input.locked, updatedAt: now })
          .where(eq(policyRules.id, id)).run();
        logger.info({ ruleId: id, ruleKey: current.ruleKey, locked: input.locked, actor }, 'Rule lock changed by admin');
        return { rule: getRuleOrThrow(tx, id), changed: true };
      }
      return { rule: current, changed: false };
    }

    if (!signatureVerifies(current)) {
      throw new RuleManagementError(
        409,
        "This rule's stored signature does not verify. Editing would re-sign it and hide the mismatch; investigate the integrity failure first.",
      );
    }

    const merged = {
      jurisdiction: input.jurisdiction ?? current.jurisdiction,
      category: input.category ?? current.category,
      conditions: input.conditions ?? parseConditions(current.conditions),
      effect: input.effect ?? current.effect,
      severity: input.severity ?? current.severity,
      humanSummary: input.humanSummary ?? current.humanSummary,
      legalReference: input.legalReference ?? current.legalReference,
      effectiveDate: input.effectiveDate ?? current.effectiveDate,
      expiresAt: input.expiresAt !== undefined ? input.expiresAt : current.expiresAt,
      industries: input.industries ?? (storedValue(current, 'industries') as string[]),
      industryScope: input.industryScope ?? current.industryScope,
      industryNotes: input.industryNotes ?? current.industryNotes,
    };
    if (merged.expiresAt && Date.parse(merged.expiresAt) <= Date.parse(merged.effectiveDate)) {
      throw new RuleManagementError(400, 'Invalid input', [
        { path: ['expiresAt'], message: 'expiresAt must be after effectiveDate' },
      ]);
    }

    const version = current.version + 1;
    const signature = signRule({
      ruleKey: current.ruleKey,
      version,
      jurisdiction: merged.jurisdiction,
      category: merged.category,
      conditions: merged.conditions,
      effect: merged.effect,
      severity: merged.severity,
      humanSummary: merged.humanSummary,
      legalReference: merged.legalReference,
    });
    tx.update(policyRules).set({
      version,
      jurisdiction: merged.jurisdiction,
      category: merged.category,
      conditions: JSON.stringify(merged.conditions),
      effect: merged.effect,
      severity: merged.severity,
      humanSummary: merged.humanSummary,
      legalReference: merged.legalReference,
      effectiveDate: merged.effectiveDate,
      expiresAt: merged.expiresAt,
      industries: JSON.stringify(merged.industries),
      industryScope: merged.industryScope,
      industryNotes: merged.industryNotes,
      locked: true,
      signature,
      updatedAt: now,
    }).where(eq(policyRules.id, id)).run();

    const updated = getRuleOrThrow(tx, id);
    pending.push(writeEvent(tx, 'policy.updated', updated, {
      actor,
      previousVersion: current.version,
      changedFields,
    }, now));
    return { rule: updated, changed: true };
  });
  publishRuleEvents(pending);
  if (result.changed) {
    logger.info({ ruleId: id, ruleKey: result.rule.ruleKey, version: result.rule.version, actor }, 'Rule updated by admin');
  }
  return result;
}

// --- Retire / reactivate ----------------------------------------------

function setActiveImpl(
  h: DbHandle,
  id: string,
  active: boolean,
  actor: string,
  reason: string,
  pending: PendingRuleEvent[],
): RuleChangeResult {
  const current = getRuleOrThrow(h, id);
  if (current.isActive === active) return { rule: current, changed: false };

  if (active) {
    const source = h.select().from(regulatorySources)
      .where(eq(regulatorySources.id, current.sourceId)).get();
    if (source && !source.isActive) {
      throw new RuleManagementError(409, "The rule's source is inactive; reactivate the source first");
    }
  }

  const now = new Date().toISOString();
  h.update(policyRules).set({ isActive: active, updatedAt: now })
    .where(eq(policyRules.id, id)).run();
  const updated = getRuleOrThrow(h, id);
  pending.push(writeEvent(
    h,
    active ? 'policy.updated' : 'policy.revoked',
    updated,
    active ? { actor, reactivated: true, reason } : { actor, reason },
    now,
  ));
  return { rule: updated, changed: true };
}

export function retireRule(db: Db, id: string, actor: string, reason = 'manual'): RuleChangeResult {
  const pending: PendingRuleEvent[] = [];
  const result = db.transaction((tx) => setActiveImpl(tx, id, false, actor, reason, pending));
  publishRuleEvents(pending);
  if (result.changed) logger.info({ ruleId: id, ruleKey: result.rule.ruleKey, actor, reason }, 'Rule retired');
  return result;
}

export function reactivateRule(db: Db, id: string, actor: string): RuleChangeResult {
  const pending: PendingRuleEvent[] = [];
  const result = db.transaction((tx) => setActiveImpl(tx, id, true, actor, 'manual', pending));
  publishRuleEvents(pending);
  if (result.changed) logger.info({ ruleId: id, ruleKey: result.rule.ruleKey, actor }, 'Rule reactivated');
  return result;
}

// --- Source cascade ------------------------------------------------------

/**
 * Retire every active rule of a source because the source was deactivated.
 * Runs inside the caller's transaction; the caller must pass the returned
 * events to `publishRuleEvents` after commit.
 */
export function retireRulesForSource(
  h: DbHandle,
  sourceId: string,
  actor: string,
): PendingRuleEvent[] {
  const pending: PendingRuleEvent[] = [];
  const active = h.select({ id: policyRules.id }).from(policyRules)
    .where(and(eq(policyRules.sourceId, sourceId), eq(policyRules.isActive, true))).all();
  for (const r of active) {
    setActiveImpl(h, r.id, false, actor, SOURCE_DEACTIVATED_REASON, pending);
  }
  return pending;
}

/**
 * Reactivate exactly the rules that a source deactivation retired: inactive
 * rules whose most recent event is a `policy.revoked` with reason
 * `source_deactivated`. Rules retired by hand (or still awaiting approval)
 * stay inactive. Must be called after the source row is active again.
 */
export function restoreRulesForSource(
  h: DbHandle,
  sourceId: string,
  actor: string,
): PendingRuleEvent[] {
  const pending: PendingRuleEvent[] = [];
  const inactive = h.select({ id: policyRules.id }).from(policyRules)
    .where(and(eq(policyRules.sourceId, sourceId), eq(policyRules.isActive, false))).all();
  for (const r of inactive) {
    // The latest activation-state event decides; plain content edits made
    // while the rule was retired do not count.
    const events = h.select().from(policyEvents)
      .where(eq(policyEvents.ruleId, r.id))
      .orderBy(desc(policyEvents.sequence))
      .all();
    let reason: unknown;
    for (const e of events) {
      let payload: { reason?: unknown; reactivated?: unknown } = {};
      try { payload = JSON.parse(e.payload) as typeof payload; } catch { /* treat as plain event */ }
      if (e.eventType === 'policy.revoked') { reason = payload.reason; break; }
      if (e.eventType === 'policy.updated' && payload.reactivated === true) break;
    }
    if (reason !== SOURCE_DEACTIVATED_REASON) continue;
    setActiveImpl(h, r.id, true, actor, 'source_reactivated', pending);
  }
  return pending;
}

// --- Reads -----------------------------------------------------------------

export interface ListRulesOptions {
  sourceId?: string;
  jurisdiction?: string;
  includeInactive: boolean;
  limit: number;
  offset: number;
}

export function serializeRule(rule: RuleRow) {
  let industries: unknown = ['all'];
  try { industries = JSON.parse(rule.industries); } catch { /* keep default */ }
  return { ...rule, conditions: parseConditions(rule.conditions), industries };
}

export function listRules(db: Db, opts: ListRulesOptions) {
  const filters = [];
  if (opts.sourceId) filters.push(eq(policyRules.sourceId, opts.sourceId));
  if (opts.jurisdiction) filters.push(eq(policyRules.jurisdiction, opts.jurisdiction));
  if (!opts.includeInactive) filters.push(eq(policyRules.isActive, true));
  const where = filters.length > 0 ? and(...filters) : undefined;

  const rows = db.select({ rule: policyRules, sourceName: regulatorySources.name })
    .from(policyRules)
    .leftJoin(regulatorySources, eq(policyRules.sourceId, regulatorySources.id))
    .where(where)
    .orderBy(policyRules.ruleKey)
    .limit(opts.limit)
    .offset(opts.offset)
    .all();
  const total = db.select({ n: sql<number>`count(*)` }).from(policyRules).where(where).get()?.n ?? 0;

  return {
    total,
    rules: rows.map((r) => ({ ...serializeRule(r.rule), sourceName: r.sourceName })),
  };
}

export function getRuleWithHistory(db: Db, id: string) {
  const rule = db.select().from(policyRules).where(eq(policyRules.id, id)).get();
  if (!rule) return null;
  const source = db.select({ name: regulatorySources.name }).from(regulatorySources)
    .where(eq(regulatorySources.id, rule.sourceId)).get();
  const history = db.select().from(policyEvents)
    .where(eq(policyEvents.ruleId, id))
    .orderBy(desc(policyEvents.sequence))
    .all()
    .map((e) => {
      let payload: unknown = null;
      try { payload = JSON.parse(e.payload); } catch { /* leave null */ }
      return {
        id: e.id,
        eventType: e.eventType,
        sequence: e.sequence,
        createdAt: e.createdAt,
        payload,
      };
    });
  return { ...serializeRule(rule), sourceName: source?.name ?? null, history };
}

import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { z } from 'zod';
import { canonicalJSON } from '../../core/policy-compiler.js';
import { cpgAuditEvents } from '../../db/schema-cpg.js';
import { rawSqlite } from '../../db/migrations/runner.js';

/**
 * The per-org, hash-chained CPG audit log (design spec §2.3 T9).
 *
 *   hash = sha256(prev_hash + canonicalJSON({id, org_id, seq, actor, action,
 *                                            target_type, target_id, payload, created_at}))
 *
 * The first event of an org chains from 64 zeros. Rows are append-only
 * (triggers), so a valid chain proves nothing was altered, removed or
 * reordered since it was written. Payloads carry identifiers and metadata
 * only, never source code.
 */

export const GENESIS_HASH = '0'.repeat(64);

/** Payloads are JSON objects; every value must survive canonicalJSON unchanged. */
const auditPayloadSchema = z.record(z.string(), z.unknown());

interface AuditEventInput {
  orgId: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
}

interface AuditEventRow {
  id: string;
  orgId: string;
  seq: number;
  actor: string;
  action: string;
  targetType: string;
  targetId: string | null;
  payload: string;
  prevHash: string;
  hash: string;
  createdAt: string;
}

/** The hash of one event given its predecessor's hash. */
export function computeAuditHash(prevHash: string, e: {
  id: string; orgId: string; seq: number; actor: string; action: string;
  targetType: string; targetId: string | null; payload: unknown; createdAt: string;
}): string {
  const body = canonicalJSON({
    id: e.id,
    org_id: e.orgId,
    seq: e.seq,
    actor: e.actor,
    action: e.action,
    target_type: e.targetType,
    target_id: e.targetId,
    payload: e.payload,
    created_at: e.createdAt,
  });
  return createHash('sha256').update(prevHash + body).digest('hex');
}

/**
 * Append one event to the org's chain. Runs in a (nested-safe) transaction so
 * the seq and prev_hash read and the insert are atomic. Call it inside the
 * same transaction as the change it records.
 */
export function appendAuditEvent(db: Db, input: AuditEventInput): AuditEventRow {
  const payload = auditPayloadSchema.parse(input.payload);
  // Round-trip so the stored text and the hashed value are the same object.
  const payloadText = canonicalJSON(payload);
  const hashedPayload = JSON.parse(payloadText) as unknown;

  return rawSqlite(db).transaction(() => {
    const last = db.select({ seq: cpgAuditEvents.seq, hash: cpgAuditEvents.hash })
      .from(cpgAuditEvents)
      .where(eq(cpgAuditEvents.orgId, input.orgId))
      .orderBy(desc(cpgAuditEvents.seq))
      .limit(1)
      .get();

    const row: AuditEventRow = {
      id: randomUUID(),
      orgId: input.orgId,
      seq: (last?.seq ?? 0) + 1,
      actor: input.actor,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      payload: payloadText,
      prevHash: last?.hash ?? GENESIS_HASH,
      hash: '',
      createdAt: new Date().toISOString(),
    };
    row.hash = computeAuditHash(row.prevHash, { ...row, payload: hashedPayload });
    db.insert(cpgAuditEvents).values(row).run();
    return row;
  })();
}

interface ChainVerification {
  valid: boolean;
  checked: number;
  /** The first seq whose link or hash does not verify, or null. */
  firstInvalidSeq: number | null;
}

/** Re-verify an org's entire chain from genesis. */
export function verifyAuditChain(db: Db, orgId: string): ChainVerification {
  const rows = db.select().from(cpgAuditEvents)
    .where(eq(cpgAuditEvents.orgId, orgId))
    .orderBy(asc(cpgAuditEvents.seq))
    .all();

  let prev = GENESIS_HASH;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let payload: unknown;
    try {
      payload = JSON.parse(r.payload);
    } catch {
      return { valid: false, checked: i, firstInvalidSeq: r.seq };
    }
    const ok = r.seq === i + 1
      && r.prevHash === prev
      && computeAuditHash(prev, { ...r, payload }) === r.hash;
    if (!ok) return { valid: false, checked: i, firstInvalidSeq: r.seq };
    prev = r.hash;
  }
  return { valid: true, checked: rows.length, firstInvalidSeq: null };
}

/** Convenience for tests and the export: the events of one action in an org. */
export function listAuditEventsByAction(db: Db, orgId: string, action: string) {
  return db.select().from(cpgAuditEvents)
    .where(and(eq(cpgAuditEvents.orgId, orgId), eq(cpgAuditEvents.action, action)))
    .orderBy(asc(cpgAuditEvents.seq))
    .all();
}

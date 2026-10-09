/**
 * The CPG audit hash chain (design spec §2.3 T9): per-org chains from a
 * genesis hash, re-verifiable from scratch, and any tampering (edit, delete,
 * reorder, forged insert) is detected. Tampering needs the triggers dropped
 * first, which is exactly what an attacker with raw database access would do.
 */
import { describe, it, expect } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { runMigrations } from '../../db/migrate.js';
import { canonicalJSON } from '../../core/policy-compiler.js';
import { GENESIS_HASH, appendAuditEvent, computeAuditHash, verifyAuditChain } from './log.js';

function setup() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);
  runMigrations(db);
  const orgs = [randomUUID(), randomUUID()];
  const now = new Date().toISOString();
  for (const id of orgs) {
    sqlite.prepare("INSERT INTO organizations (id, name, slug, jurisdiction_access, is_active, created_at, updated_at) VALUES (?, ?, ?, '[]', 1, ?, ?)").run(id, id, id, now, now);
  }
  return { sqlite, db, orgs };
}

function append(db: ReturnType<typeof setup>['db'], orgId: string, n: number) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(appendAuditEvent(db, { orgId, actor: 'user:test', action: 'test.event', targetType: 'test', targetId: `t${i}`, payload: { i, nested: { b: 2, a: 1 } } }));
  }
  return rows;
}

describe('appendAuditEvent', () => {
  it('chains from 64 zeros with seq 1, 2, 3 and the documented hash formula', () => {
    const { db, orgs } = setup();
    const [e1, e2] = append(db, orgs[0], 2);
    expect(e1.seq).toBe(1);
    expect(e1.prevHash).toBe(GENESIS_HASH);
    expect(e2.seq).toBe(2);
    expect(e2.prevHash).toBe(e1.hash);
    const expected = createHash('sha256').update(GENESIS_HASH + canonicalJSON({
      id: e1.id, org_id: e1.orgId, seq: 1, actor: 'user:test', action: 'test.event', target_type: 'test', target_id: 't0',
      payload: { i: 0, nested: { a: 1, b: 2 } }, created_at: e1.createdAt,
    })).digest('hex');
    expect(e1.hash).toBe(expected);
    expect(e1.payload).toBe('{"i":0,"nested":{"a":1,"b":2}}');
    expect(e1.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('keeps one independent chain per org', () => {
    const { db, orgs } = setup();
    // runMigrations seeded both orgs (their first events exist already).
    const a = append(db, orgs[0], 3);
    const b = append(db, orgs[1], 1);
    expect(a[1].seq).toBe(a[0].seq + 1);
    expect(a[2].prevHash).toBe(a[1].hash);
    // Org B's next event links to org B's previous event, never to org A's.
    expect(b[0].prevHash).not.toBe(a[2].hash);
    expect(verifyAuditChain(db, orgs[0])).toMatchObject({ valid: true, firstInvalidSeq: null });
    expect(verifyAuditChain(db, orgs[1])).toMatchObject({ valid: true, firstInvalidSeq: null });
    expect(verifyAuditChain(db, randomUUID())).toEqual({ valid: true, checked: 0, firstInvalidSeq: null });
  });

  it('rejects a non-object payload', () => {
    const { db, orgs } = setup();
    expect(() => appendAuditEvent(db, { orgId: orgs[0], actor: 'a', action: 'b', targetType: 'c', targetId: null, payload: [1, 2] as unknown as Record<string, unknown> })).toThrow();
  });
});

describe('verifyAuditChain detects tampering', () => {
  it('an edited payload', () => {
    const { sqlite, db, orgs } = setup();
    const rows = append(db, orgs[0], 3);
    sqlite.prepare('DROP TRIGGER trg_cpg_audit_events_no_update').run();
    sqlite.prepare("UPDATE cpg_audit_events SET payload = '{\"i\":99}' WHERE id = ?").run(rows[1].id);
    expect(verifyAuditChain(db, orgs[0])).toMatchObject({ valid: false, firstInvalidSeq: rows[1].seq });
  });

  it('an edited actor with a recomputed hash still breaks the next link', () => {
    const { sqlite, db, orgs } = setup();
    const rows = append(db, orgs[0], 3);
    sqlite.prepare('DROP TRIGGER trg_cpg_audit_events_no_update').run();
    const forged = { ...rows[1], actor: 'user:someone-else', payload: JSON.parse(rows[1].payload) };
    const forgedHash = computeAuditHash(rows[1].prevHash, forged);
    sqlite.prepare('UPDATE cpg_audit_events SET actor = ?, hash = ? WHERE id = ?').run(forged.actor, forgedHash, rows[1].id);
    expect(verifyAuditChain(db, orgs[0])).toMatchObject({ valid: false, firstInvalidSeq: rows[2].seq });
  });

  it('a deleted event', () => {
    const { sqlite, db, orgs } = setup();
    const rows = append(db, orgs[0], 3);
    sqlite.prepare('DROP TRIGGER trg_cpg_audit_events_no_delete').run();
    sqlite.prepare('DELETE FROM cpg_audit_events WHERE id = ?').run(rows[1].id);
    expect(verifyAuditChain(db, orgs[0]).valid).toBe(false);
  });

  it('a forged event inserted at the end with a wrong link', () => {
    const { sqlite, db, orgs } = setup();
    const rows = append(db, orgs[0], 2);
    sqlite.prepare(`INSERT INTO cpg_audit_events (id, org_id, seq, actor, action, target_type, target_id, payload, prev_hash, hash, created_at)
      VALUES (?, ?, ?, 'user:x', 'grant.created', 'grant', NULL, '{}', ?, ?, ?)`).run(randomUUID(), orgs[0], rows[1].seq + 1, GENESIS_HASH, 'a'.repeat(64), new Date().toISOString());
    expect(verifyAuditChain(db, orgs[0])).toMatchObject({ valid: false, firstInvalidSeq: rows[1].seq + 1 });
  });

  it('an untouched chain stays valid', () => {
    const { db, orgs } = setup();
    append(db, orgs[0], 5);
    expect(verifyAuditChain(db, orgs[0]).valid).toBe(true);
  });
});

/**
 * Registry sync and source ownership.
 *
 * The sync runs on every engine start (seedDatabase). It must keep built-in
 * sources current, but never touch what an admin added or edited, and never
 * flip isActive except when a built-in disappears from the registry.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { getDb } from './client.js';
import { runMigrations } from './migrate.js';
import { seedDatabase } from './seed.js';
import { policyRules, regulatorySources, policyEvents } from './schema.js';
import { initSigningKeys } from '../core/signing.js';
import { signRule } from '../core/rule-signing.js';
import { REGULATORY_SOURCES } from '../hunter/sources/registry.js';
import { RENAMED_SOURCES, REMOVED_REGISTRY_SOURCES, registryKeyOf } from './source-sync.js';

const REMOVED_NAME = 'US Executive Order 14110 on AI';

function insertSource(overrides: Partial<typeof regulatorySources.$inferInsert> & { name: string }) {
  const now = new Date().toISOString();
  const id = randomUUID();
  getDb().insert(regulatorySources).values({
    id,
    jurisdiction: 'EU',
    url: 'https://example.com/law',
    parserType: 'html',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run();
  return id;
}

function insertRule(sourceId: string, ruleKey: string, isActive = true) {
  const now = new Date().toISOString();
  const rule = {
    ruleKey,
    version: 1,
    jurisdiction: 'EU',
    category: 'transparency',
    conditions: { action: 'sync_test' },
    effect: 'flag' as const,
    severity: 'low' as const,
    humanSummary: 'Synthetic rule used by the sync tests.',
    legalReference: 'Test Act s.1',
  };
  const id = randomUUID();
  getDb().insert(policyRules).values({
    id,
    sourceId,
    ...rule,
    conditions: JSON.stringify(rule.conditions),
    effectiveDate: '2025-01-01',
    isActive,
    signature: signRule(rule),
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

const source = (id: string) => getDb().select().from(regulatorySources).where(eq(regulatorySources.id, id)).get()!;
const rule = (id: string) => getDb().select().from(policyRules).where(eq(policyRules.id, id)).get()!;

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
});

describe('migration', () => {
  it('upgrades a database created before ownership tracking, keeping its rows', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE regulatory_sources (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, jurisdiction TEXT NOT NULL, url TEXT NOT NULL,
        parser_type TEXT NOT NULL, selector_config TEXT NOT NULL DEFAULT '{}',
        scrape_frequency_hours INTEGER NOT NULL DEFAULT 24, is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE policy_rules (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, rule_key TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        jurisdiction TEXT NOT NULL, category TEXT NOT NULL, conditions TEXT NOT NULL, effect TEXT NOT NULL,
        severity TEXT NOT NULL, human_summary TEXT NOT NULL, legal_reference TEXT NOT NULL,
        effective_date TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, signature TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO regulatory_sources VALUES ('s1','Old Source','EU','https://example.com','html','{}',24,1,'2025-01-01','2025-01-01');
      INSERT INTO policy_rules VALUES ('r1','s1','old.rule',1,'EU','privacy','{}','flag','low','x','y','2025-01-01',1,'sig','2025-01-01','2025-01-01');
    `);
    const legacy = drizzle(sqlite);

    runMigrations(legacy);
    runMigrations(legacy); // safe to repeat

    const cols = (table: string) =>
      (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols('regulatory_sources')).toEqual(expect.arrayContaining(['origin', 'registry_key']));
    expect(cols('policy_rules')).toContain('locked');

    const src = sqlite.prepare(`SELECT origin, registry_key FROM regulatory_sources WHERE id='s1'`).get();
    expect(src).toEqual({ origin: null, registry_key: null });
    const r = sqlite.prepare(`SELECT locked FROM policy_rules WHERE id='r1'`).get();
    expect(r).toEqual({ locked: 0 });
    sqlite.close();
  });
});

describe('registry sync', () => {
  it('seeds every registry entry as a built-in with a registry key', () => {
    const rows = getDb().select().from(regulatorySources).all();
    for (const entry of REGULATORY_SOURCES) {
      const row = rows.find((r) => r.name === entry.name);
      expect(row, entry.name).toBeDefined();
      expect(row!.origin).toBe('registry');
      expect(row!.registryKey).toBe(registryKeyOf(entry.name));
    }
  });

  it('keeps a custom source, active, across a second seed', async () => {
    const id = insertSource({ name: 'Acme Internal AI Policy', origin: 'custom', isActive: true, tier: 1 });
    await seedDatabase();
    const row = source(id);
    expect(row.isActive).toBe(true);
    expect(row.origin).toBe('custom');
    expect(row.registryKey).toBeNull();
    expect(row.url).toBe('https://example.com/law');
  });

  it('does not reactivate a built-in that an admin deactivated', async () => {
    const entry = REGULATORY_SOURCES.find((s) => s.ingestionMode === 'auto')!;
    const row = getDb().select().from(regulatorySources).where(eq(regulatorySources.name, entry.name)).get()!;
    getDb().update(regulatorySources).set({ isActive: false }).where(eq(regulatorySources.id, row.id)).run();
    await seedDatabase();
    expect(source(row.id).isActive).toBe(false);
    getDb().update(regulatorySources).set({ isActive: true }).where(eq(regulatorySources.id, row.id)).run();
  });

  it('re-applies registry values to an untouched built-in', async () => {
    const entry = REGULATORY_SOURCES[0];
    const row = getDb().select().from(regulatorySources).where(eq(regulatorySources.name, entry.name)).get()!;
    getDb().update(regulatorySources).set({ url: 'https://drifted.example.com/' }).where(eq(regulatorySources.id, row.id)).run();
    await seedDatabase();
    expect(source(row.id).url).toBe(entry.url);
    expect(source(row.id).origin).toBe('registry');
  });

  it('never modifies a customized built-in', async () => {
    const entry = REGULATORY_SOURCES[1];
    const row = getDb().select().from(regulatorySources).where(eq(regulatorySources.name, entry.name)).get()!;
    getDb().update(regulatorySources)
      .set({ url: 'https://my-mirror.example.com/law', origin: 'customized' })
      .where(eq(regulatorySources.id, row.id)).run();
    await seedDatabase();
    const after = source(row.id);
    expect(after.url).toBe('https://my-mirror.example.com/law');
    expect(after.origin).toBe('customized');
    expect(after.registryKey).toBe(registryKeyOf(entry.name));
    getDb().update(regulatorySources).set({ url: entry.url, origin: 'registry' }).where(eq(regulatorySources.id, row.id)).run();
  });

  it('deactivates only registry-origin rows whose key left the registry, and retires their rules', async () => {
    const gone = insertSource({ name: 'Gone Built-in', origin: 'registry', registryKey: 'gone built-in', isActive: true });
    const goneRule = insertRule(gone, 'sync.gone.rule');
    const customized = insertSource({ name: 'Gone But Customized', origin: 'customized', registryKey: 'gone but customized', isActive: true });
    const customizedRule = insertRule(customized, 'sync.customized.rule');
    const custom = insertSource({ name: 'My Own Source', origin: 'custom', isActive: true });
    const customRule = insertRule(custom, 'sync.custom.rule');

    await seedDatabase();

    expect(source(gone).isActive).toBe(false);
    expect(rule(goneRule).isActive).toBe(false);
    expect(source(customized).isActive).toBe(true);
    expect(rule(customizedRule).isActive).toBe(true);
    expect(source(custom).isActive).toBe(true);
    expect(rule(customRule).isActive).toBe(true);

    // The retirement is recorded so a reactivation can undo exactly it.
    const events = getDb().select().from(policyEvents).where(eq(policyEvents.ruleId, goneRule)).all();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('policy.revoked');
    expect(JSON.parse(events[0].payload).reason).toBe('source_deactivated');

    // Idempotent: a further start changes nothing.
    await seedDatabase();
    expect(getDb().select().from(policyEvents).where(eq(policyEvents.ruleId, goneRule)).all()).toHaveLength(1);
  });

  it('adopts and deactivates a legacy row for the removed EO 14110 entry', async () => {
    expect(REMOVED_REGISTRY_SOURCES).toContain(REMOVED_NAME);
    const id = insertSource({ name: REMOVED_NAME, origin: null, registryKey: null, isActive: true });
    const eoRule = insertRule(id, 'sync.eo14110.rule');

    await seedDatabase();

    const row = source(id);
    expect(row.origin).toBe('registry');
    expect(row.registryKey).toBe(registryKeyOf(REMOVED_NAME));
    expect(row.isActive).toBe(false);
    expect(rule(eoRule).isActive).toBe(false);
  });

  it('renames a legacy row in place so its id and rules survive', async () => {
    const [oldName, newName] = RENAMED_SOURCES[0];
    const current = getDb().select().from(regulatorySources).where(eq(regulatorySources.name, newName)).get()!;
    // Recreate the pre-rename legacy state: old name, no ownership info.
    getDb().update(regulatorySources)
      .set({ name: oldName, origin: null, registryKey: null })
      .where(eq(regulatorySources.id, current.id)).run();
    const attached = insertRule(current.id, 'sync.renamed.rule');

    await seedDatabase();

    const row = source(current.id);
    expect(row.name).toBe(newName);
    expect(row.origin).toBe('registry');
    expect(row.registryKey).toBe(registryKeyOf(newName));
    expect(rule(attached).sourceId).toBe(current.id);
    expect(getDb().select().from(regulatorySources).where(eq(regulatorySources.name, newName)).all()).toHaveLength(1);
  });

  it('keeps the old name of a customized row but follows the registry key on rename', async () => {
    const [oldName, newName] = RENAMED_SOURCES[0];
    const current = getDb().select().from(regulatorySources).where(eq(regulatorySources.name, newName)).get()!;
    getDb().update(regulatorySources)
      .set({ name: `${oldName} (my copy)`, origin: 'customized', registryKey: registryKeyOf(oldName) })
      .where(eq(regulatorySources.id, current.id)).run();

    await seedDatabase();

    const row = source(current.id);
    expect(row.name).toBe(`${oldName} (my copy)`);
    expect(row.origin).toBe('customized');
    expect(row.registryKey).toBe(registryKeyOf(newName));
  });

  it('classifies an unmatched legacy row as custom and leaves isActive alone', async () => {
    const active = insertSource({ name: 'Legacy Active Thing', origin: null, isActive: true });
    const inactive = insertSource({ name: 'Legacy Inactive Thing', origin: null, isActive: false });

    await seedDatabase();

    expect(source(active)).toMatchObject({ origin: 'custom', isActive: true, registryKey: null });
    expect(source(inactive)).toMatchObject({ origin: 'custom', isActive: false, registryKey: null });
  });

  it('does not seed a built-in whose name a custom source already uses', async () => {
    // Simulates a later registry release adding an entry that collides with
    // an admin-added source: the admin's row wins and nothing is merged away.
    const entry = REGULATORY_SOURCES[2];
    const row = getDb().select().from(regulatorySources).where(eq(regulatorySources.name, entry.name)).get()!;
    getDb().update(regulatorySources)
      .set({ origin: 'custom', registryKey: null })
      .where(eq(regulatorySources.id, row.id)).run();

    await seedDatabase();

    const rows = getDb().select().from(regulatorySources).where(eq(regulatorySources.name, entry.name)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe('custom');
  });
});

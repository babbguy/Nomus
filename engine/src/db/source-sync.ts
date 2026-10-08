/**
 * Registry sync and source ownership.
 *
 * `regulatory_sources.origin` records who owns a row:
 *   - 'registry'   a built-in source. Its registry-controlled fields are
 *                  re-applied from hunter/sources/registry.ts on every start.
 *   - 'customized' a built-in source an admin edited. The sync never touches
 *                  it; "restore defaults" returns it to 'registry'.
 *   - 'custom'     a source an admin added. The sync never touches it.
 *   - NULL         a legacy row from before ownership was tracked. The first
 *                  sync classifies it.
 *
 * The sync never changes `is_active` except when a built-in source disappears
 * from the registry, in which case the source and its rules are retired.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { regulatorySources } from './schema.js';
import { REGULATORY_SOURCES, type SourceDefinition } from '../hunter/sources/registry.js';
import { computeProvenanceGrade } from '../core/provenance.js';
import { retireRulesForSource, publishRuleEvents, type PendingRuleEvent } from '../core/rule-management.js';
import { sameJson } from '../core/json-equal.js';
import { logger } from '../logger.js';

type Db = ReturnType<typeof getDb>;
export type SourceRow = typeof regulatorySources.$inferSelect;

/** [previous name, current name] pairs for registry entries that were renamed. */
export const RENAMED_SOURCES: ReadonlyArray<readonly [string, string]> = [
  [
    'California AI Transparency Act (AB 2013)',
    'California Generative AI Training Data Transparency Act (AB 2013)',
  ],
];

/**
 * Built-in sources that were deliberately removed from the registry. Legacy
 * databases may still hold them without an origin; the sync adopts them as
 * built-ins so the normal removal rule deactivates them.
 */
export const REMOVED_REGISTRY_SOURCES: readonly string[] = [
  'US Executive Order 14110 on AI',
];

export function registryKeyOf(name: string): string {
  return name.toLowerCase().trim();
}

export function findRegistryEntry(
  registryKey: string,
  registry: readonly SourceDefinition[] = REGULATORY_SOURCES,
): SourceDefinition | undefined {
  return registry.find((s) => registryKeyOf(s.name) === registryKey);
}

/** The columns the registry controls on a built-in source. */
export function registryFields(source: SourceDefinition) {
  return {
    url: source.url,
    jurisdiction: source.jurisdiction,
    parserType: source.parserType,
    selectorConfig: JSON.stringify(source.selectorConfig),
    tier: source.tier,
    category: source.category ?? 'ai_regulation',
    ingestionMode: source.ingestionMode,
    needsHeadless: source.needsHeadless ?? false,
  };
}

function safeGrade(url: string, parserType: string): string {
  try {
    return computeProvenanceGrade(url, parserType);
  } catch {
    return 'G';
  }
}

/** Recompute the provenance grade for a URL; never throws. */
export function provenanceGradeFor(url: string, parserType: string): string {
  return safeGrade(url, parserType);
}

function sameConfig(a: string, b: string): boolean {
  try {
    return sameJson(JSON.parse(a), JSON.parse(b));
  } catch {
    return a === b;
  }
}

function registryFieldsDiffer(row: SourceRow, source: SourceDefinition): boolean {
  const f = registryFields(source);
  return (
    row.url !== f.url ||
    row.jurisdiction !== f.jurisdiction ||
    row.parserType !== f.parserType ||
    !sameConfig(row.selectorConfig, f.selectorConfig) ||
    row.tier !== f.tier ||
    row.category !== f.category ||
    row.ingestionMode !== f.ingestionMode ||
    row.needsHeadless !== f.needsHeadless
  );
}

export interface SyncSummary {
  inserted: number;
  updated: number;
  deactivated: number;
  adopted: number;
  classifiedCustom: number;
}

/**
 * Reconcile `regulatory_sources` with the built-in registry. Runs on every
 * engine start and is idempotent.
 */
export function syncSources(
  db: Db,
  registry: readonly SourceDefinition[] = REGULATORY_SOURCES,
): SyncSummary {
  const now = new Date().toISOString();
  const summary: SyncSummary = { inserted: 0, updated: 0, deactivated: 0, adopted: 0, classifiedCustom: 0 };
  const registryByKey = new Map(registry.map((s) => [registryKeyOf(s.name), s]));
  const legacyBuiltinKeys = new Set<string>([
    ...registryByKey.keys(),
    ...RENAMED_SOURCES.map(([oldName]) => registryKeyOf(oldName)),
    ...REMOVED_REGISTRY_SOURCES.map(registryKeyOf),
  ]);
  const pendingEvents: PendingRuleEvent[] = [];

  db.transaction((tx) => {
    // 1. Classify legacy rows (no origin yet).
    for (const row of tx.select().from(regulatorySources).all()) {
      if (row.origin) continue;
      const key = registryKeyOf(row.name);
      if (legacyBuiltinKeys.has(key)) {
        tx.update(regulatorySources)
          .set({ origin: 'registry', registryKey: key })
          .where(eq(regulatorySources.id, row.id)).run();
        summary.adopted++;
      } else {
        tx.update(regulatorySources)
          .set({ origin: 'custom' })
          .where(eq(regulatorySources.id, row.id)).run();
        summary.classifiedCustom++;
      }
    }

    // 2. Renamed registry entries: keep the row (rules, snapshots and other
    //    source_id references stay attached) and move its registry_key. Only a
    //    pure built-in row follows the registry's new name.
    for (const [oldName, newName] of RENAMED_SOURCES) {
      const oldKey = registryKeyOf(oldName);
      const newKey = registryKeyOf(newName);
      const rows = tx.select().from(regulatorySources).all();
      const row = rows.find((r) => r.registryKey === oldKey);
      if (!row || rows.some((r) => r.registryKey === newKey)) continue;
      const nameTaken = rows.some((r) => r.id !== row.id && registryKeyOf(r.name) === newKey);
      const set: Partial<SourceRow> = { registryKey: newKey, updatedAt: now };
      if (row.origin === 'registry') {
        if (nameTaken) {
          logger.warn({ oldName, newName }, 'Registry rename skipped: another source already uses the new name');
        } else {
          set.name = newName;
        }
      }
      tx.update(regulatorySources).set(set).where(eq(regulatorySources.id, row.id)).run();
    }

    // 3. Insert missing registry entries; refresh pure built-ins.
    const rows = tx.select().from(regulatorySources).all();
    const byRegistryKey = new Map<string, SourceRow>();
    for (const r of rows) if (r.registryKey) byRegistryKey.set(r.registryKey, r);
    const namesInUse = new Set(rows.map((r) => registryKeyOf(r.name)));

    for (const source of registry) {
      const key = registryKeyOf(source.name);
      const match = byRegistryKey.get(key);

      if (!match) {
        if (namesInUse.has(key)) {
          logger.warn(
            { name: source.name },
            'Built-in source not seeded: a custom source already uses its name',
          );
          continue;
        }
        tx.insert(regulatorySources).values({
          id: randomUUID(),
          name: source.name,
          ...registryFields(source),
          scrapeFrequencyHours: source.scrapeFrequencyHours ?? (source.tier <= 2 ? 168 : 336),
          isActive: source.ingestionMode === 'auto', // auto-scrapeable sources start active
          provenanceGrade: safeGrade(source.url, source.parserType),
          origin: 'registry',
          registryKey: key,
          createdAt: now,
          updatedAt: now,
        }).run();
        summary.inserted++;
        continue;
      }

      if (match.origin === 'registry' && registryFieldsDiffer(match, source)) {
        tx.update(regulatorySources)
          .set({ ...registryFields(source), updatedAt: now })
          .where(eq(regulatorySources.id, match.id)).run();
        summary.updated++;
      }
    }

    // 4. Built-ins no longer in the registry: deactivate and retire their rules.
    //    Customized and custom rows are never touched. Rules are retired even
    //    when the source was already inactive (an earlier version left them
    //    applying).
    for (const row of tx.select().from(regulatorySources).all()) {
      if (row.origin !== 'registry' || !row.registryKey || registryByKey.has(row.registryKey)) continue;
      if (row.isActive) {
        tx.update(regulatorySources)
          .set({ isActive: false, updatedAt: now })
          .where(eq(regulatorySources.id, row.id)).run();
        summary.deactivated++;
        logger.info({ name: row.name }, `Deactivated source removed from registry: ${row.name}`);
      }
      pendingEvents.push(...retireRulesForSource(tx, row.id, 'system:registry-sync'));
    }
  });

  publishRuleEvents(pendingEvents);

  if (summary.inserted || summary.updated || summary.deactivated || summary.adopted || summary.classifiedCustom) {
    logger.info(
      { ...summary, total: registry.length },
      `Registry sync: ${summary.inserted} new, ${summary.updated} updated, ${summary.deactivated} deactivated, ` +
        `${summary.adopted} adopted, ${summary.classifiedCustom} classified custom`,
    );
  }
  return summary;
}

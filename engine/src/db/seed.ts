import { randomUUID, createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { getDb } from './client.js';
import { organizations, apiKeys, regulatorySources, users, policyRules } from './schema.js';
import { signRule, UNSIGNED } from '../core/rule-signing.js';
import { API_KEY_PREFIX_LIVE } from '@nomus/shared';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { syncSources } from './source-sync.js';
import { seedPhase3Rules } from './seed-phase3-rules.js';
import { seedNis2Rules } from './seed-nis2-rules.js';
import { seedDoraRules } from './seed-dora-rules.js';
import { seedFdaRules } from './seed-fda-rules.js';
import { seedCcpaRules } from './seed-ccpa-rules.js';
import { seedFerpaRules } from './seed-ferpa-rules.js';
import { seedGlbaRules } from './seed-glba-rules.js';
import { seedIso27001Rules } from './seed-iso27001-rules.js';
import { seedSoc2Rules } from './seed-soc2-rules.js';
import { seedTrismRules } from './seed-trism-rules.js';
import { seedNistRules } from './seed-nist-rules.js';
import { seedNistCsfRules } from './seed-nist-csf-rules.js';
import { seedClauseMappings } from '../clausemap/dataset.js';

/**
 * First-boot seed: creates admin org, API key, and portal admin user.
 * Safe to run repeatedly — skips if admin org already exists.
 */
export async function seedDatabase(): Promise<void> {
  const db = getDb();

  // Repair duplicate source rows before syncing: a
  // pre-sync seeder inserted the full registry on every boot, leaving 29
  // copies of each source). Idempotent; no-op on healthy databases.
  dedupeSources(db);

  // Reconcile built-in sources with the registry (see db/source-sync.ts):
  // admin-added and admin-edited sources are never touched.
  syncSources(db);

  // Seed Phase 3 detector rules (HIPAA, GDPR, PCI DSS, EU AI Act)
  seedPhase3Rules(db);

  // Seed EU regulatory rules (NIS2 + DORA)
  seedNis2Rules(db);
  seedDoraRules(db);

  // Seed FDA + SaMD rules
  seedFdaRules();

  // Seed remaining regulatory frameworks
  seedCcpaRules(db);
  seedFerpaRules(db);
  seedGlbaRules(db);
  seedIso27001Rules(db);
  seedSoc2Rules(db);
  seedTrismRules(db);
  seedNistRules(db);
  seedNistCsfRules(db);

  // Clause Map dataset (learned weights preserved across reseeds)
  seedClauseMappings(db);

  // Seeders write a placeholder signature; sign those rules now that the
  // signing keys are loaded so the integrity check can verify them.
  signUnsignedRules(db);

  // Check if admin org already exists
  const existing = db.select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, 'nomus-admin'))
    .get();

  if (existing) return;

  const now = new Date().toISOString();
  const orgId = randomUUID();

  // Create admin organization
  db.insert(organizations).values({
    id: orgId,
    name: 'Nomus Admin',
    slug: 'nomus-admin',
    jurisdictionAccess: JSON.stringify([]),
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }).run();

  // Create the bootstrap API key and the first admin user from env. Never
  // derive credentials from an unset or too-short value: in development the
  // engine starts without them, so skip creation and say so instead.
  const config = env();
  const bootstrapKey = config.NOMUS_ADMIN_BOOTSTRAP_KEY;
  if (bootstrapKey.length >= 10) {
    const keyHash = createHash('sha256').update(bootstrapKey).digest('hex');
    db.insert(apiKeys).values({
      id: randomUUID(),
      orgId,
      keyHash,
      keyPrefix: bootstrapKey.slice(0, 12),
      label: 'Bootstrap Admin Key',
      scopes: JSON.stringify(['read:policies', 'stream', 'evaluate', 'admin']),
      rateLimitRpm: config.NOMUS_RATE_LIMIT_RPM,
      isActive: true,
      createdAt: now,
    }).run();
    logger.info(`Admin organization and bootstrap API key created (${bootstrapKey.slice(0, 12)}...)`);
  } else {
    logger.warn('NOMUS_ADMIN_BOOTSTRAP_KEY is not set (min 10 chars); no bootstrap API key was created');
  }

  if (config.NOMUS_ADMIN_PASSWORD.length >= 12) {
    const passwordHash = await bcrypt.hash(config.NOMUS_ADMIN_PASSWORD, 12);
    db.insert(users).values({
      id: randomUUID(),
      orgId,
      email: config.NOMUS_ADMIN_EMAIL.toLowerCase().trim(),
      passwordHash,
      name: 'Platform Admin',
      role: 'platform_admin',
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }).run();
    logger.info(`Admin user created: ${config.NOMUS_ADMIN_EMAIL}`);
  } else {
    logger.warn('NOMUS_ADMIN_PASSWORD is not set (min 12 chars); no admin user was created');
  }

}

// Every table with a source_id FK onto regulatory_sources. Kept as an
// explicit list so the dedupe repointing below can never silently miss one —
// if a new FK is added to the schema, add it here too.
const SOURCE_FK_TABLES = [
  'raw_snapshots',
  'policy_rules',
  'graph_nodes',
  'pipeline_runs',
  'regulatory_signals',
  'source_audit_results',
  'staged_content',
  'forge_jobs',
  'forge_ledger',
  'gatekeeper_logs',
] as const;

/**
 * Collapse duplicate regulatory_sources rows (same normalized name) down to
 * one canonical row per source. The earliest-created row wins; every FK in
 * SOURCE_FK_TABLES is repointed to it before the duplicates are deleted, so
 * no snapshot, rule, or audit row is ever orphaned.
 */
function dedupeSources(db: ReturnType<typeof getDb>): void {
  const rows = db.select({
    id: regulatorySources.id,
    name: regulatorySources.name,
    createdAt: regulatorySources.createdAt,
  }).from(regulatorySources).all();

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.name.toLowerCase().trim();
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  let removed = 0;
  db.transaction((tx) => {
    for (const group of groups.values()) {
      if (group.length < 2) continue;

      // Deterministic canonical pick: earliest created, then lowest id.
      group.sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id.localeCompare(b.id)
          : a.createdAt.localeCompare(b.createdAt),
      );
      const canonical = group[0];
      const dupIds = group.slice(1).map((r) => r.id);
      const idList = sql.join(dupIds.map((id) => sql`${id}`), sql`, `);

      for (const table of SOURCE_FK_TABLES) {
        tx.run(sql`
          UPDATE ${sql.raw(table)}
          SET source_id = ${canonical.id}
          WHERE source_id IN (${idList})
        `);
      }
      tx.run(sql`DELETE FROM regulatory_sources WHERE id IN (${idList})`);
      removed += dupIds.length;
    }
  });

  if (removed > 0) {
    logger.warn({ removed }, `Removed ${removed} duplicate regulatory_sources rows (FKs repointed to canonical rows)`);
  }
}

/**
 * Sign rules that still carry the seeders' placeholder signature. Only the
 * placeholder is replaced: a rule with a real signature that fails
 * verification is left alone so the integrity check still reports it.
 */
function signUnsignedRules(db: ReturnType<typeof getDb>): void {
  const unsigned = db.select().from(policyRules)
    .where(eq(policyRules.signature, UNSIGNED))
    .all();
  if (unsigned.length === 0) return;

  const now = new Date().toISOString();
  db.transaction((tx) => {
    for (const rule of unsigned) {
      tx.update(policyRules)
        .set({ signature: signRule(rule), updatedAt: now })
        .where(eq(policyRules.id, rule.id))
        .run();
    }
  });
  logger.info({ count: unsigned.length }, 'Signed seeded policy rules');
}

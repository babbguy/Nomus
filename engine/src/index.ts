import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { loadEnv } from './config/env.js';
import { getDb, closeDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { initErrorTracking, captureError, flushErrorTracking } from './observability/error-tracking.js';
import { seedDatabase } from './db/seed.js';
import { initSigningKeys } from './core/signing.js';
import { seedRulesFromOntology } from './db/seed-rules.js';
import { seedBenchmarkDefinitions } from './db/seed-benchmarks.js';
import { seedGlbaRules } from './db/seed-glba-rules.js';
import { seedSoc2Rules } from './db/seed-soc2-rules.js';
import { seedNistRules } from './db/seed-nist-rules.js';
import { seedIso27001Rules } from './db/seed-iso27001-rules.js';
import { seedCcpaRules } from './db/seed-ccpa-rules.js';
import { seedFerpaRules } from './db/seed-ferpa-rules.js';
import { seedTrismRules } from './db/seed-trism-rules.js';
import { seedNistCsfRules } from './db/seed-nist-csf-rules.js';
import { startScheduler, stopScheduler } from './hunter/scheduler.js';
import { createApp } from './server/app.js';
import { logger } from './logger.js';

// ─── Load .env file ─────────────────────────────────────────────

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  const envFile = readFileSync(envPath, 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes (single or double)
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// ─── Bootstrap ──────────────────────────────────────────────────

const config = loadEnv();

// Error tracking first, so failures during the rest of bootstrap are captured.
// No-op unless NOMUS_SENTRY_DSN is set.
initErrorTracking();

logger.info({ env: config.NOMUS_ENV }, 'Nomus Engine starting...');

// Initialize database
getDb();
runMigrations();

// Initialize cryptographic signing before seeding — seeded rule sets
// (e.g. NIS2) sign their content, so keys must exist on a fresh database.
const { publicKey } = initSigningKeys();
logger.info({ kid: publicKey.slice(0, 16) + '...' }, 'Signing keys ready');

await seedDatabase();
logger.info('Database initialized');

// Seed rules from ontology (zero LLM cost — only on first boot when no rules exist)
const rulesSeed = seedRulesFromOntology();
if (rulesSeed.created > 0) {
  logger.info({ created: rulesSeed.created }, 'Policy rules seeded from ontology');
}

// Seed GLBA + SOC 2 rules (US finance segment)
{
  const db = getDb();
  const glbaSeed = seedGlbaRules(db);
  if (glbaSeed.created > 0) {
    logger.info({ created: glbaSeed.created }, 'GLBA Safeguards Rule rules seeded');
  }
  const soc2Seed = seedSoc2Rules(db);
  if (soc2Seed.created > 0) {
    logger.info({ created: soc2Seed.created }, 'SOC 2 Trust Service Criteria rules seeded');
  }
}

// Seed enterprise regulatory rules (NIST AI RMF, ISO 27001, CCPA/CPRA)
{
  const db = getDb();
  const nistSeed = seedNistRules(db);
  if (nistSeed.created > 0) {
    logger.info({ created: nistSeed.created }, 'NIST AI RMF rules seeded');
  }
  const isoSeed = seedIso27001Rules(db);
  if (isoSeed.created > 0) {
    logger.info({ created: isoSeed.created }, 'ISO 27001 rules seeded');
  }
  const ccpaSeed = seedCcpaRules(db);
  if (ccpaSeed.created > 0) {
    logger.info({ created: ccpaSeed.created }, 'CCPA/CPRA rules seeded');
  }
}

// Seed COMPL-AI benchmark definitions (Phase 22)
seedBenchmarkDefinitions();

// Seed regulatory framework rules (FERPA, TRiSM, NIST CSF)
{
  const db = getDb();
  const ferpa = seedFerpaRules(db);
  const trism = seedTrismRules(db);
  const nistCsf = seedNistCsfRules(db);
  const totalCreated = ferpa.created + trism.created + nistCsf.created;
  if (totalCreated > 0) {
    logger.info({ ferpa: ferpa.created, trism: trism.created, nistCsf: nistCsf.created },
      'Regulatory framework rules seeded');
  }
}

// Create and start server
const app = createApp();

const server = serve({
  fetch: app.fetch,
  port: config.NOMUS_PORT,
}, (info) => {
  logger.info(`Nomus Engine running on http://localhost:${info.port}`);
  logger.info(`Environment: ${config.NOMUS_ENV}`);
});

// Start scheduled jobs
startScheduler();

// Recover stale Forge jobs from previous crash (if any)
try {
  const { recoverStaleJobs } = await import('./forge/queue.js');
  const recovered = recoverStaleJobs();
  if (recovered > 0) {
    logger.info({ recovered }, 'Recovered stale Forge jobs');
  }
} catch {
  // Forge tables may not exist yet on first boot — safe to ignore
}

// ─── Graceful Shutdown ──────────────────────────────────────────

function shutdown() {
  logger.info('Shutting down...');
  stopScheduler();
  closeDb();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
  captureError(reason, { subsystem: 'process', context: { kind: 'unhandledRejection' } });
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception — shutting down');
  captureError(err, { subsystem: 'process', context: { kind: 'uncaughtException' } });
  void flushErrorTracking().finally(shutdown);
});

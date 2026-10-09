import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getDb } from './client.js';
import { logger } from '../logger.js';
import * as schema from './schema.js';
import { runCpgMigrations } from './migrations/runner.js';
import { seedCpgRbac } from '../cpg/rbac/seed.js';

/** All tables in dependency order (foreign keys respected). */
function migratedTables() {
  return [
    schema.organizations,
    schema.apiKeys,
    schema.usageRecords,
    schema.users,
    schema.sessions,
    schema.passwordResetTokens,
    schema.regulatorySources,
    schema.rawSnapshots,
    schema.policyRules,
    schema.graphNodes,
    schema.graphEdges,
    schema.attestationReceipts,
    schema.policyFeedback,
    schema.pipelineRuns,
    schema.policyEvents,
    schema.stateHashes,
    schema.shadowTestResults,
    schema.regulatorySignals,
    schema.badgeConfigs,
    schema.ontologyTerms,
    schema.chainAnchors,
    schema.scanFindings,
    schema.githubAppInstallations,
    schema.webhookEvents,
    schema.scoutFeeds,
    schema.scoutItems,
    schema.platformSettings,
    // Phase 21-24 tables
    schema.aiBomSystems,
    schema.aiBomSnapshots,
    schema.benchmarkRuns,
    schema.benchmarkDefinitions,
    schema.simulationRuns,
    schema.complianceScores,
    schema.sourceAuditResults,
    // Staged content (pipeline quality gate)
    schema.stagedContent,
    // Forge tables
    schema.forgeJobs,
    schema.forgeLedger,
    // Gatekeeper
    schema.gatekeeperLogs,
    // Ephemeral state (OAuth CSRF, password reset tokens, etc.)
    schema.ephemeralState,
    // Scout v2 — legislative bill tracking
    schema.trackedBills,
    schema.billStageHistory,
    schema.billScoreHistory,
    schema.billSponsors,
    schema.billNews,
    // Scout Accuracy Ledger (bill_outcomes UNIQUE(bill_id) is emitted
    // inline in the CREATE TABLE via the column-level isUnique flag below;
    // separately declared index()/uniqueIndex() entries are created by
    // createDeclaredIndexes() after the tables and column alterations)
    schema.billOutcomes,
    schema.accuracySnapshots,
    // Attestation Reliance Network (FK → attestation_receipts, which
    // is created earlier in this list)
    schema.attestationSubscriptions,
    // Clause Map (clause_matches FK → clause_mappings + organizations)
    schema.clauseMappings,
    schema.clauseMatches,
    schema.clauseLearningEvents,
  ];
}

/**
 * Auto-create all tables on startup using Drizzle schema metadata.
 * Uses CREATE TABLE IF NOT EXISTS — safe to run repeatedly. Every index
 * declared with index()/uniqueIndex() in schema.ts is then created with
 * CREATE [UNIQUE] INDEX IF NOT EXISTS (see createDeclaredIndexes).
 *
 * @param db Optional database handle — tests pass an isolated in-memory DB;
 *           production callers omit it and get the shared connection.
 */
export function runMigrations(db: BetterSQLite3Database<any> = getDb()): void {

  const tables = migratedTables();

  for (const table of tables) {
    const config = getTableConfig(table);
    const cols = config.columns.map((col) => {
      let def = `${col.name} ${getSqliteType(col)}`;
      if (col.primary) def += ' PRIMARY KEY';
      if (col.notNull) def += ' NOT NULL';
      if (col.default !== undefined) {
        const val = typeof col.default === 'string' ? `'${col.default}'`
          : typeof col.default === 'boolean' ? (col.default ? '1' : '0')
          : col.default;
        def += ` DEFAULT ${val}`;
      }
      if (col.isUnique) def += ' UNIQUE';
      return def;
    });

    const stmt = `CREATE TABLE IF NOT EXISTS ${config.name} (${cols.join(', ')})`;
    db.run(sql.raw(stmt));
  }

  // Add new columns to existing tables (safe to run repeatedly)
  const alterations: Array<{ table: string; column: string; type: string }> = [
    { table: 'organizations', column: 'industry', type: 'TEXT' },
    { table: 'organizations', column: 'sub_industry', type: 'TEXT' },
    { table: 'regulatory_sources', column: 'tier', type: 'INTEGER DEFAULT 1' },
    { table: 'regulatory_sources', column: 'category', type: "TEXT DEFAULT 'ai_regulation'" },
    { table: 'regulatory_sources', column: 'provenance_grade', type: "TEXT DEFAULT 'G'" },
    { table: 'regulatory_sources', column: 'sla_max_age_hours', type: 'INTEGER DEFAULT 48' },
    { table: 'regulatory_sources', column: 'sla_min_completeness', type: 'INTEGER DEFAULT 80' },
    { table: 'regulatory_sources', column: 'connectivity_status', type: "TEXT DEFAULT 'unknown'" },
    { table: 'regulatory_sources', column: 'connectivity_checked_at', type: 'TEXT' },
    { table: 'regulatory_sources', column: 'connectivity_error', type: 'TEXT' },
    { table: 'regulatory_sources', column: 'consecutive_failures', type: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'regulatory_sources', column: 'last_successful_scrape_at', type: 'TEXT' },
    { table: 'regulatory_sources', column: 'pending_upload_file', type: 'TEXT' },
    { table: 'regulatory_sources', column: 'pending_upload_hash', type: 'TEXT' },
    { table: 'regulatory_sources', column: 'pending_upload_at', type: 'TEXT' },
    { table: 'regulatory_sources', column: 'ingestion_mode', type: "TEXT NOT NULL DEFAULT 'auto'" },
    // ACCESS-ESCALATION tier: headless-capable flag + terminal manual-upload state
    { table: 'regulatory_sources', column: 'needs_headless', type: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'regulatory_sources', column: 'needs_manual_upload', type: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'regulatory_sources', column: 'manual_upload_reason', type: 'TEXT' },
    { table: 'users', column: 'must_change_password', type: 'INTEGER NOT NULL DEFAULT 0' },
    // Self-healing scraper
    { table: 'regulatory_sources', column: 'last_successful_strategy', type: 'TEXT' },
    { table: 'staged_content', column: 'healing_attempted', type: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'staged_content', column: 'healing_strategy', type: 'TEXT' },
    { table: 'staged_content', column: 'healing_log', type: 'TEXT' },
    // 5-step pipeline: Clean + Verify
    { table: 'staged_content', column: 'cleaned_text', type: 'TEXT' },
    { table: 'staged_content', column: 'verification_passed', type: 'INTEGER' },
    { table: 'staged_content', column: 'verification_issues', type: 'TEXT' },
    { table: 'staged_content', column: 'verification_stats', type: 'TEXT' },
    { table: 'staged_content', column: 'llm_spot_check_used', type: 'INTEGER NOT NULL DEFAULT 0' },
    // Gatekeeper verification status
    { table: 'regulatory_sources', column: 'content_verification', type: 'TEXT' },
    { table: 'regulatory_sources', column: 'content_verification_at', type: 'TEXT' },
    { table: 'regulatory_sources', column: 'content_verification_issues', type: 'TEXT' },
    // Scan findings: detector source + legal reference
    { table: 'scan_findings', column: 'detector_source', type: 'TEXT' },
    { table: 'scan_findings', column: 'legal_reference', type: 'TEXT' },
    // Raw HTTP provenance for source-exact regulatory guarantees
    { table: 'raw_snapshots', column: 'raw_bytes_hash', type: 'TEXT' },
    { table: 'raw_snapshots', column: 'raw_bytes_size', type: 'INTEGER' },
    { table: 'raw_snapshots', column: 'raw_content', type: 'TEXT' },
    { table: 'raw_snapshots', column: 'fetched_url', type: 'TEXT' },
    { table: 'raw_snapshots', column: 'http_status', type: 'INTEGER' },
    { table: 'raw_snapshots', column: 'content_type', type: 'TEXT' },
    { table: 'raw_snapshots', column: 'user_agent', type: 'TEXT' },
    { table: 'staged_content', column: 'raw_bytes_hash', type: 'TEXT' },
    { table: 'staged_content', column: 'raw_bytes_size', type: 'INTEGER' },
    { table: 'staged_content', column: 'raw_content', type: 'TEXT' },
    { table: 'staged_content', column: 'fetched_url', type: 'TEXT' },
    { table: 'staged_content', column: 'http_status', type: 'INTEGER' },
    { table: 'staged_content', column: 'content_type', type: 'TEXT' },
    // Attestation lifecycle columns on existing databases
    { table: 'attestation_receipts', column: 'schema_version', type: 'INTEGER NOT NULL DEFAULT 1' },
    { table: 'attestation_receipts', column: 'expires_at', type: 'TEXT' },
    { table: 'attestation_receipts', column: 'revoked_at', type: 'TEXT' },
    { table: 'attestation_receipts', column: 'revocation_reason', type: 'TEXT' },
    { table: 'attestation_receipts', column: 'superseded_by', type: 'TEXT' },
    { table: 'attestation_receipts', column: 'expiry_notified_at', type: 'TEXT' },
    // Public-verify org display opt-in (private by default)
    { table: 'organizations', column: 'show_org_on_public_verify', type: 'INTEGER NOT NULL DEFAULT 0' },
    // Provenance honesty: mode marker + per-fetch manifest for assembled snapshots.
    // Default is the canonical byte_exact tier (see hunter/provenance.ts).
    { table: 'raw_snapshots', column: 'provenance_mode', type: "TEXT NOT NULL DEFAULT 'byte_exact'" },
    { table: 'raw_snapshots', column: 'provenance_manifest', type: 'TEXT' },
    // Marks snapshots written by a successful promotion so the read path can
    // serve the last known-good version and hold unverified captures.
    { table: 'raw_snapshots', column: 'promoted', type: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'staged_content', column: 'provenance_mode', type: "TEXT NOT NULL DEFAULT 'byte_exact'" },
    { table: 'staged_content', column: 'provenance_manifest', type: 'TEXT' },
    // API-first ingestion (adapter framework): channel marker + official
    // point-in-time coordinate (eCFR date+title/part, FR doc number+pub date,
    // EUR-Lex CELEX version) so every stored regulation cites an official
    // immutable version, not just a fetch timestamp.
    { table: 'raw_snapshots', column: 'ingestion_channel', type: 'TEXT' },
    { table: 'raw_snapshots', column: 'point_in_time_coordinate', type: 'TEXT' },
    { table: 'staged_content', column: 'ingestion_channel', type: 'TEXT' },
    { table: 'staged_content', column: 'point_in_time_coordinate', type: 'TEXT' },
    // Source ownership (built-in vs customized vs custom) and human-edited rules
    { table: 'regulatory_sources', column: 'origin', type: 'TEXT' },
    { table: 'regulatory_sources', column: 'registry_key', type: 'TEXT' },
    { table: 'policy_rules', column: 'locked', type: 'INTEGER NOT NULL DEFAULT 0' },
    // CPG: user-bound API keys (VS Code device sign-in). NULL = org key.
    { table: 'api_keys', column: 'user_id', type: 'TEXT' },
  ];

  for (const alt of alterations) {
    try {
      db.run(sql.raw(`ALTER TABLE ${alt.table} ADD COLUMN ${alt.column} ${alt.type}`));
    } catch {
      // Column already exists — ignore
    }
  }

  // Canonicalize legacy provenance strings to the current model (idempotent).
  // 'raw' → 'byte_exact', 'cache' → 'stale_cache'. Safe to run repeatedly.
  const provenanceRenames: Array<{ table: string; from: string; to: string }> = [
    { table: 'raw_snapshots', from: 'raw', to: 'byte_exact' },
    { table: 'raw_snapshots', from: 'cache', to: 'stale_cache' },
    { table: 'staged_content', from: 'raw', to: 'byte_exact' },
    { table: 'staged_content', from: 'cache', to: 'stale_cache' },
  ];
  for (const r of provenanceRenames) {
    try {
      db.run(sql.raw(
        `UPDATE ${r.table} SET provenance_mode = '${r.to}' WHERE provenance_mode = '${r.from}'`,
      ));
    } catch {
      // Table/column not present yet — ignore
    }
  }

  // Indexes last: they may cover columns added by the alterations above.
  createDeclaredIndexes(db, tables);

  // Corporate Policy Governance: numbered, checksummed raw-SQL migrations
  // (constraints, indexes, triggers), then the RBAC catalog and per-org
  // seeding. Throws on a modified applied migration: never silent drift.
  runCpgMigrations(db);
  seedCpgRbac(db);
}

export interface DeclaredIndex {
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
}

/** Thrown when a UNIQUE index cannot be created because data already violates it. */
export class DuplicateKeysError extends Error {
  constructor(message: string, readonly violations: Array<{ table: string; index: string; keys: string[] }>) {
    super(message);
    this.name = 'DuplicateKeysError';
  }
}

/**
 * Every index declared in the Drizzle schema (index() / uniqueIndex() in a
 * table's extra config), read from the table metadata — there is no second list.
 */
export function listDeclaredIndexes(tables: ReturnType<typeof migratedTables> = migratedTables()): DeclaredIndex[] {
  const out: DeclaredIndex[] = [];
  for (const table of tables) {
    const config = getTableConfig(table);
    for (const idx of config.indexes) {
      const c = idx.config;
      if (c.where) {
        throw new Error(`Index ${c.name} on ${config.name} is partial (WHERE); the migrator does not support partial indexes`);
      }
      const columns = c.columns.map((col) => {
        const name = (col as { name?: unknown }).name;
        if (typeof name !== 'string') {
          throw new Error(`Index ${c.name} on ${config.name} uses an expression column; the migrator supports plain columns only`);
        }
        return name;
      });
      out.push({ table: config.name, name: c.name, unique: !!c.unique, columns });
    }
  }
  return out;
}

/**
 * Create every declared index idempotently. Before any UNIQUE index that does
 * not yet exist is created, existing rows are checked for duplicate keys; if
 * any are found startup fails with an error naming table, index and keys, and
 * no data is touched. Each index creation is logged once at info level.
 */
function createDeclaredIndexes(
  db: BetterSQLite3Database<any>,
  tables: ReturnType<typeof migratedTables>,
): void {
  const existing = new Set(
    (db.all(sql.raw(`SELECT name FROM sqlite_master WHERE type = 'index'`)) as Array<{ name: string }>)
      .map((r) => r.name),
  );
  const pending = listDeclaredIndexes(tables).filter((i) => !existing.has(i.name));

  const violations: Array<{ table: string; index: string; keys: string[] }> = [];
  for (const idx of pending.filter((i) => i.unique)) {
    const cols = idx.columns.join(', ');
    const notNull = idx.columns.map((c) => `${c} IS NOT NULL`).join(' AND ');
    const rows = db.all(sql.raw(
      `SELECT ${cols}, COUNT(*) AS n FROM ${idx.table} WHERE ${notNull} GROUP BY ${cols} HAVING COUNT(*) > 1 ORDER BY ${cols} LIMIT 20`,
    )) as Array<Record<string, unknown>>;
    if (rows.length > 0) {
      violations.push({
        table: idx.table,
        index: idx.name,
        keys: rows.map((r) => `(${idx.columns.map((c) => JSON.stringify(r[c])).join(', ')}) x${r.n}`),
      });
    }
  }
  if (violations.length > 0) {
    const detail = violations
      .map((v) => `table ${v.table}, unique index ${v.index}: duplicated keys ${v.keys.join('; ')}`)
      .join(' | ');
    throw new DuplicateKeysError(
      `Cannot create unique index: existing rows contain duplicate keys. No data was changed; resolve the duplicates and restart. ${detail}`,
      violations,
    );
  }

  for (const idx of pending) {
    db.run(sql.raw(
      `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${idx.name} ON ${idx.table} (${idx.columns.join(', ')})`,
    ));
    logger.info({ table: idx.table, index: idx.name, unique: idx.unique, columns: idx.columns }, 'Created database index');
  }
}

function getSqliteType(col: { dataType: string; columnType: string }): string {
  if (col.dataType === 'string') return 'TEXT';
  if (col.dataType === 'number') return 'INTEGER';
  if (col.dataType === 'boolean') return 'INTEGER';
  if (col.columnType === 'SQLiteReal') return 'REAL';
  return 'TEXT';
}

/**
 * Wipe Regulatory Data — Selective Database Reset
 * ==================================================
 *
 * Wipes all regulatory and operational data from the Nomus DB while
 * preserving identity and auth data. Used to validate that the scraper
 * works from a clean state and that nothing about the OS/cache/state
 * carries forward to taint a fresh ingestion.
 *
 * PRESERVES (identity / auth / settings — customers + their access):
 *   organizations, users, sessions, password_reset_tokens, api_keys,
 *   github_app_installations, platform_settings, state_hashes,
 *   ephemeral_state
 *
 * WIPES (regulatory + scan + scout state):
 *   regulatory_sources, raw_snapshots, staged_content, policy_rules,
 *   policy_events, policy_feedback, pipeline_runs, regulatory_signals,
 *   gatekeeper_logs, source_audit_results, ontology_terms,
 *   graph_nodes, graph_edges, attestation_receipts, chain_anchors,
 *   shadow_test_results, scan_findings, scout_feeds, scout_items,
 *   tracked_bills, bill_stage_history, bill_score_history, bill_sponsors,
 *   bill_news, ai_bom_systems, ai_bom_snapshots, benchmark_runs,
 *   benchmark_definitions, simulation_runs, compliance_scores,
 *   forge_jobs, forge_ledger, badge_configs, webhook_events,
 *   usage_records
 *
 * Run:
 *   npx tsx engine/scripts/wipe-regulatory-data.ts                  # interactive (asks for confirm)
 *   npx tsx engine/scripts/wipe-regulatory-data.ts --yes            # no prompt
 *   npx tsx engine/scripts/wipe-regulatory-data.ts --dry-run        # report only, no writes
 */

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

// Tables to TRUNCATE — anything regulatory, scan-related, or operational logs.
const WIPE_TABLES = [
  // Regulatory ingestion
  'regulatory_sources',
  'raw_snapshots',
  'staged_content',
  'policy_rules',
  'policy_events',
  'policy_feedback',
  'pipeline_runs',
  'regulatory_signals',
  'gatekeeper_logs',
  'source_audit_results',
  // Knowledge graph + ontology + attestation chain
  'ontology_terms',
  'graph_nodes',
  'graph_edges',
  'attestation_receipts',
  'chain_anchors',
  'shadow_test_results',
  // Scanner history
  'scan_findings',
  // Scout legislative tracking
  'scout_feeds',
  'scout_items',
  'tracked_bills',
  'bill_stage_history',
  'bill_score_history',
  'bill_sponsors',
  'bill_news',
  // AI BOM + benchmarks + simulations
  'ai_bom_systems',
  'ai_bom_snapshots',
  'benchmark_runs',
  'benchmark_definitions',
  'simulation_runs',
  'compliance_scores',
  // Forge jobs + ledger
  'forge_jobs',
  'forge_ledger',
  // Misc operational
  'badge_configs',
  'webhook_events',
  'usage_records',
];

// Tables to PRESERVE — identity, auth, settings.
// Listed for documentation only; not touched by the wipe.
const PRESERVE_TABLES = [
  'organizations',
  'users',
  'sessions',
  'password_reset_tokens',
  'api_keys',
  'github_app_installations',
  'platform_settings',
  'state_hashes',
  'ephemeral_state',
];

interface ParsedArgs {
  yes: boolean;
  dryRun: boolean;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  return {
    yes: args.includes('--yes') || args.includes('-y'),
    dryRun: args.includes('--dry-run') || args.includes('--dryrun'),
  };
}

function getRowCount(tableName: string): number {
  const db = getDb();
  try {
    const r = db.all(sql.raw(`SELECT COUNT(*) as c FROM ${tableName}`)) as Array<{ c: number }>;
    return r[0]?.c ?? 0;
  } catch {
    return -1; // table doesn't exist
  }
}

async function main(): Promise<void> {
  const { yes, dryRun } = parseArgs();

  // Ensure schema is in place
  runMigrations();

  console.log('\n\x1b[1mNomus Regulatory Data Wipe\x1b[0m');
  console.log(dryRun ? '  Mode: DRY RUN (no writes)' : '  Mode: \x1b[31mLIVE\x1b[0m');
  console.log('');

  // Show preserve summary
  console.log('\x1b[32mPreserved tables (identity / auth):\x1b[0m');
  for (const t of PRESERVE_TABLES) {
    const c = getRowCount(t);
    console.log(`  ${t.padEnd(35, ' ')} ${c >= 0 ? `${c} rows` : '(missing)'}`);
  }

  // Show wipe targets with current counts
  console.log('\n\x1b[33mTables to WIPE:\x1b[0m');
  let totalRows = 0;
  for (const t of WIPE_TABLES) {
    const c = getRowCount(t);
    if (c > 0) totalRows += c;
    console.log(`  ${t.padEnd(35, ' ')} ${c >= 0 ? `${c} rows` : '(missing — skipped)'}`);
  }
  console.log(`\n  Total rows to delete: \x1b[1m${totalRows}\x1b[0m`);

  if (totalRows === 0) {
    console.log('\nNothing to wipe — DB is already clean.');
    closeDb();
    return;
  }

  if (dryRun) {
    console.log('\nDry run — no changes made.');
    closeDb();
    return;
  }

  if (!yes) {
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question(
      '\n\x1b[31mType "WIPE" to confirm deletion: \x1b[0m',
    );
    rl.close();
    if (answer.trim() !== 'WIPE') {
      console.log('Aborted.');
      closeDb();
      process.exit(1);
    }
  }

  // Execute the wipe in a single transaction
  const db = getDb();
  let deleted = 0;
  db.transaction((tx) => {
    // Disable FK enforcement for the wipe so we can delete in any order
    tx.run(sql.raw('PRAGMA foreign_keys = OFF'));
    for (const t of WIPE_TABLES) {
      try {
        tx.run(sql.raw(`DELETE FROM ${t}`));
        deleted++;
      } catch (err) {
        console.warn(`  ! ${t}: ${(err as Error).message}`);
      }
    }
    tx.run(sql.raw('PRAGMA foreign_keys = ON'));
  });

  // VACUUM outside the transaction
  try {
    db.run(sql.raw('VACUUM'));
  } catch {
    // VACUUM can fail if there's an open txn or WAL — non-fatal
  }

  console.log(`\n\x1b[32m✓ Wipe complete\x1b[0m  ${deleted}/${WIPE_TABLES.length} tables truncated`);
  closeDb();
}

main().catch((err) => {
  console.error('Wipe failed:', err);
  process.exit(2);
});

/**
 * Review-case test fixtures: boards and policies (with an active or proposed
 * version 1) written straight to a migrated database. Used only by *.test.ts.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

const NOW = '2026-10-09T12:00:00.000Z';

export function caseFixtures(sqlite: Database.Database) {
  const run = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params);

  function insertBoard(org: string, key: string): string {
    const id = randomUUID();
    run("INSERT INTO cpg_boards (id, org_id, key, name, kind, created_by, created_at) VALUES (?, ?, ?, ?, 'custom', 'test', ?)", id, org, key, key, NOW);
    return id;
  }

  /** A policy whose version 1 has head state `state`, enforced from `enforceFrom`. */
  function insertPolicy(org: string, key: string, tier: string, boards: string[], opts: { state?: 'active' | 'proposed'; enforceFrom?: string } = {}): string {
    const policyId = randomUUID();
    const compileId = randomUUID();
    const versionId = randomUUID();
    const author = `user:${randomUUID()}`;
    const h = 'c'.repeat(64);
    run('INSERT INTO cpg_policies (id, org_id, policy_key, created_by, created_at) VALUES (?, ?, ?, ?, ?)', policyId, org, key, author, NOW);
    run(`INSERT INTO cpg_compile_records (id, org_id, requested_by, input_text, input_hash, examples, prompt_version, status, compiled_rule, compiled_rule_hash, created_at)
         VALUES (?, ?, ?, 'A policy text that is long enough.', ?, '{}', 1, 'compiled', '{}', ?, ?)`, compileId, org, author, h, h, NOW);
    run(`INSERT INTO cpg_policy_versions (id, policy_id, org_id, version, kind, title, plain_text, tier, owning_board_ids, rule, rule_hash, compile_record_id, edited_from_compile, created_by, created_at)
         VALUES (?, ?, ?, 1, 'define', ?, 'text', ?, ?, '{}', ?, ?, 0, ?, ?)`, versionId, policyId, org, `Policy ${key}`, tier, JSON.stringify(boards), h, compileId, author, NOW);
    if (opts.state === 'proposed') {
      run("INSERT INTO cpg_policy_heads (policy_id, org_id, state, pending_version_id, updated_at) VALUES (?, ?, 'proposed', ?, ?)", policyId, org, versionId, NOW);
    } else {
      run(`INSERT INTO cpg_policy_heads (policy_id, org_id, state, active_version_id, active_version, enforce_from, activation_signature, updated_at)
           VALUES (?, ?, 'active', ?, 1, ?, 'sig', ?)`, policyId, org, versionId, opts.enforceFrom ?? NOW, NOW);
    }
    return versionId;
  }

  return { insertBoard, insertPolicy };
}

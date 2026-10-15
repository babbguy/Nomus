import type { Migration } from './runner.js';
import { appendOnlyTriggers, isoCheck, sha256HexCheck, uuidCheck } from './sql-helpers.js';

/**
 * CPG Phase 6: the CI gate (design spec §2.3, migration `cpg_0005_ci`, table
 * T31, §11.2). One row per CI evaluation, with its signed verdict. Append-only;
 * a run is refused on a closed case, so a closure record's CI run ids are as
 * fixed as the rest of the record (§13.3).
 *
 * Applied once by runCpgMigrations and checksummed. NEVER edit this file
 * after it has shipped: add a new numbered migration instead.
 */

const count = (col: string) => `${col} INTEGER NOT NULL CHECK (${col} >= 0)`;

export const cpg0005Ci: Migration = {
  id: 'cpg_0005_ci',
  statements: [
    `CREATE TABLE cpg_ci_runs (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      api_key_id TEXT NOT NULL REFERENCES api_keys(id),
      repo TEXT NOT NULL CHECK (repo = lower(repo) AND length(repo) BETWEEN 3 AND 200),
      branch TEXT NOT NULL CHECK (length(branch) BETWEEN 1 AND 255 AND branch NOT GLOB 'refs/*'),
      pr_number INTEGER NULL CHECK (pr_number IS NULL OR pr_number > 0),
      head_sha TEXT NOT NULL CHECK (length(head_sha) = 40 AND head_sha NOT GLOB '*[^0-9a-f]*'),
      event_name TEXT NOT NULL CHECK (length(event_name) <= 50),
      bundle_hash TEXT NOT NULL CHECK ${sha256HexCheck('bundle_hash')},
      scanned_file_count INTEGER NOT NULL CHECK (scanned_file_count >= 0),
      verdict TEXT NOT NULL CHECK (verdict IN ('pass','fail')),
      ${count('blocking_count')},
      ${count('pending_count')},
      ${count('rejected_count')},
      ${count('approved_count')},
      ${count('excepted_count')},
      ${count('advisory_count')},
      case_id TEXT NULL REFERENCES cpg_cases(id),
      findings TEXT NOT NULL CHECK (json_valid(findings) AND json_type(findings) = 'array'),
      evaluated_at TEXT NOT NULL CHECK ${isoCheck('evaluated_at')},
      signed_payload TEXT NOT NULL CHECK (json_valid(signed_payload)),
      signature TEXT NOT NULL CHECK (length(signature) >= 1),
      CHECK ((verdict = 'fail') = (blocking_count > 0))
    )`,
    'CREATE INDEX ix_cpg_ci_runs_sha ON cpg_ci_runs (org_id, repo, head_sha)',
    'CREATE INDEX ix_cpg_ci_runs_case ON cpg_ci_runs (case_id)',
    `CREATE TRIGGER trg_cpg_ci_runs_same_org BEFORE INSERT ON cpg_ci_runs
      WHEN (SELECT org_id FROM api_keys WHERE id = NEW.api_key_id) IS NOT NEW.org_id
        OR (NEW.case_id IS NOT NULL AND (SELECT org_id FROM cpg_cases WHERE id = NEW.case_id) IS NOT NEW.org_id)
      BEGIN SELECT RAISE(ABORT, 'cpg_ci_runs: the API key and the case must belong to the run org'); END`,
    `CREATE TRIGGER trg_cpg_ci_runs_case_open BEFORE INSERT ON cpg_ci_runs
      WHEN NEW.case_id IS NOT NULL AND (SELECT closed_at FROM cpg_cases WHERE id = NEW.case_id) IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'cpg_ci_runs: the case is closed and immutable'); END`,
    ...appendOnlyTriggers('cpg_ci_runs'),
  ],
};

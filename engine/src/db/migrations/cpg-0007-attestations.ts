import type { Migration } from './runner.js';
import { appendOnlyTriggers, isoCheck, sha256HexCheck } from './sql-helpers.js';

/**
 * CPG Phase 8: attestations (design spec §2.3, migration `cpg_0007_attestations`,
 * tables T36 and T37, §13.4). A signed governance manifest beside an
 * attestation receipt, and one link row per CPG record it lists. The receipt
 * and its signed payload are untouched. Both tables are append-only.
 *
 * Applied once by runCpgMigrations and checksummed. NEVER edit this file
 * after it has shipped: add a new numbered migration instead.
 */

export const cpg0007Attestations: Migration = {
  id: 'cpg_0007_attestations',
  statements: [
    `CREATE TABLE cpg_attestation_manifests (
      attestation_id TEXT PRIMARY KEY REFERENCES attestation_receipts(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      repo TEXT NOT NULL CHECK (repo = lower(repo) AND length(repo) BETWEEN 3 AND 200),
      branch TEXT NULL CHECK (branch IS NULL OR length(branch) BETWEEN 1 AND 255),
      evaluated_at TEXT NOT NULL CHECK ${isoCheck('evaluated_at')},
      bundle_hash TEXT NOT NULL CHECK ${sha256HexCheck('bundle_hash')},
      signed_payload TEXT NOT NULL CHECK (json_valid(signed_payload)),
      signature TEXT NOT NULL CHECK (length(signature) >= 1),
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')}
    )`,
    // A manifest can only describe its attestation, at that attestation's instant.
    `CREATE TRIGGER trg_cpg_attestation_manifests_bound BEFORE INSERT ON cpg_attestation_manifests
      WHEN NEW.evaluated_at IS NOT (SELECT evaluated_at FROM attestation_receipts WHERE id = NEW.attestation_id)
        OR NEW.org_id IS NOT (SELECT org_id FROM attestation_receipts WHERE id = NEW.attestation_id)
      BEGIN SELECT RAISE(ABORT, 'cpg_attestation_manifests: the manifest must match its attestation org and instant'); END`,
    ...appendOnlyTriggers('cpg_attestation_manifests'),
    `CREATE TABLE cpg_attestation_links (
      attestation_id TEXT NOT NULL REFERENCES cpg_attestation_manifests(attestation_id),
      item_type TEXT NOT NULL CHECK (item_type IN ('decision','case_closure','ci_run')),
      item_id TEXT NOT NULL,
      item_signature_sha256 TEXT NOT NULL CHECK ${sha256HexCheck('item_signature_sha256')},
      PRIMARY KEY (attestation_id, item_type, item_id)
    )`,
    ...appendOnlyTriggers('cpg_attestation_links'),
  ],
};

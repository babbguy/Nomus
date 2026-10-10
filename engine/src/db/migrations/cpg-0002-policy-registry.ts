import type { Migration } from './runner.js';
import {
  appendOnlyTriggers,
  boolCheck,
  immutableColumnsTrigger,
  isoCheck,
  isoOrNullCheck,
  noDeleteTrigger,
  sha256HexCheck,
  uuidCheck,
} from './sql-helpers.js';

/**
 * CPG Phase 2: review boards, versioned quorum configuration and the
 * corporate policy registry (design spec §2.3, migration
 * `cpg_0002_policy_registry`, tables T10 to T18).
 *
 * Applied once by runCpgMigrations and checksummed. NEVER edit this file
 * after it has shipped: add a new numbered migration instead.
 */

const actorCheck = (col: string) => `(length(${col}) BETWEEN 1 AND 100)`;
const jsonCheck = (col: string) => `(json_valid(${col}))`;
const jsonOrNullCheck = (col: string) => `(${col} IS NULL OR json_valid(${col}))`;

export const cpg0002PolicyRegistry: Migration = {
  id: 'cpg_0002_policy_registry',
  statements: [
    // ── T10 cpg_boards: projection; name, description and archive columns mutable
    `CREATE TABLE cpg_boards (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      key TEXT NOT NULL CHECK (key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9_-]*' AND length(key) <= 50),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
      kind TEXT NOT NULL CHECK (kind IN ('governance','legal','ai','security','custom')),
      description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
      created_by TEXT NOT NULL CHECK ${actorCheck('created_by')},
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')},
      archived_at TEXT NULL CHECK ${isoOrNullCheck('archived_at')},
      archived_by TEXT NULL,
      CHECK ((archived_at IS NULL) = (archived_by IS NULL))
    )`,
    'CREATE UNIQUE INDEX ux_cpg_boards_org_key ON cpg_boards (org_id, key)',
    immutableColumnsTrigger('cpg_boards', ['id', 'org_id', 'key', 'kind', 'created_by', 'created_at']),
    `CREATE TRIGGER trg_cpg_boards_archive_final BEFORE UPDATE ON cpg_boards
      WHEN OLD.archived_at IS NOT NULL AND (NEW.archived_at IS NOT OLD.archived_at OR NEW.archived_by IS NOT OLD.archived_by)
      BEGIN SELECT RAISE(ABORT, 'cpg_boards: archiving is final'); END`,
    noDeleteTrigger('cpg_boards'),

    // ── T11 cpg_board_members: semi-append-only, removal written once
    `CREATE TABLE cpg_board_members (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      board_id TEXT NOT NULL REFERENCES cpg_boards(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      added_by TEXT NOT NULL CHECK ${actorCheck('added_by')},
      added_at TEXT NOT NULL CHECK ${isoCheck('added_at')},
      removed_at TEXT NULL CHECK ${isoOrNullCheck('removed_at')},
      removed_by TEXT NULL,
      CHECK ((removed_at IS NULL) = (removed_by IS NULL))
    )`,
    'CREATE UNIQUE INDEX ux_cpg_board_members_active ON cpg_board_members (board_id, user_id) WHERE removed_at IS NULL',
    'CREATE INDEX ix_cpg_board_members_user ON cpg_board_members (user_id, removed_at)',
    `CREATE TRIGGER trg_cpg_board_members_same_org BEFORE INSERT ON cpg_board_members
      WHEN (SELECT org_id FROM cpg_boards WHERE id = NEW.board_id) IS NOT NEW.org_id
        OR (SELECT org_id FROM users WHERE id = NEW.user_id) IS NOT NEW.org_id
      BEGIN SELECT RAISE(ABORT, 'cpg_board_members: board and user must belong to the member org'); END`,
    `CREATE TRIGGER trg_cpg_board_members_remove_once BEFORE UPDATE ON cpg_board_members
      WHEN OLD.removed_at IS NOT NULL
        OR NEW.removed_at IS NULL
        OR NEW.id IS NOT OLD.id
        OR NEW.board_id IS NOT OLD.board_id
        OR NEW.org_id IS NOT OLD.org_id
        OR NEW.user_id IS NOT OLD.user_id
        OR NEW.added_by IS NOT OLD.added_by
        OR NEW.added_at IS NOT OLD.added_at
      BEGIN SELECT RAISE(ABORT, 'cpg_board_members: only a single removal may be recorded'); END`,
    noDeleteTrigger('cpg_board_members'),

    // ── T12 cpg_quorum_config_versions: append-only, signed
    `CREATE TABLE cpg_quorum_config_versions (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      version INTEGER NOT NULL CHECK (version >= 1),
      config TEXT NOT NULL CHECK ${jsonCheck('config')},
      config_hash TEXT NOT NULL CHECK ${sha256HexCheck('config_hash')},
      change_note TEXT NOT NULL CHECK (length(change_note) BETWEEN 1 AND 1000),
      created_by TEXT NOT NULL CHECK (created_by GLOB 'user:*' OR (version = 1 AND created_by = 'system:seed')),
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')},
      signature TEXT NOT NULL CHECK (length(signature) >= 1)
    )`,
    'CREATE UNIQUE INDEX ux_cpg_quorum_org_version ON cpg_quorum_config_versions (org_id, version)',
    ...appendOnlyTriggers('cpg_quorum_config_versions'),

    // ── T13 cpg_policies: identity, append-only
    `CREATE TABLE cpg_policies (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      policy_key TEXT NOT NULL CHECK (policy_key GLOB 'corp.[a-z0-9]*' AND policy_key NOT GLOB '*[^a-z0-9._-]*'
        AND length(policy_key) <= 90 AND instr(policy_key, ':') = 0),
      created_by TEXT NOT NULL CHECK (created_by GLOB 'user:*'),
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')},
      origin_case_id TEXT NULL CHECK (origin_case_id IS NULL OR ${uuidCheck('origin_case_id')})
    )`,
    'CREATE UNIQUE INDEX ux_cpg_policies_org_key ON cpg_policies (org_id, policy_key)',
    ...appendOnlyTriggers('cpg_policies'),

    // ── T14 cpg_compile_records: every compile attempt, append-only
    `CREATE TABLE cpg_compile_records (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      policy_id TEXT NULL REFERENCES cpg_policies(id),
      requested_by TEXT NOT NULL CHECK (requested_by GLOB 'user:*'),
      input_text TEXT NOT NULL CHECK (length(input_text) BETWEEN 20 AND 8000),
      input_hash TEXT NOT NULL CHECK ${sha256HexCheck('input_hash')},
      examples TEXT NOT NULL CHECK ${jsonCheck('examples')},
      prompt_version INTEGER NOT NULL CHECK (prompt_version >= 1),
      provider TEXT NULL,
      model TEXT NULL,
      raw_output TEXT NULL CHECK (raw_output IS NULL OR length(raw_output) <= 65536),
      status TEXT NOT NULL CHECK (status IN ('compiled','rejected_unexpressible','rejected_schema','rejected_validation','rejected_examples','llm_error')),
      rejection TEXT NULL CHECK ${jsonOrNullCheck('rejection')},
      suggestion TEXT NULL CHECK ${jsonOrNullCheck('suggestion')},
      compiled_rule TEXT NULL CHECK ${jsonOrNullCheck('compiled_rule')},
      compiled_rule_hash TEXT NULL CHECK (compiled_rule_hash IS NULL OR ${sha256HexCheck('compiled_rule_hash')}),
      example_results TEXT NULL CHECK ${jsonOrNullCheck('example_results')},
      tokens_in INTEGER NULL CHECK (tokens_in IS NULL OR tokens_in >= 0),
      tokens_out INTEGER NULL CHECK (tokens_out IS NULL OR tokens_out >= 0),
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')},
      CHECK ((status = 'compiled') = (compiled_rule IS NOT NULL AND compiled_rule_hash IS NOT NULL)),
      CHECK ((status = 'compiled') = (rejection IS NULL))
    )`,
    'CREATE INDEX ix_cpg_compile_records_org ON cpg_compile_records (org_id, created_at)',
    `CREATE TRIGGER trg_cpg_compile_records_same_org BEFORE INSERT ON cpg_compile_records
      WHEN NEW.policy_id IS NOT NULL AND (SELECT org_id FROM cpg_policies WHERE id = NEW.policy_id) IS NOT NEW.org_id
      BEGIN SELECT RAISE(ABORT, 'cpg_compile_records: the policy must belong to the record org'); END`,
    ...appendOnlyTriggers('cpg_compile_records'),

    // ── T15 cpg_policy_versions: content of each version, append-only
    `CREATE TABLE cpg_policy_versions (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      policy_id TEXT NOT NULL REFERENCES cpg_policies(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      version INTEGER NOT NULL CHECK (version >= 1),
      kind TEXT NOT NULL CHECK (kind IN ('define','retire')),
      title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 120 AND instr(title, char(10)) = 0 AND instr(title, char(13)) = 0),
      plain_text TEXT NOT NULL CHECK (length(plain_text) BETWEEN 1 AND 8000),
      tier TEXT NOT NULL CHECK (tier IN ('advisory','review-required','prohibited')),
      owning_board_ids TEXT NOT NULL CHECK (json_valid(owning_board_ids) AND json_type(owning_board_ids) = 'array' AND json_array_length(owning_board_ids) >= 1),
      rule TEXT NULL CHECK ${jsonOrNullCheck('rule')},
      rule_hash TEXT NULL CHECK (rule_hash IS NULL OR ${sha256HexCheck('rule_hash')}),
      compile_record_id TEXT NULL REFERENCES cpg_compile_records(id),
      edited_from_compile INTEGER NOT NULL CHECK ${boolCheck('edited_from_compile')},
      grace_days INTEGER NULL CHECK (grace_days IS NULL OR grace_days BETWEEN 0 AND 365),
      enforce_from_requested TEXT NULL CHECK ${isoOrNullCheck('enforce_from_requested')},
      created_by TEXT NOT NULL CHECK (created_by GLOB 'user:*'),
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')},
      CHECK ((kind = 'retire') = (rule IS NULL)),
      CHECK ((rule IS NULL) = (rule_hash IS NULL)),
      CHECK (kind = 'retire' OR compile_record_id IS NOT NULL)
    )`,
    'CREATE UNIQUE INDEX ux_cpg_policy_versions_policy_version ON cpg_policy_versions (policy_id, version)',
    'CREATE UNIQUE INDEX ux_cpg_policy_versions_compile ON cpg_policy_versions (compile_record_id) WHERE compile_record_id IS NOT NULL',
    `CREATE TRIGGER trg_cpg_policy_versions_same_org BEFORE INSERT ON cpg_policy_versions
      WHEN (SELECT org_id FROM cpg_policies WHERE id = NEW.policy_id) IS NOT NEW.org_id
        OR (NEW.compile_record_id IS NOT NULL AND (SELECT org_id FROM cpg_compile_records WHERE id = NEW.compile_record_id) IS NOT NEW.org_id)
      BEGIN SELECT RAISE(ABORT, 'cpg_policy_versions: policy and compile record must belong to the version org'); END`,
    ...appendOnlyTriggers('cpg_policy_versions'),

    // ── T16 cpg_policy_version_events: the lifecycle of each version, append-only
    `CREATE TABLE cpg_policy_version_events (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      version_id TEXT NOT NULL REFERENCES cpg_policy_versions(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      event TEXT NOT NULL CHECK (event IN ('proposed','approved','rejected','withdrawn','activated','superseded','retired','expired_proposal')),
      actor TEXT NOT NULL CHECK ${actorCheck('actor')},
      details TEXT NOT NULL CHECK ${jsonCheck('details')},
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')}
    )`,
    'CREATE INDEX ix_cpg_policy_version_events_version ON cpg_policy_version_events (version_id, created_at)',
    `CREATE TRIGGER trg_cpg_policy_version_events_same_org BEFORE INSERT ON cpg_policy_version_events
      WHEN (SELECT org_id FROM cpg_policy_versions WHERE id = NEW.version_id) IS NOT NEW.org_id
      BEGIN SELECT RAISE(ABORT, 'cpg_policy_version_events: the version must belong to the event org'); END`,
    ...appendOnlyTriggers('cpg_policy_version_events'),

    // ── T17 cpg_policy_approvals: votes; four-eyes enforced by the database too
    `CREATE TABLE cpg_policy_approvals (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      version_id TEXT NOT NULL REFERENCES cpg_policy_versions(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      voter_user_id TEXT NOT NULL REFERENCES users(id),
      vote TEXT NOT NULL CHECK (vote IN ('approve','reject')),
      comment TEXT NOT NULL DEFAULT '' CHECK (length(comment) <= 2000),
      quorum_config_version INTEGER NOT NULL CHECK (quorum_config_version >= 1),
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')}
    )`,
    'CREATE UNIQUE INDEX ux_cpg_policy_approvals_voter ON cpg_policy_approvals (version_id, voter_user_id)',
    `CREATE TRIGGER trg_cpg_policy_approvals_four_eyes BEFORE INSERT ON cpg_policy_approvals
      WHEN 'user:' || NEW.voter_user_id = (SELECT created_by FROM cpg_policy_versions WHERE id = NEW.version_id)
        OR 'user:' || NEW.voter_user_id IN (
          SELECT cr.requested_by FROM cpg_compile_records cr
          JOIN cpg_policy_versions v ON v.compile_record_id = cr.id
          WHERE v.id = NEW.version_id)
      BEGIN SELECT RAISE(ABORT, 'cpg_policy_approvals: self-approval is forbidden (the author and the compile requester cannot vote)'); END`,
    `CREATE TRIGGER trg_cpg_policy_approvals_same_org BEFORE INSERT ON cpg_policy_approvals
      WHEN (SELECT org_id FROM cpg_policy_versions WHERE id = NEW.version_id) IS NOT NEW.org_id
        OR (SELECT org_id FROM users WHERE id = NEW.voter_user_id) IS NOT NEW.org_id
      BEGIN SELECT RAISE(ABORT, 'cpg_policy_approvals: version and voter must belong to the vote org'); END`,
    ...appendOnlyTriggers('cpg_policy_approvals'),

    // ── T18 cpg_policy_heads: projection of T15 + T16, one row per policy
    `CREATE TABLE cpg_policy_heads (
      policy_id TEXT PRIMARY KEY REFERENCES cpg_policies(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      state TEXT NOT NULL CHECK (state IN ('draft','proposed','active','retired')),
      active_version_id TEXT NULL REFERENCES cpg_policy_versions(id),
      active_version INTEGER NULL CHECK (active_version IS NULL OR active_version >= 1),
      enforce_from TEXT NULL CHECK ${isoOrNullCheck('enforce_from')},
      activation_signature TEXT NULL,
      pending_version_id TEXT NULL REFERENCES cpg_policy_versions(id),
      updated_at TEXT NOT NULL CHECK ${isoCheck('updated_at')},
      CHECK ((active_version_id IS NULL) = (active_version IS NULL)),
      CHECK (state <> 'active' OR (active_version_id IS NOT NULL AND enforce_from IS NOT NULL AND activation_signature IS NOT NULL)),
      CHECK (state <> 'proposed' OR pending_version_id IS NOT NULL)
    )`,
    'CREATE INDEX ix_cpg_policy_heads_org_state ON cpg_policy_heads (org_id, state)',
    immutableColumnsTrigger('cpg_policy_heads', ['policy_id', 'org_id']),
    noDeleteTrigger('cpg_policy_heads'),
  ],
};

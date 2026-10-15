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
 * CPG Phase 4: review cases (design spec §2.3, migration
 * `cpg_0003_review_cases`, tables T19 to T26, and §5).
 *
 * A case is the one open review per (org, repo, branch). Everything else
 * hangs off it and is append-only. Once the case is closed, the case row is
 * frozen and every child table refuses new rows (§5.7).
 *
 * Applied once by runCpgMigrations and checksummed. NEVER edit this file
 * after it has shipped: add a new numbered migration instead.
 */

const actorCheck = (col: string) => `(length(${col}) BETWEEN 1 AND 100)`;
const jsonCheck = (col: string) => `(json_valid(${col}))`;
const fingerprintCheck = (col: string) => `(${col} GLOB '[0-9a-f]*:corp.*:[0-9]*' AND length(${col}) <= 200)`;
const TIERS = "('advisory','review-required','prohibited')";

/**
 * The guards every case child table carries: no rows once the case is closed,
 * and the row's org is the case's org (plus any `alsoInvalid` condition).
 */
function caseChildTriggers(table: string, alsoInvalid?: string): string[] {
  return [
    `CREATE TRIGGER trg_${table}_case_open BEFORE INSERT ON ${table}
      WHEN (SELECT closed_at FROM cpg_cases WHERE id = NEW.case_id) IS NOT NULL
      BEGIN SELECT RAISE(ABORT, '${table}: the case is closed and immutable'); END`,
    `CREATE TRIGGER trg_${table}_same_org BEFORE INSERT ON ${table}
      WHEN (SELECT org_id FROM cpg_cases WHERE id = NEW.case_id) IS NOT NEW.org_id${alsoInvalid ? ` OR ${alsoInvalid}` : ''}
      BEGIN SELECT RAISE(ABORT, '${table}: every referenced row must belong to the case org'); END`,
    ...appendOnlyTriggers(table),
  ];
}

export const cpg0003ReviewCases: Migration = {
  id: 'cpg_0003_review_cases',
  statements: [
    // ── T19 cpg_cases: identity plus a state projection, frozen once closed
    `CREATE TABLE cpg_cases (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      ref TEXT NOT NULL CHECK (ref = 'CPG-' || upper(substr(id, 1, 8))),
      repo TEXT NOT NULL CHECK (repo = lower(repo) AND length(repo) BETWEEN 3 AND 200),
      branch TEXT NOT NULL CHECK (length(branch) BETWEEN 1 AND 255 AND branch NOT GLOB 'refs/*'),
      pr_number INTEGER NULL CHECK (pr_number IS NULL OR pr_number > 0),
      state TEXT NOT NULL CHECK (state IN ('open','in_review','changes_requested','decided','closed')),
      close_reason TEXT NULL CHECK (close_reason IS NULL OR close_reason IN ('merged','withdrawn','closed_by_reviewer','pr_closed_unmerged','abandoned')),
      latest_revision INTEGER NOT NULL DEFAULT 0 CHECK (latest_revision >= 0),
      opened_by TEXT NOT NULL CHECK ${actorCheck('opened_by')},
      opened_at TEXT NOT NULL CHECK ${isoCheck('opened_at')},
      closed_at TEXT NULL CHECK ${isoOrNullCheck('closed_at')},
      closed_by TEXT NULL,
      closure_signature TEXT NULL,
      updated_at TEXT NOT NULL CHECK ${isoCheck('updated_at')},
      CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
      CHECK ((closed_at IS NULL) = (close_reason IS NULL)
        AND (closed_at IS NULL) = (closed_by IS NULL)
        AND (closed_at IS NULL) = (closure_signature IS NULL))
    )`,
    'CREATE UNIQUE INDEX ux_cpg_cases_open ON cpg_cases (org_id, repo, branch) WHERE closed_at IS NULL',
    'CREATE INDEX ix_cpg_cases_org_state ON cpg_cases (org_id, state)',
    'CREATE INDEX ix_cpg_cases_org_pr ON cpg_cases (org_id, repo, pr_number)',
    `CREATE TRIGGER trg_cpg_cases_closed BEFORE UPDATE ON cpg_cases
      WHEN OLD.closed_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'cpg_cases: the case is closed and immutable'); END`,
    immutableColumnsTrigger('cpg_cases', ['id', 'org_id', 'ref', 'repo', 'branch', 'opened_by', 'opened_at']),
    noDeleteTrigger('cpg_cases'),

    // ── T20 cpg_case_events: the case's own event log
    `CREATE TABLE cpg_case_events (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      case_id TEXT NOT NULL REFERENCES cpg_cases(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      seq INTEGER NOT NULL CHECK (seq >= 1),
      event TEXT NOT NULL CHECK (event IN ('opened','revision_added','submitted','pr_attached','pr_changed','commit_linked',
        'ci_result','state_changed','changes_requested','justification_added','comment_added','proposal_created',
        'decision_recorded','policy_proposed_from_case','integration_linked','closed')),
      actor TEXT NOT NULL CHECK ${actorCheck('actor')},
      details TEXT NOT NULL CHECK ${jsonCheck('details')},
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')}
    )`,
    'CREATE UNIQUE INDEX ux_cpg_case_events_seq ON cpg_case_events (case_id, seq)',
    ...caseChildTriggers('cpg_case_events'),

    // ── T21 cpg_case_revisions: one full snapshot of the branch's findings
    `CREATE TABLE cpg_case_revisions (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      case_id TEXT NOT NULL REFERENCES cpg_cases(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      source TEXT NOT NULL CHECK (source IN ('vscode','ci','dashboard')),
      head_sha TEXT NULL CHECK (head_sha IS NULL OR (length(head_sha) = 40 AND head_sha NOT GLOB '*[^0-9a-f]*')),
      bundle_hash TEXT NOT NULL CHECK ${sha256HexCheck('bundle_hash')},
      findings_digest TEXT NOT NULL CHECK ${sha256HexCheck('findings_digest')},
      added_count INTEGER NOT NULL CHECK (added_count >= 0),
      carried_count INTEGER NOT NULL CHECK (carried_count >= 0),
      resolved_count INTEGER NOT NULL CHECK (resolved_count >= 0),
      created_by TEXT NOT NULL CHECK ${actorCheck('created_by')},
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')}
    )`,
    'CREATE UNIQUE INDEX ux_cpg_case_revisions_revision ON cpg_case_revisions (case_id, revision)',
    ...caseChildTriggers('cpg_case_revisions'),

    // ── T22 cpg_snippets: content-addressed, stored normalized (the bytes that were hashed)
    `CREATE TABLE cpg_snippets (
      org_id TEXT NOT NULL REFERENCES organizations(id),
      snippet_hash TEXT NOT NULL CHECK ${sha256HexCheck('snippet_hash')},
      normalized_text TEXT NOT NULL CHECK (length(normalized_text) <= 32768),
      line_count INTEGER NOT NULL CHECK (line_count BETWEEN 1 AND 400),
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')},
      PRIMARY KEY (org_id, snippet_hash)
    )`,
    ...appendOnlyTriggers('cpg_snippets'),

    // ── T23 cpg_case_findings: one row per finding location per revision
    `CREATE TABLE cpg_case_findings (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      revision_id TEXT NOT NULL REFERENCES cpg_case_revisions(id),
      case_id TEXT NOT NULL REFERENCES cpg_cases(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      fingerprint TEXT NOT NULL CHECK ${fingerprintCheck('fingerprint')},
      snippet_hash TEXT NOT NULL,
      policy_id TEXT NOT NULL REFERENCES cpg_policies(id),
      policy_version_id TEXT NOT NULL REFERENCES cpg_policy_versions(id),
      policy_key TEXT NOT NULL,
      policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
      tier TEXT NOT NULL CHECK (tier IN ${TIERS}),
      enforced INTEGER NOT NULL CHECK ${boolCheck('enforced')},
      file_path TEXT NOT NULL CHECK (length(file_path) BETWEEN 1 AND 500 AND file_path NOT GLOB '/*' AND instr(file_path, '..') = 0),
      start_line INTEGER NOT NULL CHECK (start_line >= 1),
      end_line INTEGER NOT NULL CHECK (end_line >= start_line),
      language TEXT NULL,
      status_at_revision TEXT NOT NULL CHECK (status_at_revision IN ('new','carried')),
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')},
      CHECK (fingerprint = snippet_hash || ':' || policy_key || ':' || policy_version),
      FOREIGN KEY (org_id, snippet_hash) REFERENCES cpg_snippets(org_id, snippet_hash)
    )`,
    'CREATE UNIQUE INDEX ux_cpg_case_findings_location ON cpg_case_findings (revision_id, fingerprint, file_path, start_line)',
    'CREATE INDEX ix_cpg_case_findings_case_fp ON cpg_case_findings (case_id, fingerprint)',
    ...caseChildTriggers('cpg_case_findings', `(SELECT case_id FROM cpg_case_revisions WHERE id = NEW.revision_id) IS NOT NEW.case_id
        OR (SELECT org_id FROM cpg_policy_versions WHERE id = NEW.policy_version_id AND policy_id = NEW.policy_id) IS NOT NEW.org_id`),

    // ── T24 cpg_reviewer_contexts: generated context; a retry is a new attempt row
    `CREATE TABLE cpg_reviewer_contexts (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      snippet_hash TEXT NOT NULL,
      policy_version_id TEXT NOT NULL REFERENCES cpg_policy_versions(id),
      status TEXT NOT NULL CHECK (status IN ('generated','failed','disabled')),
      what_it_does TEXT NULL CHECK (what_it_does IS NULL OR length(what_it_does) <= 1200),
      why_flagged TEXT NULL CHECK (why_flagged IS NULL OR length(why_flagged) <= 1200),
      provider TEXT NULL,
      model TEXT NULL,
      prompt_version INTEGER NOT NULL CHECK (prompt_version >= 1),
      attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 5),
      error TEXT NULL,
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')},
      FOREIGN KEY (org_id, snippet_hash) REFERENCES cpg_snippets(org_id, snippet_hash)
    )`,
    'CREATE UNIQUE INDEX ux_cpg_reviewer_contexts_attempt ON cpg_reviewer_contexts (org_id, snippet_hash, policy_version_id, prompt_version, attempt)',
    `CREATE TRIGGER trg_cpg_reviewer_contexts_same_org BEFORE INSERT ON cpg_reviewer_contexts
      WHEN (SELECT org_id FROM cpg_policy_versions WHERE id = NEW.policy_version_id) IS NOT NEW.org_id
      BEGIN SELECT RAISE(ABORT, 'cpg_reviewer_contexts: the policy version must belong to the context org'); END`,
    ...appendOnlyTriggers('cpg_reviewer_contexts'),

    // ── T25 cpg_justifications: the latest row per (case, fingerprint) is current
    `CREATE TABLE cpg_justifications (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      case_id TEXT NOT NULL REFERENCES cpg_cases(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      fingerprint TEXT NOT NULL CHECK ${fingerprintCheck('fingerprint')},
      author_user_id TEXT NOT NULL REFERENCES users(id),
      body TEXT NOT NULL CHECK (length(body) BETWEEN 20 AND 4000),
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')}
    )`,
    'CREATE INDEX ix_cpg_justifications_case_fp ON cpg_justifications (case_id, fingerprint, created_at)',
    ...caseChildTriggers('cpg_justifications', '(SELECT org_id FROM users WHERE id = NEW.author_user_id) IS NOT NEW.org_id'),

    // ── T26 cpg_comments: threads; a change request names the lane's board
    `CREATE TABLE cpg_comments (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      case_id TEXT NOT NULL REFERENCES cpg_cases(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      thread_id TEXT NOT NULL CHECK ${uuidCheck('thread_id')},
      parent_id TEXT NULL REFERENCES cpg_comments(id),
      kind TEXT NOT NULL CHECK (kind IN ('comment','change_request','reply')),
      board_id TEXT NULL REFERENCES cpg_boards(id),
      fingerprints TEXT NOT NULL CHECK (json_valid(fingerprints) AND json_type(fingerprints) = 'array'),
      author_user_id TEXT NOT NULL REFERENCES users(id),
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')},
      CHECK (kind <> 'change_request' OR board_id IS NOT NULL),
      CHECK ((kind = 'reply') = (parent_id IS NOT NULL)),
      CHECK ((parent_id IS NULL) = (thread_id = id))
    )`,
    'CREATE INDEX ix_cpg_comments_case_thread ON cpg_comments (case_id, thread_id, created_at)',
    ...caseChildTriggers('cpg_comments', `(SELECT org_id FROM users WHERE id = NEW.author_user_id) IS NOT NEW.org_id
        OR (NEW.board_id IS NOT NULL AND (SELECT org_id FROM cpg_boards WHERE id = NEW.board_id) IS NOT NEW.org_id)
        OR (NEW.parent_id IS NOT NULL AND (SELECT case_id FROM cpg_comments WHERE id = NEW.parent_id) IS NOT NEW.case_id)`),

    // A policy proposed from inside a case names a case of the same org (§2.3, cpg_0003).
    `CREATE TRIGGER trg_cpg_policies_origin_case BEFORE INSERT ON cpg_policies
      WHEN NEW.origin_case_id IS NOT NULL AND (SELECT org_id FROM cpg_cases WHERE id = NEW.origin_case_id) IS NOT NEW.org_id
      BEGIN SELECT RAISE(ABORT, 'cpg_policies: origin_case_id must be a case of the same org'); END`,
  ],
};

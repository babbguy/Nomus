import type { Migration } from './runner.js';
import { appendOnlyTriggers, isoCheck, isoOrNullCheck, sha256HexCheck, uuidCheck } from './sql-helpers.js';

/**
 * CPG Phase 5: approvals and exceptions (design spec §2.3, migration
 * `cpg_0004_approvals`, tables T27 to T30, §4.3, §5.5, §7, §13.2).
 *
 * Every table is append-only: a proposal's status is derived from its votes,
 * decisions and invalidation (§5.5), and a decision ends only by expiry or a
 * signed revocation. The database itself refuses self-approval (the case
 * opener, a justification author or a revision creator voting), bulk on the
 * prohibited tier, and any child row once the case is closed.
 *
 * Standing exceptions (pattern) and revocations are created here so the next
 * chunk needs no change to an applied migration.
 *
 * Applied once by runCpgMigrations and checksummed. NEVER edit this file
 * after it has shipped: add a new numbered migration instead.
 */

const jsonArrayCheck = (col: string) => `(json_valid(${col}) AND json_type(${col}) = 'array')`;
const caseOf = (proposal: string) => `(SELECT c.closed_at FROM cpg_proposals p JOIN cpg_cases c ON c.id = p.case_id WHERE p.id = ${proposal})`;

/** A child row of a proposal's case is refused once the case is closed (§5.7). */
function closedCaseTrigger(table: string, closedAt: string): string {
  return `CREATE TRIGGER trg_${table}_case_open BEFORE INSERT ON ${table}
      WHEN ${closedAt} IS NOT NULL
      BEGIN SELECT RAISE(ABORT, '${table}: the case is closed and immutable'); END`;
}

export const cpg0004Approvals: Migration = {
  id: 'cpg_0004_approvals',
  statements: [
    // ── T27 cpg_proposals: what is proposed, and the requirement computed at creation
    `CREATE TABLE cpg_proposals (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      case_id TEXT NULL REFERENCES cpg_cases(id),
      scope TEXT NOT NULL CHECK (scope IN ('snippet','bulk','standing')),
      outcome TEXT NOT NULL CHECK (outcome IN ('approve','reject')),
      policy_id TEXT NOT NULL REFERENCES cpg_policies(id),
      policy_version_id TEXT NOT NULL REFERENCES cpg_policy_versions(id),
      policy_key TEXT NOT NULL,
      policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
      tier TEXT NOT NULL CHECK (tier IN ('advisory','review-required','prohibited')),
      fingerprints TEXT NOT NULL CHECK (${jsonArrayCheck('fingerprints')} AND CASE scope
        WHEN 'snippet' THEN json_array_length(fingerprints) = 1
        WHEN 'bulk' THEN json_array_length(fingerprints) BETWEEN 2 AND 500
        ELSE json_array_length(fingerprints) = 0 END),
      pattern TEXT NULL CHECK (pattern IS NULL OR json_valid(pattern)),
      requested_expires_at TEXT NULL CHECK ${isoOrNullCheck('requested_expires_at')},
      rationale TEXT NOT NULL CHECK (length(rationale) BETWEEN 20 AND 4000),
      required TEXT NOT NULL CHECK (json_valid(required) AND json_type(required) = 'object'),
      quorum_config_version_at_creation INTEGER NOT NULL CHECK (quorum_config_version_at_creation >= 1),
      proposer_user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')},
      lapses_at TEXT NOT NULL CHECK (${isoCheck('lapses_at')} AND lapses_at > created_at),
      CHECK (scope <> 'bulk' OR tier <> 'prohibited'),
      CHECK ((scope = 'standing') = (pattern IS NOT NULL)),
      CHECK (scope = 'standing' OR case_id IS NOT NULL),
      CHECK ((outcome = 'approve') = (requested_expires_at IS NOT NULL)),
      CHECK (requested_expires_at IS NULL OR requested_expires_at > created_at)
    )`,
    'CREATE INDEX ix_cpg_proposals_case ON cpg_proposals (case_id, created_at)',
    'CREATE INDEX ix_cpg_proposals_org_scope ON cpg_proposals (org_id, scope, created_at)',
    `CREATE TRIGGER trg_cpg_proposals_same_org BEFORE INSERT ON cpg_proposals
      WHEN (NEW.case_id IS NOT NULL AND (SELECT org_id FROM cpg_cases WHERE id = NEW.case_id) IS NOT NEW.org_id)
        OR (SELECT org_id FROM cpg_policies WHERE id = NEW.policy_id AND policy_key = NEW.policy_key) IS NOT NEW.org_id
        OR (SELECT org_id FROM cpg_policy_versions WHERE id = NEW.policy_version_id AND policy_id = NEW.policy_id
              AND version = NEW.policy_version AND tier = NEW.tier) IS NOT NEW.org_id
        OR (SELECT org_id FROM users WHERE id = NEW.proposer_user_id) IS NOT NEW.org_id
      BEGIN SELECT RAISE(ABORT, 'cpg_proposals: case, policy version (with its tier) and proposer must belong to the proposal org'); END`,
    closedCaseTrigger('cpg_proposals', '(SELECT closed_at FROM cpg_cases WHERE id = NEW.case_id)'),
    ...appendOnlyTriggers('cpg_proposals'),

    // ── T28 cpg_votes: one per voter, with the eligibility facts at vote time
    `CREATE TABLE cpg_votes (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      proposal_id TEXT NOT NULL REFERENCES cpg_proposals(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      voter_user_id TEXT NOT NULL REFERENCES users(id),
      vote TEXT NOT NULL CHECK (vote IN ('approve','reject')),
      boards_at_vote TEXT NOT NULL CHECK ${jsonArrayCheck('boards_at_vote')},
      permissions_at_vote TEXT NOT NULL CHECK ${jsonArrayCheck('permissions_at_vote')},
      comment TEXT NOT NULL DEFAULT '' CHECK (length(comment) <= 2000),
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')}
    )`,
    'CREATE UNIQUE INDEX ux_cpg_votes_voter ON cpg_votes (proposal_id, voter_user_id)',
    // Self-approval is forbidden whatever the configuration (brief §3, spec §4.3 step 3).
    `CREATE TRIGGER trg_cpg_votes_no_self_approval BEFORE INSERT ON cpg_votes
      WHEN EXISTS (SELECT 1 FROM cpg_proposals p JOIN cpg_cases c ON c.id = p.case_id WHERE p.id = NEW.proposal_id AND (
          c.opened_by = 'user:' || NEW.voter_user_id
          OR EXISTS (SELECT 1 FROM cpg_justifications j WHERE j.case_id = c.id AND j.author_user_id = NEW.voter_user_id)
          OR EXISTS (SELECT 1 FROM cpg_case_revisions r WHERE r.case_id = c.id AND r.created_by = 'user:' || NEW.voter_user_id)))
      BEGIN SELECT RAISE(ABORT, 'cpg_votes: self-approval is forbidden (the case opener, a justification author or a revision creator cannot vote)'); END`,
    `CREATE TRIGGER trg_cpg_votes_same_org BEFORE INSERT ON cpg_votes
      WHEN (SELECT org_id FROM cpg_proposals WHERE id = NEW.proposal_id) IS NOT NEW.org_id
        OR (SELECT org_id FROM users WHERE id = NEW.voter_user_id) IS NOT NEW.org_id
      BEGIN SELECT RAISE(ABORT, 'cpg_votes: proposal and voter must belong to the vote org'); END`,
    closedCaseTrigger('cpg_votes', caseOf('NEW.proposal_id')),
    ...appendOnlyTriggers('cpg_votes'),

    // ── Proposal invalidation (§4.3 step 6, §5.5): the requirement failed at finalization
    `CREATE TABLE cpg_proposal_events (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      proposal_id TEXT NOT NULL REFERENCES cpg_proposals(id),
      org_id TEXT NOT NULL REFERENCES organizations(id),
      event TEXT NOT NULL CHECK (event IN ('invalidated')),
      actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
      details TEXT NOT NULL CHECK (json_valid(details)),
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')}
    )`,
    'CREATE UNIQUE INDEX ux_cpg_proposal_events_event ON cpg_proposal_events (proposal_id, event)',
    `CREATE TRIGGER trg_cpg_proposal_events_same_org BEFORE INSERT ON cpg_proposal_events
      WHEN (SELECT org_id FROM cpg_proposals WHERE id = NEW.proposal_id) IS NOT NEW.org_id
      BEGIN SELECT RAISE(ABORT, 'cpg_proposal_events: the proposal must belong to the event org'); END`,
    ...appendOnlyTriggers('cpg_proposal_events'),

    // ── T29 cpg_decisions: signed final outcomes, one per finding (or per standing exception)
    `CREATE TABLE cpg_decisions (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      proposal_id TEXT NOT NULL REFERENCES cpg_proposals(id),
      case_id TEXT NULL REFERENCES cpg_cases(id),
      scope TEXT NOT NULL CHECK (scope IN ('snippet','bulk','standing')),
      outcome TEXT NOT NULL CHECK (outcome IN ('approve','reject')),
      repo TEXT NULL CHECK (repo IS NULL OR (repo = lower(repo) AND length(repo) BETWEEN 3 AND 200)),
      fingerprint TEXT NULL,
      batch_id TEXT NULL,
      policy_id TEXT NOT NULL REFERENCES cpg_policies(id),
      policy_version_id TEXT NOT NULL REFERENCES cpg_policy_versions(id),
      policy_key TEXT NOT NULL,
      policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
      expires_at TEXT NULL CHECK ${isoOrNullCheck('expires_at')},
      approver_user_ids TEXT NOT NULL CHECK (${jsonArrayCheck('approver_user_ids')} AND json_array_length(approver_user_ids) >= 1),
      quorum_config_version INTEGER NOT NULL CHECK (quorum_config_version >= 1),
      quorum_config_hash TEXT NOT NULL CHECK ${sha256HexCheck('quorum_config_hash')},
      finalized_at TEXT NOT NULL CHECK ${isoCheck('finalized_at')},
      signed_payload TEXT NOT NULL CHECK (json_valid(signed_payload)),
      signature TEXT NOT NULL CHECK (length(signature) >= 1),
      CHECK ((outcome = 'approve') = (expires_at IS NOT NULL)),
      CHECK (expires_at IS NULL OR expires_at > finalized_at),
      CHECK ((scope = 'standing') = (repo IS NULL) AND (scope = 'standing') = (fingerprint IS NULL)),
      CHECK ((scope = 'bulk') = (batch_id IS NOT NULL) AND (batch_id IS NULL OR batch_id = proposal_id))
    )`,
    'CREATE INDEX ix_cpg_decisions_finding ON cpg_decisions (org_id, repo, fingerprint, finalized_at)',
    'CREATE INDEX ix_cpg_decisions_scope_expiry ON cpg_decisions (org_id, scope, expires_at)',
    'CREATE UNIQUE INDEX ux_cpg_decisions_proposal_finding ON cpg_decisions (proposal_id, coalesce(fingerprint, \'\'))',
    // A decision restates its proposal: the scope (so bulk-on-prohibited stays impossible), outcome, policy version, case and repo.
    `CREATE TRIGGER trg_cpg_decisions_match_proposal BEFORE INSERT ON cpg_decisions
      WHEN NOT EXISTS (SELECT 1 FROM cpg_proposals p WHERE p.id = NEW.proposal_id AND p.org_id = NEW.org_id
          AND p.case_id IS NEW.case_id AND p.scope = NEW.scope AND p.outcome = NEW.outcome
          AND p.policy_id = NEW.policy_id AND p.policy_version_id = NEW.policy_version_id
          AND p.policy_key = NEW.policy_key AND p.policy_version = NEW.policy_version
          AND (NEW.fingerprint IS NULL OR EXISTS (SELECT 1 FROM json_each(p.fingerprints) f WHERE f.value = NEW.fingerprint))
          AND (NEW.repo IS NULL OR NEW.repo = (SELECT repo FROM cpg_cases WHERE id = p.case_id)))
      BEGIN SELECT RAISE(ABORT, 'cpg_decisions: a decision must restate its proposal (org, case, scope, outcome, policy version, finding)'); END`,
    closedCaseTrigger('cpg_decisions', '(SELECT closed_at FROM cpg_cases WHERE id = NEW.case_id)'),
    ...appendOnlyTriggers('cpg_decisions'),

    // ── T30 cpg_revocations: a decision is revoked at most once, signed
    `CREATE TABLE cpg_revocations (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      decision_id TEXT NOT NULL REFERENCES cpg_decisions(id),
      revoked_by_user_id TEXT NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
      revoked_at TEXT NOT NULL CHECK ${isoCheck('revoked_at')},
      signed_payload TEXT NOT NULL CHECK (json_valid(signed_payload)),
      signature TEXT NOT NULL CHECK (length(signature) >= 1)
    )`,
    'CREATE UNIQUE INDEX ux_cpg_revocations_decision ON cpg_revocations (decision_id)',
    `CREATE TRIGGER trg_cpg_revocations_same_org BEFORE INSERT ON cpg_revocations
      WHEN (SELECT org_id FROM cpg_decisions WHERE id = NEW.decision_id) IS NOT NEW.org_id
        OR (SELECT org_id FROM users WHERE id = NEW.revoked_by_user_id) IS NOT NEW.org_id
      BEGIN SELECT RAISE(ABORT, 'cpg_revocations: decision and revoker must belong to the revocation org'); END`,
    ...appendOnlyTriggers('cpg_revocations'),
  ],
};

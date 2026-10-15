/**
 * Review cases (design spec §5): find-or-create, revisions (digest,
 * idempotence, carried/new/resolved), the derived state, lanes, the
 * closed-case triggers on every child table, and org isolation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { fingerprintOf } from '@nomus/scanner/corporate';
import { runMigrations } from '../../db/migrate.js';
import { caseFixtures } from '../__fixtures__/case-fixtures.js';
import { CpgError } from '../errors.js';
import { addRevision, findOrCreateCase, findingsDigest, getCase, type RevisionFinding } from './service.js';
import { caseLanes, splitIntoLanes } from './lanes.js';

const sqlite = new Database(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const NOW = '2026-10-09T12:00:00.000Z';
const BUNDLE = 'b'.repeat(64);
const ACTOR = 'user:test';

const run = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params);

function insertOrg(): string {
  const id = randomUUID();
  run("INSERT INTO organizations (id, name, slug, jurisdiction_access, is_active, created_at, updated_at) VALUES (?, ?, ?, '[]', 1, ?, ?)", id, `Org ${id}`, `org-${id}`, NOW, NOW);
  return id;
}

function insertUser(org: string): string {
  const id = randomUUID();
  run(`INSERT INTO users (id, org_id, email, name, role, auth_provider, must_change_password, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'U', 'member', 'local', 0, 1, ?, ?)`, id, org, `${id}@gate.example.org`, NOW, NOW);
  return id;
}

const { insertBoard, insertPolicy } = caseFixtures(sqlite);

function finding(code: string, policyKey: string, filePath = 'src/app.ts', startLine = 1): RevisionFinding {
  return { fingerprint: fingerprintOf(code, policyKey, 1), filePath, startLine, endLine: startLine, language: 'typescript', snippet: code };
}

const rev = (findings: RevisionFinding[], headSha: string | null = null) => ({ source: 'ci' as const, headSha, bundleHash: BUNDLE, findings });

function cpgError(fn: () => unknown): { status: number; code: string } | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (!(err instanceof CpgError)) throw err;
    return { status: err.status, code: err.code };
  }
}

function sqliteError(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return `${(err as { code?: string }).code}: ${(err as Error).message}`;
  }
}

function events(caseId: string): Array<{ seq: number; event: string; details: string }> {
  return sqlite.prepare('SELECT seq, event, details FROM cpg_case_events WHERE case_id = ? ORDER BY seq').all(caseId) as Array<{ seq: number; event: string; details: string }>;
}

function closeCase(caseId: string): void {
  run(`UPDATE cpg_cases SET state = 'closed', close_reason = 'withdrawn', closed_at = ?, closed_by = ?, closure_signature = 'sig' WHERE id = ?`, NOW, ACTOR, caseId);
}

let orgId: string;
let otherOrgId: string;
let userId: string;
let aiBoard: string;
let legalBoard: string;

beforeAll(() => {
  runMigrations(db);
  orgId = insertOrg();
  otherOrgId = insertOrg();
  userId = insertUser(orgId);
  aiBoard = insertBoard(orgId, 'ai');
  legalBoard = insertBoard(orgId, 'legal');
  insertPolicy(orgId, 'corp.no-openai', 'prohibited', [aiBoard, legalBoard]);
  insertPolicy(orgId, 'corp.pii-logging', 'review-required', [legalBoard]);
  insertPolicy(orgId, 'corp.model-notice', 'advisory', [aiBoard]);
  insertPolicy(orgId, 'corp.in-grace', 'prohibited', [aiBoard], { enforceFrom: '2999-01-01T00:00:00.000Z' });
  insertPolicy(orgId, 'corp.proposed', 'prohibited', [aiBoard], { state: 'proposed' });
  insertPolicy(otherOrgId, 'corp.other-org', 'prohibited', [insertBoard(otherOrgId, 'ai')]);
});

let branchSeq = 0;
const newCase = () => findOrCreateCase(db, { orgId, repo: 'acme/app', branch: `feat/case-${++branchSeq}` }, ACTOR).case;

describe('find or create (§5.1)', () => {
  it('creates one open case per branch and returns it on the next call', () => {
    const first = findOrCreateCase(db, { orgId, repo: 'acme/app', branch: 'feat/identity' }, ACTOR);
    expect(first.created).toBe(true);
    expect(first.case).toMatchObject({ state: 'open', latestRevision: 0, ref: `CPG-${first.case.id.slice(0, 8).toUpperCase()}` });
    const again = findOrCreateCase(db, { orgId, repo: 'acme/app', branch: 'feat/identity' }, ACTOR);
    expect(again).toEqual({ case: first.case, created: false });
    expect(events(first.case.id).map((e) => [e.seq, e.event, e.details])).toEqual([[1, 'opened', '{}']]);
  });

  it('opens a new case after a close, pointing at the closed one', () => {
    const first = findOrCreateCase(db, { orgId, repo: 'acme/app', branch: 'feat/reopen' }, ACTOR).case;
    closeCase(first.id);
    const next = findOrCreateCase(db, { orgId, repo: 'acme/app', branch: 'feat/reopen' }, ACTOR);
    expect(next.created).toBe(true);
    expect(next.case.id).not.toBe(first.id);
    expect(JSON.parse(events(next.case.id)[0].details)).toEqual({ previousCaseId: first.id });
  });

  it('the database refuses a second open case on the same branch', () => {
    const c = findOrCreateCase(db, { orgId, repo: 'acme/app', branch: 'feat/unique' }, ACTOR).case;
    const id = randomUUID();
    expect(sqliteError(() => run(`INSERT INTO cpg_cases (id, org_id, ref, repo, branch, state, opened_by, opened_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'open', 'test', ?, ?)`, id, orgId, `CPG-${id.slice(0, 8).toUpperCase()}`, c.repo, c.branch, NOW, NOW)))
      .toMatch(/^SQLITE_CONSTRAINT_UNIQUE/);
  });
});

describe('revisions (§5.4)', () => {
  const A = finding('const a = openai.chat();', 'corp.no-openai');
  const B = finding('log(user.email);', 'corp.pii-logging');
  const C = finding('const c = openai.chat();', 'corp.no-openai', 'src/c.ts');
  const D = finding('const d = openai.chat();', 'corp.no-openai', 'src/d.ts');

  it('the digest is sha256 of the sorted fingerprints joined by newlines', () => {
    const fps = [B.fingerprint, A.fingerprint];
    const expected = createHash('sha256').update([...fps].sort().join('\n')).digest('hex');
    expect(findingsDigest(fps)).toBe(expected);
    expect(findingsDigest([A.fingerprint, B.fingerprint])).toBe(expected);
  });

  it('is idempotent: the same findings in any order, at any head, add no revision and no event', () => {
    const c = newCase();
    const first = addRevision(db, orgId, c.id, rev([A, B], 'a'.repeat(40)), ACTOR);
    expect(first.revisionCreated).toBe(true);
    expect(first.revision).toMatchObject({ revision: 1, findingsDigest: findingsDigest([A.fingerprint, B.fingerprint]), addedCount: 2, carriedCount: 0, resolvedCount: 0 });
    const eventCount = events(c.id).length;
    const again = addRevision(db, orgId, c.id, rev([B, A], 'f'.repeat(40)), ACTOR);
    expect(again).toEqual({ revision: first.revision, revisionCreated: false });
    expect(events(c.id)).toHaveLength(eventCount);
    expect(getCase(db, orgId, c.id).latestRevision).toBe(1);
  });

  it('counts new, carried and resolved fingerprints, and marks each row', () => {
    const c = newCase();
    addRevision(db, orgId, c.id, rev([A, B]), ACTOR);
    const second = addRevision(db, orgId, c.id, rev([B, C, D]), ACTOR);
    expect(second.revision).toMatchObject({ revision: 2, addedCount: 2, carriedCount: 1, resolvedCount: 1 });
    const rows = sqlite.prepare('SELECT fingerprint, status_at_revision AS s FROM cpg_case_findings WHERE revision_id = ?').all(second.revision.id) as Array<{ fingerprint: string; s: string }>;
    expect(Object.fromEntries(rows.map((r) => [r.fingerprint, r.s]))).toEqual({ [B.fingerprint]: 'carried', [C.fingerprint]: 'new', [D.fingerprint]: 'new' });
    const added = events(c.id).filter((e) => e.event === 'revision_added').map((e) => JSON.parse(e.details));
    expect(added[1]).toMatchObject({ revision: 2, added: 2, carried: 1, resolved: 1 });
  });

  it('keeps one fingerprint at two locations as two rows, counted once', () => {
    const c = newCase();
    const copy = { ...A, filePath: 'src/copy.ts', startLine: 9, endLine: 9 };
    const r = addRevision(db, orgId, c.id, rev([A, copy]), ACTOR).revision;
    expect(r.addedCount).toBe(1);
    expect(sqlite.prepare('SELECT count(*) AS n FROM cpg_case_findings WHERE revision_id = ?').get(r.id)).toEqual({ n: 2 });
  });

  it('stores each snippet normalized, once per org, and accepts a later finding without its text', () => {
    const c = newCase();
    const crlf = finding('const e = openai.chat();   \r\nreturn e;', 'corp.no-openai');
    addRevision(db, orgId, c.id, rev([crlf]), ACTOR);
    const hash = crlf.fingerprint.slice(0, 64);
    expect(sqlite.prepare('SELECT normalized_text AS t, line_count AS n FROM cpg_snippets WHERE org_id = ? AND snippet_hash = ?').get(orgId, hash))
      .toEqual({ t: 'const e = openai.chat();\nreturn e;', n: 2 });
    const { snippet: _omitted, ...withoutText } = crlf;
    expect(addRevision(db, orgId, c.id, rev([withoutText, B]), ACTOR).revisionCreated).toBe(true);
  });

  it('refuses a snippet that does not hash to its fingerprint, unknown or inactive versions, and duplicates', () => {
    const c = newCase();
    expect(cpgError(() => addRevision(db, orgId, c.id, rev([{ ...A, snippet: 'const a = openai.chat(); // edited' }]), ACTOR)))
      .toEqual({ status: 422, code: 'snippet_hash_mismatch' });
    expect(cpgError(() => addRevision(db, orgId, c.id, rev([{ ...A, fingerprint: A.fingerprint.replace(/:1$/, ':2') }]), ACTOR)))
      .toEqual({ status: 422, code: 'unknown_policy_version' });
    expect(cpgError(() => addRevision(db, orgId, c.id, rev([finding('x();', 'corp.proposed')]), ACTOR)))
      .toEqual({ status: 422, code: 'policy_version_not_active' });
    expect(cpgError(() => addRevision(db, orgId, c.id, rev([A, A]), ACTOR))).toEqual({ status: 422, code: 'duplicate_finding' });
    const { snippet: _omitted, ...neverStored } = finding('never stored', 'corp.no-openai');
    expect(cpgError(() => addRevision(db, orgId, c.id, rev([neverStored]), ACTOR))).toEqual({ status: 422, code: 'snippet_required' });
    // Every refusal rolled back: no revision, no snippet.
    expect(getCase(db, orgId, c.id).latestRevision).toBe(0);
    expect(sqlite.prepare('SELECT count(*) AS n FROM cpg_snippets WHERE normalized_text LIKE ?').get('%edited%')).toEqual({ n: 0 });
  });

  it('refuses a revision on a closed case with 409 case_closed', () => {
    const c = newCase();
    closeCase(c.id);
    expect(cpgError(() => addRevision(db, orgId, c.id, rev([A]), ACTOR))).toEqual({ status: 409, code: 'case_closed' });
  });
});

describe('derived state across revisions (§5.2, §5.3)', () => {
  it('moves open → decided → open → in_review → open, recording each move', () => {
    const c = newCase();
    const advisory = finding('model: "old-model"', 'corp.model-notice');
    const grace = finding('graceCall();', 'corp.in-grace');
    const blocking = finding('const z = openai.chat();', 'corp.no-openai');
    const more = finding('log(user.phone);', 'corp.pii-logging');
    const state = () => getCase(db, orgId, c.id).state;

    addRevision(db, orgId, c.id, rev([advisory, grace]), ACTOR); // nothing blocks: advisory, and a policy in its grace period
    expect(state()).toBe('decided');
    addRevision(db, orgId, c.id, rev([advisory, blocking]), ACTOR);
    expect(state()).toBe('open');
    run("INSERT INTO cpg_justifications (id, case_id, org_id, fingerprint, author_user_id, body, created_at) VALUES (?, ?, ?, ?, ?, 'Migrating to the gateway next sprint.', ?)",
      randomUUID(), c.id, orgId, blocking.fingerprint, userId, NOW);
    addRevision(db, orgId, c.id, rev([blocking]), ACTOR);
    expect(state()).toBe('in_review');
    addRevision(db, orgId, c.id, rev([blocking, more]), ACTOR);
    expect(state()).toBe('open');

    const moves = events(c.id).filter((e) => e.event === 'state_changed').map((e) => JSON.parse(e.details));
    expect(moves).toEqual([
      { from: 'open', to: 'decided' }, { from: 'decided', to: 'open' }, { from: 'open', to: 'in_review' }, { from: 'in_review', to: 'open' },
    ]);
  });

  it('refuses a move the table forbids and rolls the whole revision back', () => {
    const c = newCase();
    run("UPDATE cpg_cases SET state = 'changes_requested' WHERE id = ?", c.id);
    const blocking = finding('const y = openai.chat();', 'corp.no-openai');
    expect(cpgError(() => addRevision(db, orgId, c.id, rev([blocking]), ACTOR))).toEqual({ status: 409, code: 'invalid_transition' });
    expect(getCase(db, orgId, c.id)).toMatchObject({ state: 'changes_requested', latestRevision: 0 });
  });
});

describe('lanes (§5.6)', () => {
  it('splits a mixed-owner bundle into one lane per board; a finding with two owners is in both', () => {
    const lanes = splitIntoLanes([
      { fingerprint: 'f1', owningBoardIds: ['ai', 'legal'], blocking: true, decided: false },
      { fingerprint: 'f2', owningBoardIds: ['legal'], blocking: true, decided: true },
      { fingerprint: 'f3', owningBoardIds: ['ai'], blocking: false, decided: false },
      { fingerprint: 'f4', owningBoardIds: ['security'], blocking: true, decided: true },
    ], new Set(['security']));
    expect(lanes).toEqual([
      { boardId: 'ai', fingerprints: ['f1', 'f3'], blocking: 1, decided: 0, state: 'needs_review' },
      { boardId: 'legal', fingerprints: ['f1', 'f2'], blocking: 2, decided: 1, state: 'needs_review' },
      { boardId: 'security', fingerprints: ['f4'], blocking: 1, decided: 1, state: 'changes_requested' },
    ]);
    expect(splitIntoLanes([{ fingerprint: 'f', owningBoardIds: ['ai'], blocking: true, decided: true }])[0].state).toBe('decided');
  });

  it('derives the lanes of a case from its latest revision', () => {
    const c = newCase();
    const both = finding('const w = openai.chat();', 'corp.no-openai');
    const legal = finding('log(user.ssn);', 'corp.pii-logging');
    const advisory = finding('model: "older-model"', 'corp.model-notice');
    expect(caseLanes(db, orgId, c.id)).toEqual([]);
    addRevision(db, orgId, c.id, rev([both, legal, advisory]), ACTOR);
    const lanes = caseLanes(db, orgId, c.id);
    const byBoard = Object.fromEntries(lanes.map((l) => [l.boardId, l]));
    expect(lanes).toHaveLength(2);
    expect(byBoard[aiBoard]).toEqual({ boardId: aiBoard, fingerprints: [both.fingerprint, advisory.fingerprint].sort(), blocking: 1, decided: 0, state: 'needs_review' });
    expect(byBoard[legalBoard]).toEqual({ boardId: legalBoard, fingerprints: [both.fingerprint, legal.fingerprint].sort(), blocking: 2, decided: 0, state: 'needs_review' });
  });
});

describe('a closed case is immutable (§5.7)', () => {
  it('refuses any update of the case row, and identity changes while open', () => {
    const c = newCase();
    expect(sqliteError(() => run("UPDATE cpg_cases SET branch = 'other' WHERE id = ?", c.id))).toMatch(/^SQLITE_CONSTRAINT_TRIGGER: cpg_cases: immutable column/);
    closeCase(c.id);
    for (const sql of ["UPDATE cpg_cases SET pr_number = 7 WHERE id = ?", "UPDATE cpg_cases SET state = 'open', close_reason = NULL, closed_at = NULL, closed_by = NULL, closure_signature = NULL WHERE id = ?"]) {
      expect(sqliteError(() => run(sql, c.id)), sql).toMatch(/^SQLITE_CONSTRAINT_TRIGGER: cpg_cases: the case is closed/);
    }
    expect(sqliteError(() => run('DELETE FROM cpg_cases WHERE id = ?', c.id))).toMatch(/^SQLITE_CONSTRAINT_TRIGGER/);
  });

  it('every child table refuses new rows once the case is closed', () => {
    const c = newCase();
    const f = finding('const v = openai.chat();', 'corp.no-openai');
    const revisionId = addRevision(db, orgId, c.id, rev([f]), ACTOR).revision.id;
    const row = sqlite.prepare('SELECT * FROM cpg_case_findings WHERE revision_id = ?').get(revisionId) as Record<string, unknown>;
    const commentId = randomUUID();
    const inserts: Record<string, () => unknown> = {
      cpg_case_events: () => run("INSERT INTO cpg_case_events (id, case_id, org_id, seq, event, actor, details, created_at) VALUES (?, ?, ?, 99, 'closed', 'test', '{}', ?)", randomUUID(), c.id, orgId, NOW),
      cpg_case_revisions: () => run(`INSERT INTO cpg_case_revisions (id, case_id, org_id, revision, source, bundle_hash, findings_digest, added_count, carried_count, resolved_count, created_by, created_at)
        VALUES (?, ?, ?, 9, 'ci', ?, ?, 0, 0, 0, 'test', ?)`, randomUUID(), c.id, orgId, BUNDLE, BUNDLE, NOW),
      cpg_case_findings: () => run(`INSERT INTO cpg_case_findings (id, revision_id, case_id, org_id, fingerprint, snippet_hash, policy_id, policy_version_id, policy_key, policy_version,
        tier, enforced, file_path, start_line, end_line, status_at_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, 'src/other.ts', 1, 1, 'new', ?)`,
      randomUUID(), revisionId, c.id, orgId, row.fingerprint, row.snippet_hash, row.policy_id, row.policy_version_id, row.policy_key, row.tier, NOW),
      cpg_justifications: () => run("INSERT INTO cpg_justifications (id, case_id, org_id, fingerprint, author_user_id, body, created_at) VALUES (?, ?, ?, ?, ?, 'A justification that is long enough.', ?)",
        randomUUID(), c.id, orgId, f.fingerprint, userId, NOW),
      cpg_comments: () => run("INSERT INTO cpg_comments (id, case_id, org_id, thread_id, kind, board_id, fingerprints, author_user_id, body, created_at) VALUES (?, ?, ?, ?, 'change_request', ?, '[]', ?, 'Please fix', ?)",
        commentId, c.id, orgId, commentId, aiBoard, userId, NOW),
    };
    const attempt = () => Object.fromEntries(Object.entries(inserts).map(([table, insert]) => {
      run('SAVEPOINT probe');
      const error = sqliteError(insert);
      run('ROLLBACK TO probe');
      run('RELEASE probe');
      return [table, error];
    }));
    // Each insert is valid while the case is open (each probe is rolled back)...
    expect(attempt()).toEqual(Object.fromEntries(Object.keys(inserts).map((t) => [t, null])));
    closeCase(c.id);
    // ...and refused by the closed-case trigger once it is closed.
    expect(attempt()).toEqual(Object.fromEntries(Object.keys(inserts).map((t) => [t, `SQLITE_CONSTRAINT_TRIGGER: ${t}: the case is closed and immutable`])));
  });
});

describe('org isolation', () => {
  it('another org cannot read, revise or list lanes of a case: 404', () => {
    const c = newCase();
    expect(cpgError(() => getCase(db, otherOrgId, c.id))).toEqual({ status: 404, code: 'not_found' });
    expect(cpgError(() => addRevision(db, otherOrgId, c.id, rev([]), ACTOR))).toEqual({ status: 404, code: 'not_found' });
    expect(cpgError(() => caseLanes(db, otherOrgId, c.id))).toEqual({ status: 404, code: 'not_found' });
  });

  it('the same repo and branch in two orgs are two cases, and policies of another org are unknown', () => {
    const key = { repo: 'acme/shared', branch: 'main' };
    const mine = findOrCreateCase(db, { orgId, ...key }, ACTOR).case;
    const theirs = findOrCreateCase(db, { orgId: otherOrgId, ...key }, ACTOR).case;
    expect(theirs.id).not.toBe(mine.id);
    expect(cpgError(() => addRevision(db, orgId, mine.id, rev([finding('x();', 'corp.other-org')]), ACTOR)))
      .toEqual({ status: 422, code: 'unknown_policy_version' });
  });

  it('the database refuses child rows whose org differs from the case org', () => {
    const c = newCase();
    expect(sqliteError(() => run("INSERT INTO cpg_case_events (id, case_id, org_id, seq, event, actor, details, created_at) VALUES (?, ?, ?, 1, 'submitted', 'test', '{}', ?)",
      randomUUID(), c.id, otherOrgId, NOW))).toBe('SQLITE_CONSTRAINT_TRIGGER: cpg_case_events: every referenced row must belong to the case org');
  });
});

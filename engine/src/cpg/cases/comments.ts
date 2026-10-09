import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { rawSqlite } from '../../db/migrations/runner.js';
import { cpgComments } from '../../db/schema-cpg.js';
import { appendAuditEvent } from '../audit/log.js';
import { activeMembers } from '../boards/service.js';
import { CpgError, notFound } from '../errors.js';
import { notifyCase } from '../notify/outbox.js';
import { caseLanes } from './lanes.js';
import { addCaseEvent, assertLatestFingerprints, getCase, openCase, openChangeRequests, refreshCaseState, type CaseRow } from './service.js';

/**
 * Case comments and the request-changes loop (design spec §5.3 rows 4 and
 * 5, §5.6). A board member asks for changes on findings of their lane; the
 * developer replies, marks each request resolved with a `resolves` reply, and
 * resubmits. A new revision with a changed finding set also clears them.
 * Everything is append-only: resolving is a reply plus a case event.
 */

type Db = BetterSQLite3Database<any>;
export type CommentRow = typeof cpgComments.$inferSelect;

interface CommentBase {
  orgId: string;
  caseId: string;
  userId: string;
  body: string;
  fingerprints: readonly string[];
}

export function listComments(db: Db, caseId: string): CommentRow[] {
  return db.select().from(cpgComments).where(eq(cpgComments.caseId, caseId)).orderBy(sql`rowid`).all();
}

function insertComment(db: Db, c: CaseRow, input: CommentBase, fields: Pick<CommentRow, 'kind' | 'threadId' | 'parentId' | 'boardId'> & { id: string }, now: string): CommentRow {
  const row: CommentRow = {
    ...fields, caseId: c.id, orgId: c.orgId, fingerprints: JSON.stringify([...input.fingerprints].sort()),
    authorUserId: input.userId, body: input.body, createdAt: now,
  };
  db.insert(cpgComments).values(row).run();
  return row;
}

/** A comment, or a reply to a thread. `resolves` marks a change request resolved (it still needs a resubmit). */
export function addComment(db: Db, input: CommentBase & { kind: 'comment' | 'reply'; threadId?: string; resolves?: boolean }): CommentRow {
  return rawSqlite(db).transaction(() => {
    const c = openCase(db, input.orgId, input.caseId);
    assertLatestFingerprints(db, c.id, input.fingerprints);
    let threadId: string | null = null;
    let threadBoard: string | null = null;
    if (input.kind === 'reply') {
      const root = db.select({ id: cpgComments.id, boardId: cpgComments.boardId }).from(cpgComments)
        .where(and(eq(cpgComments.id, input.threadId ?? ''), eq(cpgComments.caseId, c.id), isNull(cpgComments.parentId))).get();
      if (!root) throw notFound('Thread');
      threadId = root.id;
      threadBoard = root.boardId;
    }
    if (input.resolves && !(threadId && openChangeRequests(db, c.id).has(threadId))) {
      throw new CpgError(409, 'change_request_not_open', 'Only a reply to an open change request can resolve it');
    }
    const id = randomUUID();
    const actor = `user:${input.userId}`;
    const now = new Date().toISOString();
    const row = insertComment(db, c, input, { id, kind: input.kind, threadId: threadId ?? id, parentId: threadId, boardId: null }, now);
    const details = { commentId: id, threadId: row.threadId, kind: row.kind, resolves: input.resolves === true };
    addCaseEvent(db, c, 'comment_added', actor, details, now);
    appendAuditEvent(db, { orgId: c.orgId, actor, action: 'case.comment_added', targetType: 'case', targetId: c.id, payload: details });
    // A reply to a change request goes to that board's lane; any other reply to every lane.
    if (input.kind === 'reply') notifyCase(db, c, 'case.replied', { boardId: threadBoard });
    return row;
  }).immediate();
}

/**
 * Request changes for one lane (§5.3 row 4). The caller must be an active
 * member of the lane's board; the fingerprints must be findings of that lane.
 */
export function requestChanges(db: Db, input: CommentBase & { boardId: string }): CommentRow {
  return rawSqlite(db).transaction(() => {
    const c = openCase(db, input.orgId, input.caseId);
    const lane = caseLanes(db, c.orgId, c.id).find((l) => l.boardId === input.boardId);
    if (!lane) throw new CpgError(422, 'unknown_board', 'The board owns no finding of this case', { boardId: input.boardId });
    if (!activeMembers(db, lane.boardId).some((m) => m.userId === input.userId)) {
      throw new CpgError(403, 'not_eligible_voter', 'Only a member of the board can request changes for its lane', { boardId: lane.boardId });
    }
    const outside = input.fingerprints.filter((fp) => !lane.fingerprints.includes(fp));
    if (outside.length > 0) throw new CpgError(422, 'unknown_fingerprint', 'Not a finding of this lane', { fingerprints: outside });

    const id = randomUUID();
    const actor = `user:${input.userId}`;
    const now = new Date().toISOString();
    const row = insertComment(db, c, input, { id, kind: 'change_request', threadId: id, parentId: null, boardId: lane.boardId }, now);
    addCaseEvent(db, c, 'changes_requested', actor, { commentId: id, boardId: lane.boardId }, now);
    appendAuditEvent(db, {
      orgId: c.orgId, actor, action: 'case.changes_requested', targetType: 'case', targetId: c.id,
      payload: { commentId: id, boardId: lane.boardId, fingerprints: JSON.parse(row.fingerprints) as string[] },
    });
    refreshCaseState(db, c, actor, now);
    notifyCase(db, getCase(db, c.orgId, c.id), 'case.changes_requested', { boardId: lane.boardId });
    return row;
  }).immediate();
}

/** Resubmit after every open change request has a resolving reply (§5.3 row 5). */
export function resubmit(db: Db, input: { orgId: string; caseId: string; userId: string }): void {
  rawSqlite(db).transaction(() => {
    const c = openCase(db, input.orgId, input.caseId);
    const open = openChangeRequests(db, c.id);
    if (open.size === 0) throw new CpgError(409, 'no_change_requests', 'The case has no open change request to resubmit');
    const unresolved = [...open].filter(([, s]) => !s.resolved).map(([id]) => id);
    if (unresolved.length > 0) {
      throw new CpgError(409, 'change_requests_unresolved', 'Reply to every change request with resolves: true first', { commentIds: unresolved });
    }
    const actor = `user:${input.userId}`;
    const now = new Date().toISOString();
    addCaseEvent(db, c, 'submitted', actor, { via: 'resubmit', commentIds: [...open.keys()] }, now);
    appendAuditEvent(db, { orgId: c.orgId, actor, action: 'case.resubmitted', targetType: 'case', targetId: c.id, payload: { commentIds: [...open.keys()] } });
    refreshCaseState(db, c, actor, now);
    notifyCase(db, getCase(db, c.orgId, c.id), 'case.review_requested');
  }).immediate();
}

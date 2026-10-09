import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { rawSqlite } from '../../db/migrations/runner.js';
import { cpgBoardMembers, cpgBoards } from '../../db/schema-cpg.js';
import { users } from '../../db/schema.js';
import { appendAuditEvent } from '../audit/log.js';
import { CpgError, notFound } from '../errors.js';

/**
 * Review boards and their membership (design spec §2.3 T10, T11). Boards own
 * policies (each policy version names its owning boards) and, from Phase 4,
 * review lanes. Every change is written to the audit chain in the same
 * transaction.
 */

type Db = BetterSQLite3Database<any>;

export const BOARD_KINDS = ['governance', 'legal', 'ai', 'security', 'custom'] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];
export type BoardRow = typeof cpgBoards.$inferSelect;
export type BoardMemberRow = typeof cpgBoardMembers.$inferSelect;

export function getBoard(db: Db, orgId: string, boardId: string): BoardRow {
  const board = db.select().from(cpgBoards).where(and(eq(cpgBoards.id, boardId), eq(cpgBoards.orgId, orgId))).get();
  if (!board) throw notFound('Board');
  return board;
}

export function listBoards(db: Db, orgId: string): BoardRow[] {
  return db.select().from(cpgBoards).where(eq(cpgBoards.orgId, orgId)).orderBy(asc(cpgBoards.key)).all();
}

export function activeMembers(db: Db, boardId: string): BoardMemberRow[] {
  return db.select().from(cpgBoardMembers)
    .where(and(eq(cpgBoardMembers.boardId, boardId), isNull(cpgBoardMembers.removedAt)))
    .orderBy(asc(cpgBoardMembers.addedAt), asc(cpgBoardMembers.id)).all();
}

/** The active boards a user is a member of, for /cpg/me and /cpg/users. */
export function boardsOfUser(db: Db, orgId: string, userId: string): Array<{ id: string; name: string }> {
  return db.select({ id: cpgBoards.id, name: cpgBoards.name }).from(cpgBoardMembers)
    .innerJoin(cpgBoards, eq(cpgBoards.id, cpgBoardMembers.boardId))
    .where(and(eq(cpgBoardMembers.orgId, orgId), eq(cpgBoardMembers.userId, userId), isNull(cpgBoardMembers.removedAt), isNull(cpgBoards.archivedAt)))
    .orderBy(asc(cpgBoards.name), asc(cpgBoards.id)).all();
}

export function createBoard(db: Db, orgId: string, input: { key: string; name: string; kind: BoardKind; description?: string }, actor: string): BoardRow {
  return rawSqlite(db).transaction(() => {
    const taken = db.select({ id: cpgBoards.id }).from(cpgBoards).where(and(eq(cpgBoards.orgId, orgId), eq(cpgBoards.key, input.key))).get();
    if (taken) throw new CpgError(409, 'board_key_taken', `A board with key "${input.key}" already exists`);
    const row: BoardRow = {
      id: randomUUID(), orgId, key: input.key, name: input.name, kind: input.kind, description: input.description ?? '',
      createdBy: actor, createdAt: new Date().toISOString(), archivedAt: null, archivedBy: null,
    };
    db.insert(cpgBoards).values(row).run();
    appendAuditEvent(db, {
      orgId, actor, action: 'board.created', targetType: 'board', targetId: row.id,
      payload: { key: row.key, name: row.name, kind: row.kind },
    });
    return row;
  })();
}

export function updateBoard(db: Db, orgId: string, boardId: string, input: { name?: string; description?: string }, actor: string): BoardRow {
  return rawSqlite(db).transaction(() => {
    const before = getBoard(db, orgId, boardId);
    if (before.archivedAt) throw new CpgError(409, 'board_archived', 'The board is archived');
    const after = { name: input.name ?? before.name, description: input.description ?? before.description };
    if (after.name === before.name && after.description === before.description) return before;
    db.update(cpgBoards).set(after).where(eq(cpgBoards.id, boardId)).run();
    appendAuditEvent(db, {
      orgId, actor, action: 'board.updated', targetType: 'board', targetId: boardId,
      payload: { before: { name: before.name, description: before.description }, after },
    });
    return getBoard(db, orgId, boardId);
  })();
}

/**
 * Archive a board. Refused with 409 board_in_use while an active or pending
 * policy version names it as an owner (§2.3 T10).
 */
export function archiveBoard(db: Db, orgId: string, boardId: string, actor: string, boardInUse: (boardId: string) => string[]): BoardRow {
  return rawSqlite(db).transaction(() => {
    const before = getBoard(db, orgId, boardId);
    if (before.archivedAt) return before;
    const inUse = boardInUse(boardId);
    if (inUse.length > 0) throw new CpgError(409, 'board_in_use', 'The board owns active or pending policy versions', { policyKeys: inUse });
    db.update(cpgBoards).set({ archivedAt: new Date().toISOString(), archivedBy: actor }).where(eq(cpgBoards.id, boardId)).run();
    appendAuditEvent(db, { orgId, actor, action: 'board.archived', targetType: 'board', targetId: boardId, payload: { key: before.key } });
    return getBoard(db, orgId, boardId);
  })();
}

export function addBoardMember(db: Db, orgId: string, boardId: string, userId: string, actor: string): BoardMemberRow {
  return rawSqlite(db).transaction(() => {
    const board = getBoard(db, orgId, boardId);
    if (board.archivedAt) throw new CpgError(409, 'board_archived', 'The board is archived');
    const user = db.select({ id: users.id, orgId: users.orgId, isActive: users.isActive, role: users.role }).from(users).where(eq(users.id, userId)).get();
    // Cross-org ids are 404, never 403 (§9.1).
    if (!user || user.orgId !== orgId) throw notFound('User');
    if (!user.isActive) throw new CpgError(409, 'user_inactive', 'The user is deactivated');
    const existing = db.select().from(cpgBoardMembers)
      .where(and(eq(cpgBoardMembers.boardId, boardId), eq(cpgBoardMembers.userId, userId), isNull(cpgBoardMembers.removedAt))).get();
    if (existing) throw new CpgError(409, 'already_member', 'The user is already a member of the board');
    const row: BoardMemberRow = {
      id: randomUUID(), boardId, orgId, userId, addedBy: actor, addedAt: new Date().toISOString(), removedAt: null, removedBy: null,
    };
    db.insert(cpgBoardMembers).values(row).run();
    appendAuditEvent(db, { orgId, actor, action: 'board.member_added', targetType: 'board', targetId: boardId, payload: { userId, memberId: row.id } });
    return row;
  })();
}

export function removeBoardMember(db: Db, orgId: string, boardId: string, userId: string, actor: string): BoardMemberRow {
  return rawSqlite(db).transaction(() => {
    getBoard(db, orgId, boardId);
    const member = db.select().from(cpgBoardMembers)
      .where(and(eq(cpgBoardMembers.boardId, boardId), eq(cpgBoardMembers.userId, userId), isNull(cpgBoardMembers.removedAt))).get();
    if (!member) throw notFound('Board member');
    const removedAt = new Date().toISOString();
    db.update(cpgBoardMembers).set({ removedAt, removedBy: actor }).where(eq(cpgBoardMembers.id, member.id)).run();
    appendAuditEvent(db, { orgId, actor, action: 'board.member_removed', targetType: 'board', targetId: boardId, payload: { userId, memberId: member.id } });
    return { ...member, removedAt, removedBy: actor };
  })();
}

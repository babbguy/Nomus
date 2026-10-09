import { Hono } from 'hono';
import { inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { AppEnv } from '../../app.js';
import { getDb } from '../../../db/client.js';
import { users } from '../../../db/schema.js';
import { requireSessionOrApiKey } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { requireCpgPermission } from '../../../cpg/rbac/middleware.js';
import { can } from '../../../cpg/rbac/can.js';
import {
  activeMembers, addBoardMember, archiveBoard, createBoard, getBoard, listBoards, removeBoardMember, updateBoard,
  type BoardMemberRow, type BoardRow,
} from '../../../cpg/boards/service.js';
import { policiesOwnedByBoard } from '../../../cpg/policies/service.js';
import { invalidateCorporateBundle } from '../../../cpg/bundle/build.js';
import {
  addBoardMemberRequestSchema, boardMemberResponseSchema, boardResponseSchema, createBoardRequestSchema, emptyRequestSchema,
  listOf, patchBoardRequestSchema, type BoardMemberResponse, type BoardResponse,
} from '../../../cpg/contracts.js';
import { actorFrom, auditActor, handle, parseBody, pathParam } from './helpers.js';

/**
 * Review boards (design spec §9.2, E19 to E24). Reading needs policy.read
 * (user-bound keys too); every change needs boards.manage and a browser
 * session. Cross-org ids are 404.
 */
export const cpgBoardRoutes = new Hono<AppEnv>();

type Db = BetterSQLite3Database<any>;

function serializeMembers(db: Db, rows: BoardMemberRow[]): BoardMemberResponse[] {
  const ids = rows.map((r) => r.userId);
  const byId = new Map(ids.length ? db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids)).all().map((u) => [u.id, u]) : []);
  return rows.map((r) => ({
    id: r.id, boardId: r.boardId, userId: r.userId, userName: byId.get(r.userId)?.name ?? '', userEmail: byId.get(r.userId)?.email ?? '',
    addedAt: r.addedAt, addedBy: r.addedBy, removedAt: r.removedAt, removedBy: r.removedBy,
  }));
}

function serializeBoard(db: Db, b: BoardRow, withMembers: boolean): BoardResponse {
  const members = activeMembers(db, b.id);
  return boardResponseSchema.parse({
    id: b.id, key: b.key, name: b.name, kind: b.kind, description: b.description, createdAt: b.createdAt, createdBy: b.createdBy,
    archivedAt: b.archivedAt, archivedBy: b.archivedBy, memberCount: members.length,
    members: withMembers ? serializeMembers(db, members) : null,
  });
}

const manage = [requireSessionOrApiKey(), rateLimit(), requireCpgPermission('boards.manage')] as const;

// E19
cpgBoardRoutes.get('/', requireSessionOrApiKey('read:policies'), rateLimit(), requireCpgPermission('policy.read', { allowUserKey: true }), handle((c) => {
  const db = getDb();
  const actor = actorFrom(c);
  const withMembers = can(actor, 'boards.manage');
  const items = listBoards(db, actor.orgId).map((b) => serializeBoard(db, b, withMembers));
  return c.json(listOf(boardResponseSchema).parse({ items }));
}));

// E20
cpgBoardRoutes.post('/', ...manage, handle(async (c) => {
  const body = await parseBody(c, createBoardRequestSchema);
  const db = getDb();
  const board = createBoard(db, actorFrom(c).orgId, body, auditActor(c));
  return c.json(serializeBoard(db, board, true), 201);
}));

// E21
cpgBoardRoutes.patch('/:id', ...manage, handle(async (c) => {
  const body = await parseBody(c, patchBoardRequestSchema);
  const db = getDb();
  const orgId = actorFrom(c).orgId;
  const before = getBoard(db, orgId, pathParam(c, 'id'));
  const board = updateBoard(db, orgId, before.id, body, auditActor(c));
  // Board names travel in the bundle.
  if (board.name !== before.name) invalidateCorporateBundle(orgId, 'board_renamed');
  return c.json(serializeBoard(db, board, true));
}));

// E22
cpgBoardRoutes.post('/:id/archive', ...manage, handle(async (c) => {
  await parseBody(c, emptyRequestSchema);
  const db = getDb();
  const orgId = actorFrom(c).orgId;
  const board = archiveBoard(db, orgId, pathParam(c, 'id'), auditActor(c), (boardId) => policiesOwnedByBoard(db, orgId, boardId));
  return c.json(serializeBoard(db, board, true));
}));

// E23
cpgBoardRoutes.post('/:id/members', ...manage, handle(async (c) => {
  const body = await parseBody(c, addBoardMemberRequestSchema);
  const db = getDb();
  const member = addBoardMember(db, actorFrom(c).orgId, pathParam(c, 'id'), body.userId, auditActor(c));
  return c.json(boardMemberResponseSchema.parse(serializeMembers(db, [member])[0]), 201);
}));

// E24
cpgBoardRoutes.post('/:id/members/:userId/remove', ...manage, handle(async (c) => {
  await parseBody(c, emptyRequestSchema);
  const db = getDb();
  const member = removeBoardMember(db, actorFrom(c).orgId, pathParam(c, 'id'), pathParam(c, 'userId'), auditActor(c));
  return c.json(boardMemberResponseSchema.parse(serializeMembers(db, [member])[0]));
}));

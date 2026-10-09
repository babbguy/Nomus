import { inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { cpgComments, cpgPolicyVersions } from '../../db/schema-cpg.js';
import { boardIdsOf } from '../policies/service.js';
import { getCase, isBlocking, latestFindings, openChangeRequests } from './service.js';

/**
 * Review lanes (design spec §5.6): a case has one lane per owning board, and
 * lane `b` holds the latest-revision findings whose policy version names `b`.
 * A finding owned by two boards is in both lanes. Lanes are derived, never
 * stored.
 */

type Db = BetterSQLite3Database<any>;
export type LaneState = 'needs_review' | 'changes_requested' | 'decided';

export interface LaneFinding {
  fingerprint: string;
  owningBoardIds: readonly string[];
  blocking: boolean;
  /** Has a final decision or a standing-exception cover. */
  decided: boolean;
}

export interface Lane {
  boardId: string;
  /** Distinct fingerprints, sorted. */
  fingerprints: string[];
  /** Distinct blocking fingerprints, and how many of them are decided. */
  blocking: number;
  decided: number;
  state: LaneState;
}

/** Split findings into lanes, ordered by board id. `changeRequestBoards` are boards with an unresolved change request. */
export function splitIntoLanes(findings: readonly LaneFinding[], changeRequestBoards: ReadonlySet<string> = new Set()): Lane[] {
  const byBoard = new Map<string, Map<string, LaneFinding>>();
  for (const f of findings) {
    for (const boardId of f.owningBoardIds) {
      const lane = byBoard.get(boardId) ?? new Map<string, LaneFinding>();
      lane.set(f.fingerprint, f);
      byBoard.set(boardId, lane);
    }
  }
  return [...byBoard.keys()].sort().map((boardId) => {
    const lane = [...byBoard.get(boardId)!.values()];
    const blocking = lane.filter((f) => f.blocking);
    const decided = blocking.filter((f) => f.decided).length;
    const state: LaneState = changeRequestBoards.has(boardId) ? 'changes_requested'
      : decided === blocking.length ? 'decided' : 'needs_review';
    return { boardId, fingerprints: lane.map((f) => f.fingerprint).sort(), blocking: blocking.length, decided, state };
  });
}

/**
 * The lanes of a case's latest revision. Decisions (Phase 5) have no writer
 * yet, so every blocking finding is undecided. A lane with a change request
 * that no revision or resubmit has cleared is in changes_requested.
 */
export function caseLanes(db: Db, orgId: string, caseId: string): Lane[] {
  getCase(db, orgId, caseId);
  const findings = latestFindings(db, caseId);
  if (findings.length === 0) return [];
  const versionIds = [...new Set(findings.map((f) => f.policyVersionId))];
  const owners = new Map(db.select({ id: cpgPolicyVersions.id, owningBoardIds: cpgPolicyVersions.owningBoardIds })
    .from(cpgPolicyVersions).where(inArray(cpgPolicyVersions.id, versionIds)).all()
    .map((v) => [v.id, boardIdsOf(v)]));
  const open = [...openChangeRequests(db, caseId).keys()];
  const changeRequestBoards = new Set(open.length === 0 ? [] : db.select({ boardId: cpgComments.boardId }).from(cpgComments)
    .where(inArray(cpgComments.id, open)).all().map((r) => r.boardId!));
  return splitIntoLanes(findings.map((f) => ({
    fingerprint: f.fingerprint, owningBoardIds: owners.get(f.policyVersionId)!, blocking: isBlocking(f), decided: false,
  })), changeRequestBoards);
}

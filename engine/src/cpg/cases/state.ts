import type { CASE_STATES } from '../../db/schema-cpg.js';
import { CpgError } from '../errors.js';

/**
 * The review-case state machine (design spec §5.2, §5.3). The stored state
 * is a projection: every mutation recomputes it with deriveCaseState in its
 * own transaction and moves it only along TRANSITIONS.
 */

export type CaseState = (typeof CASE_STATES)[number];
type ActiveCaseState = Exclude<CaseState, 'closed'>;

/** What the state depends on, counted over the latest revision. */
export interface CaseFacts {
  /** Distinct blocking fingerprints with no final decision or standing-exception cover. */
  blockingUndecided: number;
  /** Of those, how many have no justification. */
  unjustified: number;
  /** Change requests (in any lane) not yet resolved. */
  openChangeRequests: number;
}

/** §5.2. `closed` is never derived: only an explicit close reaches it. */
export function deriveCaseState(f: CaseFacts): ActiveCaseState {
  if (f.openChangeRequests > 0) return 'changes_requested';
  if (f.blockingUndecided === 0) return 'decided';
  return f.unjustified === 0 ? 'in_review' : 'open';
}

/**
 * Allowed moves, from §5.3 (row numbers in the comments). `null` is a case
 * that does not exist yet. Two moves the table leaves out are added because a
 * new revision produces them exactly as it produces row 7: `in_review → open`
 * (the revision adds an unjustified blocking finding) and `open → decided`
 * (the revision has no blocking finding left).
 */
const TRANSITIONS: ReadonlyMap<CaseState | null, readonly CaseState[]> = new Map<CaseState | null, readonly CaseState[]>([
  [null, ['open', 'in_review']], // 1, 2
  ['open', ['in_review', 'decided', 'closed']], // 3, revision, 8–12
  ['in_review', ['changes_requested', 'decided', 'open', 'closed']], // 4, 6, revision, 8–12
  ['changes_requested', ['in_review', 'closed']], // 5, 8–12
  ['decided', ['changes_requested', 'in_review', 'open', 'closed']], // 4, 7, 8–12
  ['closed', []], // terminal
]);

export function canTransition(from: CaseState | null, to: CaseState): boolean {
  return TRANSITIONS.get(from)?.includes(to) ?? false;
}

/** Throws 409 invalid_transition for any move §5.3 does not allow. */
export function assertTransition(from: CaseState | null, to: CaseState): void {
  if (!canTransition(from, to)) {
    throw new CpgError(409, 'invalid_transition', `A case cannot move from ${from ?? 'nothing'} to ${to}`, { from, to });
  }
}

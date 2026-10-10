/**
 * The review-case state machine (design spec §5.2, §5.3): every pair of
 * states is checked against the allowed table, so a move added or dropped by
 * accident fails here.
 */
import { describe, it, expect } from 'vitest';
import { CASE_STATES } from '../../db/schema-cpg.js';
import { CpgError } from '../errors.js';
import { assertTransition, canTransition, deriveCaseState, type CaseState } from './state.js';

const ALLOWED: Array<[CaseState | null, CaseState, string]> = [
  [null, 'open', '#1 CI finds blocking undecided findings'],
  [null, 'in_review', '#2 request-review justifies every blocking finding'],
  ['open', 'in_review', '#3 the justification set is complete'],
  ['in_review', 'changes_requested', '#4 a lane requests changes'],
  ['decided', 'changes_requested', '#4 a lane requests changes after deciding'],
  ['changes_requested', 'in_review', '#5 new revision, or resolved and resubmitted'],
  ['in_review', 'decided', '#6 the last blocking finding is decided'],
  ['decided', 'in_review', '#7 a revision adds justified blocking findings'],
  ['decided', 'open', '#7 a revision adds unjustified blocking findings'],
  ['in_review', 'open', 'revision adds an unjustified blocking finding'],
  ['open', 'decided', 'revision leaves no blocking finding'],
  ['open', 'closed', '#8–12'],
  ['in_review', 'closed', '#8–12'],
  ['changes_requested', 'closed', '#8–12'],
  ['decided', 'closed', '#8–12'],
];

describe('§5.3 transition table', () => {
  for (const [from, to, why] of ALLOWED) {
    it(`allows ${from ?? '∅'} → ${to} (${why})`, () => {
      expect(canTransition(from, to)).toBe(true);
      expect(() => assertTransition(from, to)).not.toThrow();
    });
  }

  const allowed = new Set(ALLOWED.map(([from, to]) => `${from}>${to}`));
  const forbidden = [null, ...CASE_STATES].flatMap((from) => CASE_STATES.map((to) => [from, to] as const))
    .filter(([from, to]) => !allowed.has(`${from}>${to}`));

  it('forbids every other move: 15 of the 30 pairs, including all from closed and self-moves', () => {
    expect(forbidden).toHaveLength(15);
    for (const [from, to] of forbidden) {
      expect(canTransition(from, to), `${from} → ${to}`).toBe(false);
      let err: unknown;
      try { assertTransition(from, to); } catch (e) { err = e; }
      expect(err, `${from} → ${to}`).toBeInstanceOf(CpgError);
      expect((err as CpgError).status).toBe(409);
      expect((err as CpgError).code).toBe('invalid_transition');
    }
    expect(forbidden).toContainEqual(['closed', 'open']);
    expect(forbidden).toContainEqual([null, 'closed']);
    expect(forbidden).toContainEqual(['changes_requested', 'decided']);
    expect(forbidden).toContainEqual(['open', 'changes_requested']);
  });
});

describe('§5.2 deriveCaseState', () => {
  it('derives each state from the facts, change requests first', () => {
    expect(deriveCaseState({ blockingUndecided: 2, unjustified: 1, openChangeRequests: 0 })).toBe('open');
    expect(deriveCaseState({ blockingUndecided: 2, unjustified: 0, openChangeRequests: 0 })).toBe('in_review');
    expect(deriveCaseState({ blockingUndecided: 0, unjustified: 0, openChangeRequests: 0 })).toBe('decided');
    expect(deriveCaseState({ blockingUndecided: 2, unjustified: 0, openChangeRequests: 1 })).toBe('changes_requested');
    expect(deriveCaseState({ blockingUndecided: 0, unjustified: 0, openChangeRequests: 1 })).toBe('changes_requested');
  });
});

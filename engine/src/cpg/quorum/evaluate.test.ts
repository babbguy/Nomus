/**
 * The quorum evaluator (design spec §4.3), as a table: every tier × scope
 * of the seed config, overrides, extra and archived boards, coverage modes,
 * the required permission, vetoes, rejections, expiry ranges and the derived
 * proposal status including lapse.
 */
import { describe, it, expect } from 'vitest';
import { CpgError } from '../errors.js';
import { SEED_QUORUM_CONFIG, quorumConfigSchema, type QuorumConfig } from './schema.js';
import { expiryInRange, proposalStatus, requirementFor, tally, type Ballot, type Requirement } from './evaluate.js';

const AI = '00000000-0000-4000-8000-00000000000a';
const LEGAL = '00000000-0000-4000-8000-00000000000b';
const SEC = '00000000-0000-4000-8000-00000000000c';
const POLICY = '00000000-0000-4000-8000-0000000000f1';
const ACTIVE = new Set([AI, LEGAL, SEC]);
const NOW = '2026-10-09T12:00:00.000Z';
const days = (n: number, ms = 0) => new Date(Date.parse(NOW) + n * 86_400_000 + ms).toISOString();

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (!(err instanceof CpgError)) throw err;
    return `${err.status} ${err.code}`;
  }
}

const withOverride = (slot: object): QuorumConfig => quorumConfigSchema.parse({ ...SEED_QUORUM_CONFIG, policyOverrides: { [POLICY]: { snippet: slot } } });

describe('requirementFor: effective rule per tier, scope and override (§4.3 step 1)', () => {
  const target = (tier: 'advisory' | 'review-required' | 'prohibited', scope: 'snippet' | 'bulk' | 'standing', owning = [AI, LEGAL]) =>
    ({ tier, scope, policyId: POLICY, owningBoardIds: owning });

  it.each([
    ['review-required', 'snippet', { approvals: 1, boardCoverage: 'any_owning', requiredPermission: null, maxExpiryDays: 180 }],
    ['review-required', 'bulk', { approvals: 1, boardCoverage: 'any_owning', requiredPermission: null, maxExpiryDays: 180 }],
    ['review-required', 'standing', { approvals: 1, boardCoverage: 'any_owning', requiredPermission: 'exception.approve', maxExpiryDays: 90 }],
    ['prohibited', 'snippet', { approvals: 2, boardCoverage: 'all_owning', requiredPermission: null, maxExpiryDays: 90 }],
    ['prohibited', 'standing', { approvals: 2, boardCoverage: 'all_owning', requiredPermission: 'exception.approve', maxExpiryDays: 90 }],
  ] as const)('seed %s / %s', (tier, scope, expected) => {
    expect(requirementFor(SEED_QUORUM_CONFIG, target(tier, scope), ACTIVE)).toMatchObject({ ...expected, boardIds: [AI, LEGAL] });
  });

  it('advisory needs no decision (422); prohibited bulk is not allowed (422)', () => {
    for (const scope of ['snippet', 'bulk', 'standing'] as const) {
      expect(code(() => requirementFor(SEED_QUORUM_CONFIG, target('advisory', scope), ACTIVE))).toBe('422 advisory_needs_no_decision');
    }
    expect(code(() => requirementFor(SEED_QUORUM_CONFIG, target('prohibited', 'bulk'), ACTIVE))).toBe('422 scope_not_allowed');
  });

  it('an override replaces the whole slot: it can disallow a scope or change every field', () => {
    expect(code(() => requirementFor(withOverride({ allowed: false }), target('review-required', 'snippet'), ACTIVE))).toBe('422 scope_not_allowed');
    const slot = { allowed: true, approvals: 3, boardCoverage: 'all_owning', extraBoardIds: [SEC], requiredPermission: 'exception.approve', maxExpiryDays: 10, defaultExpiryDays: 5 };
    expect(requirementFor(withOverride(slot), target('review-required', 'snippet'), ACTIVE)).toEqual({
      approvals: 3, boardCoverage: 'all_owning', boardIds: [AI, LEGAL, SEC].sort(), requiredPermission: 'exception.approve', maxExpiryDays: 10, defaultExpiryDays: 5,
    });
    // Other policies and other scopes keep the tier rule.
    expect(requirementFor(withOverride(slot), { ...target('review-required', 'snippet'), policyId: SEC }, ACTIVE).approvals).toBe(1);
    expect(requirementFor(withOverride(slot), target('review-required', 'bulk'), ACTIVE).approvals).toBe(1);
  });

  it('an override can never enable bulk on a prohibited policy', () => {
    const cfg = quorumConfigSchema.parse({ ...SEED_QUORUM_CONFIG, policyOverrides: { [POLICY]: { bulk: SEED_QUORUM_CONFIG.tiers['review-required'].bulk } } });
    expect(code(() => requirementFor(cfg, target('prohibited', 'bulk'), ACTIVE))).toBe('422 scope_not_allowed');
  });

  it('archived boards drop out of the required set; none left is 409 no_active_owning_board', () => {
    expect(requirementFor(SEED_QUORUM_CONFIG, target('prohibited', 'snippet'), new Set([LEGAL])).boardIds).toEqual([LEGAL]);
    expect(code(() => requirementFor(SEED_QUORUM_CONFIG, target('prohibited', 'snippet'), new Set([SEC])))).toBe('409 no_active_owning_board');
  });
});

describe('expiry range (§4.3 step 6)', () => {
  it.each([
    [days(0), false], [days(0, 1), true], [days(30), true], [days(90), true], [days(90, 1), false], [days(-1), false],
  ])('%s within (now, now + 90 days] is %s', (at, ok) => {
    expect(expiryInRange(at, NOW, 90)).toBe(ok);
  });
});

describe('tally: coverage, approvals, required permission, veto and rejection (§4.3 steps 4 and 5)', () => {
  const req = (over: Partial<Requirement> = {}): Requirement => ({
    approvals: 2, boardCoverage: 'all_owning', boardIds: [AI, LEGAL], requiredPermission: null, maxExpiryDays: 90, defaultExpiryDays: 30, ...over,
  });
  const ballot = (voterUserId: string, boards: string[], vote: 'approve' | 'reject' = 'approve', permissions: string[] = ['case.review']): Ballot =>
    ({ voterUserId, vote, boards, permissions });

  it.each([
    ['one approval of two', req(), [ballot('u1', [AI])], 'pending'],
    ['two approvals, both from AI (all_owning uncovered)', req(), [ballot('u1', [AI]), ballot('u2', [AI])], 'pending'],
    ['two approvals covering AI and Legal', req(), [ballot('u1', [AI]), ballot('u2', [LEGAL])], 'reached'],
    ['one voter in both boards still counts once', req(), [ballot('u1', [AI, LEGAL])], 'pending'],
    ['any_owning: one approval from either board', req({ approvals: 1, boardCoverage: 'any_owning' }), [ballot('u1', [LEGAL])], 'reached'],
    ['required permission missing', req({ approvals: 1, boardCoverage: 'any_owning', requiredPermission: 'exception.approve' }), [ballot('u1', [AI])], 'pending'],
    ['required permission held by one approver', req({ requiredPermission: 'exception.approve' }), [ballot('u1', [AI]), ballot('u2', [LEGAL], 'approve', ['exception.approve'])], 'reached'],
    ['one reject vetoes, whatever else (D12)', req({ approvals: 1, boardCoverage: 'any_owning' }), [ballot('u1', [AI]), ballot('u2', [LEGAL], 'reject')], 'vetoed'],
  ] as const)('approve proposal: %s → %s', (_name, r, ballots, state) => {
    expect(tally('approve', r, ballots).state).toBe(state);
  });

  it('reports the deciding voters sorted', () => {
    expect(tally('approve', req(), [ballot('u2', [LEGAL]), ballot('u1', [AI])])).toEqual({ state: 'reached', deciders: ['u1', 'u2'] });
  });

  it('a reject proposal is carried by one eligible reject vote, never needing the approval quorum', () => {
    expect(tally('reject', req({ approvals: 5 }), [ballot('u1', [AI], 'reject')])).toEqual({ state: 'reached', deciders: ['u1'] });
    expect(tally('reject', req(), [])).toEqual({ state: 'pending' });
  });
});

describe('proposalStatus: derived in the order of §5.5', () => {
  const base = { finalized: false, vetoed: false, invalidated: false, caseClosed: false, lapsesAt: days(30) };
  it.each([
    [{ ...base, finalized: true, vetoed: true, invalidated: true, caseClosed: true, lapsesAt: days(-1) }, NOW, 'finalized'],
    [{ ...base, vetoed: true, invalidated: true, caseClosed: true }, NOW, 'vetoed'],
    [{ ...base, invalidated: true, caseClosed: true }, NOW, 'invalidated'],
    [{ ...base, caseClosed: true, lapsesAt: days(-1) }, NOW, 'void'],
    [base, days(30, 1), 'lapsed'],
    [base, days(30), 'pending'],
  ] as const)('%o at %s → %s', (facts, at, status) => {
    expect(proposalStatus(facts, at)).toBe(status);
  });
});

import { z } from 'zod';
import { CpgError } from '../errors.js';
import type { QuorumConfig, TIERS } from './schema.js';

/**
 * The quorum evaluator (design spec §4.3). Pure: callers load the config,
 * the policy version, the org's active boards and the votes, and this module
 * decides. The same functions run when a proposal is created and again, with
 * the config then in force, every time a vote may finalize it.
 */

export type Scope = 'snippet' | 'bulk' | 'standing';
export type Tier = (typeof TIERS)[number];
export type Outcome = 'approve' | 'reject';

const DAY_MS = 86_400_000;

/** What a proposal must collect (§4.3 step 1), snapshotted into cpg_proposals.required. */
export const requirementSchema = z.object({
  approvals: z.number().int().min(1),
  boardCoverage: z.enum(['all_owning', 'any_owning']),
  /** The required boards: owning plus extra, minus archived; sorted. */
  boardIds: z.array(z.string().uuid()).min(1),
  requiredPermission: z.enum(['exception.approve']).nullable(),
  maxExpiryDays: z.number().int().min(1),
  defaultExpiryDays: z.number().int().min(1),
}).strict();
export type Requirement = z.infer<typeof requirementSchema>;

export interface DecisionTarget {
  scope: Scope;
  tier: Tier;
  policyId: string;
  owningBoardIds: readonly string[];
}

/**
 * §4.3 step 1: the effective rule. A per-policy override replaces the whole
 * scope slot (no field-level merge), so what applied is unambiguous.
 */
export function requirementFor(config: QuorumConfig, target: DecisionTarget, activeBoardIds: ReadonlySet<string>): Requirement {
  if (target.tier === 'advisory') throw new CpgError(422, 'advisory_needs_no_decision', 'Advisory findings never block and need no decision');
  const rule = config.policyOverrides[target.policyId]?.[target.scope] ?? config.tiers[target.tier][target.scope];
  // Bulk on prohibited is refused here whatever an override says, and by the cpg_proposals CHECK.
  if (!rule.allowed || (target.scope === 'bulk' && target.tier === 'prohibited')) {
    throw new CpgError(422, 'scope_not_allowed', `A ${target.scope} decision is not allowed on this ${target.tier} policy`, { scope: target.scope, tier: target.tier });
  }
  const boardIds = [...new Set([...target.owningBoardIds, ...rule.extraBoardIds])].filter((b) => activeBoardIds.has(b)).sort();
  if (boardIds.length === 0) throw new CpgError(409, 'no_active_owning_board', 'No active board owns this policy');
  return {
    approvals: rule.approvals, boardCoverage: rule.boardCoverage, boardIds, requiredPermission: rule.requiredPermission,
    maxExpiryDays: rule.maxExpiryDays, defaultExpiryDays: rule.defaultExpiryDays,
  };
}

/** §4.3 step 6: an approval expires in (now, now + maxExpiryDays]. */
export function expiryInRange(expiresAt: string, now: string, maxExpiryDays: number): boolean {
  const at = Date.parse(expiresAt);
  const from = Date.parse(now);
  return at > from && at <= from + maxExpiryDays * DAY_MS;
}

export function assertExpiry(expiresAt: string, now: string, maxExpiryDays: number): void {
  if (!expiryInRange(expiresAt, now, maxExpiryDays)) {
    throw new CpgError(422, 'expiry_out_of_range', `The expiry must be after now and at most ${maxExpiryDays} days ahead`, {
      maxExpiryDays, latest: new Date(Date.parse(now) + maxExpiryDays * DAY_MS).toISOString(),
    });
  }
}

export const lapsesAt = (createdAt: string, lapseDays: number) => new Date(Date.parse(createdAt) + lapseDays * DAY_MS).toISOString();

/** One recorded vote, with the boards and permissions its voter held at vote time. */
export interface Ballot {
  voterUserId: string;
  vote: Outcome;
  boards: readonly string[];
  permissions: readonly string[];
}

export type Tally =
  | { state: 'pending' }
  /** D12: one eligible reject vote vetoes an approve proposal. */
  | { state: 'vetoed' }
  /** Quorum met: `deciders` are the sorted voters whose votes carried the outcome. */
  | { state: 'reached'; deciders: string[] };

/**
 * §4.3 steps 4 and 5. Every recorded vote is eligible (ineligible voters are
 * refused before a vote is written). A reject proposal is carried by its
 * eligible proposer's own reject vote: denial never needs more than approval.
 */
export function tally(outcome: Outcome, req: Requirement, ballots: readonly Ballot[]): Tally {
  const sorted = (bs: readonly Ballot[]) => [...new Set(bs.map((b) => b.voterUserId))].sort();
  const rejects = ballots.filter((b) => b.vote === 'reject');
  if (outcome === 'reject') return rejects.length > 0 ? { state: 'reached', deciders: sorted(rejects) } : { state: 'pending' };
  if (rejects.length > 0) return { state: 'vetoed' };

  const approves = ballots.filter((b) => b.vote === 'approve');
  const covers = (board: string) => approves.some((b) => b.boards.includes(board));
  const covered = req.boardCoverage === 'all_owning' ? req.boardIds.every(covers) : req.boardIds.some(covers);
  const permitted = req.requiredPermission === null || approves.some((b) => b.permissions.includes(req.requiredPermission!));
  const counted = sorted(approves);
  return counted.length >= req.approvals && covered && permitted ? { state: 'reached', deciders: counted } : { state: 'pending' };
}

export type ProposalStatus = 'finalized' | 'vetoed' | 'invalidated' | 'void' | 'lapsed' | 'pending';

/** §5.5, in this order. */
export function proposalStatus(f: { finalized: boolean; vetoed: boolean; invalidated: boolean; caseClosed: boolean; lapsesAt: string }, now: string): ProposalStatus {
  if (f.finalized) return 'finalized';
  if (f.vetoed) return 'vetoed';
  if (f.invalidated) return 'invalidated';
  if (f.caseClosed) return 'void';
  return now > f.lapsesAt ? 'lapsed' : 'pending';
}

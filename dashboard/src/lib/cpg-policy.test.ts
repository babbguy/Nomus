import { describe, it, expect } from 'vitest';
import * as fx from '../test/cpg-fixtures';
import type { CpgMe, PolicyDetail } from '../api/cpg-schemas';
import {
  describeRule, enforcementSummary, formatUtc, fourEyesStatus, jsonDiff, policyErrorMessage, userRoleLabel, versionDiff,
} from './cpg-policy';
import { compileInputProblems, ruleEditProblems, tomorrowUtc } from './cpg-policy-forms';
import { pathLabel, quorumChanges, quorumIssues, removeAt, setAt, slotSummary, toggledSlot } from './cpg-quorum-form';

const detail = fx.policyDetail as PolicyDetail;
const meAs = (userId: string, permissions: string[]): CpgMe => fx.me({
  user: { id: userId, name: 'X', email: 'x@example.org' },
  permissions: permissions.map((key) => ({ key, scope: 'org' as const, scopeId: null })),
});
const apiError = (status: number, body: unknown) => ({ response: { status, data: body } });

describe('rule description (derived from the rule data, not generated)', () => {
  it('reads an SDK rule with a gateway exclusion', () => {
    expect(describeRule(fx.sdkRule)).toEqual([
      'Flags any call through the OpenAI SDK.',
      'Applies to files matching **/*, except src/llm/gateway/**.',
      'Developers see: "Call OpenAI only through the approved LLM gateway."',
    ]);
  });

  it('reads companions, windows and unless clauses', () => {
    const lines = describeRule({
      ...fx.sdkRule,
      match: {
        all: [{ kind: 'sdk_call', sdks: ['openai'], methods: ['chat.completions.create'] }, { kind: 'data_pattern', categories: ['pii'], labels: ['ssn'] }],
        withinLines: 20,
        unless: [{ kind: 'line_regex', pattern: { source: 'moderations', flags: 'i', ignoreComments: true } }],
        unlessScope: 'window',
      },
      files: { include: ['src/**'], exclude: [], languages: ['typescript'] },
    });
    expect(lines[0]).toBe('Flags a call to chat.completions.create of the OpenAI SDK.');
    expect(lines[1]).toBe('Only when within 20 lines there is also data of the kind ssn (pii).');
    expect(lines[2]).toBe('Not when within 20 lines there is a line matching the pattern /moderations/i (comments ignored).');
    expect(lines).toContain('Languages: typescript.');
  });
});

describe('diffs', () => {
  it('jsonDiff reports leaf paths', () => {
    expect(jsonDiff({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 3] }, d: true })).toEqual([
      { path: 'b.c[1]', before: 2, after: 3 },
      { path: 'd', before: null, after: true },
    ]);
    expect(jsonDiff({ x: [1] }, { x: [1] })).toEqual([]);
  });

  it('versionDiff lists tier, boards, grace and rule changes between versions', () => {
    const rows = versionDiff(detail.versions[0], detail.versions[1]);
    const fields = rows.map((r) => r.field);
    expect(fields).toContain('Tier');
    expect(fields).toContain('Owning boards');
    expect(fields).toContain('Grace period (days)');
    expect(fields).toContain('Rule message');
    expect(fields).not.toContain('Title');
    expect(rows.find((r) => r.field === 'Tier')).toEqual({ field: 'Tier', before: 'Review required', after: 'Prohibited' });
    expect(versionDiff(detail.versions[0], detail.versions[0])).toEqual([]);
  });
});

describe('four-eyes status of the pending version', () => {
  it('the author is told why they cannot vote, and can withdraw', () => {
    const s = fourEyesStatus(detail, meAs(fx.AUTHOR_ID, ['policy.approve', 'policy.author']))!;
    expect(s.canVote).toBe(false);
    expect(s.voteBlockedReason).toMatch(/You proposed this version/);
    expect(s.canWithdraw).toBe(true);
    expect([s.approvals, s.required]).toEqual([0, 1]);
  });

  it('the compile requester is refused even when someone else proposed', () => {
    const other = { ...detail, versions: detail.versions.map((v) => (v.id === fx.V2_ID ? { ...v, createdBy: `user:${fx.OWNER_ID}` } : v)) };
    const s = fourEyesStatus(other, meAs(fx.AUTHOR_ID, ['policy.approve']))!;
    expect(s.voteBlockedReason).toMatch(/You compiled this rule/);
    expect(s.canWithdraw).toBe(false);
  });

  it('an approver may vote once; others need policy.approve', () => {
    expect(fourEyesStatus(detail, meAs(fx.APPROVER_ID, ['policy.approve']))!.canVote).toBe(true);
    expect(fourEyesStatus(detail, meAs(fx.APPROVER_ID, ['policy.read']))!.voteBlockedReason).toMatch(/policy\.approve/);
    const voted = { ...detail, votes: [...detail.votes, { ...detail.votes[0], id: '0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f', versionId: fx.V2_ID }] };
    const s = fourEyesStatus(voted, meAs(fx.APPROVER_ID, ['policy.approve']))!;
    expect(s.voteBlockedReason).toBe('You already voted (approve).');
    expect(s.approvals).toBe(1);
  });

  it('is null without a pending version', () => {
    expect(fourEyesStatus({ ...detail, policy: { ...detail.policy, pendingVersionId: null, pendingVersion: null } }, fx.me())).toBeNull();
  });
});

describe('enforcement and dates', () => {
  const now = Date.parse('2026-10-09T08:00:00.000Z');
  it('grace period, enforced, retired, not active', () => {
    expect(enforcementSummary(fx.policyHead, now)).toEqual({ label: 'Grace period', variant: 'warning', detail: 'Advisory until Oct 22, 2026, 08:00 UTC (13 days), then enforced.' });
    expect(enforcementSummary({ ...fx.policyHead, inGracePeriod: false }, now).label).toBe('Enforced');
    expect(enforcementSummary({ ...fx.policyHead, state: 'retired' }, now).label).toBe('Retired');
    expect(enforcementSummary({ ...fx.policyHead, state: 'proposed', enforceFrom: null }, now).label).toBe('Not active');
    expect(enforcementSummary({ ...fx.policyHead, tier: 'advisory' }, now).label).toBe('Advisory');
  });

  it('formats instants in UTC and never shows Invalid Date', () => {
    expect(formatUtc('2026-10-22T08:00:00.000Z')).toBe('Oct 22, 2026, 08:00 UTC');
    expect(formatUtc('not a date')).toBe('—');
    expect(formatUtc(null)).toBe('—');
    expect(tomorrowUtc(now)).toBe('2026-10-10');
  });
});

describe('error messages', () => {
  it('lists validation reasons and failing examples', () => {
    expect(policyErrorMessage(apiError(422, { error: 'The edited rule is not valid', code: 'rule_validation_failed', details: { reasons: ['rule.match.all.0.sdks.0: Invalid enum value'] } }), 'x'))
      .toBe('The edited rule is not valid: rule.match.all.0.sdks.0: Invalid enum value');
    const examples = policyErrorMessage(apiError(422, { error: "The edited rule does not satisfy the compile record's examples", code: 'rule_examples_failed', details: { exampleResults: fx.examplesRecord.exampleResults } }), 'x');
    expect(examples).toContain('Violating example 1 (src/util.ts): FAILED, expected at least one finding, got no finding.');
  });

  it('marks a four-eyes refusal, names board keys, and explains server errors', () => {
    expect(policyErrorMessage(apiError(403, { error: 'You cannot vote on a policy version you proposed or compiled', code: 'self_approval_forbidden' }), 'x'))
      .toBe('Refused (four-eyes): You cannot vote on a policy version you proposed or compiled');
    expect(policyErrorMessage(apiError(409, { error: 'Board in use', code: 'board_in_use', details: { policyKeys: ['corp.a', 'corp.b'] } }), 'x')).toBe('Board in use: Policies: corp.a, corp.b');
    expect(policyErrorMessage(apiError(500, 'Internal Server Error'), 'Saving failed')).toBe('Saving failed (server error 500). Try again; if it keeps failing, check the engine logs.');
    expect(policyErrorMessage(apiError(400, { error: 'Invalid input', code: 'invalid_input', details: [{ path: ['config', 'proposalLapseDays'], message: 'too big' }] }), 'x'))
      .toBe('Invalid input: config.proposalLapseDays: too big');
  });
});

describe('sidebar role label (brief §9)', () => {
  it('keeps the legacy label for platform admins and users without governance roles', () => {
    expect(userRoleLabel('platform_admin', fx.me())).toBe('Admin');
    expect(userRoleLabel('member', null)).toBe('Member');
    expect(userRoleLabel('member', fx.me({ roles: [] }))).toBe('Member');
    expect(userRoleLabel('member', fx.me({ isPlatformAdmin: true }))).toBe('Member');
  });

  it('shows the most privileged governance role plus +N', () => {
    expect(userRoleLabel('member', fx.me())).toBe('Org Admin +1');
    expect(userRoleLabel('member', fx.me({ roles: [{ id: fx.ROLE_DEV_ID, key: 'developer', name: 'Developer', isSystem: true }] }))).toBe('Developer');
    expect(userRoleLabel('member', fx.me({ roles: [
      { id: fx.ROLE_CUSTOM_ID, key: 'repo_reader', name: 'Repo Reader', isSystem: false },
      { id: fx.ROLE_DEV_ID, key: 'developer', name: 'Developer', isSystem: true },
      { id: fx.ROLE_ADMIN_ID, key: 'policy_approver', name: 'Policy Approver', isSystem: true },
    ] }))).toBe('Policy Approver +2');
  });
});

describe('authoring form checks', () => {
  it('compile input limits mirror the server', () => {
    expect(compileInputProblems('short', [{ path: '', code: '' }], [])).toEqual([
      'Describe the policy in at least 20 characters.',
      'Violating example 1: give a file path (for example src/app/chat.ts).',
      'Violating example 1: paste the code.',
    ]);
    expect(compileInputProblems('A policy text that is long enough.', [{ path: 'src/a.ts', code: 'x' }], [])).toEqual([]);
    expect(compileInputProblems('A policy text that is long enough.', [], [])).toContain('Add at least one violating example.');
  });

  it('an edited rule must be JSON with the rule structure; defaults may be omitted', () => {
    expect(ruleEditProblems('{')[0]).toMatch(/^Not valid JSON/);
    expect(ruleEditProblems(JSON.stringify(fx.sdkRule))).toEqual([]);
    expect(ruleEditProblems(JSON.stringify({ schemaVersion: 1, match: { all: [{ kind: 'sdk_import', sdks: ['openai'] }] }, files: {}, message: 'Do not import the OpenAI SDK.' }))).toEqual([]);
    expect(ruleEditProblems(JSON.stringify({ ...fx.sdkRule, extra: 1 }))[0]).toMatch(/Unrecognized key/);
    expect(ruleEditProblems(JSON.stringify({ ...fx.sdkRule, match: { all: [] } }))[0]).toMatch(/^rule\.match\.all/);
  });
});

describe('quorum form', () => {
  it('the seed configuration is valid', () => {
    expect(quorumIssues(fx.quorumConfig)).toEqual([]);
  });

  it('bulk can never be enabled on the prohibited tier', () => {
    const bad = setAt(fx.quorumConfig, ['tiers', 'prohibited', 'bulk'], fx.quorumConfig.tiers['review-required'].bulk);
    const issues = quorumIssues(bad);
    expect(issues.some((i) => i.path === 'tiers.prohibited.bulk.allowed')).toBe(true);
  });

  it('reports out-of-range numbers and cross-field rules on the slot the admin edited', () => {
    const zero = setAt(fx.quorumConfig, ['tiers', 'review-required', 'snippet', 'approvals'], 0);
    expect(quorumIssues(zero)).toEqual([{ path: 'tiers.review-required.snippet.approvals', message: 'Number must be greater than or equal to 1' }]);
    const inverted = setAt(fx.quorumConfig, ['tiers', 'prohibited', 'snippet', 'defaultExpiryDays'], 120);
    expect(quorumIssues(inverted).map((i) => i.message)).toContain('defaultExpiryDays must be <= maxExpiryDays');
    const tooLong = setAt(fx.quorumConfig, ['standingExceptions', 'maxExpiryDays'], 20);
    const msgs = quorumIssues(tooLong).map((i) => `${i.path}: ${i.message}`);
    expect(msgs).toContain('tiers.review-required.standing.maxExpiryDays: exceeds standingExceptions.maxExpiryDays');
    expect(msgs).toContain('standingExceptions.defaultExpiryDays: must be <= maxExpiryDays');
    expect(quorumIssues(setAt(fx.quorumConfig, ['policyApproval', 'approvals'], -1))[0].path).toBe('policyApproval.approvals');
  });

  it('updates are immutable; changes and labels are readable', () => {
    const next = setAt(fx.quorumConfig, ['proposalLapseDays'], 45);
    expect(fx.quorumConfig.proposalLapseDays).toBe(30);
    expect(quorumChanges(fx.quorumConfig, next)).toEqual([{ field: 'Proposal lapses after (days)', before: '30', after: '45' }]);
    const withOverride = setAt(next, ['policyOverrides', fx.POLICY_ID], { snippet: toggledSlot(true, undefined) });
    expect(quorumChanges(next, withOverride, new Map([[fx.POLICY_ID, 'corp.no-gpt-4-32k']]))[0].field).toBe('Override for corp.no-gpt-4-32k');
    expect(removeAt(withOverride, ['policyOverrides', fx.POLICY_ID]).policyOverrides).toEqual({});
    expect(pathLabel('tiers.prohibited.snippet.approvals')).toBe('Prohibited · One finding (snippet) · Approvals');
    expect(toggledSlot(false, fx.quorumConfig.tiers.prohibited.snippet)).toEqual({ allowed: false });
    expect(slotSummary(fx.quorumConfig.tiers.prohibited.snippet)).toBe('2 approvals; one from each owning board; expiry up to 90 days (default 30)');
    expect(slotSummary({ allowed: false })).toBe('Not allowed');
  });
});

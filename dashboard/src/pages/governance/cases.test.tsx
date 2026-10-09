import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { CaseTable } from './GovernanceCases';
import { CaseView } from './CaseDetail';
import { FindingList } from './cases/Findings';
import * as fx from '../../test/cpg-fixtures';
import { FindingDecision, type DecisionContext } from './cases/Decisions';
import { ProposalCard } from './decisions/parts';
import {
  caseDetailSchema, caseSummarySchema, proposalSchema, revisionDetailSchema, standingExceptionSchema, type CaseDetail, type CpgMe,
} from '../../api/cpg';
import { exceptionRows, lapsingCount, parseDays, progressText, quorumProgress, requirementText, scopeRule } from '../../lib/cpg-approvals';
import { asSentence, breakablePath, caseActions, pageNote, pullRequestUrl, threadsOf } from '../../lib/cpg-cases';
import { missingPermissions } from '../../lib/cpg-permissions';

const text = (node: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>)
  .replace(/<\/span><wbr\/><span class="whitespace-nowrap">/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const expectClean = (t: string) => { for (const re of fx.BROKEN) expect(t).not.toMatch(re); };

const CASE_ID = '6f1c2d3e-4a5b-4c6d-8e7f-901234567890';
const DEV_ID = '11111111-1111-4111-8111-111111111111';
const REVIEWER_ID = '22222222-2222-4222-8222-222222222222';
const AI = '33333333-3333-4333-8333-333333333333';
const LEGAL = '44444444-4444-4444-8444-444444444444';
const POLICY_ID = '55555555-5555-4555-8555-555555555555';
const FP = `${'a'.repeat(64)}:corp.no-direct-openai:1`;
const T = '2026-10-09T08:00:00.000Z';

const lanes = [
  { boardId: AI, boardName: 'AI Review Board', state: 'changes_requested' as const, blocking: 1, decided: 0 },
  { boardId: LEGAL, boardName: 'Legal Board', state: 'needs_review' as const, blocking: 1, decided: 0 },
];
const summary = caseSummarySchema.parse({
  id: CASE_ID, ref: 'CPG-6F1C2D3E', repo: 'example-org/support-app', branch: 'feat/chat', prNumber: 42, state: 'changes_requested',
  closeReason: null, latestRevision: 1, openedAt: T, updatedAt: T, closedAt: null, openedBy: { actor: `user:${DEV_ID}`, name: 'Dana Developer' }, lanes,
});
const request = {
  id: '66666666-6666-4666-8666-666666666666', threadId: '66666666-6666-4666-8666-666666666666', parentId: null, kind: 'change_request' as const,
  boardId: AI, fingerprints: [FP], authorUserId: REVIEWER_ID, authorName: 'Rita Reviewer', body: 'Use the gateway client.', createdAt: T,
};
const reply = { ...request, id: '77777777-7777-4777-8777-777777777777', parentId: request.id, kind: 'reply' as const, boardId: null, fingerprints: [], authorUserId: DEV_ID, authorName: 'Dana Developer', body: 'Moving it next sprint.' };
const detail: CaseDetail = caseDetailSchema.parse({
  case: {
    id: CASE_ID, ref: summary.ref, repo: summary.repo, branch: summary.branch, prNumber: 42, state: 'changes_requested', closeReason: null, latestRevision: 1,
    url: `https://nomus.example.org/governance/cases/${CASE_ID}`, lanes,
    openChangeRequests: [{ commentId: request.id, boardName: 'AI Review Board', authorName: 'Rita Reviewer', body: request.body, fingerprints: [FP], createdAt: T }],
    resolutions: [{ fingerprint: FP, status: 'changes_requested', blocking: true, tier: 'prohibited', enforceFrom: T, decisionId: null, exceptionDecisionId: null, expiresAt: null }],
    updatedAt: T,
  },
  openedAt: T, openedBy: summary.openedBy, closure: null,
  viewer: { comment: true, review: true, close: true, withdraw: true, revoke: false, selfApproval: false },
  revisions: [{ revision: 1, source: 'vscode', headSha: null, findingsDigest: 'b'.repeat(64), addedCount: 1, carriedCount: 0, resolvedCount: 0, createdAt: T }],
  justifications: [{ id: '88888888-8888-4888-8888-888888888888', fingerprint: FP, authorUserId: DEV_ID, authorName: 'Dana Developer', body: 'Streaming is needed first.', createdAt: T }],
  comments: [request, reply],
});
const closedDetail: CaseDetail = caseDetailSchema.parse({
  ...detail,
  case: { ...detail.case, state: 'closed', closeReason: 'closed_by_reviewer', openChangeRequests: [] },
  viewer: { comment: true, review: true, close: true, withdraw: true, revoke: false, selfApproval: false },
  closure: {
    reason: 'closed_by_reviewer', note: 'Replaced by another branch.', closedAt: T, closedBy: { actor: `user:${REVIEWER_ID}`, name: 'Rita Reviewer' },
    record: { kind: 'nomus.cpg-case-closure.v1', caseId: CASE_ID }, signature: 'c2lnbmF0dXJl', signatureValid: true,
  },
});
const revision = revisionDetailSchema.parse({
  revision: detail.revisions[0],
  findings: [{
    id: '99999999-9999-4999-8999-999999999999', fingerprint: FP, policyId: POLICY_ID, policyKey: 'corp.no-direct-openai', policyTitle: 'No direct OpenAI calls',
    policyVersion: 1, tier: 'prohibited', blocking: true, owningBoardIds: [AI, LEGAL], statusAtRevision: 'new', filePath: 'src/chat.ts', startLine: 3, endLine: 4,
    language: 'typescript', snippet: 'const r = await openai.chat.completions.create({\n  model });', justification: detail.justifications[0], contextStatus: 'none',
  }],
});
const meAs = (userId: string, keys: string[], boards: Array<{ id: string; name: string }> = [], over: Partial<CpgMe> = {}) => fx.me({
  user: { id: userId, name: 'X', email: 'x@example.org' }, cpgEnabled: true, boards,
  permissions: keys.map((key) => ({ key, scope: 'org' as const, scopeId: null })), ...over,
});
const reviewer = meAs(REVIEWER_ID, ['case.read', 'case.review'], [{ id: AI, name: 'AI Review Board' }]);
const dev = meAs(DEV_ID, ['case.read', 'case.create']);
const asViewer = (d: CaseDetail, viewer: CaseDetail['viewer']) => ({ ...d, viewer });

describe('case pages: rules', () => {
  it('pages that the permission filter shortened say so; full and last pages do not', () => {
    expect(pageNote(0, 25, true)).toMatch(/^No case on this page is in a repository you can read/);
    expect(pageNote(3, 25, true)).toMatch(/fewer cases than usual/);
    expect([pageNote(25, 25, true), pageNote(3, 25, false), pageNote(0, 25, false)]).toEqual([null, null, null]);
  });

  it('links a pull request only for GitHub repositories (owner/name)', () => {
    expect(pullRequestUrl('example-org/app', 7)).toBe('https://github.com/example-org/app/pull/7');
    expect([pullRequestUrl('git.example.org/team/app', 7), pullRequestUrl('example-org/app', null)]).toEqual([null, null]);
  });

  it('adds a full stop only when the text has no closing mark', () => {
    expect([asSentence('Connection error.'), asSentence('Connection error'), asSentence('Timed out?'), asSentence('Failed! ')])
      .toEqual(['Connection error.', 'Connection error.', 'Timed out?', 'Failed!']);
  });

  it('repository paths and branches wrap only after / and .', () => {
    expect(breakablePath('git.example.org/example-org/billing')).toEqual(['git.', 'example.', 'org/', 'example-org/', 'billing']);
    expect(breakablePath('feat/chat-gateway')).toEqual(['feat/', 'chat-gateway']);
  });

  it('groups replies under their thread', () => {
    expect(threadsOf(detail.comments).map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([[request.id, [reply.id]]]);
  });

  it('a lane member may request changes on their lane only; another reviewer is told why; a developer is not', () => {
    expect(caseActions(detail, reviewer).reviewLanes.map((l) => l.boardId)).toEqual([AI]);
    const outsider = caseActions(detail, meAs(REVIEWER_ID, ['case.review']));
    expect([outsider.reviewLanes, outsider.reviewBlocked]).toEqual([[], 'Only members of the AI Review Board or Legal Board can request changes on this case.']);
    const asDev = caseActions(asViewer(detail, { comment: true, review: false, close: false, withdraw: true, revoke: false, selfApproval: true }), dev);
    expect([asDev.reviewBlocked, asDev.end, asDev.comment]).toEqual([null, 'withdraw', null]);
    expect(caseActions(asViewer(detail, { comment: false, review: false, close: false, withdraw: false, revoke: false, selfApproval: false }), meAs(REVIEWER_ID, ['case.read'])))
      .toMatchObject({ end: null, comment: 'Commenting needs the case.comment permission on this repository.' });
  });

  it('closed cases and governance switched off are read-only', () => {
    expect(caseActions(closedDetail, reviewer).readOnly).toBe('This case is closed: it can no longer be changed.');
    expect(caseActions(detail, { ...reviewer, cpgEnabled: false }).readOnly).toMatch(/^Governance is off/);
  });

  it('the case pages need case.read in any scope (repository grants count)', () => {
    const repoOnly = fx.me({ permissions: [{ key: 'case.read', scope: 'repo', scopeId: 'example-org/app' }] });
    expect(missingPermissions(repoOnly, { scoped: ['case.read'] })).toEqual([]);
    expect(missingPermissions(fx.me({ permissions: [] }), { scoped: ['case.read'] })).toEqual(['case.read']);
  });
});

describe('case pages: rendering', () => {
  it('the list shows ref, repository @ branch, state, lanes, opener, activity and the pull request link', () => {
    const html = renderToStaticMarkup(<MemoryRouter><CaseTable items={[summary]} /></MemoryRouter>);
    expect(html).toContain('href="https://github.com/example-org/support-app/pull/42"');
    const t = text(<CaseTable items={[summary]} />);
    for (const s of ['CPG-6F1C2D3E', 'revision 1', 'example-org/support-app', '@ feat/chat', 'Changes requested', 'AI Review Board', '0/1 decided', 'Dana Developer', 'Oct 9, 2026, 08:00 UTC']) expect(t).toContain(s);
    expectClean(t);
  });

  it('the detail shows the people, lanes, revisions and the thread, and offers the reviewer the actions', () => {
    const t = text(<CaseView detail={detail} me={reviewer} notice={null} onChanged={() => {}} fetchedAt={T} />);
    for (const s of ['Rita Reviewer : requested changes', 'Dana Developer : opened the case, justified findings, replied', 'AI Review Board', 'Legal Board',
      'Request changes', 'Close case', 'Use the gateway client.', 'Moving it next sprint.', 'Add a comment', 'VS Code']) expect(t).toContain(s);
    expect(t).not.toContain('Closure record');
    expectClean(t);
  });

  it('a closed case is read-only and shows its verified closure record', () => {
    const t = text(<CaseView detail={closedDetail} me={reviewer} notice={null} onChanged={() => {}} fetchedAt={T} />);
    for (const s of ['This case is closed', 'Closure record', 'Signature verified', 'Closed by a reviewer', 'Replaced by another branch.', 'c2lnbmF0dXJl']) expect(t).toContain(s);
    for (const s of ['Close case', 'Add a comment', 'Reply', 'Needs review']) expect(t).not.toContain(s);
    const bad = text(<CaseView detail={{ ...closedDetail, closure: { ...closedDetail.closure!, signatureValid: false } }} me={reviewer} notice={null} onChanged={() => {}} fetchedAt={T} />);
    expect(bad).toContain('Signature does not verify');
  });

  it('a closed case never offers to generate reviewer context; stored context stays viewable', () => {
    const f = revision.findings[0];
    const closedList = (contextStatus: 'none' | 'generated' | 'failed') => text(<FindingList caseId={CASE_ID} findings={[{ ...f, contextStatus }]} resolutions={null} closed />);
    expect(closedList('none')).toContain('No reviewer context was generated before the case closed.');
    expect(closedList('none')).not.toContain('Show reviewer context');
    expect(closedList('failed')).toContain('Generating reviewer context failed before the case closed.');
    expect(closedList('generated')).toContain('Show reviewer context');
  });

  it('a finding links its policy and shows the location, the snippet as code, the justification and the context button', () => {
    const node = <FindingList caseId={CASE_ID} findings={revision.findings} resolutions={new Map(detail.case.resolutions.map((r) => [r.fingerprint, r]))} />;
    const html = renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
    expect(html).toContain(`href="/governance/policies/${POLICY_ID}"`);
    expect(html).toMatch(/<pre[^>]*><code>const r = await openai\.chat\.completions\.create\(\{\n {2}model \}\);<\/code><\/pre>/);
    const t = text(node);
    for (const s of ['No direct OpenAI calls', 'corp.no-direct-openai v1', 'Prohibited', 'Changes requested', 'src/chat.ts:3-4', 'Streaming is needed first.', 'Show reviewer context']) expect(t).toContain(s);
    expectClean(t);
  });
});

describe('case decisions and standing exceptions', () => {
  const PROPOSAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const DECISION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const proposal = proposalSchema.parse({
    id: PROPOSAL_ID, caseId: CASE_ID, scope: 'snippet', outcome: 'approve', status: 'pending', policyId: POLICY_ID, policyKey: 'corp.no-direct-openai',
    policyVersion: 1, tier: 'prohibited', fingerprints: [FP], pattern: null, requestedExpiresAt: '2026-11-08T08:00:00.000Z', rationale: 'Kept until the gateway client streams.',
    required: { approvals: 2, boardCoverage: 'all_owning', boardIds: [AI, LEGAL], requiredPermission: null, maxExpiryDays: 90, defaultExpiryDays: 30 },
    quorumConfigVersionAtCreation: 2, proposer: { userId: REVIEWER_ID, name: 'Rita Reviewer' }, createdAt: T, lapsesAt: '2026-11-08T08:00:00.000Z',
    votes: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', voterUserId: REVIEWER_ID, voterName: 'Rita Reviewer', vote: 'approve', boards: [AI], permissions: ['case.review'], comment: '', createdAt: T }],
    decisionIds: [], invalidation: null, revocations: [], viewer: { canVote: true, reason: null },
  });
  const boardName = (id: string) => ({ [AI]: 'AI Review Board', [LEGAL]: 'Legal Board' } as Record<string, string>)[id] ?? 'another required board';
  const ctx = (over: Partial<DecisionContext> = {}): DecisionContext => ({
    detail, me: reviewer, quorum: fx.quorumConfig, proposals: [], readOnly: null, boardName, onChanged: () => {}, ...over,
  });
  const resolution = detail.case.resolutions[0];
  const finding = revision.findings[0];

  it('quorum progress names the boards and the permission still needed', () => {
    expect(progressText(quorumProgress(proposal), boardName)).toBe('1 of 2 approvals; still needed: an approver from Legal Board');
    const standing = { ...proposal, required: { ...proposal.required, requiredPermission: 'exception.approve' as const, boardCoverage: 'any_owning' as const } };
    expect(progressText(quorumProgress(standing), boardName)).toBe('1 of 2 approvals; still needed: an approver holding exception.approve');
    const met = { ...proposal, votes: [...proposal.votes, { ...proposal.votes[0], id: PROPOSAL_ID, boards: [LEGAL] }, { ...proposal.votes[0], id: DECISION_ID, boards: [AI] }] };
    expect(progressText(quorumProgress(met), boardName)).toBe('3 approvals, 2 required');
  });

  it('expiry limits follow the quorum: overrides replace the slot, bulk never applies to prohibited, standing is capped', () => {
    const q = fx.quorumConfig;
    expect(scopeRule(q, POLICY_ID, 'prohibited', 'snippet')).toMatchObject({ maxDays: 90, defaultDays: 30, approvals: 2 });
    expect([scopeRule(q, POLICY_ID, 'prohibited', 'bulk'), scopeRule(q, POLICY_ID, 'advisory', 'snippet')]).toEqual([null, null]);
    expect(scopeRule({ ...q, standingExceptions: { ...q.standingExceptions, maxExpiryDays: 20 } }, POLICY_ID, 'review-required', 'standing')).toMatchObject({ maxDays: 20, defaultDays: 20 });
    const override = { ...q, policyOverrides: { [POLICY_ID]: { snippet: { ...q.tiers['review-required'].snippet, maxExpiryDays: 10, defaultExpiryDays: 5 } } } };
    expect(scopeRule(override, POLICY_ID, 'review-required', 'snippet')).toMatchObject({ maxDays: 10, defaultDays: 5 });
    expect(requirementText(scopeRule(q, POLICY_ID, 'prohibited', 'standing')!))
      .toBe('2 approvals covering every owning board, one of them by someone holding exception.approve (the Exception Approver role)');
    expect([parseDays('30', 90), parseDays('91', 90), parseDays('0', 90), parseDays('1.5', 90)]).toEqual([30, null, null, null]);
  });

  it('a board member who did not open, justify or revise the case is offered approval and rejection', () => {
    const t = text(<FindingDecision ctx={ctx()} finding={finding} resolution={resolution} />);
    for (const s of ['No decision yet.', 'Propose approval', 'Propose rejection']) expect(t).toContain(s);
    expectClean(t);
  });

  it('self-approval is never offered: the opener sees why, and so does a reviewer outside the owning boards', () => {
    const own = text(<FindingDecision ctx={ctx({ detail: asViewer(detail, { ...detail.viewer, selfApproval: true }) })} finding={finding} resolution={resolution} />);
    expect(own).toContain('You opened, justified or revised this case, so you cannot propose or vote on its decisions (four-eyes).');
    expect(own).not.toContain('Propose approval');
    const outsider = text(<FindingDecision ctx={ctx({ me: meAs(REVIEWER_ID, ['case.review'], []) })} finding={finding} resolution={resolution} />);
    expect(outsider).toContain('Only members of a board that owns this policy can propose a decision on it.');
  });

  it('a pending proposal shows its progress on the finding, and the vote form or the reason not to vote', () => {
    expect(text(<FindingDecision ctx={ctx({ proposals: [proposal] })} finding={finding} resolution={{ ...resolution, status: 'pending' }} />))
      .toContain('An approval is pending: 1 of 2 approvals; still needed: an approver from Legal Board. Vote below');
    const card = (p: typeof proposal) => text(<ul><ProposalCard proposal={p} subject={null} boardName={boardName} onChanged={() => {}} /></ul>);
    const open = card(proposal);
    for (const s of ['Snippet approval', 'corp.no-direct-openai v1', 'Pending', 'Rita Reviewer (AI Review Board)', 'Approve', 'Reject', 'Nov 8, 2026, 08:00 UTC']) expect(open).toContain(s);
    expectClean(open);
    const refused = card({ ...proposal, viewer: { canVote: false, reason: 'self_approval_forbidden' } });
    expect(refused).toContain('You proposed this, or opened, justified or revised a case it decides, so you cannot vote on it (four-eyes).');
    expect(refused).not.toMatch(/\bApprove\b/);
    const revoked = card({ ...proposal, status: 'finalized', decisionIds: [DECISION_ID], revocations: [{ decisionId: DECISION_ID, revokedByName: 'Ezra Exceptions', reason: 'The client was removed.', revokedAt: T }] });
    for (const s of ['Decided', 'Revoked', 'Ezra Exceptions', 'The client was removed.']) expect(revoked).toContain(s);
  });

  it('exception rows: pending proposals without a case, finalized exceptions by status, and the count a new version lapses', () => {
    const pattern = { repos: ['example-org/app'], teamIds: [], paths: ['src/legacy/**'], excludePaths: [], policyKey: 'corp.no-direct-openai', policyVersion: 1, conditions: {} };
    const pending = { ...proposal, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', caseId: null, scope: 'standing' as const, pattern, fingerprints: [] };
    const vetoed = { ...pending, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', status: 'vetoed' as const };
    const done = { ...pending, status: 'finalized' as const, decisionIds: [DECISION_ID] };
    const exception = standingExceptionSchema.parse({
      id: DECISION_ID, proposalId: done.id, caseId: null, policyId: POLICY_ID, policyKey: 'corp.no-direct-openai', policyVersion: 1, pattern,
      expiresAt: '2026-11-08T08:00:00.000Z', finalizedAt: T, approverUserIds: [REVIEWER_ID], status: 'lapsed', revocation: null,
    });
    expect(exceptionRows([pending, vetoed], []).map((r) => r.status)).toEqual(['not_approved', 'pending']);
    expect(exceptionRows([done], [exception])[0]).toMatchObject({ status: 'lapsed', exception: { id: DECISION_ID } });
    const active = { ...exception, status: 'active' as const };
    expect([lapsingCount([active, exception], 'corp.no-direct-openai', 1), lapsingCount([active], 'corp.no-direct-openai', 2)]).toEqual([1, 0]);
  });
});

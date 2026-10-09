import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { CaseTable } from './GovernanceCases';
import { CaseView } from './CaseDetail';
import { FindingList } from './cases/Findings';
import * as fx from '../../test/cpg-fixtures';
import { caseDetailSchema, caseSummarySchema, revisionDetailSchema, type CaseDetail, type CpgMe } from '../../api/cpg';
import { caseActions, pageNote, pullRequestUrl, threadsOf } from '../../lib/cpg-cases';
import { missingPermissions } from '../../lib/cpg-permissions';

const text = (node: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>)
  .replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
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
  viewer: { comment: true, review: true, close: true, withdraw: true },
  revisions: [{ revision: 1, source: 'vscode', headSha: null, findingsDigest: 'b'.repeat(64), addedCount: 1, carriedCount: 0, resolvedCount: 0, createdAt: T }],
  justifications: [{ id: '88888888-8888-4888-8888-888888888888', fingerprint: FP, authorUserId: DEV_ID, authorName: 'Dana Developer', body: 'Streaming is needed first.', createdAt: T }],
  comments: [request, reply],
});
const closedDetail: CaseDetail = caseDetailSchema.parse({
  ...detail,
  case: { ...detail.case, state: 'closed', closeReason: 'closed_by_reviewer', openChangeRequests: [] },
  viewer: { comment: true, review: true, close: true, withdraw: true },
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
    language: 'typescript', snippet: 'const r = await openai.chat.completions.create({\n  model });', justification: detail.justifications[0],
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

  it('groups replies under their thread', () => {
    expect(threadsOf(detail.comments).map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([[request.id, [reply.id]]]);
  });

  it('a lane member may request changes on their lane only; another reviewer is told why; a developer is not', () => {
    expect(caseActions(detail, reviewer).reviewLanes.map((l) => l.boardId)).toEqual([AI]);
    const outsider = caseActions(detail, meAs(REVIEWER_ID, ['case.review']));
    expect([outsider.reviewLanes, outsider.reviewBlocked]).toEqual([[], 'Only members of the AI Review Board or Legal Board can request changes on this case.']);
    const asDev = caseActions(asViewer(detail, { comment: true, review: false, close: false, withdraw: true }), dev);
    expect([asDev.reviewBlocked, asDev.end, asDev.comment]).toEqual([null, 'withdraw', null]);
    expect(caseActions(asViewer(detail, { comment: false, review: false, close: false, withdraw: false }), meAs(REVIEWER_ID, ['case.read'])))
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

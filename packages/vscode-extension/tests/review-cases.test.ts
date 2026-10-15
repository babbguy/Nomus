import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import type { CaseStatus } from '@nomus/scanner/corporate';
import { CaseTracker } from '../src/cpg/case-status';
import { CorporateViewProvider } from '../src/cpg/corporate-view';
import { caseNotices, closedNotice } from '../src/cpg/corporate-format';
import { draftKey, replyToChangeRequest, requestReview, type CaseCommandDeps } from '../src/cpg/request-review';
import type { CpgClient, CpgResult } from '../src/cpg/cpg-client';
import type { CorporateController } from '../src/cpg/corporate-controller';
import { corporateFinding, signedBundle, signedPolicy } from './helpers/corporate';

/**
 * The review-case flow of design spec §10.3–§10.5 with the vscode mock: the
 * request-review steps (identity, status, selection, justifications, submit),
 * the "same justification for all" path, drafts kept on every failure, the
 * reply → resubmit path, the case node of the view, and the notifications.
 */

const REPO = 'gate-example/policy-repo';
const BRANCH = 'feat/policy-check';
vi.mock('../src/cpg/git-context', () => ({ readGitContext: async () => ({ ok: true, repo: 'gate-example/policy-repo', branch: 'feat/policy-check', headSha: null }) }));
let scanned = [corporateFinding()];
vi.mock('@nomus/scanner', () => ({ runCorporateScanOnDisk: async () => ({ findings: scanned }) }));

const FP_A = corporateFinding().fingerprint;
const FP_B = `${'b'.repeat(64)}:corp.no-pii-to-ai:1`;
const findingB = corporateFinding({ fingerprint: FP_B, policyKey: 'corp.no-pii-to-ai', policyVersion: 1, tier: 'review-required', filePath: 'app/summarize.py', startLine: 8, endLine: 8 });
const JUSTIFY = 'Needed for support chat until the gateway client streams.';

function caseStatus(over: Partial<CaseStatus> = {}): CaseStatus {
  return {
    id: '3f0c9a1e-2b4d-4e6f-8a1b-2c3d4e5f6a7b', ref: 'CPG-3F0C9A1E', repo: REPO, branch: BRANCH, prNumber: null, state: 'in_review', closeReason: null,
    latestRevision: 1, url: 'http://gate.example.org/governance/cases/3f0c9a1e-2b4d-4e6f-8a1b-2c3d4e5f6a7b',
    lanes: [{ boardId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', boardName: 'AI Review Board', state: 'needs_review', blocking: 1, decided: 0 }],
    openChangeRequests: [], resolutions: [], updatedAt: '2026-10-09T12:00:00.000Z', ...over,
  };
}
const changeRequest = { commentId: '7d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a', boardName: 'AI Review Board', authorName: 'Ai Reviewer', body: 'Call OpenAI through the approved gateway client.', fingerprints: [FP_A], createdAt: '2026-10-09T12:30:00.000Z' };

type Route = (body: any) => CpgResult<unknown>;
let routes: Record<string, Route>;
let sent: Array<{ method: string; path: string; body: any }>;
let messages: Array<{ level: string; text: string }>;
let quickPicks: Array<(items: any[]) => unknown>;
let inputs: Array<string | undefined>;
let inputOptions: Array<{ value?: string; title?: string }>;
const memento = () => {
  const m = new Map<string, unknown>();
  return { get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d), update: async (k: string, v: unknown) => { if (v === undefined) m.delete(k); else m.set(k, v); }, m };
};
let context: { globalState: ReturnType<typeof memento>; workspaceState: ReturnType<typeof memento> };

const ok = (data: unknown, status = 200): CpgResult<unknown> => ({ ok: true, status, data });
const offline: CpgResult<unknown> = { ok: false, status: 0, code: 'unreachable', message: 'Nomus is unreachable.', offline: true };
const me = (over = {}) => ok({ identity: 'user_key', cpgEnabled: true, permissions: [{ key: 'case.create', scope: 'org', scopeId: null }], ...over });

function deps(): CaseCommandDeps {
  const client = {
    request: vi.fn(async (method: string, path: string, schema: { safeParse: (v: unknown) => { success: boolean } }, body?: unknown) => {
      sent.push({ method, path, body });
      const route = Object.entries(routes).find(([p]) => path.startsWith(p))?.[1];
      const res = route ? route(body) : ({ ok: false, status: 404, code: 'not_found', message: 'Not found', offline: false } as const);
      if (res.ok) expect(schema.safeParse(res.data).success).toBe(true); // the fixtures follow the real contracts
      return res;
    }),
  } as unknown as CpgClient;
  const corporate = { ensureBundle: async () => signedBundle([signedPolicy()]), applyWorkspaceFindings: vi.fn() } as unknown as CorporateController;
  const ctx = context as unknown as vscode.ExtensionContext;
  return { context: ctx, client, corporate, cases: new CaseTracker(ctx, client) };
}

beforeEach(() => {
  scanned = [corporateFinding(), findingB];
  sent = [];
  messages = [];
  quickPicks = [];
  inputs = [];
  inputOptions = [];
  context = { globalState: memento(), workspaceState: memento() };
  (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: vscode.Uri.file('/project'), name: 'p', index: 0 }];
  routes = {
    '/me': () => me(),
    '/findings/status': (b) => ok({ items: b.fingerprints.map((fingerprint: string) => ({ fingerprint, status: 'needs_review', blocking: true, tier: 'prohibited', enforceFrom: '2026-10-01T09:00:00.000Z', decisionId: null, exceptionDecisionId: null, expiresAt: null })), evaluatedAt: '2026-10-09T12:00:00.000Z' }),
    '/cases/request-review': () => ok({ created: true, revisionCreated: true, case: caseStatus() }, 201),
  };
  for (const level of ['Information', 'Warning', 'Error'] as const) {
    vi.spyOn(vscode.window, `show${level}Message`).mockImplementation(((text: string) => { messages.push({ level: level.toLowerCase(), text }); return Promise.resolve(undefined); }) as never);
  }
  vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: any[]) => quickPicks.shift()?.(await items)) as never);
  vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (o: { value?: string; title?: string }) => { inputOptions.push(o); return inputs.shift(); }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;
});

const all = (items: any[]) => items;
const pickLabel = (re: RegExp) => (items: any[]) => items.find((i) => re.test(typeof i === 'string' ? i : i.label));

describe('nomus.cpg.requestReview (§10.3)', () => {
  it('sends every finding with the same justification for all when chosen, clears the drafts and shows the case', async () => {
    const d = deps();
    quickPicks = [all, pickLabel(/^Use this justification for the remaining 1 finding$/)];
    inputs = [JUSTIFY];
    await requestReview(d);
    const submit = sent.find((s) => s.path === '/cases/request-review')!.body;
    expect(submit).toMatchObject({ repo: REPO, branch: BRANCH, headSha: null });
    expect(submit.findings.map((f: { fingerprint: string; snippet: string }) => [f.fingerprint, typeof f.snippet])).toEqual([[FP_A, 'string'], [FP_B, 'string']]);
    expect(submit.justifications).toEqual([{ fingerprint: FP_A, body: JUSTIFY }, { fingerprint: FP_B, body: JUSTIFY }]);
    expect(inputOptions[0].title).toBe('Justification (1/2): corp.no-direct-openai @ src/chat.ts:7');
    expect(messages).toEqual([{ level: 'information', text: 'Nomus: Review case CPG-3F0C9A1E opened (revision 1). Sent to: AI Review Board.' }]);
    expect(context.workspaceState.m.size).toBe(0);
    expect(d.cases.openCase()?.ref).toBe('CPG-3F0C9A1E');
  });

  it('offline at submit: nothing is queued, the error says so, and the drafts come back next time', async () => {
    routes['/cases/request-review'] = () => offline;
    quickPicks = [all, pickLabel(/^Write each one$/)];
    inputs = [JUSTIFY, `${JUSTIFY} Second.`];
    await requestReview(deps());
    expect(messages.at(-1)).toEqual({ level: 'error', text: 'Nomus: Nomus is unreachable: the review request was not sent. Your justifications are saved as a draft.' });
    expect(context.workspaceState.m.get(draftKey(REPO, BRANCH))).toEqual({ [FP_A]: JUSTIFY, [FP_B]: `${JUSTIFY} Second.` });

    routes['/cases/request-review'] = () => ({ ok: false, status: 422, code: 'snippet_hash_mismatch', message: 'The snippet does not hash to its fingerprint', offline: false });
    quickPicks = [all, pickLabel(/^Write each one$/)];
    inputs = [JUSTIFY, `${JUSTIFY} Second.`];
    inputOptions = [];
    await requestReview(deps());
    expect(inputOptions.map((o) => o.value)).toEqual([JUSTIFY, `${JUSTIFY} Second.`]);
    expect(messages.at(-1)?.text).toBe('Nomus: The review request was not sent: The snippet does not hash to its fingerprint. Your justifications are saved as a draft.');
    expect(context.workspaceState.m.has(draftKey(REPO, BRANCH))).toBe(true);
  });

  it('Esc on the second justification keeps the first as a draft', async () => {
    quickPicks = [all, pickLabel(/^Write each one$/)];
    inputs = [JUSTIFY, undefined];
    await requestReview(deps());
    expect(messages.at(-1)?.text).toBe('Nomus: Review not requested. Your justifications are saved as a draft.');
    expect(context.workspaceState.m.get(draftKey(REPO, BRANCH))).toEqual({ [FP_A]: JUSTIFY });
    expect(sent.some((s) => s.path === '/cases/request-review')).toBe(false);
  });

  it('an organization key is asked to sign in; nothing to review is said plainly', async () => {
    routes['/me'] = () => ({ ok: false, status: 403, code: 'user_identity_required', message: 'x', offline: false });
    await requestReview(deps());
    expect(messages).toEqual([{ level: 'error', text: 'Nomus: Requesting review needs your Nomus sign-in (not an organization API key). Sign in again?' }]);

    routes['/me'] = () => me();
    routes['/findings/status'] = (b) => ok({ items: b.fingerprints.map((fingerprint: string) => ({ fingerprint, status: 'approved', blocking: false, tier: 'prohibited', enforceFrom: '2026-10-01T09:00:00.000Z', decisionId: null, exceptionDecisionId: null, expiresAt: null })), evaluatedAt: '2026-10-09T12:00:00.000Z' });
    await requestReview(deps());
    expect(messages.at(-1)?.text).toBe('Nomus: Nothing needs review: every blocking finding is approved or excepted.');
  });
});

describe('case status, reply and resubmit (§10.4, §10.5)', () => {
  it('a new change request warns once; replying with "resolves" offers to resubmit', async () => {
    const d = deps();
    routes['/cases/by-branch'] = () => ok({ case: caseStatus() });
    await d.cases.refresh(true);
    expect(messages).toEqual([]);
    routes['/cases/by-branch'] = () => ok({ case: caseStatus({ state: 'changes_requested', openChangeRequests: [changeRequest] }) });
    await d.cases.refresh(true);
    await d.cases.refresh(true);
    expect(messages).toEqual([{ level: 'warning', text: 'Nomus: CPG-3F0C9A1E: Changes requested by Ai Reviewer (AI Review Board): "Call OpenAI through the approved gateway client."' }]);

    routes[`/cases/${caseStatus().id}/comments`] = (b) => {
      expect(b).toEqual({ kind: 'reply', threadId: changeRequest.commentId, resolves: true, body: 'Moved behind the gateway client.' });
      routes['/cases/by-branch'] = () => ok({ case: caseStatus({ state: 'changes_requested' }) });
      return ok({ id: '8e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b' }, 201);
    };
    inputs = ['Moved behind the gateway client.'];
    quickPicks = [pickLabel(/^This resolves the request$/)];
    await replyToChangeRequest(d, changeRequest.commentId);
    expect(messages.at(-1)?.text).toBe('Nomus: Reply sent. Every change request on CPG-3F0C9A1E is resolved: resubmit the case for review.');
  });

  it('offline the last status is kept, marked "as of"; the view shows lanes, requests and what to do next', async () => {
    const d = deps();
    const view = new CorporateViewProvider();
    d.cases.onDidChange((v) => view.setCase(v));
    view.setState({ kind: 'bundle', bundle: { kind: 'verified', bundle: signedBundle([signedPolicy()]), fetchedAt: '2026-10-09T09:41:00.000Z', checkedAt: '2026-10-09T09:41:00.000Z' }, findings: [corporateFinding()], checked: true, repository: null });
    routes['/cases/by-branch'] = () => ok({ case: null });
    await d.cases.refresh(true);
    const label = (n: unknown) => String(view.getTreeItem(n as never).label);
    expect(label(view.getChildren()[0])).toBe('No review case for this branch: run "Nomus: Request Policy Review"');

    routes['/cases/by-branch'] = () => ok({ case: caseStatus({ state: 'changes_requested', openChangeRequests: [changeRequest] }) });
    await d.cases.refresh(true);
    routes['/cases/by-branch'] = () => offline;
    await d.cases.refresh(true);
    const caseNode = view.getChildren()[0];
    const item = view.getTreeItem(caseNode);
    expect([item.label, item.description]).toEqual(['Case CPG-3F0C9A1E · changes requested (revision 1)', expect.stringMatching(/^as of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(offline\)$/)]);
    expect(view.getChildren(caseNode).map(label)).toEqual([
      'AI Review Board: needs review (1 blocking)',
      'Changes requested by Ai Reviewer (AI Review Board): "Call OpenAI through the approved gateway client."',
      'Open in dashboard',
    ]);
  });

  it('a case that leaves the branch is reported closed only when the server says it is closed', async () => {
    const d = deps();
    routes['/cases/by-branch'] = () => ok({ case: caseStatus() });
    await d.cases.refresh(true);
    // Governance switched off: by-branch answers null, but the case is still open.
    routes['/cases/by-branch'] = () => ok({ case: null });
    routes[`/cases/${caseStatus().id}`] = () => ok({ case: caseStatus() });
    await d.cases.refresh(true);
    expect(messages).toEqual([]);
    routes['/cases/by-branch'] = () => ok({ case: caseStatus() });
    await d.cases.refresh(true);
    routes['/cases/by-branch'] = () => ok({ case: null });
    routes[`/cases/${caseStatus().id}`] = () => ok({ case: caseStatus({ state: 'closed', closeReason: 'merged' }) });
    await d.cases.refresh(true);
    expect(messages).toEqual([{ level: 'information', text: 'Nomus: Review case CPG-3F0C9A1E is closed: the pull request was merged.' }]);
  });

  it('notices: decisions are counted, and a closed case says why', () => {
    const before = caseStatus({ resolutions: [{ fingerprint: FP_A, status: 'needs_review', blocking: true, tier: 'prohibited', enforceFrom: null, decisionId: null, exceptionDecisionId: null, expiresAt: null }] });
    const after = caseStatus({ state: 'decided', resolutions: [{ ...before.resolutions[0], status: 'approved', blocking: false }] });
    expect(caseNotices(before, after)).toEqual([{ level: 'info', text: 'CPG-3F0C9A1E: 1 finding approved. Every blocking finding is decided.', actions: ['Open case'] }]);
    expect(closedNotice('CPG-3F0C9A1E', 'merged')).toBe('Review case CPG-3F0C9A1E is closed: the pull request was merged.');
  });
});

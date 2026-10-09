import { describe, it, expect } from 'vitest';
import { CorporateViewProvider, type CorporateViewState } from '../src/cpg/corporate-view';
import { bundleStatusText, corporateMessage, corporateSeverity, formatUtc, groupFindings, ownersText, statusText } from '../src/cpg/corporate-format';
import type { BundleState } from '../src/cpg/bundle-cache';
import { corporateFinding, signedBundle, signedPolicy } from './helpers/corporate';

const BAD = /\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b|Invalid Date/;

function render(p: CorporateViewProvider) {
  const out: Array<{ depth: number; label: string; description: string; tooltip: string }> = [];
  const walk = (node: unknown, depth: number) => {
    for (const child of p.getChildren(node as never)) {
      const item = p.getTreeItem(child);
      out.push({ depth, label: String(item.label), description: String(item.description ?? ''), tooltip: String(item.tooltip ?? '') });
      if (item.collapsibleState) walk(child, depth + 1);
    }
  };
  walk(undefined, 0);
  return out;
}

const bundle = signedBundle([signedPolicy(), signedPolicy('corp.b', { policyId: '9c8b7a6f-5e4d-4c3b-8a29-1f0e9d8c7b6a' }), signedPolicy('corp.c', { policyId: '1c8b7a6f-5e4d-4c3b-8a29-1f0e9d8c7b6a' })]);
const verified: BundleState = { kind: 'verified', bundle, fetchedAt: '2026-10-09T09:41:00.000Z', checkedAt: '2026-10-09T09:41:00.000Z' };
const findings = [
  corporateFinding(),
  corporateFinding({ filePath: 'app/summarize.py', file: '/p/app/summarize.py', startLine: 8, endLine: 8, policyKey: 'corp.no-pii-to-ai', tier: 'review-required' }),
  corporateFinding({ filePath: 'src/models.ts', file: '/p/src/models.ts', startLine: 3, endLine: 3, policyKey: 'corp.no-gpt-4-32k', tier: 'review-required', status: 'grace', blocking: false, enforceFrom: '2026-10-23T09:00:00.000Z' }),
];

describe('Corporate Policies view (design spec §10.2, §10.5)', () => {
  it('verified: groups with counts, finding rows, the repository and the status row; nothing undefined/NaN/null', () => {
    const p = new CorporateViewProvider();
    p.setState({ kind: 'bundle', bundle: verified, findings, checked: true, repository: { ok: true, repo: 'acme/payments', branch: 'feat/x', headSha: null } });
    const rows = render(p);
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.label}`)).toEqual([
      'Blocking: needs review (2)',
      '  corp.no-direct-openai · src/chat.ts:7-10',
      '  corp.no-pii-to-ai · app/summarize.py:8',
      'Advisory / grace period (1)',
      '  corp.no-gpt-4-32k · src/models.ts:3',
      'Repository: acme/payments @ feat/x',
      'Policy bundle: 3 policies · verified 2026-10-09 09:41 UTC',
    ]);
    expect(rows[4].description).toBe('review-required · advisory; enforced from 2026-10-23');
    expect(rows.filter((r) => BAD.test(`${r.label} ${r.description} ${r.tooltip}`))).toEqual([]);
  });

  it('every unusable bundle state says why and shows no findings (never an empty "no violations" list)', () => {
    const states: BundleState[] = [
      { kind: 'unavailable', reason: 'Could not reach the server' },
      { kind: 'expired', fetchedAt: '2026-10-05T08:10:00.000Z', reason: 'x' },
      { kind: 'rejected', reason: 'The corporate policy bundle signature does not verify' },
      { kind: 'denied', status: 401, reason: 'x' },
    ];
    for (const s of states) {
      const p = new CorporateViewProvider();
      p.setState({ kind: 'bundle', bundle: s, findings, checked: true, repository: null });
      const rows = render(p);
      expect(rows.map((r) => r.label)).toEqual(['Corporate policy findings cannot be shown until a verified policy bundle is available', bundleStatusText(s)]);
      expect(rows.filter((r) => BAD.test(r.label))).toEqual([]);
    }
  });

  it('offline: findings from the cache and the "offline (cached …)" row; not enabled, not supported, off and signed out', () => {
    const p = new CorporateViewProvider();
    p.setState({ kind: 'bundle', bundle: { kind: 'offline', bundle, fetchedAt: '2026-10-08T08:10:00.000Z', reason: 'x' }, findings: [], checked: true, repository: null });
    expect(render(p).map((r) => r.label)).toEqual(['No corporate policy findings in the scanned files', 'Policy bundle: offline (cached 2026-10-08 08:10 UTC)']);
    p.setState({ kind: 'bundle', bundle: verified, findings: [], checked: false, repository: null });
    expect(render(p).map((r) => r.label)).toEqual(['No files checked yet: save a file or run "Nomus: Scan Workspace"', 'Policy bundle: 3 policies · verified 2026-10-09 09:41 UTC']);
    p.setState({ kind: 'bundle', bundle: { ...verified, bundle: signedBundle([], false) }, findings: [], checked: true, repository: null });
    expect(render(p).map((r) => r.label)).toEqual(['Corporate policies are not enabled for this organization', 'Policy bundle: 0 policies · verified 2026-10-09 09:41 UTC']);
    p.setState({ kind: 'bundle', bundle: { kind: 'not_supported' }, findings: [], checked: true, repository: null });
    expect(render(p).map((r) => r.label)).toEqual(['This Nomus server does not support corporate policies']);
    p.setState({ kind: 'off', reason: 'setting' } as CorporateViewState);
    expect(render(p).map((r) => r.label)).toEqual(['Corporate policy checks are off (setting nomus.corporate.enabled)']);
    p.setState({ kind: 'off', reason: 'signed_out' });
    expect(render(p).map((r) => r.label)).toEqual(['Sign in to Nomus to check corporate policies']);
  });

  it('a finding row opens its file at the range', () => {
    const p = new CorporateViewProvider();
    p.setState({ kind: 'bundle', bundle: verified, findings: [corporateFinding()], checked: true, repository: null });
    const [group] = p.getChildren();
    const [row] = p.getChildren(group);
    const item = p.getTreeItem(row);
    expect(item.command?.command).toBe('vscode.open');
    expect(item.contextValue).toBe('nomus.corporate.finding.blocking');
    p.setState({ kind: 'bundle', bundle: verified, findings: [corporateFinding({ tier: 'advisory', status: 'advisory', blocking: false })], checked: true, repository: null });
    const [advisoryGroup] = p.getChildren();
    expect(p.getTreeItem(p.getChildren(advisoryGroup)[0]).description).toBe('advisory');
  });
});

describe('Corporate Policies view: server decisions (§10.4)', () => {
  it('approved and excepted findings move to their own group; every finding shows its decision status', () => {
    const resolution = (f: (typeof findings)[number], status: string, expiresAt: string | null) =>
      ({ fingerprint: f.fingerprint, status, blocking: status === 'rejected', tier: f.tier, enforceFrom: f.enforceFrom, decisionId: null, exceptionDecisionId: null, expiresAt });
    const chat = corporateFinding({ fingerprint: `${'c'.repeat(64)}:corp.no-direct-openai:2` });
    const pii = { ...findings[1], fingerprint: `${'d'.repeat(64)}:corp.no-pii-to-ai:2` };
    const p = new CorporateViewProvider();
    p.setState({ kind: 'bundle', bundle: verified, findings: [chat, pii, findings[2]], checked: true, repository: null });
    p.setCase({
      kind: 'case', asOf: '2026-10-09T12:00:00.000Z', offline: false,
      status: { lanes: [], openChangeRequests: [], resolutions: [resolution(chat, 'excepted', '2026-11-08T00:00:00.000Z'), resolution(pii, 'rejected', null)] } as never,
    });
    const rows = render(p).filter((r) => !r.label.startsWith('Case ') && r.label !== 'Open in dashboard');
    expect(rows.slice(0, 6).map((r) => `${r.label} | ${r.description}`)).toEqual([
      'Blocking: needs review (1) | ',
      'corp.no-pii-to-ai · app/summarize.py:8 | review-required · rejected',
      'Approved or excepted (1) | ',
      'corp.no-direct-openai · src/chat.ts:7-10 | prohibited · excepted (standing exception) until 2026-11-08',
      'Advisory / grace period (1) | ',
      'corp.no-gpt-4-32k · src/models.ts:3 | review-required · advisory; enforced from 2026-10-23',
    ]);
  });
});

describe('corporate text (design spec §10.2)', () => {
  it('message, status and severity table', () => {
    expect(corporateMessage(corporateFinding())).toBe('[Policy · PROHIBITED] corp.no-direct-openai v2: Call OpenAI only through the approved LLM gateway. Status: needs review.');
    expect(statusText({ status: 'grace', enforceFrom: '2026-10-22T09:00:00.000Z' })).toBe('advisory; enforced from 2026-10-22');
    expect(corporateSeverity({ blocking: true, tier: 'prohibited' })).toBe('error');
    expect(corporateSeverity({ blocking: true, tier: 'review-required' })).toBe('warning');
    expect(corporateSeverity({ blocking: false, tier: 'prohibited' })).toBe('information');
    expect(formatUtc('nope')).toBe('unknown time');
    const f = corporateFinding();
    expect(ownersText({ rule: { ...f.rule, owningBoards: [...f.rule.owningBoards].reverse() } })).toBe('Owned by: AI Review Board, Legal');
    expect(groupFindings([])).toEqual([]);
  });
});

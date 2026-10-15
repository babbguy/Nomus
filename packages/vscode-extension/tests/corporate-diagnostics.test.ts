import { describe, it, expect } from 'vitest';
import { Uri, DiagnosticSeverity } from 'vscode';
import { DiagnosticsProvider, CORPORATE_SOURCE, type DiagnosticFinding } from '../src/diagnostics';
import { corporateFinding } from './helpers/corporate';

const REG: DiagnosticFinding = {
  file: '/project/src/chat.ts', line: 3, sdk: 'openai', severity: 'high', ruleKey: 'eu.test.rule',
  humanSummary: 'An obligation applies.', legalReference: 'Test Art. 1',
};
const stored = (p: DiagnosticsProvider, uri: Uri) => (p as unknown as { collection: { _store: Map<string, any[]> } }).collection._store.get(uri.toString());
const link = (id: string) => Uri.parse(`https://nomus.example.org/governance/policies/${id}`);

describe('DiagnosticsProvider: corporate findings (design spec §10.2)', () => {
  it('regulatory diagnostics are unchanged when corporate findings are merged into the same collection', () => {
    const uri = Uri.file('/project/src/chat.ts');
    const alone = new DiagnosticsProvider(link);
    alone.setFindings(uri, [REG]);
    const merged = new DiagnosticsProvider(link);
    merged.setFindings(uri, [REG], [corporateFinding()]);
    const a = stored(alone, uri)!;
    const m = stored(merged, uri)!;
    expect(m).toHaveLength(2);
    expect(JSON.stringify(m[0])).toBe(JSON.stringify(a[0]));
    expect(m[0].source).toBe('Nomus');
    expect(m[1].source).toBe(CORPORATE_SOURCE);
  });

  it('a corporate diagnostic: source, code with the policy page, full line range, message and owners', () => {
    const uri = Uri.file('/project/src/chat.ts');
    const p = new DiagnosticsProvider(link);
    p.setFindings(uri, [], [corporateFinding()]);
    const [d] = stored(p, uri)!;
    expect(d.source).toBe('Nomus Policy');
    expect(d.code.value).toBe('corp.no-direct-openai');
    expect(d.code.target.toString()).toBe('https://nomus.example.org/governance/policies/0b8f5d2c-3e4a-4f6b-9c1d-2e3f4a5b6c7d');
    expect([d.range.startLine, d.range.endLine]).toEqual([6, 9]);
    expect(d.message).toBe('[Policy · PROHIBITED] corp.no-direct-openai v2: Call OpenAI only through the approved LLM gateway. Status: needs review.');
    expect(d.relatedInformation.map((r: { message: string }) => r.message)).toEqual(['Owned by: AI Review Board, Legal']);
    expect(d.message).not.toMatch(/undefined|NaN|null/);
  });

  it('severity: blocking prohibited Error, blocking review-required Warning, grace and advisory Information', () => {
    const uri = Uri.file('/project/a.ts');
    const p = new DiagnosticsProvider(link);
    p.setFindings(uri, [], [
      corporateFinding(),
      corporateFinding({ tier: 'review-required', startLine: 20, endLine: 20 }),
      corporateFinding({ tier: 'review-required', status: 'grace', blocking: false, enforceFrom: '2026-10-22T09:00:00.000Z', startLine: 30, endLine: 30 }),
      corporateFinding({ tier: 'advisory', status: 'advisory', blocking: false, startLine: 40, endLine: 40 }),
    ]);
    const ds = stored(p, uri)!;
    expect(ds.map((d) => d.severity)).toEqual([DiagnosticSeverity.Error, DiagnosticSeverity.Warning, DiagnosticSeverity.Information, DiagnosticSeverity.Information]);
    expect(ds[2].message).toMatch(/^\[Policy · REVIEW-REQUIRED\] .* Status: advisory; enforced from 2026-10-22\.$/);
    expect(ds[3].message).toMatch(/Status: advisory\.$/);
  });

  it('setFindings without corporate keeps the corporate diagnostics; setCorporateFindings keeps the regulatory ones', () => {
    const uri = Uri.file('/project/src/chat.ts');
    const p = new DiagnosticsProvider(link);
    p.setFindings(uri, [REG], [corporateFinding()]);
    p.setFindings(uri, [REG, { ...REG, line: 5, ruleKey: 'eu.other' }]);
    expect(stored(p, uri)!.map((d) => d.source)).toEqual(['Nomus', 'Nomus', 'Nomus Policy']);
    p.setCorporateFindings(uri, []);
    expect(stored(p, uri)!.map((d) => d.code.value)).toEqual(['eu.test.rule', 'eu.other']);
  });

  it('clearing corporate findings of a file that never had any does not touch the collection', () => {
    const uri = Uri.file('/project/untouched.ts');
    const p = new DiagnosticsProvider(link);
    p.setCorporateFindings(uri, []);
    expect(stored(p, uri)).toBeUndefined();
  });

  it('without a dashboard origin the code is the bare policy key', () => {
    const uri = Uri.file('/project/a.ts');
    const p = new DiagnosticsProvider(() => undefined);
    p.setFindings(uri, [], [corporateFinding()]);
    expect(stored(p, uri)![0].code).toBe('corp.no-direct-openai');
  });

  it('clear() drops both kinds', () => {
    const uri = Uri.file('/project/a.ts');
    const p = new DiagnosticsProvider(link);
    p.setFindings(uri, [REG], [corporateFinding()]);
    p.clear();
    p.setCorporateFindings(uri, []);
    expect(stored(p, uri)).toBeUndefined();
  });
});

describe('DiagnosticsProvider: server decisions (design spec §10.4)', () => {
  const FP = corporateFinding().fingerprint;
  const resolution = (status: string, expiresAt: string | null = null) => ({
    fingerprint: FP, status, blocking: status !== 'approved' && status !== 'excepted', tier: 'prohibited', enforceFrom: '2026-10-01T09:00:00.000Z',
    decisionId: null, exceptionDecisionId: null, expiresAt,
  }) as never;
  const cases: Array<[string, string | null, DiagnosticSeverity, string]> = [
    ['approved', '2026-11-08T00:00:00.000Z', DiagnosticSeverity.Hint, 'approved until 2026-11-08'],
    ['excepted', '2026-11-08T00:00:00.000Z', DiagnosticSeverity.Hint, 'excepted (standing exception) until 2026-11-08'],
    ['rejected', null, DiagnosticSeverity.Error, 'rejected'],
    ['pending', null, DiagnosticSeverity.Error, 'decision pending'],
    ['changes_requested', null, DiagnosticSeverity.Error, 'changes requested'],
    ['expired', '2026-10-01T00:00:00.000Z', DiagnosticSeverity.Error, 'approval expired; needs review'],
    ['needs_review', null, DiagnosticSeverity.Error, 'needs review'],
  ];
  it.each(cases)('%s: severity and status text', (status, expiresAt, severity, text) => {
    const uri = Uri.file('/project/src/chat.ts');
    const p = new DiagnosticsProvider(link);
    p.setFindings(uri, [REG], [corporateFinding()]);
    p.setResolutions([resolution(status, expiresAt)]);
    const [reg, d] = stored(p, uri)!;
    expect([reg.source, d.severity, d.message.endsWith(`Status: ${text}.`)]).toEqual(['Nomus', severity, true]);
  });

  it('a review-required finding stays a Warning until decided; resolutions of other fingerprints do not apply; clearing restores the scan status', () => {
    const uri = Uri.file('/project/a.ts');
    const p = new DiagnosticsProvider(link);
    p.setCorporateFindings(uri, [corporateFinding({ tier: 'review-required' })]);
    p.setResolutions([{ ...resolution('approved', '2026-11-08T00:00:00.000Z'), fingerprint: `${'b'.repeat(64)}:corp.other:1` }]);
    expect(stored(p, uri)![0].severity).toBe(DiagnosticSeverity.Warning);
    p.setResolutions([resolution('approved', '2026-11-08T00:00:00.000Z')]);
    expect(stored(p, uri)![0].severity).toBe(DiagnosticSeverity.Hint);
    p.setResolutions([]);
    expect([stored(p, uri)![0].severity, stored(p, uri)![0].message.endsWith('Status: needs review.')]).toEqual([DiagnosticSeverity.Warning, true]);
  });
});

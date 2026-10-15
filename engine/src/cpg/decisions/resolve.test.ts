/** §7.4 precedence and §7.3 standing-match conditions, as pure functions. */
import { describe, it, expect } from 'vitest';
import { standingPatternSchema } from '../contracts.js';
import { precedence, type DecisionRow } from './resolve.js';
import { matchesStanding, type LocatedFinding, type StandingRule } from './standing.js';

const NOW = '2026-10-09T12:00:00.000Z';
const PAST = '2026-10-01T00:00:00.000Z';
const SOON = '2026-10-20T00:00:00.000Z';
const LATER = '2026-11-20T00:00:00.000Z';

const decision = (id: string, outcome: 'approve' | 'reject', expiresAt: string | null) => ({ id, outcome, expiresAt }) as DecisionRow;
const approved = (id: string, at: string) => decision(id, 'approve', at);

describe('precedence (§7.4)', () => {
  const exception = approved('x1', SOON);
  const cases: Array<[string, DecisionRow | undefined, DecisionRow[], string | null, string | undefined, string | undefined]> = [
    ['no decision, no exception: undecided', undefined, [], null, undefined, undefined],
    ['a rejection blocks and beats an exception', decision('d', 'reject', null), [exception], 'rejected', 'd', undefined],
    ['an unexpired approval passes, reported over an exception', approved('d', LATER), [exception], 'approved', 'd', undefined],
    ['an expired approval falls through to an exception', approved('d', PAST), [exception], 'excepted', 'd', 'x1'],
    ['an expired approval with no exception is expired', approved('d', PAST), [], 'expired', 'd', undefined],
    ['an exception alone excepts', undefined, [exception], 'excepted', undefined, 'x1'],
    ['an expired exception does not except', undefined, [approved('x0', PAST)], null, undefined, undefined],
    ['the exception that expires last is reported', undefined, [exception, approved('x2', LATER)], 'excepted', undefined, 'x2'],
    ['ties go to the lowest id', undefined, [approved('xb', SOON), approved('xa', SOON)], 'excepted', undefined, 'xa'],
  ];
  it.each(cases)('%s', (_name, d, exceptions, status, decisionId, exceptionId) => {
    const c = precedence(d, exceptions, NOW);
    expect([c.status, c.decision?.id, c.exception?.id]).toEqual([status, decisionId, exceptionId]);
  });
});

describe('matchesStanding (§7.3)', () => {
  const finding: LocatedFinding = {
    repo: 'gate.example.org/team/app', branch: 'feat/legacy', filePath: 'src/legacy/old.ts', startLine: 3, endLine: 5,
    language: 'typescript', policyKey: 'corp.no-openai', policyVersion: 2, snippetHash: 'h',
  };
  const rule = (pattern: Record<string, unknown>, teamRepos: string[] = []): StandingRule => ({
    pattern: standingPatternSchema.parse({ repos: ['gate.example.org/team/app'], paths: ['src/legacy/**'], policyKey: 'corp.no-openai', policyVersion: 2, ...pattern }),
    teamRepos,
  });
  const snippet = (hash: string) => (hash === 'h' ? 'client.chat.completions.create(req)' : undefined);
  const matches = (r: StandingRule, f: Partial<LocatedFinding> = {}) => matchesStanding({ ...finding, ...f }, r, snippet);

  it('matches the pattern; every condition can exclude the finding', () => {
    expect(matches(rule({}))).toBe(true);
    expect(matches(rule({}), { policyVersion: 3 })).toBe(false); // D11: pinned to the policy version
    expect(matches(rule({}), { policyKey: 'corp.other' })).toBe(false);
    expect(matches(rule({}), { repo: 'gate.example.org/team/other' })).toBe(false);
    expect(matches(rule({}), { filePath: 'src/new/chat.ts' })).toBe(false);
    expect(matches(rule({ excludePaths: ['**/old.ts'] }))).toBe(false);
    expect(matches(rule({ conditions: { branches: ['release/*'] } }))).toBe(false);
    expect(matches(rule({ conditions: { branches: ['feat/*'] } }))).toBe(true);
    expect(matches(rule({ conditions: { languages: ['python'] } }))).toBe(false);
    expect(matches(rule({ conditions: { languages: ['typescript'] } }), { language: null })).toBe(false);
    expect(matches(rule({ conditions: { maxLinesPerFinding: 2 } }))).toBe(false);
    expect(matches(rule({ conditions: { maxLinesPerFinding: 3 } }))).toBe(true);
    expect(matches(rule({ conditions: { snippetMustMatch: { source: 'CHAT\\.completions', flags: 'i' } } }))).toBe(true);
    expect(matches(rule({ conditions: { snippetMustMatch: { source: 'responses\\.create', flags: '' } } }))).toBe(false);
  });

  it('fails closed when the snippet a condition needs is not stored', () => {
    expect(matches(rule({ conditions: { snippetMustMatch: { source: 'chat', flags: '' } } }), { snippetHash: 'missing' })).toBe(false);
  });

  it('a team covers the repositories it resolves to', () => {
    const team = rule({ repos: [], teamIds: ['5b0c1b8e-3c8e-4a52-9a43-6f2f1a9d1c10'] }, ['gate.example.org/team/*']);
    expect(matches(team)).toBe(true);
    expect(matches({ ...team, teamRepos: [] })).toBe(false); // archived team: nothing resolved
  });
});

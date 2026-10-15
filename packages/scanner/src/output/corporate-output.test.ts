import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CorporateFinding } from '../match/rule-matcher.js';
import type { CorporateScanSummary } from '../scan-corporate.js';
import { formatCorporateSarif, formatCorporateSarifRun, CORPORATE_SARIF_CATEGORY, policyPageUrl } from './sarif-corporate.js';
import { corporateStatusText, formatCorporateConsoleReport, formatCorporateJson } from './reporter.js';

const SNIPPET = "  const reply = await client.chat.completions.create({\n    model: 'gpt-4o',\n  });";

function finding(over: Partial<CorporateFinding> = {}): CorporateFinding {
  const base: CorporateFinding = {
    source: 'corporate', file: '/repo/src/chat.ts', filePath: 'src/chat.ts', language: 'typescript',
    startLine: 6, endLine: 8, anchorLine: 6, matchedBy: 'sdk_call',
    policyKey: 'corp.no-direct-openai', policyVersion: 2, tier: 'prohibited', status: 'needs_review', blocking: true,
    enforceFrom: '2026-10-01T09:00:00.000Z',
    fingerprint: `${'a'.repeat(64)}:corp.no-direct-openai:2`, snippetHash: 'a'.repeat(64), snippet: SNIPPET, truncated: false,
    rule: {
      policyId: '0b8f5d2c-3e4a-4f6b-9c1d-2e3f4a5b6c7d', policyKey: 'corp.no-direct-openai', version: 2, title: 'No direct OpenAI calls',
      tier: 'prohibited', message: 'Call OpenAI only through the approved LLM gateway.',
      owningBoards: [{ id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'AI Review Board' }, { id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', name: 'Legal' }],
      enforceFrom: '2026-10-01T09:00:00.000Z', activatedAt: '2026-10-01T09:00:00.000Z', policyReference: 'Corporate policy corp.no-direct-openai v2: No direct OpenAI calls',
    },
  };
  return { ...base, ...over };
}
const grace = finding({
  filePath: 'src/models.ts', file: '/repo/src/models.ts', startLine: 3, endLine: 3, policyKey: 'corp.no-gpt-4-32k', policyVersion: 1,
  tier: 'review-required', status: 'grace', blocking: false, enforceFrom: '2026-10-22T09:00:00.000Z',
  fingerprint: `${'b'.repeat(64)}:corp.no-gpt-4-32k:1`, snippet: "export const LEGACY_MODEL = 'gpt-4-32k';",
  rule: { ...finding().rule, policyId: '9c8b7a6f-5e4d-4c3b-8a29-1f0e9d8c7b6a', policyKey: 'corp.no-gpt-4-32k', version: 1, title: 'Do not use gpt-4-32k', tier: 'review-required', message: 'The gpt-4-32k model is retired.' },
});
const SUMMARY: CorporateScanSummary = {
  available: true, enabled: true, orgId: '6f1c2a4e-9b7d-4c3e-8a21-0d5e6f7a8b9c', bundleHash: 'c'.repeat(64),
  policyCount: 3, scannedFileCount: 5, skippedLongLines: 0, skippedFileCount: 0,
};

async function validateSarif(log: unknown): Promise<string[]> {
  // The release gate's own SARIF 2.1.0 validator (plain JS, loaded at run time).
  const url = pathToFileURL(join(import.meta.dirname, '..', '..', '..', '..', 'e2e', 'lib', 'sarif.mjs')).href;
  const mod = await import(url) as { validateSarif: (l: unknown) => string[] };
  return mod.validateSarif(log);
}

describe('corporate SARIF (spec §11.4)', () => {
  it('is a valid SARIF 2.1.0 run with the nomus-corporate/ category and one result per finding', async () => {
    const log = formatCorporateSarif([finding(), grace], { dashboardUrl: 'https://nomus.example.org/' });
    expect(await validateSarif(log)).toEqual([]);
    const run = log.runs[0];
    expect(run.automationDetails.id).toBe(CORPORATE_SARIF_CATEGORY);
    expect(run.tool.driver.name).toBe('Nomus Corporate Policy');
    expect(run.tool.driver.rules.map((r) => [r.id, r.shortDescription.text, r.properties.tags])).toEqual([
      ['corp.no-direct-openai', 'No direct OpenAI calls', ['corporate-policy', 'prohibited']],
      ['corp.no-gpt-4-32k', 'Do not use gpt-4-32k', ['corporate-policy', 'review-required']],
    ]);
    expect(run.tool.driver.rules[0].helpUri).toBe('https://nomus.example.org/governance/policies/0b8f5d2c-3e4a-4f6b-9c1d-2e3f4a5b6c7d');
    expect(run.results.map((r) => [r.level, r.locations[0].physicalLocation.region, r.partialFingerprints['nomusCorporate/v1']])).toEqual([
      ['error', { startLine: 6, endLine: 8, startColumn: 1 }, finding().fingerprint],
      ['note', { startLine: 3, endLine: 3, startColumn: 1 }, grace.fingerprint],
    ]);
    expect(run.results[1].message.text).toMatch(/Status: advisory; enforced from 2026-10-22\.$/);
  });

  it('never carries the code: no snippet text in the log', () => {
    const text = JSON.stringify(formatCorporateSarif([finding(), grace]));
    expect(text).not.toContain('chat.completions.create');
    expect(text).not.toContain("LEGACY_MODEL = 'gpt-4-32k'");
  });

  it('without a dashboard origin the rules carry no helpUri; an empty run is still valid', async () => {
    expect(formatCorporateSarifRun([finding()]).tool.driver.rules[0].helpUri).toBeUndefined();
    expect(policyPageUrl(undefined, 'x')).toBeUndefined();
    expect(await validateSarif(formatCorporateSarif([]))).toEqual([]);
  });

  it('with the server resolutions (CI gate): the status, level and a suppression for an approved finding, and the case link', async () => {
    const decisionId = '7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918';
    const resolution = { fingerprint: finding().fingerprint, status: 'approved' as const, blocking: false, tier: 'prohibited' as const, enforceFrom: finding().enforceFrom, decisionId, exceptionDecisionId: null, expiresAt: '2026-11-08T00:00:00.000Z' };
    const log = formatCorporateSarif([finding(), grace], { resolutionOf: (f) => (f.filePath === 'src/chat.ts' ? resolution : undefined), caseUrl: 'https://gate.example.org/governance/cases/x' });
    expect(await validateSarif(log)).toEqual([]);
    const [approved, local] = log.runs[0].results;
    expect([approved.level, approved.properties.status, approved.properties.blocking]).toEqual(['note', 'approved', false]);
    expect(approved.suppressions).toEqual([{ kind: 'external', status: 'accepted', justification: `Approved by Nomus decision ${decisionId} until 2026-11-08T00:00:00.000Z` }]);
    expect(approved.message.text).toMatch(/Status: approved\. Review case: https:\/\/gate\.example\.org\/governance\/cases\/x$/);
    expect(local.suppressions).toBeUndefined();
    expect(JSON.stringify(log)).not.toContain('chat.completions.create');
  });
});

describe('corporate report sections', () => {
  it('status text: needs review, advisory with the enforce-from day, advisory', () => {
    expect(corporateStatusText(finding())).toBe('needs review');
    expect(corporateStatusText(grace)).toBe('advisory; enforced from 2026-10-22');
    expect(corporateStatusText(finding({ status: 'advisory' }))).toBe('advisory');
  });

  it('JSON: repository-relative findings with fingerprints and no code', () => {
    const j = formatCorporateJson([finding(), grace], SUMMARY);
    expect(j.corporate).toEqual({ enabled: true, orgId: SUMMARY.orgId, bundleHash: SUMMARY.bundleHash, policyCount: 3, scannedFileCount: 5, skippedLongLines: 0, skippedFileCount: 0, total: 2, blocking: 1 });
    expect(j.corporateFindings[0]).toMatchObject({ file: 'src/chat.ts', startLine: 6, endLine: 8, policyKey: 'corp.no-direct-openai', status: 'needs_review', blocking: true, owningBoards: ['AI Review Board', 'Legal'] });
    expect(JSON.stringify(j)).not.toContain('chat.completions.create');
  });

  it('console: a separate section listing each finding, its status and fingerprint; no undefined/NaN', () => {
    const text = formatCorporateConsoleReport([finding(), grace], SUMMARY);
    expect(text).toContain(`Corporate policies: 3 active policies (bundle ${SUMMARY.bundleHash!.slice(0, 12)})
5 files checked for corporate policies (every repository file in a policy's scope, of any type)
`);
    expect(text).toContain('[PROHIBITED] corp.no-direct-openai v2: No direct OpenAI calls');
    expect(text).toContain('File:   src/chat.ts:6-8');
    expect(text).toContain('Status: needs review (blocking)');
    expect(text).toContain('Status: advisory; enforced from 2026-10-22');
    expect(text).toContain(`Fingerprint: ${finding().fingerprint}`);
    expect(text).not.toMatch(/undefined|NaN|\[object Object\]/);
    expect(formatCorporateConsoleReport([], { ...SUMMARY, policyCount: 1, scannedFileCount: 1 })).toContain('No corporate policy findings.');
  });

  it('console: owners by name, whatever order the bundle lists them in', () => {
    const f = finding();
    const reversed = { ...f, rule: { ...f.rule, owningBoards: [...f.rule.owningBoards].reverse() } };
    expect(formatCorporateConsoleReport([reversed], SUMMARY)).toMatch(/^ {3}Owners: AI Review Board, Legal$/m);
  });
});

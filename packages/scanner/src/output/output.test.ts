/**
 * Scanner output tests — covers fix/suggestions, output/reporter, output/sarif
 *
 * Closes the UNTESTED-but-probably-works gap from the 2026-04-07 end-to-end audit.
 * Each function is exercised end-to-end with a small set of synthetic Findings,
 * and the result is asserted against the documented contract.
 */
import { describe, it, expect } from 'vitest';
import { generateSuggestions } from '../fix/suggestions.js';
import { formatConsoleReport, formatJsonReport } from './reporter.js';
import { formatSarifReport } from './sarif.js';
import type { Finding } from '../match/rule-matcher.js';

function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    file: '/repo/src/api/handler.ts',
    line: 42,
    sdk: 'openai',
    detectorSource: 'phi-pattern-detector',
    evidence: 'await openai.chat.completions.create({...})',
    rule: {
      ruleKey: 'hipaa.164_502.phi_in_ai_pipeline',
      effect: 'deny',
      severity: 'critical',
      humanSummary: 'PHI flowing into AI model calls violates the HIPAA Privacy Rule',
      legalReference: '45 CFR § 164.502(a)',
      matchedOn: ['capability:phi_in_ai_call'],
      confidence: 0.85,
    },
    ...over,
  };
}

// ════════════════════════════════════════════════════════════════════
// generateSuggestions
// ════════════════════════════════════════════════════════════════════

describe('generateSuggestions', () => {
  it('attaches a suggestion string to every finding', () => {
    const findings = [
      makeFinding({ rule: { ...makeFinding().rule, effect: 'deny' } }),
      makeFinding({ rule: { ...makeFinding().rule, effect: 'allow_with_audit' } }),
      makeFinding({ rule: { ...makeFinding().rule, effect: 'require_disclosure' } }),
      makeFinding({ rule: { ...makeFinding().rule, effect: 'flag' } }),
    ];
    const out = generateSuggestions(findings);
    expect(out.length).toBe(4);
    for (const f of out) {
      expect(f.suggestion).toBeTruthy();
      expect(typeof f.suggestion).toBe('string');
      expect(f.suggestion!.length).toBeGreaterThan(20);
    }
  });

  it('deny effect suggestion mentions human oversight + conformity assessment', () => {
    const out = generateSuggestions([makeFinding({ rule: { ...makeFinding().rule, effect: 'deny' } })]);
    expect(out[0].suggestion).toMatch(/human oversight/i);
    expect(out[0].suggestion).toMatch(/conformity assessment/i);
  });

  it('require_disclosure suggestion includes the AI disclosure header example', () => {
    const out = generateSuggestions([makeFinding({ rule: { ...makeFinding().rule, effect: 'require_disclosure' } })]);
    expect(out[0].suggestion).toMatch(/X-AI-Generated/);
    expect(out[0].suggestion).toMatch(/_ai_disclosure/);
  });

  it('allow_with_audit suggestion uses sdk-specific call example', () => {
    const out = generateSuggestions([makeFinding({ sdk: 'openai', rule: { ...makeFinding().rule, effect: 'allow_with_audit' } })]);
    expect(out[0].suggestion).toMatch(/openai\.chat\.completions\.create/);
    expect(out[0].suggestion).toMatch(/auditLog/);
  });

  it('flag effect suggestion is informational', () => {
    const out = generateSuggestions([makeFinding({ rule: { ...makeFinding().rule, effect: 'flag' } })]);
    expect(out[0].suggestion).toMatch(/flagged for review/i);
  });

  it('unknown effect falls back to generic review message', () => {
    const out = generateSuggestions([makeFinding({ rule: { ...makeFinding().rule, effect: 'unknown_effect' } })]);
    expect(out[0].suggestion).toMatch(/Review/);
    expect(out[0].suggestion).toMatch(/hipaa\.164_502\.phi_in_ai_pipeline/);
  });

  it('preserves all other Finding fields', () => {
    const f = makeFinding();
    const out = generateSuggestions([f]);
    expect(out[0].file).toBe(f.file);
    expect(out[0].line).toBe(f.line);
    expect(out[0].sdk).toBe(f.sdk);
    expect(out[0].detectorSource).toBe(f.detectorSource);
    expect(out[0].rule.ruleKey).toBe(f.rule.ruleKey);
  });
});

// ════════════════════════════════════════════════════════════════════
// formatConsoleReport
// ════════════════════════════════════════════════════════════════════

describe('formatConsoleReport', () => {
  it('returns the empty-state message when no findings', () => {
    const out = formatConsoleReport([]);
    expect(out).toMatch(/No applicable regulatory obligations/);
  });

  it('groups findings by severity and shows counts', () => {
    const findings = [
      makeFinding({ rule: { ...makeFinding().rule, severity: 'critical', ruleKey: 'r1' } }),
      makeFinding({ rule: { ...makeFinding().rule, severity: 'high', ruleKey: 'r2' } }),
      makeFinding({ rule: { ...makeFinding().rule, severity: 'high', ruleKey: 'r3' } }),
      makeFinding({ rule: { ...makeFinding().rule, severity: 'low', ruleKey: 'r4' } }),
    ];
    const out = formatConsoleReport(findings);
    expect(out).toMatch(/4 applicable regulatory obligation/);
    expect(out).toMatch(/1 critical, 2 high, 4 total/);
  });

  it('shows FAIL status when any critical finding present', () => {
    const out = formatConsoleReport([makeFinding({ rule: { ...makeFinding().rule, severity: 'critical' } })]);
    expect(out).toMatch(/FAIL/);
    expect(out).toMatch(/Critical regulatory obligations/);
  });

  it('shows WARN status when high but no critical', () => {
    const out = formatConsoleReport([makeFinding({ rule: { ...makeFinding().rule, severity: 'high' } })]);
    expect(out).toMatch(/WARN/);
  });

  it('shows PASS status when only low/medium', () => {
    const out = formatConsoleReport([makeFinding({ rule: { ...makeFinding().rule, severity: 'low' } })]);
    expect(out).toMatch(/PASS/);
  });

  it('renders file:line, sdk, ruleKey, legal reference, and effect for each finding', () => {
    const out = formatConsoleReport([makeFinding()]);
    expect(out).toContain('/repo/src/api/handler.ts:42');
    expect(out).toContain('openai');
    expect(out).toContain('hipaa.164_502.phi_in_ai_pipeline');
    expect(out).toContain('45 CFR § 164.502(a)');
    expect(out).toContain('BLOCKED');
  });

  it('includes the legal disclaimer', () => {
    const out = formatConsoleReport([makeFinding()]);
    expect(out).toMatch(/does not provide legal advice/);
  });
});

// ════════════════════════════════════════════════════════════════════
// formatJsonReport
// ════════════════════════════════════════════════════════════════════

describe('formatJsonReport', () => {
  it('returns pass status for empty findings', () => {
    const out = formatJsonReport([]);
    expect(out.status).toBe('pass');
    expect(out.total).toBe(0);
    expect(out.critical).toBe(0);
    expect(out.findings).toEqual([]);
  });

  it('returns fail status when any critical present', () => {
    const out = formatJsonReport([makeFinding()]);
    expect(out.status).toBe('fail');
    expect(out.critical).toBe(1);
  });

  it('correctly counts severity buckets', () => {
    const findings = [
      makeFinding({ rule: { ...makeFinding().rule, severity: 'critical' } }),
      makeFinding({ rule: { ...makeFinding().rule, severity: 'high' } }),
      makeFinding({ rule: { ...makeFinding().rule, severity: 'high' } }),
      makeFinding({ rule: { ...makeFinding().rule, severity: 'medium' } }),
      makeFinding({ rule: { ...makeFinding().rule, severity: 'low' } }),
    ];
    const out = formatJsonReport(findings);
    expect(out.total).toBe(5);
    expect(out.critical).toBe(1);
    expect(out.high).toBe(2);
    expect(out.medium).toBe(1);
    expect(out.low).toBe(1);
  });

  it('serializes each finding with the documented field set', () => {
    const out = formatJsonReport([makeFinding()]);
    const f = out.findings[0];
    expect(f.file).toBe('/repo/src/api/handler.ts');
    expect(f.line).toBe(42);
    expect(f.sdk).toBe('openai');
    expect(f.ruleKey).toBe('hipaa.164_502.phi_in_ai_pipeline');
    expect(f.severity).toBe('critical');
    expect(f.effect).toBe('deny');
    expect(f.summary).toMatch(/PHI flowing/);
    expect(f.legalReference).toBe('45 CFR § 164.502(a)');
  });

  it('includes the legal disclaimer', () => {
    const out = formatJsonReport([makeFinding()]);
    expect(out._disclaimer).toMatch(/does not provide legal advice/);
  });
});

// ════════════════════════════════════════════════════════════════════
// formatSarifReport
// ════════════════════════════════════════════════════════════════════

describe('formatSarifReport', () => {
  it('produces a SARIF 2.1.0 schema-compliant document', () => {
    const out = formatSarifReport([makeFinding()], '/repo');
    expect(out.version).toBe('2.1.0');
    expect(out.$schema).toMatch(/sarif-schema-2\.1\.0\.json/);
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0].tool.driver.name).toBe('Nomus');
    expect(out.runs[0].tool.driver.informationUri).toBe('https://github.com/babbguy/Nomus');
  });

  it('builds a unique rule per ruleKey, deduped across findings', () => {
    const findings = [
      makeFinding({ file: '/repo/a.ts' }),
      makeFinding({ file: '/repo/b.ts' }),
      makeFinding({ file: '/repo/c.ts', rule: { ...makeFinding().rule, ruleKey: 'gdpr.art5.pii_in_ai_pipeline' } }),
    ];
    const out = formatSarifReport(findings, '/repo');
    expect(out.runs[0].tool.driver.rules).toHaveLength(2);
    expect(out.runs[0].results).toHaveLength(3);
  });

  it('maps severity to SARIF level (critical/high → error, medium → warning, low → note)', () => {
    const out = formatSarifReport(
      [
        makeFinding({ rule: { ...makeFinding().rule, severity: 'critical' } }),
        makeFinding({ rule: { ...makeFinding().rule, severity: 'high' } }),
        makeFinding({ rule: { ...makeFinding().rule, severity: 'medium' } }),
        makeFinding({ rule: { ...makeFinding().rule, severity: 'low' } }),
      ],
      '/repo',
    );
    expect(out.runs[0].results[0].level).toBe('error');
    expect(out.runs[0].results[1].level).toBe('error');
    expect(out.runs[0].results[2].level).toBe('warning');
    expect(out.runs[0].results[3].level).toBe('note');
  });

  it('includes detector source and evidence in result message', () => {
    const out = formatSarifReport(
      [makeFinding({ detectorSource: 'phi-pattern-detector', evidence: 'patient_name = req.body.name' })],
      '/repo',
    );
    expect(out.runs[0].results[0].message.text).toContain('phi-pattern-detector');
    expect(out.runs[0].results[0].message.text).toContain('patient_name = req.body.name');
  });

  it('uses paths relative to rootDir with forward slashes', () => {
    const out = formatSarifReport([makeFinding({ file: '/repo/src/api/handler.ts' })], '/repo');
    const uri = out.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri).toBe('src/api/handler.ts');
    expect(uri).not.toContain('\\'); // never backslashes even on Windows
  });

  it('carries the suggestion in result properties, never as a schema-invalid fix', () => {
    const finding = makeFinding({ suggestion: 'Add audit logging here' });
    const out = formatSarifReport([finding], '/repo');
    const result = out.runs[0].results[0] as unknown as Record<string, unknown>;
    // SARIF 2.1.0 requires fix.artifactChanges; GitHub rejects fixes without it.
    expect(result.fixes).toBeUndefined();
    expect(out.runs[0].results[0].properties?.suggestion).toBe('Add audit logging here');
  });

  it('omits properties when finding has no suggestion', () => {
    const finding = makeFinding();
    delete (finding as { suggestion?: string }).suggestion;
    const out = formatSarifReport([finding], '/repo');
    expect(out.runs[0].results[0].properties).toBeUndefined();
  });

  it('tags rules with effect-derived properties', () => {
    const out = formatSarifReport([makeFinding({ rule: { ...makeFinding().rule, effect: 'deny' } })], '/repo');
    const tags = out.runs[0].tool.driver.rules[0].properties.tags;
    expect(tags).toContain('security');
    expect(tags).toContain('regulatory');
    expect(tags).toContain('ai-regulation');
    expect(tags).toContain('prohibited');
  });
});

// ════════════════════════════════════════════════════════════════════
// --fail-on agreement (end-to-end audit: the report must match the exit code)
// ════════════════════════════════════════════════════════════════════

describe('report status honours --fail-on', () => {
  const high = () => makeFinding({ rule: { ...makeFinding().rule, severity: 'high' } });

  it('JSON status is fail for a high finding under --fail-on=high', () => {
    const out = formatJsonReport([high()], { failOn: 'high' });
    expect(out.status).toBe('fail');
    expect(out.failOn).toBe('high');
  });

  it('JSON status stays pass for a high finding under the default threshold', () => {
    expect(formatJsonReport([high()]).status).toBe('pass');
  });

  it('console summary says FAIL (not WARN) when --fail-on=high trips', () => {
    const out = formatConsoleReport([high()], { failOn: 'high' });
    expect(out).toMatch(/FAIL/);
    expect(out).toMatch(/--fail-on=high/);
    expect(out).not.toMatch(/WARN/);
  });

  it('prints the whole multi-line suggestion, not just its first line', () => {
    const [f] = generateSuggestions([makeFinding({ rule: { ...makeFinding().rule, effect: 'deny' } })]);
    const out = formatConsoleReport([f]);
    expect(out).toMatch(/1\. Adding human oversight/);
    expect(out).toMatch(/3\. Consulting legal counsel/);
  });

  it('reports paths relative to rootDir when given', () => {
    const out = formatJsonReport([makeFinding({ file: '/repo/src/api/handler.ts' })], { rootDir: '/repo' });
    expect(out.findings[0].file).toBe('src/api/handler.ts');
    expect(formatConsoleReport([makeFinding({ file: '/repo/src/api/handler.ts' })], { rootDir: '/repo' }))
      .toContain('File: src/api/handler.ts:42');
  });
});

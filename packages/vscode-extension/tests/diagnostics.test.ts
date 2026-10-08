import { describe, it, expect, beforeEach } from 'vitest';
import { DiagnosticsProvider, type DiagnosticFinding } from '../src/diagnostics';
import { Uri, DiagnosticSeverity } from 'vscode';

describe('DiagnosticsProvider', () => {
  let provider: DiagnosticsProvider;

  beforeEach(() => {
    provider = new DiagnosticsProvider();
  });

  it('creates a diagnostic collection', () => {
    // Provider should be constructable and disposable
    expect(provider).toBeDefined();
    provider.dispose();
  });

  it('sets findings as diagnostics on a URI', () => {
    const uri = Uri.file('/project/src/app.ts');
    const findings: DiagnosticFinding[] = [
      {
        file: '/project/src/app.ts',
        line: 5,
        sdk: '@anthropic-ai/sdk',
        severity: 'critical',
        ruleKey: 'eu-ai-act.high-risk.transparency',
        humanSummary: 'AI system must provide transparency documentation',
        legalReference: 'EU AI Act Article 13',
      },
    ];

    provider.setFindings(uri, findings);
    // The diagnostic collection is set — verify via the internal mock
    const collection = (provider as any).collection;
    const stored = collection._store.get(uri.toString());
    expect(stored).toHaveLength(1);
    expect(stored[0].message).toContain('eu-ai-act.high-risk.transparency');
    expect(stored[0].message).toContain('AI system must provide transparency documentation');
    expect(stored[0].severity).toBe(DiagnosticSeverity.Error); // critical → Error
    expect(stored[0].source).toBe('Nomus');
  });

  it('maps severity levels correctly', () => {
    const uri = Uri.file('/test.ts');
    const severities = ['critical', 'high', 'medium', 'low'];
    const expected = [
      DiagnosticSeverity.Error,
      DiagnosticSeverity.Error,
      DiagnosticSeverity.Warning,
      DiagnosticSeverity.Information,
    ];

    for (let i = 0; i < severities.length; i++) {
      const findings: DiagnosticFinding[] = [{
        file: '/test.ts',
        line: i + 1,
        sdk: 'openai',
        severity: severities[i],
        ruleKey: `test.rule.${severities[i]}`,
        humanSummary: `Test finding with ${severities[i]} severity`,
        legalReference: 'Test reference',
      }];

      provider.setFindings(uri, findings);
      const collection = (provider as any).collection;
      const stored = collection._store.get(uri.toString());
      expect(stored[i === 0 ? 0 : 0].severity).toBe(expected[i]);
    }
  });

  it('handles unknown severity as Warning', () => {
    const uri = Uri.file('/test.ts');
    const findings: DiagnosticFinding[] = [{
      file: '/test.ts',
      line: 1,
      sdk: 'openai',
      severity: 'unknown_severity',
      ruleKey: 'test.rule',
      humanSummary: 'Unknown severity test',
      legalReference: '',
    }];

    provider.setFindings(uri, findings);
    const collection = (provider as any).collection;
    const stored = collection._store.get(uri.toString());
    expect(stored[0].severity).toBe(DiagnosticSeverity.Warning);
  });

  it('includes legal reference as related information', () => {
    const uri = Uri.file('/test.ts');
    const findings: DiagnosticFinding[] = [{
      file: '/test.ts',
      line: 10,
      sdk: 'openai',
      severity: 'high',
      ruleKey: 'eu-ai-act.article-52',
      humanSummary: 'Disclosure required',
      legalReference: 'EU AI Act Article 52(1)',
    }];

    provider.setFindings(uri, findings);
    const collection = (provider as any).collection;
    const stored = collection._store.get(uri.toString());
    expect(stored[0].relatedInformation).toHaveLength(1);
    expect(stored[0].relatedInformation[0].message).toContain('EU AI Act Article 52(1)');
  });

  it('does not add related info when legalReference is empty', () => {
    const uri = Uri.file('/test.ts');
    const findings: DiagnosticFinding[] = [{
      file: '/test.ts',
      line: 1,
      sdk: 'openai',
      severity: 'low',
      ruleKey: 'test.rule',
      humanSummary: 'No legal ref',
      legalReference: '',
    }];

    provider.setFindings(uri, findings);
    const collection = (provider as any).collection;
    const stored = collection._store.get(uri.toString());
    // relatedInformation should be empty or undefined
    expect(stored[0].relatedInformation ?? []).toHaveLength(0);
  });

  it('sets code with link to the documentation', () => {
    const uri = Uri.file('/test.ts');
    const findings: DiagnosticFinding[] = [{
      file: '/test.ts',
      line: 1,
      sdk: 'openai',
      severity: 'medium',
      ruleKey: 'eu-ai-act.transparency',
      humanSummary: 'Test',
      legalReference: 'Test',
    }];

    provider.setFindings(uri, findings);
    const collection = (provider as any).collection;
    const stored = collection._store.get(uri.toString());
    expect(stored[0].code.value).toBe('eu-ai-act.transparency');
    expect(stored[0].code.target.toString()).toContain('/babbguy/Nomus/tree/main/docs');
  });

  it('clears all diagnostics', () => {
    const uri = Uri.file('/test.ts');
    provider.setFindings(uri, [{
      file: '/test.ts', line: 1, sdk: 'openai', severity: 'high',
      ruleKey: 'test', humanSummary: 'test', legalReference: '',
    }]);

    provider.clear();
    const collection = (provider as any).collection;
    expect(collection._store.size).toBe(0);
  });

  it('handles empty findings array', () => {
    const uri = Uri.file('/test.ts');
    provider.setFindings(uri, []);
    const collection = (provider as any).collection;
    const stored = collection._store.get(uri.toString());
    expect(stored).toHaveLength(0);
  });

  it('adjusts line numbers (1-indexed to 0-indexed)', () => {
    const uri = Uri.file('/test.ts');
    provider.setFindings(uri, [{
      file: '/test.ts', line: 42, sdk: 'openai', severity: 'medium',
      ruleKey: 'test', humanSummary: 'test', legalReference: '',
    }]);

    const collection = (provider as any).collection;
    const stored = collection._store.get(uri.toString());
    // Line 42 in source → line 41 in Range (0-indexed)
    expect(stored[0].range.startLine).toBe(41);
  });

  it('clamps line 0 to line 0 (minimum)', () => {
    const uri = Uri.file('/test.ts');
    provider.setFindings(uri, [{
      file: '/test.ts', line: 0, sdk: 'openai', severity: 'medium',
      ruleKey: 'test', humanSummary: 'test', legalReference: '',
    }]);

    const collection = (provider as any).collection;
    const stored = collection._store.get(uri.toString());
    expect(stored[0].range.startLine).toBe(0);
  });
});

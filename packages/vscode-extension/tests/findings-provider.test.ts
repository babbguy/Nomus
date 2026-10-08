import { describe, it, expect, beforeEach } from 'vitest';
import { FindingsTreeProvider } from '../src/sidebar/findings-provider';
import type { DiagnosticFinding } from '../src/diagnostics';

describe('FindingsTreeProvider', () => {
  let provider: FindingsTreeProvider;

  beforeEach(() => {
    provider = new FindingsTreeProvider();
  });

  it('returns empty children when no findings', () => {
    const children = provider.getChildren();
    expect(children).toHaveLength(0);
  });

  it('returns findings sorted by severity', () => {
    const findings: DiagnosticFinding[] = [
      { file: '/a.ts', line: 1, sdk: 'openai', severity: 'low', ruleKey: 'rule.low', humanSummary: 'Low finding', legalReference: '' },
      { file: '/b.ts', line: 2, sdk: 'openai', severity: 'critical', ruleKey: 'rule.critical', humanSummary: 'Critical finding', legalReference: '' },
      { file: '/c.ts', line: 3, sdk: 'openai', severity: 'high', ruleKey: 'rule.high', humanSummary: 'High finding', legalReference: '' },
      { file: '/d.ts', line: 4, sdk: 'openai', severity: 'medium', ruleKey: 'rule.medium', humanSummary: 'Medium finding', legalReference: '' },
    ];

    provider.setFindings(findings);
    const children = provider.getChildren();

    // Should be ordered: critical, high, medium, low
    expect(children).toHaveLength(4);
    expect(children[0].description).toContain('Critical finding');
    expect(children[1].description).toContain('High finding');
    expect(children[2].description).toContain('Medium finding');
    expect(children[3].description).toContain('Low finding');
  });

  it('groups multiple findings of the same severity together', () => {
    const findings: DiagnosticFinding[] = [
      { file: '/a.ts', line: 1, sdk: 'openai', severity: 'high', ruleKey: 'rule.1', humanSummary: 'First', legalReference: '' },
      { file: '/b.ts', line: 2, sdk: 'openai', severity: 'high', ruleKey: 'rule.2', humanSummary: 'Second', legalReference: '' },
      { file: '/c.ts', line: 3, sdk: 'openai', severity: 'critical', ruleKey: 'rule.3', humanSummary: 'Third', legalReference: '' },
    ];

    provider.setFindings(findings);
    const children = provider.getChildren();

    expect(children).toHaveLength(3);
    // Critical first, then two highs
    expect(children[0].description).toContain('Third');
    expect(children[1].description).toContain('First');
    expect(children[2].description).toContain('Second');
  });

  it('clears findings', () => {
    provider.setFindings([
      { file: '/a.ts', line: 1, sdk: 'openai', severity: 'high', ruleKey: 'rule', humanSummary: 'Test', legalReference: '' },
    ]);

    expect(provider.getChildren()).toHaveLength(1);
    provider.clear();
    expect(provider.getChildren()).toHaveLength(0);
  });

  it('tree items have click-to-navigate command', () => {
    provider.setFindings([
      { file: '/project/src/app.ts', line: 42, sdk: 'openai', severity: 'high', ruleKey: 'rule', humanSummary: 'Navigate test', legalReference: '' },
    ]);

    const items = provider.getChildren();
    expect(items[0].command).toBeDefined();
    expect(items[0].command!.command).toBe('vscode.open');
    expect(items[0].command!.arguments![0].fsPath).toBe('/project/src/app.ts');
  });

  it('tree items have tooltip with SDK and legal info', () => {
    provider.setFindings([
      { file: '/a.ts', line: 1, sdk: '@anthropic-ai/sdk', severity: 'critical', ruleKey: 'eu.article13', humanSummary: 'Transparency required', legalReference: 'EU AI Act Art. 13' },
    ]);

    const items = provider.getChildren();
    expect(items[0].tooltip).toContain('@anthropic-ai/sdk');
    expect(items[0].tooltip).toContain('Transparency required');
    expect(items[0].tooltip).toContain('EU AI Act Art. 13');
  });

  it('fires onDidChangeTreeData when findings change', () => {
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });

    provider.setFindings([
      { file: '/a.ts', line: 1, sdk: 'openai', severity: 'low', ruleKey: 'rule', humanSummary: 'Test', legalReference: '' },
    ]);

    expect(fired).toBe(true);
  });

  it('fires onDidChangeTreeData when cleared', () => {
    let fireCount = 0;
    provider.onDidChangeTreeData(() => { fireCount++; });

    provider.setFindings([]);
    provider.clear();

    expect(fireCount).toBe(2);
  });

  it('returns no children for child elements', () => {
    provider.setFindings([
      { file: '/a.ts', line: 1, sdk: 'openai', severity: 'high', ruleKey: 'rule', humanSummary: 'Test', legalReference: '' },
    ]);

    const items = provider.getChildren();
    const childItems = provider.getChildren(items[0]);
    expect(childItems).toHaveLength(0);
  });

  it('skips severities with no findings', () => {
    // Only medium findings — should not create empty critical/high/low groups
    provider.setFindings([
      { file: '/a.ts', line: 1, sdk: 'openai', severity: 'medium', ruleKey: 'rule', humanSummary: 'Only medium', legalReference: '' },
    ]);

    const children = provider.getChildren();
    expect(children).toHaveLength(1);
  });
});

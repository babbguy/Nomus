import type { Finding } from '../match/rule-matcher.js';

const SEVERITY_ICONS: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
};

const EFFECT_LABELS: Record<string, string> = {
  deny: 'BLOCKED',
  require_disclosure: 'DISCLOSURE REQUIRED',
  allow_with_audit: 'AUDIT REQUIRED',
  flag: 'FLAGGED',
};

/**
 * Format findings as console output.
 */
export function formatConsoleReport(findings: Finding[]): string {
  if (findings.length === 0) {
    return '\n✅ No applicable regulatory obligations identified.\n';
  }

  const lines: string[] = [
    '',
    `⚠️  Nomus identified ${findings.length} applicable regulatory obligation(s):`,
    '',
  ];

  // Group by severity
  const bySeverity: Record<string, Finding[]> = {};
  for (const f of findings) {
    const sev = f.rule.severity;
    if (!bySeverity[sev]) bySeverity[sev] = [];
    bySeverity[sev].push(f);
  }

  for (const severity of ['critical', 'high', 'medium', 'low']) {
    const group = bySeverity[severity];
    if (!group) continue;

    for (const f of group) {
      const icon = SEVERITY_ICONS[severity] ?? '⚪';
      const effect = EFFECT_LABELS[f.rule.effect] ?? f.rule.effect.toUpperCase();
      lines.push(`${icon} ${severity.toUpperCase()}: ${f.rule.ruleKey}`);
      lines.push(`   File: ${f.file}:${f.line}`);
      lines.push(`   SDK:  ${f.sdk}`);
      lines.push(`   Rule: ${f.rule.humanSummary}`);
      lines.push(`   Ref:  ${f.rule.legalReference}`);
      lines.push(`   Effect: ${effect}`);
      if (f.suggestion) {
        lines.push(`   Fix:  ${f.suggestion.split('\n')[0]}`);
      }
      lines.push('');
    }
  }

  // Summary
  const critical = bySeverity['critical']?.length ?? 0;
  const high = bySeverity['high']?.length ?? 0;
  lines.push('─'.repeat(60));
  lines.push(`Summary: ${critical} critical, ${high} high, ${findings.length} total`);

  if (critical > 0) {
    lines.push('❌ FAIL — Critical regulatory obligations require immediate attention.');
  } else if (high > 0) {
    lines.push('⚠️  WARN — High-weight obligations identified. Review required.');
  } else {
    lines.push('✅ PASS — No blocking issues.');
  }

  lines.push('');
  lines.push('Nomus is a regulatory applicability engine. It identifies applicable obligations — it does not provide legal advice.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Format findings as JSON for programmatic consumption.
 */
export function formatJsonReport(findings: Finding[]) {
  const critical = findings.filter((f) => f.rule.severity === 'critical').length;
  return {
    status: critical > 0 ? 'fail' : 'pass',
    total: findings.length,
    critical,
    high: findings.filter((f) => f.rule.severity === 'high').length,
    medium: findings.filter((f) => f.rule.severity === 'medium').length,
    low: findings.filter((f) => f.rule.severity === 'low').length,
    findings: findings.map((f) => ({
      file: f.file,
      line: f.line,
      sdk: f.sdk,
      ruleKey: f.rule.ruleKey,
      severity: f.rule.severity,
      effect: f.rule.effect,
      summary: f.rule.humanSummary,
      legalReference: f.rule.legalReference,
      suggestion: f.suggestion,
    })),
    _disclaimer: 'Nomus is a regulatory applicability engine. It identifies applicable obligations — it does not provide legal advice.',
  };
}

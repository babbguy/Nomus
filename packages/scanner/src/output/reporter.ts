import { relative, isAbsolute } from 'node:path';
import type { CorporateFinding, Finding } from '../match/rule-matcher.js';
import type { CorporateScanSummary } from '../scan-corporate.js';

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

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export interface ReportOptions {
  /**
   * Severity at or above which the scan fails (the CLI's `--fail-on`).
   * Default `critical`. The reported status always agrees with the exit code.
   */
  failOn?: string;
  /** When set, file paths are reported relative to this directory. */
  rootDir?: string;
}

const DISCLAIMER = 'Nomus is a regulatory applicability engine. It identifies applicable obligations — it does not provide legal advice.';

/** pass/fail for a set of findings under a --fail-on threshold. */
export function reportStatus(findings: Finding[], failOn = 'critical'): 'pass' | 'fail' {
  const threshold = SEVERITY_RANK[failOn] ?? SEVERITY_RANK.critical;
  return findings.some((f) => (SEVERITY_RANK[f.rule.severity] ?? 0) >= threshold) ? 'fail' : 'pass';
}

function displayPath(file: string, rootDir?: string): string {
  if (!rootDir || !isAbsolute(file)) return file;
  const rel = relative(rootDir, file).replace(/\\/g, '/');
  return rel.startsWith('..') ? file : rel;
}

/**
 * Format findings as console output.
 */
export function formatConsoleReport(findings: Finding[], options: ReportOptions = {}): string {
  if (findings.length === 0) {
    return '\n✅ No applicable regulatory obligations identified.\n';
  }

  const failOn = options.failOn ?? 'critical';
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
      lines.push(`   File: ${displayPath(f.file, options.rootDir)}:${f.line}`);
      lines.push(`   SDK:  ${f.sdk}`);
      lines.push(`   Rule: ${f.rule.humanSummary}`);
      lines.push(`   Ref:  ${f.rule.legalReference}`);
      lines.push(`   Effect: ${effect}`);
      if (f.suggestion) {
        // The whole suggestion: its first line usually ends in ':' and the
        // steps or code that follow are the actual fix.
        const [first, ...rest] = f.suggestion.split('\n');
        lines.push(`   Fix:  ${first}`);
        for (const line of rest) lines.push(line ? `         ${line}` : '');
      }
      lines.push('');
    }
  }

  // Summary
  const critical = bySeverity['critical']?.length ?? 0;
  const high = bySeverity['high']?.length ?? 0;
  lines.push('─'.repeat(60));
  lines.push(`Summary: ${critical} critical, ${high} high, ${findings.length} total`);

  if (reportStatus(findings, failOn) === 'fail') {
    lines.push(failOn === 'critical'
      ? '❌ FAIL — Critical regulatory obligations require immediate attention.'
      : `❌ FAIL — Obligations at or above ${failOn} severity require attention (--fail-on=${failOn}).`);
  } else if (critical > 0 || high > 0) {
    lines.push('⚠️  WARN — High-weight obligations identified. Review required.');
  } else {
    lines.push('✅ PASS — No blocking issues.');
  }

  lines.push('');
  lines.push(DISCLAIMER);
  lines.push('');

  return lines.join('\n');
}

/**
 * Format findings as JSON for programmatic consumption.
 */
export function formatJsonReport(findings: Finding[], options: ReportOptions = {}) {
  const failOn = options.failOn ?? 'critical';
  return {
    status: reportStatus(findings, failOn),
    failOn,
    total: findings.length,
    critical: findings.filter((f) => f.rule.severity === 'critical').length,
    high: findings.filter((f) => f.rule.severity === 'high').length,
    medium: findings.filter((f) => f.rule.severity === 'medium').length,
    low: findings.filter((f) => f.rule.severity === 'low').length,
    findings: findings.map((f) => ({
      file: displayPath(f.file, options.rootDir),
      line: f.line,
      sdk: f.sdk,
      ruleKey: f.rule.ruleKey,
      severity: f.rule.severity,
      effect: f.rule.effect,
      summary: f.rule.humanSummary,
      legalReference: f.rule.legalReference,
      confidence: f.rule.confidence,
      detectorSource: f.detectorSource,
      suggestion: f.suggestion,
    })),
    _disclaimer: DISCLAIMER,
  };
}

// ── Corporate policy findings (CPG) ────────────────────────────────────
// A separate section, printed only when the org has corporate policy
// governance switched on. The regulatory report above is unchanged, and
// corporate findings never change the status or the exit code.

/** `needs review`, `advisory; enforced from 2026-10-22` or `advisory`. */
export function corporateStatusText(f: Pick<CorporateFinding, 'status' | 'enforceFrom'>): string {
  switch (f.status) {
    case 'needs_review': return 'needs review';
    case 'grace': return `advisory; enforced from ${f.enforceFrom.slice(0, 10)}`;
    case 'advisory': return 'advisory';
  }
}

/** Owning boards by name (the bundle lists them by id, which differs between servers). */
function ownerNames(f: Pick<CorporateFinding, 'rule'>): string {
  return f.rule.owningBoards.map((b) => b.name).sort((a, b) => a.localeCompare(b)).join(', ');
}

function lineSpan(f: Pick<CorporateFinding, 'startLine' | 'endLine'>): string {
  return f.startLine === f.endLine ? `${f.startLine}` : `${f.startLine}-${f.endLine}`;
}

/** The corporate section of the console report. */
export function formatCorporateConsoleReport(findings: readonly CorporateFinding[], summary: CorporateScanSummary): string {
  const files = `${summary.scannedFileCount} file${summary.scannedFileCount === 1 ? '' : 's'} checked`;
  const head = `Corporate policies: ${summary.policyCount} active polic${summary.policyCount === 1 ? 'y' : 'ies'}, ${files} (bundle ${summary.bundleHash?.slice(0, 12) ?? 'none'})`;
  if (findings.length === 0) return `\n${head}\nNo corporate policy findings.\n`;
  const blocking = findings.filter((f) => f.blocking).length;
  const lines = ['', head, `${findings.length} corporate policy finding(s), ${blocking} blocking:`, ''];
  for (const f of findings) {
    lines.push(`[${f.tier.toUpperCase()}] ${f.policyKey} v${f.policyVersion}: ${f.rule.title}`);
    lines.push(`   File:   ${f.filePath}:${lineSpan(f)}`);
    lines.push(`   Policy: ${f.rule.message}`);
    lines.push(`   Status: ${corporateStatusText(f)}${f.blocking ? ' (blocking)' : ''}`);
    lines.push(`   Owners: ${ownerNames(f)}`);
    lines.push(`   Fingerprint: ${f.fingerprint}`);
    lines.push('');
  }
  if (summary.skippedLongLines > 0) lines.push(`Note: ${summary.skippedLongLines} line(s) longer than 4,096 characters were not checked by line patterns.`);
  if (summary.skippedFileCount > 0) lines.push(`Note: ${summary.skippedFileCount} file(s) were skipped (over 2 MB, binary or outside the repository).`);
  lines.push('Corporate policy findings never change the exit code of this command.');
  lines.push('');
  return lines.join('\n');
}

/**
 * The corporate fields of the JSON report: `corporate` (what was evaluated)
 * and `corporateFindings`. Paths are repository-relative; the code itself is
 * not included, only its range and fingerprint.
 */
export function formatCorporateJson(findings: readonly CorporateFinding[], summary: CorporateScanSummary) {
  return {
    corporate: {
      enabled: summary.enabled,
      orgId: summary.orgId,
      bundleHash: summary.bundleHash,
      policyCount: summary.policyCount,
      scannedFileCount: summary.scannedFileCount,
      skippedLongLines: summary.skippedLongLines,
      skippedFileCount: summary.skippedFileCount,
      total: findings.length,
      blocking: findings.filter((f) => f.blocking).length,
    },
    corporateFindings: findings.map((f) => ({
      file: f.filePath,
      startLine: f.startLine,
      endLine: f.endLine,
      language: f.language,
      policyKey: f.policyKey,
      policyVersion: f.policyVersion,
      policyId: f.rule.policyId,
      title: f.rule.title,
      tier: f.tier,
      status: f.status,
      blocking: f.blocking,
      enforceFrom: f.enforceFrom,
      message: f.rule.message,
      owningBoards: f.rule.owningBoards.map((b) => b.name),
      fingerprint: f.fingerprint,
      snippetHash: f.snippetHash,
      truncated: f.truncated,
    })),
  };
}

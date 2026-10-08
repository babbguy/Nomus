/**
 * Data Quality Auditor — Background agent that validates the integrity and
 * accuracy of all scraped data currently stored in the database.
 *
 * Runs silently in the background. Only surfaces errors/warnings via SSE
 * and stores results per-source in source_audit_results for display on
 * regulation tiles.
 *
 * Checks performed per source:
 * 1. Snapshot quality re-scan (free, local)
 * 2. Rule integrity (orphaned, duplicates, expired, severity mismatches)
 * 3. Staleness detection (SLA breach)
 * 4. Provenance gap (rules exist but no snapshot)
 * 5. LLM re-audit sample (opt-in, Haiku, cents per source)
 */

import { randomUUID } from 'node:crypto';
import { eq, desc, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  regulatorySources,
  rawSnapshots,
  policyRules,
  sourceAuditResults,
} from '../db/schema.js';
import { scoreDocumentQuality } from './quality-scorer.js';
import { resolveProvider } from '../llm/provider.js';
import { broadcastEvent } from '../sse/manager.js';
import { logger } from '../logger.js';

// ─── Types ──────────────────────────────────────────────────────

export interface AuditIssue {
  type: 'snapshot_quality' | 'duplicate_rule' | 'expired_active' | 'severity_mismatch'
    | 'orphaned_rules' | 'stale_source' | 'provenance_gap' | 'llm_reaudit';
  severity: 'error' | 'warning' | 'info';
  description: string;
  ruleId?: string;
}

export interface SourceAuditReport {
  sourceId: string;
  sourceName: string;
  snapshotGrade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  ruleCount: number;
  issueCount: number;
  issues: AuditIssue[];
  llmReauditScore: number | null;
  llmReauditSample: number;
  overallVerdict: 'pass' | 'warn' | 'fail';
  durationMs: number;
}

export interface FullAuditReport {
  sourcesAudited: number;
  sourcesPassed: number;
  sourcesWarned: number;
  sourcesFailed: number;
  totalIssues: number;
  reports: SourceAuditReport[];
  durationMs: number;
}

// ─── LLM Re-Audit Prompt ────────────────────────────────────────

const REAUDIT_PROMPT = `You are a regulatory compliance accuracy auditor.

You will be given a policy rule that was automatically extracted from a regulatory source document, along with a snippet of the source content.

Evaluate whether the rule ACCURATELY reflects the source material:
1. Does the legal reference actually exist in the source?
2. Does the humanSummary correctly describe the requirement?
3. Is the effect (deny/allow_with_audit/require_disclosure/flag) appropriate?
4. Is the severity (critical/high/medium/low) proportionate?

Score 1-10:
- 9-10: Rule is accurate and well-formed
- 7-8: Minor imprecision but functionally correct
- 5-6: Noticeable inaccuracies that could mislead
- 3-4: Significantly wrong
- 1-2: Hallucinated or completely inaccurate

Output JSON only: {"score": N, "issue": "brief description if score < 7, empty string if fine"}`;

// ─── Constants ──────────────────────────────────────────────────

/** Max rules to re-audit per source via LLM */
const LLM_REAUDIT_SAMPLE_SIZE = 5;

/** Delay between LLM re-audit calls to avoid rate limits */
const LLM_REAUDIT_DELAY_MS = 2000;

/**
 * Find the section of content most relevant to a rule's legal reference.
 * Searches for the article/section heading, then extracts surrounding context.
 * Falls back to the beginning of the document if no match found.
 */
function findRelevantSection(content: string, legalReference: string | null, maxChars: number): string {
  if (!legalReference || !content) return content.slice(0, maxChars);

  // Extract article/section number patterns from the legal reference
  const refPatterns = [
    // "Article 5" / "Art. 5" / "Section 1798.100"
    ...Array.from(legalReference.matchAll(/(?:Article|Art\.?|Section|Sec\.?|Chapter|Recital|Annex)\s*[\d.]+/gi))
      .map((m) => m[0]),
    // "§ 164.502"
    ...Array.from(legalReference.matchAll(/§\s*[\d.]+/g)).map((m) => m[0]),
  ];

  if (refPatterns.length === 0) return content.slice(0, maxChars);

  // Search for the first matching reference in the content
  for (const pattern of refPatterns) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    const match = regex.exec(content);

    if (match) {
      // Center the window around the match
      const contextBefore = Math.floor(maxChars * 0.2);
      const start = Math.max(0, match.index - contextBefore);
      const end = Math.min(content.length, start + maxChars);
      return content.slice(start, end);
    }
  }

  // Fallback: use beginning of document
  return content.slice(0, maxChars);
}

// ─── Core Audit Logic ───────────────────────────────────────────

/**
 * Audit a single source. Returns a report with all issues found.
 */
export async function auditSource(
  sourceId: string,
  options: { deepAudit?: boolean } = {},
): Promise<SourceAuditReport> {
  const start = performance.now();
  const db = getDb();
  const issues: AuditIssue[] = [];

  // Load source
  const source = db.select().from(regulatorySources)
    .where(eq(regulatorySources.id, sourceId))
    .get();

  if (!source) {
    return {
      sourceId, sourceName: 'Unknown', snapshotGrade: null, ruleCount: 0,
      issueCount: 1, issues: [{ type: 'provenance_gap', severity: 'error', description: 'Source not found in database' }],
      llmReauditScore: null, llmReauditSample: 0, overallVerdict: 'fail',
      durationMs: Math.round(performance.now() - start),
    };
  }

  // ─── 1. Snapshot Quality Re-Scan ────────────────────────────
  let snapshotGrade: 'A' | 'B' | 'C' | 'D' | 'F' | null = null;

  const latestSnapshot = db.select().from(rawSnapshots)
    .where(eq(rawSnapshots.sourceId, sourceId))
    .orderBy(desc(rawSnapshots.scrapedAt))
    .limit(1)
    .get();

  if (latestSnapshot) {
    const quality = scoreDocumentQuality(latestSnapshot.content);
    snapshotGrade = quality.overallGrade;

    if (quality.overallGrade === 'D' || quality.overallGrade === 'F') {
      issues.push({
        type: 'snapshot_quality',
        severity: quality.overallGrade === 'F' ? 'error' : 'warning',
        description: `Snapshot quality grade ${quality.overallGrade}: ${quality.issues.join('; ') || 'Low text/structure scores'}. Words: ${quality.wordCount}, Headings: ${quality.headingCount}`,
      });
    }
  } else {
    issues.push({
      type: 'provenance_gap',
      severity: 'warning',
      description: 'No raw snapshots found for this source — content may have been cleaned up',
    });
  }

  // ─── 2. Rule Integrity Checks ──────────────────────────────
  const rules = db.select().from(policyRules)
    .where(eq(policyRules.sourceId, sourceId))
    .all();

  const activeRules = rules.filter((r) => r.isActive);

  // 2a. Expired rules still active
  const now = new Date().toISOString();
  for (const rule of activeRules) {
    if (rule.expiresAt && rule.expiresAt < now) {
      issues.push({
        type: 'expired_active',
        severity: 'warning',
        description: `Rule "${rule.ruleKey}" expired on ${rule.expiresAt} but is still active`,
        ruleId: rule.id,
      });
    }
  }

  // 2b. Severity/effect mismatches
  for (const rule of activeRules) {
    if (rule.severity === 'critical' && rule.effect === 'flag') {
      issues.push({
        type: 'severity_mismatch',
        severity: 'warning',
        description: `Rule "${rule.ruleKey}" is critical severity but only flags — should likely deny or require audit`,
        ruleId: rule.id,
      });
    }
    if (rule.severity === 'low' && rule.effect === 'deny') {
      issues.push({
        type: 'severity_mismatch',
        severity: 'warning',
        description: `Rule "${rule.ruleKey}" is low severity but denies — effect may be too harsh`,
        ruleId: rule.id,
      });
    }
  }

  // 2c. Duplicate rules (same legal reference)
  const refCounts = new Map<string, string[]>();
  for (const rule of activeRules) {
    const ref = rule.legalReference.trim().toLowerCase();
    if (!refCounts.has(ref)) refCounts.set(ref, []);
    refCounts.get(ref)!.push(rule.ruleKey);
  }
  for (const [ref, keys] of refCounts) {
    if (keys.length > 1) {
      issues.push({
        type: 'duplicate_rule',
        severity: 'warning',
        description: `${keys.length} rules share legal reference "${ref}": ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '…' : ''}`,
      });
    }
  }

  // 2d. Orphaned rules (source is inactive but rules are active)
  if (!source.isActive && activeRules.length > 0) {
    issues.push({
      type: 'orphaned_rules',
      severity: 'warning',
      description: `Source is inactive but ${activeRules.length} rules are still active — consider deactivating`,
    });
  }

  // ─── 3. Staleness Detection ────────────────────────────────
  if (source.isActive && source.lastScrapedAt) {
    const lastScraped = new Date(source.lastScrapedAt).getTime();
    const ageHours = (Date.now() - lastScraped) / (1000 * 60 * 60);
    const slaMaxAge = source.slaMaxAgeHours ?? 48;

    if (ageHours > slaMaxAge) {
      issues.push({
        type: 'stale_source',
        severity: 'error',
        description: `Source last scraped ${Math.round(ageHours)}h ago — exceeds SLA of ${slaMaxAge}h`,
      });
    }
  } else if (source.isActive && !source.lastScrapedAt) {
    issues.push({
      type: 'stale_source',
      severity: 'warning',
      description: 'Active source has never been scraped',
    });
  }

  // ─── 4. Provenance Gap ────────────────────────────────────
  if (activeRules.length > 0 && !latestSnapshot) {
    issues.push({
      type: 'provenance_gap',
      severity: 'error',
      description: `${activeRules.length} active rules exist but no raw snapshot available — cannot verify rule accuracy`,
    });
  }

  // ─── 5. LLM Re-Audit (opt-in) ─────────────────────────────
  let llmReauditScore: number | null = null;
  let llmReauditSample = 0;

  if (options.deepAudit && latestSnapshot && activeRules.length > 0) {
    try {
      const sampleSize = Math.min(LLM_REAUDIT_SAMPLE_SIZE, activeRules.length);
      // Sample evenly: pick rules spread across the full set
      const step = Math.max(1, Math.floor(activeRules.length / sampleSize));
      const sample = [];
      for (let i = 0; i < activeRules.length && sample.length < sampleSize; i += step) {
        sample.push(activeRules[i]);
      }

      const { provider, model } = await resolveProvider('classifier');
      let scoreSum = 0;
      let scored = 0;

      const fullContent = latestSnapshot.content;

      for (const rule of sample) {
        try {
          // Find the relevant section using the rule's legal reference
          const contentSnippet = findRelevantSection(fullContent, rule.legalReference, 8000);

          const userMessage = `SOURCE CONTENT (excerpt — located by legal reference "${rule.legalReference || 'N/A'}"):\n${contentSnippet}\n\nRULE TO VERIFY:\n${JSON.stringify({
            ruleKey: rule.ruleKey,
            effect: rule.effect,
            severity: rule.severity,
            legalReference: rule.legalReference,
            humanSummary: rule.humanSummary,
          }, null, 1)}`;

          const response = await provider.generate(REAUDIT_PROMPT, userMessage, model);
          const jsonStr = response.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
          const parsed = JSON.parse(jsonStr);
          const score = Number(parsed.score) || 5;
          scoreSum += score;
          scored++;

          if (score < 7 && parsed.issue) {
            issues.push({
              type: 'llm_reaudit',
              severity: score < 4 ? 'error' : 'warning',
              description: `Rule "${rule.ruleKey}" scored ${score}/10: ${parsed.issue}`,
              ruleId: rule.id,
            });
          }

          // Rate limit delay
          if (scored < sample.length) {
            await new Promise((r) => setTimeout(r, LLM_REAUDIT_DELAY_MS));
          }
        } catch (err) {
          logger.warn({ ruleKey: rule.ruleKey, error: (err as Error).message },
            'LLM re-audit failed for rule — skipping');
        }
      }

      if (scored > 0) {
        llmReauditScore = Math.round((scoreSum / scored) * 10) / 10;
        llmReauditSample = scored;
      }
    } catch (err) {
      logger.warn({ sourceId, error: (err as Error).message },
        'LLM re-audit failed — proceeding without deep audit');
    }
  }

  // ─── Compute Verdict ──────────────────────────────────────
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;

  let overallVerdict: 'pass' | 'warn' | 'fail';
  if (errorCount > 0 || (llmReauditScore !== null && llmReauditScore < 4)) {
    overallVerdict = 'fail';
  } else if (warningCount > 0 || (llmReauditScore !== null && llmReauditScore < 7)) {
    overallVerdict = 'warn';
  } else {
    overallVerdict = 'pass';
  }

  const durationMs = Math.round(performance.now() - start);

  return {
    sourceId,
    sourceName: source.name,
    snapshotGrade,
    ruleCount: activeRules.length,
    issueCount: issues.length,
    issues,
    llmReauditScore,
    llmReauditSample,
    overallVerdict,
    durationMs,
  };
}

/**
 * Persist an audit report to the database (upserts — keeps latest per source).
 */
export function saveAuditReport(report: SourceAuditReport): void {
  const db = getDb();
  const now = new Date().toISOString();

  // Delete previous audit for this source (keep only latest)
  db.delete(sourceAuditResults)
    .where(eq(sourceAuditResults.sourceId, report.sourceId))
    .run();

  db.insert(sourceAuditResults).values({
    id: randomUUID(),
    sourceId: report.sourceId,
    snapshotGrade: report.snapshotGrade,
    ruleCount: report.ruleCount,
    issueCount: report.issueCount,
    issues: JSON.stringify(report.issues),
    llmReauditScore: report.llmReauditScore,
    llmReauditSample: report.llmReauditSample,
    overallVerdict: report.overallVerdict,
    durationMs: report.durationMs,
    auditedAt: now,
  }).run();
}

/**
 * Run a full audit across ALL active sources. Designed to run in the background.
 * Processes sources sequentially to avoid overwhelming the system.
 * Only broadcasts SSE events for warnings and errors.
 */
export async function runFullAudit(
  options: { deepAudit?: boolean } = {},
): Promise<FullAuditReport> {
  const fullStart = performance.now();
  const db = getDb();

  const sources = db.select().from(regulatorySources)
    .where(eq(regulatorySources.isActive, true))
    .all();

  logger.info({ sources: sources.length, deepAudit: !!options.deepAudit },
    'Data quality audit starting');

  const reports: SourceAuditReport[] = [];
  let sourcesPassed = 0;
  let sourcesWarned = 0;
  let sourcesFailed = 0;
  let totalIssues = 0;

  for (const source of sources) {
    try {
      const report = await auditSource(source.id, options);

      // Persist result
      saveAuditReport(report);
      reports.push(report);
      totalIssues += report.issueCount;

      if (report.overallVerdict === 'pass') sourcesPassed++;
      else if (report.overallVerdict === 'warn') sourcesWarned++;
      else sourcesFailed++;

      // Only broadcast warnings and errors — silently log passes
      if (report.overallVerdict !== 'pass') {
        broadcastEvent({
          id: randomUUID(),
          type: 'audit.result',
          data: {
            sourceId: source.id,
            sourceName: source.name,
            verdict: report.overallVerdict,
            issueCount: report.issueCount,
            snapshotGrade: report.snapshotGrade,
            llmReauditScore: report.llmReauditScore,
            issues: report.issues.filter((i) => i.severity === 'error').slice(0, 3),
          },
          jurisdiction: source.jurisdiction,
        });
      }

      logger.info({
        sourceId: source.id,
        sourceName: source.name,
        verdict: report.overallVerdict,
        issues: report.issueCount,
        grade: report.snapshotGrade,
        durationMs: report.durationMs,
      }, `Audit ${source.name}: ${report.overallVerdict}`);
    } catch (err) {
      logger.error({ sourceId: source.id, error: (err as Error).message },
        'Audit failed for source');

      // Save a failure report
      const failReport: SourceAuditReport = {
        sourceId: source.id,
        sourceName: source.name,
        snapshotGrade: null,
        ruleCount: 0,
        issueCount: 1,
        issues: [{ type: 'provenance_gap', severity: 'error', description: `Audit error: ${(err as Error).message}` }],
        llmReauditScore: null,
        llmReauditSample: 0,
        overallVerdict: 'fail',
        durationMs: 0,
      };
      saveAuditReport(failReport);
      reports.push(failReport);
      sourcesFailed++;
      totalIssues++;
    }
  }

  const fullDuration = Math.round(performance.now() - fullStart);

  logger.info({
    sources: sources.length,
    passed: sourcesPassed,
    warned: sourcesWarned,
    failed: sourcesFailed,
    totalIssues,
    durationMs: fullDuration,
  }, 'Data quality audit complete');

  return {
    sourcesAudited: sources.length,
    sourcesPassed,
    sourcesWarned,
    sourcesFailed,
    totalIssues,
    reports,
    durationMs: fullDuration,
  };
}

/**
 * Get the latest audit result for a specific source.
 */
export function getAuditResult(sourceId: string) {
  const db = getDb();
  const result = db.select().from(sourceAuditResults)
    .where(eq(sourceAuditResults.sourceId, sourceId))
    .orderBy(desc(sourceAuditResults.auditedAt))
    .limit(1)
    .get();

  if (!result) return null;

  return {
    ...result,
    issues: JSON.parse(result.issues) as AuditIssue[],
  };
}

/** Raw snake_case row shape returned by the getAllAuditResults() SELECT sar.*. */
interface RawAuditRow {
  id: string;
  source_id: string;
  snapshot_grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  rule_count: number;
  issue_count: number;
  issues: string | null;
  llm_reaudit_score: number | null;
  llm_reaudit_sample: number;
  overall_verdict: 'pass' | 'warn' | 'fail';
  duration_ms: number;
  audited_at: string;
}

/**
 * Get audit results for all sources (for bulk display on source list).
 */
export function getAllAuditResults() {
  const db = getDb();

  // Get the latest audit per source using a subquery
  const rows = db.all(sql`
    SELECT sar.* FROM source_audit_results sar
    INNER JOIN (
      SELECT source_id, MAX(audited_at) as max_at
      FROM source_audit_results
      GROUP BY source_id
    ) latest ON sar.source_id = latest.source_id AND sar.audited_at = latest.max_at
  `);

  return (rows as RawAuditRow[]).map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    snapshotGrade: r.snapshot_grade,
    ruleCount: r.rule_count,
    issueCount: r.issue_count,
    issues: JSON.parse(r.issues ?? '[]') as AuditIssue[],
    llmReauditScore: r.llm_reaudit_score,
    llmReauditSample: r.llm_reaudit_sample,
    overallVerdict: r.overall_verdict,
    durationMs: r.duration_ms,
    auditedAt: r.audited_at,
  }));
}

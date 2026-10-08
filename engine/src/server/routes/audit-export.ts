import { Hono } from 'hono';
import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { attestationReceipts, scanFindings, complianceScores } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';
import { safeParseInt } from '../utils.js';
import type { AnySQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

export const auditExportRoutes = new Hono<AppEnv>();

auditExportRoutes.use('*', requireSessionOrApiKey('read:policies'));
auditExportRoutes.use('*', rateLimit());

interface AuditEntry {
  timestamp: string;
  type: string;
  action: string;
  result: string;
  jurisdiction: string | null;
  details: string;
}

// Unified audit log — combines attestations, scan findings, and score snapshots
auditExportRoutes.get('/', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const since = c.req.query('since');
  const until = c.req.query('until');
  const type = c.req.query('type'); // attestation, scan, score
  const limit = Math.min(safeParseInt(c.req.query('limit'), 200), 1000);

  const entries: AuditEntry[] = [];

  // Attestation receipts
  if (!type || type === 'attestation') {
    const conditions = [eq(attestationReceipts.orgId, orgId)];
    if (since) conditions.push(gte(attestationReceipts.evaluatedAt, since));
    if (until) conditions.push(lte(attestationReceipts.evaluatedAt, until));

    const receipts = db.select().from(attestationReceipts)
      .where(and(...conditions))
      .orderBy(desc(attestationReceipts.evaluatedAt))
      .limit(limit)
      .all();

    for (const r of receipts) {
      entries.push({
        timestamp: r.evaluatedAt,
        type: 'attestation',
        action: 'compliance_evaluation',
        result: r.result,
        jurisdiction: r.jurisdiction,
        details: `Policy state: ${r.policyStateHash} | Rules evaluated: ${(() => { try { return JSON.parse(r.rulesEvaluated).length; } catch { return 'N/A'; } })()}`,
      });
    }
  }

  // Scan findings
  if (!type || type === 'scan') {
    const conditions = [eq(scanFindings.orgId, orgId)];
    if (since) conditions.push(gte(scanFindings.scannedAt, since));
    if (until) conditions.push(lte(scanFindings.scannedAt, until));

    const findings = db.select().from(scanFindings)
      .where(and(...conditions))
      .orderBy(desc(scanFindings.scannedAt))
      .limit(limit)
      .all();

    for (const f of findings) {
      entries.push({
        timestamp: f.scannedAt,
        type: 'scan',
        action: `finding_${f.status}`,
        result: f.severity,
        jurisdiction: null,
        details: `${f.ruleKey} in ${f.filePath}:${f.lineNumber} (${f.repo}) | ${f.humanSummary || f.capabilityDetected}`,
      });
    }
  }

  // Compliance score snapshots
  if (!type || type === 'score') {
    const conditions = [eq(complianceScores.orgId, orgId)];
    if (since) conditions.push(gte(complianceScores.computedAt, since));
    if (until) conditions.push(lte(complianceScores.computedAt, until));

    const scores = db.select().from(complianceScores)
      .where(and(...conditions))
      .orderBy(desc(complianceScores.computedAt))
      .limit(limit)
      .all();

    for (const s of scores) {
      entries.push({
        timestamp: s.computedAt,
        type: 'score',
        action: 'compliance_score_computed',
        result: `${s.overallScore}`,
        jurisdiction: null,
        details: `Score: ${s.overallScore} | Open findings: ${s.openFindings} | Trigger: ${s.triggerEvent} | AI systems: ${s.aiBomSystems}`,
      });
    }
  }

  // Sort all entries by timestamp descending
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Per-type totals for the filters (the Audit Log page counted types within
  // the returned page of at most `limit` merged entries).
  const count = (table: SQLiteTable, orgCol: AnySQLiteColumn, tsCol: AnySQLiteColumn) => {
    const conditions = [eq(orgCol, orgId)];
    if (since) conditions.push(gte(tsCol, since));
    if (until) conditions.push(lte(tsCol, until));
    return db.select({ n: sql<number>`count(*)` }).from(table).where(and(...conditions)).get()?.n ?? 0;
  };
  const totals = {
    attestation: !type || type === 'attestation' ? count(attestationReceipts, attestationReceipts.orgId, attestationReceipts.evaluatedAt) : 0,
    scan: !type || type === 'scan' ? count(scanFindings, scanFindings.orgId, scanFindings.scannedAt) : 0,
    score: !type || type === 'score' ? count(complianceScores, complianceScores.orgId, complianceScores.computedAt) : 0,
  };

  return c.json({
    count: entries.length,
    totals,
    entries: entries.slice(0, limit),
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// Export as CSV
auditExportRoutes.get('/csv', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const since = c.req.query('since');
  const until = c.req.query('until');
  const type = c.req.query('type');
  // An export is the whole trail (the JSON export takes up to 5000 per type);
  // a cut-off is reported in X-Nomus-Truncated instead of silently dropped.
  const limit = Math.min(Math.max(safeParseInt(c.req.query('limit'), 5000), 1), 5000);

  const entries: AuditEntry[] = [];

  // Same logic as above but higher limit for export
  let perTypeHitLimit = false;
  if (!type || type === 'attestation') {
    const conditions = [eq(attestationReceipts.orgId, orgId)];
    if (since) conditions.push(gte(attestationReceipts.evaluatedAt, since));
    if (until) conditions.push(lte(attestationReceipts.evaluatedAt, until));

    const receipts = db.select().from(attestationReceipts)
      .where(and(...conditions))
      .orderBy(desc(attestationReceipts.evaluatedAt))
      .limit(limit)
      .all();
    if (receipts.length === limit) perTypeHitLimit = true;

    for (const r of receipts) {
      entries.push({
        timestamp: r.evaluatedAt,
        type: 'attestation',
        action: 'compliance_evaluation',
        result: r.result,
        jurisdiction: r.jurisdiction,
        details: `Policy state: ${r.policyStateHash}`,
      });
    }
  }

  if (!type || type === 'scan') {
    const conditions = [eq(scanFindings.orgId, orgId)];
    if (since) conditions.push(gte(scanFindings.scannedAt, since));
    if (until) conditions.push(lte(scanFindings.scannedAt, until));

    const findings = db.select().from(scanFindings)
      .where(and(...conditions))
      .orderBy(desc(scanFindings.scannedAt))
      .limit(limit)
      .all();
    if (findings.length === limit) perTypeHitLimit = true;

    for (const f of findings) {
      entries.push({
        timestamp: f.scannedAt,
        type: 'scan',
        action: `finding_${f.status}`,
        result: f.severity,
        jurisdiction: null,
        details: `${f.ruleKey} in ${f.filePath}:${f.lineNumber}`,
      });
    }
  }

  if (!type || type === 'score') {
    const conditions = [eq(complianceScores.orgId, orgId)];
    if (since) conditions.push(gte(complianceScores.computedAt, since));
    if (until) conditions.push(lte(complianceScores.computedAt, until));

    const scores = db.select().from(complianceScores)
      .where(and(...conditions))
      .orderBy(desc(complianceScores.computedAt))
      .limit(limit)
      .all();
    if (scores.length === limit) perTypeHitLimit = true;

    for (const s of scores) {
      entries.push({
        timestamp: s.computedAt,
        type: 'score',
        action: 'compliance_score_computed',
        result: `${s.overallScore}`,
        jurisdiction: null,
        details: `Score: ${s.overallScore} | Trigger: ${s.triggerEvent}`,
      });
    }
  }

  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const limited = entries.slice(0, limit);
  const truncated = entries.length > limit || perTypeHitLimit;

  // Build CSV
  const csvHeader = 'Timestamp,Type,Action,Result,Jurisdiction,Details';
  const csvRows = limited.map((e) => {
    const escapeCsv = (raw: string | null) => {
      if (!raw) return '';
      // Cells starting with = + - @ are formulas in spreadsheet apps; file
      // paths and summaries come from scanner uploads, so neutralise them.
      const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    return [e.timestamp, e.type, e.action, e.result, e.jurisdiction ?? '', e.details].map(escapeCsv).join(',');
  });

  const csv = [csvHeader, ...csvRows].join('\n');

  if (truncated) c.header('X-Nomus-Truncated', String(limit));
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="nomus-audit-log-${new Date().toISOString().split('T')[0]}.csv"`);
  return c.body(csv);
});

// Export as JSON (downloadable file)
auditExportRoutes.get('/json', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const since = c.req.query('since');
  const until = c.req.query('until');
  const type = c.req.query('type');

  // Attestations
  const attConditions = [eq(attestationReceipts.orgId, orgId)];
  if (since) attConditions.push(gte(attestationReceipts.evaluatedAt, since));
  if (until) attConditions.push(lte(attestationReceipts.evaluatedAt, until));

  const attestations = (!type || type === 'attestation')
    ? db.select().from(attestationReceipts)
        .where(and(...attConditions))
        .orderBy(desc(attestationReceipts.evaluatedAt))
        .limit(5000)
        .all()
        .map((r) => ({
          ...r,
          actionContext: (() => { try { return JSON.parse(r.actionContext); } catch { return r.actionContext; } })(),
          rulesEvaluated: (() => { try { return JSON.parse(r.rulesEvaluated); } catch { return r.rulesEvaluated; } })(),
        }))
    : [];

  // Scan findings
  const scanConditions = [eq(scanFindings.orgId, orgId)];
  if (since) scanConditions.push(gte(scanFindings.scannedAt, since));
  if (until) scanConditions.push(lte(scanFindings.scannedAt, until));

  const findings = (!type || type === 'scan')
    ? db.select().from(scanFindings)
        .where(and(...scanConditions))
        .orderBy(desc(scanFindings.scannedAt))
        .limit(5000)
        .all()
    : [];

  // Scores
  const scoreConditions = [eq(complianceScores.orgId, orgId)];
  if (since) scoreConditions.push(gte(complianceScores.computedAt, since));
  if (until) scoreConditions.push(lte(complianceScores.computedAt, until));

  const scores = (!type || type === 'score')
    ? db.select().from(complianceScores)
        .where(and(...scoreConditions))
        .orderBy(desc(complianceScores.computedAt))
        .limit(5000)
        .all()
    : [];

  const exportData = {
    exportedAt: new Date().toISOString(),
    orgId,
    filters: { since: since ?? null, until: until ?? null, type: type ?? 'all' },
    attestations,
    scanFindings: findings,
    complianceScores: scores,
    _disclaimer: LEGAL_DISCLAIMER,
  };

  c.header('Content-Type', 'application/json; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="nomus-audit-log-${new Date().toISOString().split('T')[0]}.json"`);
  return c.body(JSON.stringify(exportData, null, 2));
});

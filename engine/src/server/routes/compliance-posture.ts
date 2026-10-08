import { Hono } from 'hono';
import { randomUUID, createHash } from 'node:crypto';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import {
  complianceScores, policyRules, scanFindings,
  aiBomSystems, benchmarkRuns, organizations,
} from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';

export const compliancePostureRoutes = new Hono<AppEnv>();

compliancePostureRoutes.use('*', requireSessionOrApiKey('read:policies'));

// 30-second score cache to avoid recomputing on rapid dashboard calls
const scoreCache = new Map<string, { result: ReturnType<typeof calculateScore>; expiresAt: number }>();

interface ScoreFactor {
  category: string;
  description: string;
  impact: number; // positive = bonus, negative = deduction
}

/**
 * Calculate compliance score for an org.
 * Formula: base 100, deductions for findings and unclassified systems, bonus for benchmarks.
 */
function calculateScore(orgId: string): {
  overallScore: number;
  factorsPositive: ScoreFactor[];
  factorsNegative: ScoreFactor[];
  scoresByJurisdiction: Record<string, number>;
  scoresByCategory: Record<string, number>;
  rulesActive: number;
  rulesApplicable: number;
  openFindings: number;
  aiBomSystemCount: number;
  highRiskSystems: number;
  benchmarkScore: number | null;
  lastBenchmarkAt: string | null;
  policyStateHash: string;
} {
  const db = getDb();

  // Fetch org's jurisdiction access
  const org = db.select().from(organizations)
    .where(eq(organizations.id, orgId))
    .get();

  const orgJurisdictions: string[] = org ? JSON.parse(org.jurisdictionAccess || '[]') : [];

  // Count active rules using SQL
  const rulesActiveResult = db.select({ count: sql<number>`count(*)` })
    .from(policyRules)
    .where(eq(policyRules.isActive, true))
    .get();
  const rulesActive = rulesActiveResult?.count ?? 0;

  // Count applicable rules (filtered by org jurisdictions)
  let rulesApplicable = rulesActive;
  if (orgJurisdictions.length > 0) {
    const applicableResult = db.select({ count: sql<number>`count(*)` })
      .from(policyRules)
      .where(and(
        eq(policyRules.isActive, true),
        sql`${policyRules.jurisdiction} IN (${sql.join(orgJurisdictions.map((j) => sql`${j}`), sql`, `)})`
      ))
      .get();
    rulesApplicable = applicableResult?.count ?? 0;
  }

  // Count open scan findings by severity using SQL GROUP BY
  const findingCounts = db.select({
    severity: scanFindings.severity,
    count: sql<number>`count(*)`,
  })
    .from(scanFindings)
    .where(and(eq(scanFindings.orgId, orgId), eq(scanFindings.status, 'open')))
    .groupBy(scanFindings.severity)
    .all();

  const severityMap: Record<string, number> = {};
  let openFindings = 0;
  for (const row of findingCounts) {
    severityMap[row.severity] = row.count;
    openFindings += row.count;
  }
  const criticalFindings = severityMap['critical'] ?? 0;
  const highFindings = severityMap['high'] ?? 0;
  const mediumFindings = severityMap['medium'] ?? 0;

  // AI-BOM systems
  const systems = db.select().from(aiBomSystems)
    .where(and(eq(aiBomSystems.orgId, orgId), eq(aiBomSystems.isActive, true)))
    .all();

  const aiBomSystemCount = systems.length;
  const highRiskSystems = systems.filter((s) =>
    s.riskClassification === 'high' || s.riskClassification === 'unacceptable'
  ).length;
  const unclassifiedSystems = systems.filter((s) => s.riskClassification === 'unclassified').length;

  // Latest benchmark
  const latestBenchmark = db.select().from(benchmarkRuns)
    .where(and(eq(benchmarkRuns.orgId, orgId), eq(benchmarkRuns.status, 'completed')))
    .orderBy(desc(benchmarkRuns.completedAt))
    .limit(1)
    .get();

  const benchmarkScore = latestBenchmark?.overallScore ?? null;
  const lastBenchmarkAt = latestBenchmark?.completedAt ?? null;

  // Calculate score
  let score = 100;
  const factorsPositive: ScoreFactor[] = [];
  const factorsNegative: ScoreFactor[] = [];

  // Deductions for open findings
  if (criticalFindings > 0) {
    const deduction = criticalFindings * 5;
    score -= deduction;
    factorsNegative.push({
      category: 'scan_findings',
      description: `${criticalFindings} critical open finding(s)`,
      impact: -deduction,
    });
  }
  if (highFindings > 0) {
    const deduction = highFindings * 3;
    score -= deduction;
    factorsNegative.push({
      category: 'scan_findings',
      description: `${highFindings} high severity open finding(s)`,
      impact: -deduction,
    });
  }
  if (mediumFindings > 0) {
    const deduction = mediumFindings * 1;
    score -= deduction;
    factorsNegative.push({
      category: 'scan_findings',
      description: `${mediumFindings} medium severity open finding(s)`,
      impact: -deduction,
    });
  }

  // Deduction for unclassified AI systems
  if (unclassifiedSystems > 0) {
    const deduction = unclassifiedSystems * 2;
    score -= deduction;
    factorsNegative.push({
      category: 'ai_bom',
      description: `${unclassifiedSystems} unclassified AI system(s)`,
      impact: -deduction,
    });
  }

  // Bonus for good benchmark score
  if (benchmarkScore !== null && benchmarkScore > 80) {
    const bonus = 10;
    score += bonus;
    factorsPositive.push({
      category: 'benchmarks',
      description: `COMPL-AI benchmark score ${benchmarkScore.toFixed(1)} (>80)`,
      impact: bonus,
    });
  }

  // Bonus for having rules in place
  if (rulesApplicable > 0) {
    factorsPositive.push({
      category: 'policy_coverage',
      description: `${rulesApplicable} applicable policy rule(s) active`,
      impact: 0, // informational
    });
  }

  // Bonus for classified systems
  const classifiedSystems = aiBomSystemCount - unclassifiedSystems;
  if (classifiedSystems > 0) {
    factorsPositive.push({
      category: 'ai_bom',
      description: `${classifiedSystems} AI system(s) classified`,
      impact: 0, // informational
    });
  }

  // Clamp score between 0 and 100
  score = Math.max(0, Math.min(100, score));

  // Scores by jurisdiction — use SQL JOIN to group findings by rule jurisdiction
  const scoresByJurisdiction: Record<string, number> = {};
  const jGroups = db.select({
    jurisdiction: sql<string>`coalesce(${policyRules.jurisdiction}, 'unknown')`,
    severity: scanFindings.severity,
    count: sql<number>`count(*)`,
  })
    .from(scanFindings)
    .leftJoin(policyRules, eq(scanFindings.ruleId, policyRules.id))
    .where(and(eq(scanFindings.orgId, orgId), eq(scanFindings.status, 'open')))
    .groupBy(sql`coalesce(${policyRules.jurisdiction}, 'unknown')`, scanFindings.severity)
    .all();

  // Also get all applicable jurisdictions from rules
  const ruleJurisdictions = db.select({ jurisdiction: policyRules.jurisdiction })
    .from(policyRules)
    .where(eq(policyRules.isActive, true))
    .groupBy(policyRules.jurisdiction)
    .all();

  for (const rj of ruleJurisdictions) {
    if (!scoresByJurisdiction[rj.jurisdiction]) scoresByJurisdiction[rj.jurisdiction] = 100;
  }

  const jDeductions: Record<string, number> = {};
  for (const row of jGroups) {
    const j = row.jurisdiction;
    if (!jDeductions[j]) jDeductions[j] = 0;
    if (row.severity === 'critical') jDeductions[j] += row.count * 5;
    else if (row.severity === 'high') jDeductions[j] += row.count * 3;
    else if (row.severity === 'medium') jDeductions[j] += row.count * 1;
  }
  for (const [j, deduction] of Object.entries(jDeductions)) {
    scoresByJurisdiction[j] = Math.max(0, Math.min(100, 100 - deduction));
  }

  // Scores by category — use SQL JOIN to group findings by rule category
  const scoresByCategory: Record<string, number> = {};
  const cGroups = db.select({
    category: sql<string>`coalesce(${policyRules.category}, 'uncategorized')`,
    severity: scanFindings.severity,
    count: sql<number>`count(*)`,
  })
    .from(scanFindings)
    .leftJoin(policyRules, eq(scanFindings.ruleId, policyRules.id))
    .where(and(eq(scanFindings.orgId, orgId), eq(scanFindings.status, 'open')))
    .groupBy(sql`coalesce(${policyRules.category}, 'uncategorized')`, scanFindings.severity)
    .all();

  // Also get all categories from rules
  const ruleCategories = db.select({ category: policyRules.category })
    .from(policyRules)
    .where(eq(policyRules.isActive, true))
    .groupBy(policyRules.category)
    .all();

  for (const rc of ruleCategories) {
    if (!scoresByCategory[rc.category]) scoresByCategory[rc.category] = 100;
  }

  const cDeductions: Record<string, number> = {};
  for (const row of cGroups) {
    const cat = row.category;
    if (!cDeductions[cat]) cDeductions[cat] = 0;
    if (row.severity === 'critical') cDeductions[cat] += row.count * 5;
    else if (row.severity === 'high') cDeductions[cat] += row.count * 3;
    else if (row.severity === 'medium') cDeductions[cat] += row.count * 1;
  }
  for (const [cat, deduction] of Object.entries(cDeductions)) {
    scoresByCategory[cat] = Math.max(0, Math.min(100, 100 - deduction));
  }

  // Compute policy state hash for audit trail using SQL-fetched rule IDs
  const ruleIdsForHash = db.select({ id: policyRules.id })
    .from(policyRules)
    .where(eq(policyRules.isActive, true))
    .all()
    .map((r) => r.id)
    .sort()
    .join(',');
  const policyStateHash = createHash('sha256').update(ruleIdsForHash).digest('hex').slice(0, 16);

  return {
    overallScore: Math.round(score * 100) / 100,
    factorsPositive,
    factorsNegative,
    scoresByJurisdiction,
    scoresByCategory,
    rulesActive,
    rulesApplicable,
    openFindings,
    aiBomSystemCount,
    highRiskSystems,
    benchmarkScore,
    lastBenchmarkAt,
    policyStateHash,
  };
}

// Get current compliance score (cached for 30s)
compliancePostureRoutes.get('/score', (c) => {
  const orgId = c.get('orgId')!;
  const now = Date.now();
  const cached = scoreCache.get(orgId);
  let result: ReturnType<typeof calculateScore>;
  if (cached && cached.expiresAt > now) {
    result = cached.result;
  } else {
    result = calculateScore(orgId);
    scoreCache.set(orgId, { result, expiresAt: now + 30_000 });
  }

  return c.json({
    ...result,
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// Force recalculation and store in complianceScores table
compliancePostureRoutes.post('/recalculate', (c) => {
  const orgId = c.get('orgId')!;
  const db = getDb();
  const now = new Date().toISOString();

  const result = calculateScore(orgId);
  const id = randomUUID();

  db.insert(complianceScores).values({
    id,
    orgId,
    overallScore: result.overallScore,
    scoresByJurisdiction: JSON.stringify(result.scoresByJurisdiction),
    scoresByCategory: JSON.stringify(result.scoresByCategory),
    factorsPositive: JSON.stringify(result.factorsPositive),
    factorsNegative: JSON.stringify(result.factorsNegative),
    rulesActive: result.rulesActive,
    rulesApplicable: result.rulesApplicable,
    openFindings: result.openFindings,
    aiBomSystems: result.aiBomSystemCount,
    highRiskSystems: result.highRiskSystems,
    benchmarkScore: result.benchmarkScore,
    lastBenchmarkAt: result.lastBenchmarkAt,
    triggerEvent: 'manual',
    policyStateHash: result.policyStateHash,
    computedAt: now,
  }).run();

  return c.json({
    id,
    ...result,
    computedAt: now,
    _disclaimer: LEGAL_DISCLAIMER,
  }, 201);
});

// Score history over time (for trend chart)
compliancePostureRoutes.get('/history', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const limit = Math.min(parseInt(c.req.query('limit') || '90'), 365);

  const history = db.select({
    id: complianceScores.id,
    overallScore: complianceScores.overallScore,
    openFindings: complianceScores.openFindings,
    aiBomSystems: complianceScores.aiBomSystems,
    highRiskSystems: complianceScores.highRiskSystems,
    benchmarkScore: complianceScores.benchmarkScore,
    triggerEvent: complianceScores.triggerEvent,
    computedAt: complianceScores.computedAt,
  })
    .from(complianceScores)
    .where(eq(complianceScores.orgId, orgId))
    .orderBy(desc(complianceScores.computedAt))
    .limit(limit)
    .all();

  return c.json({
    count: history.length,
    history,
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// Detailed breakdown of what affects the score
compliancePostureRoutes.get('/factors', (c) => {
  const orgId = c.get('orgId')!;
  const result = calculateScore(orgId);

  return c.json({
    overallScore: result.overallScore,
    factorsPositive: result.factorsPositive,
    factorsNegative: result.factorsNegative,
    breakdown: {
      rulesActive: result.rulesActive,
      rulesApplicable: result.rulesApplicable,
      openFindings: result.openFindings,
      aiBomSystems: result.aiBomSystemCount,
      highRiskSystems: result.highRiskSystems,
      benchmarkScore: result.benchmarkScore,
      lastBenchmarkAt: result.lastBenchmarkAt,
    },
    scoresByJurisdiction: result.scoresByJurisdiction,
    scoresByCategory: result.scoresByCategory,
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

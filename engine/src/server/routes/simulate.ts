import { Hono } from 'hono';
import { eq, and, or } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { policyRules, graphEdges, graphNodes } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';
import { safeJson } from '../utils.js';
import { matchRuleToProfile } from '../../core/applicability.js';

const simulateSchema = z.object({
  capabilities: z.array(z.string()).min(1),
  dataTypes: z.array(z.string()).default([]),
  targetMarkets: z.array(z.string()).min(1),
  modelType: z.string().optional(),
  sector: z.string().optional(),
});

interface MarketReport {
  jurisdiction: string;
  totalRules: number;
  triggered: number;
  riskLevel: 'critical' | 'high' | 'medium' | 'low' | 'none';
  rules: Array<{
    ruleKey: string;
    effect: string;
    severity: string;
    humanSummary: string;
    legalReference: string;
    matchedOn: string[];
  }>;
}

export const simulateRoutes = new Hono<AppEnv>();

simulateRoutes.use('*', requireSessionOrApiKey('evaluate'));
simulateRoutes.use('*', rateLimit());

simulateRoutes.post('/', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = simulateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  }

  const { capabilities, dataTypes, targetMarkets, modelType, sector } = parsed.data;
  const db = getDb();

  const markets: Record<string, MarketReport> = {};
  const severityRank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

  for (const market of targetMarkets) {
    // Get all active rules for this jurisdiction.
    // INTL rules (PCI DSS, OWASP, etc.) apply globally — include them for every market query.
    const rules = db.select().from(policyRules)
      .where(
        and(
          eq(policyRules.isActive, true),
          or(eq(policyRules.jurisdiction, market), eq(policyRules.jurisdiction, 'INTL')),
        ),
      )
      .all();

    const triggered: MarketReport['rules'] = [];

    for (const rule of rules) {
      let conditions: Record<string, unknown>;
      try { conditions = JSON.parse(rule.conditions); } catch { continue; }
      if (!conditions || typeof conditions !== 'object') continue;

      // Every condition the rule declares must hold (same semantics as
      // /evaluate) — see core/applicability.ts.
      const matchedOn = matchRuleToProfile(conditions, rule.industries, {
        capabilities, dataTypes, market, sector, modelType,
      }) ?? [];

      if (matchedOn.length > 0) {
        triggered.push({
          ruleKey: rule.ruleKey,
          effect: rule.effect,
          severity: rule.severity,
          humanSummary: rule.humanSummary,
          legalReference: rule.legalReference,
          matchedOn,
        });
      }
    }

    // Determine overall risk level
    let maxSeverity = 0;
    for (const t of triggered) {
      const rank = severityRank[t.severity] ?? 0;
      if (rank > maxSeverity) maxSeverity = rank;
    }

    const riskLevel = maxSeverity >= 4 ? 'critical'
      : maxSeverity >= 3 ? 'high'
      : maxSeverity >= 2 ? 'medium'
      : maxSeverity >= 1 ? 'low'
      : 'none';

    markets[market] = {
      jurisdiction: market,
      totalRules: rules.length,
      triggered: triggered.length,
      riskLevel,
      rules: triggered,
    };
  }

  // Detect cross-jurisdiction conflicts
  const conflicts: Array<{
    jurisdictionA: string;
    jurisdictionB: string;
    description: string;
  }> = [];

  const conflictEdges = db.select().from(graphEdges)
    .where(eq(graphEdges.edgeType, 'conflicts_with'))
    .all();

  for (const edge of conflictEdges) {
    const fromNode = db.select().from(graphNodes).where(eq(graphNodes.id, edge.fromNodeId)).get();
    const toNode = db.select().from(graphNodes).where(eq(graphNodes.id, edge.toNodeId)).get();
    if (fromNode && toNode &&
        targetMarkets.includes(fromNode.jurisdiction) &&
        targetMarkets.includes(toNode.jurisdiction)) {
      conflicts.push({
        jurisdictionA: fromNode.jurisdiction,
        jurisdictionB: toNode.jurisdiction,
        description: edge.description,
      });
    }
  }

  // Gap analysis
  const allJurisdictionsCovered = targetMarkets.every((m) => markets[m]?.totalRules > 0);
  const uncoveredMarkets = targetMarkets.filter((m) => (markets[m]?.totalRules ?? 0) === 0);

  // Overall risk
  const overallRiskValues = Object.values(markets).map((m) => severityRank[m.riskLevel] ?? 0);
  const maxOverall = Math.max(...overallRiskValues, 0);
  const overallRisk = maxOverall >= 4 ? 'critical'
    : maxOverall >= 3 ? 'high'
    : maxOverall >= 2 ? 'medium'
    : maxOverall >= 1 ? 'low'
    : 'none';

  return c.json({
    input: { capabilities, dataTypes, targetMarkets, modelType, sector },
    markets,
    conflicts,
    gapAnalysis: {
      allJurisdictionsCovered,
      uncoveredMarkets,
    },
    overallRisk,
    totalRulesTriggered: Object.values(markets).reduce((sum, m) => sum + m.triggered, 0),
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { eq, and, desc, gte } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { simulationRuns, regulatorySignals, aiBomSystems } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';
import { safeJson, safeParseInt } from '../utils.js';

export const simulationRoutes = new Hono<AppEnv>();

simulationRoutes.use('*', requireSessionOrApiKey('read:policies'));
// Simulations call evaluateImpact over every AI-BOM system per request and
// /auto-simulate fans out across every active signal — both are heavier
// than the average read endpoint. Cap requests per org.
simulationRoutes.use('*', rateLimit());

/**
 * Auto-simulation considers signals at or above this likelihood. A signal
 * crossing 51% means the political/regulatory weather has tipped toward
 * "more likely than not" — the threshold at which we want a baseline
 * impact estimate ready for customers, even before promotion.
 */
const AUTO_SIMULATION_LIKELIHOOD_THRESHOLD = 51;

/**
 * Convert an integer cents value to a NUMERIC(18,8) string without going
 * through float division. Nomus Laws: never use float arithmetic on
 * money. For values up to 2^53 cents this is precise either way, but the
 * helper makes the integer-only path explicit and easy to audit.
 */
function centsToNumeric8(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error(`centsToNumeric8: expected integer, got ${cents}`);
  }
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100);
  const remainder = abs % 100;
  // 8 fractional digits: 2 of cents + 6 zeros. e.g. 50000 cents → "500.00000000".
  const frac = remainder.toString().padStart(2, '0') + '000000';
  return `${negative ? '-' : ''}${dollars}.${frac}`;
}

interface ImpactDetail {
  systemId: string;
  systemName: string;
  impact: 'high' | 'medium' | 'low' | 'none';
  reason: string;
  remediationSteps: string[];
  estimatedCost: string;
}

interface RoadmapStep {
  step: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
  estimatedDays: number;
  description: string;
}

/**
 * Run the simulation logic: for each AI-BOM system, determine impact
 * based on jurisdiction overlap, risk classification, and capabilities.
 */
function evaluateImpact(
  signal: { jurisdiction: string; title: string; likelihoodPercent: number },
  systems: Array<{
    id: string;
    name: string;
    jurisdictions: string;
    riskClassification: string;
    capabilities: string;
    systemType: string;
  }>,
): { impactDetails: ImpactDetail[]; roadmap: RoadmapStep[]; overallRisk: string; totalCost: number } {
  const impactDetails: ImpactDetail[] = [];
  let stepCounter = 0;
  const roadmap: RoadmapStep[] = [];
  let totalCost = 0;

  for (const system of systems) {
    let systemJurisdictions: string[];
    let capabilities: string[];
    try { systemJurisdictions = JSON.parse(system.jurisdictions || '[]'); } catch { systemJurisdictions = []; }
    try { capabilities = JSON.parse(system.capabilities || '[]'); } catch { capabilities = []; }

    // Check jurisdiction overlap
    const jurisdictionOverlap = systemJurisdictions.length === 0 ||
      systemJurisdictions.includes(signal.jurisdiction) ||
      systemJurisdictions.includes('global');

    if (!jurisdictionOverlap) {
      impactDetails.push({
        systemId: system.id,
        systemName: system.name,
        impact: 'none',
        reason: 'No jurisdiction overlap',
        remediationSteps: [],
        estimatedCost: centsToNumeric8(0),
      });
      continue;
    }

    // Determine impact level based on risk classification
    let impact: 'high' | 'medium' | 'low' = 'low';
    const remediationSteps: string[] = [];
    let costMultiplier = 1;

    if (system.riskClassification === 'unacceptable' || system.riskClassification === 'high') {
      impact = 'high';
      costMultiplier = 5;
      remediationSteps.push('Conduct full conformity assessment under new regulation');
      remediationSteps.push('Update risk management documentation');
      remediationSteps.push('Review and update data governance procedures');
    } else if (system.riskClassification === 'limited') {
      impact = 'medium';
      costMultiplier = 3;
      remediationSteps.push('Update transparency disclosures');
      remediationSteps.push('Review notification requirements');
    } else {
      impact = 'low';
      costMultiplier = 1;
      remediationSteps.push('Monitor for further regulatory developments');
    }

    // Capability-based adjustments
    if (capabilities.includes('biometric') || capabilities.includes('facial_recognition')) {
      impact = 'high';
      costMultiplier = Math.max(costMultiplier, 8);
      remediationSteps.push('Review biometric data processing under new regulation');
    }
    if (capabilities.includes('decision_making') || capabilities.includes('scoring')) {
      if (impact !== 'high') impact = 'medium';
      costMultiplier = Math.max(costMultiplier, 4);
      remediationSteps.push('Assess automated decision-making compliance requirements');
    }

    // Base cost per system: $500 (50000 cents) * multiplier
    const estimatedCostCents = 50000 * costMultiplier;
    totalCost += estimatedCostCents;

    impactDetails.push({
      systemId: system.id,
      systemName: system.name,
      impact,
      reason: `${system.riskClassification} risk system in affected jurisdiction`,
      remediationSteps,
      estimatedCost: centsToNumeric8(estimatedCostCents),
    });

    // Generate roadmap steps for impacted systems
    if (impact === 'high' || impact === 'medium') {
      stepCounter++;
      roadmap.push({
        step: stepCounter,
        priority: impact === 'high' ? 'critical' : 'high',
        estimatedDays: impact === 'high' ? 30 : 14,
        description: `Assess ${system.name}: ${remediationSteps[0] || 'Review compliance requirements'}`,
      });
    }
  }

  // Determine overall risk level
  const highCount = impactDetails.filter((d) => d.impact === 'high').length;
  const mediumCount = impactDetails.filter((d) => d.impact === 'medium').length;

  let overallRisk = 'none';
  if (highCount >= 3) overallRisk = 'critical';
  else if (highCount >= 1) overallRisk = 'high';
  else if (mediumCount >= 2) overallRisk = 'medium';
  else if (mediumCount >= 1 || impactDetails.some((d) => d.impact === 'low')) overallRisk = 'low';

  return { impactDetails, roadmap, overallRisk, totalCost };
}

// Run a predictive simulation for a specific signal
simulationRoutes.post('/run', async (c) => {
  const { data: rawBody, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const orgId = c.get('orgId')!;
  const db = getDb();

  const { signalId } = rawBody as { signalId: string };
  if (!signalId) {
    return c.json({ error: 'signalId is required' }, 400);
  }

  // Fetch the signal
  const signal = db.select().from(regulatorySignals)
    .where(eq(regulatorySignals.id, signalId))
    .get();

  if (!signal) {
    return c.json({ error: 'Signal not found' }, 404);
  }

  // Fetch org's AI-BOM systems
  const systems = db.select().from(aiBomSystems)
    .where(and(eq(aiBomSystems.orgId, orgId), eq(aiBomSystems.isActive, true)))
    .all();

  const now = new Date().toISOString();
  const id = randomUUID();

  if (systems.length === 0) {
    // No systems to analyze - store empty simulation
    db.insert(simulationRuns).values({
      id,
      orgId,
      signalId,
      signalTitle: signal.title,
      signalJurisdiction: signal.jurisdiction,
      signalLikelihood: signal.likelihoodPercent,
      systemsAnalyzed: 0,
      systemsImpacted: 0,
      impactDetails: '[]',
      overallRiskLevel: 'none',
      estimatedRemediationCost: '0.00000000',
      remediationRoadmap: '[]',
      status: 'completed',
      errorMessage: null,
      completedAt: now,
      createdAt: now,
    }).run();

    return c.json({
      id,
      status: 'completed',
      systemsAnalyzed: 0,
      systemsImpacted: 0,
      overallRiskLevel: 'none',
      estimatedRemediationCost: centsToNumeric8(0),
    }, 201);
  }

  // Run impact evaluation
  const { impactDetails, roadmap, overallRisk, totalCost } = evaluateImpact(signal, systems);

  const systemsImpacted = impactDetails.filter((d) => d.impact !== 'none').length;
  // Store cost as NUMERIC(18,8) text
  const costDecimal = centsToNumeric8(totalCost);

  db.insert(simulationRuns).values({
    id,
    orgId,
    signalId,
    signalTitle: signal.title,
    signalJurisdiction: signal.jurisdiction,
    signalLikelihood: signal.likelihoodPercent,
    systemsAnalyzed: systems.length,
    systemsImpacted,
    impactDetails: JSON.stringify(impactDetails),
    overallRiskLevel: overallRisk as 'critical' | 'high' | 'medium' | 'low' | 'none',
    estimatedRemediationCost: costDecimal,
    remediationRoadmap: JSON.stringify(roadmap),
    status: 'completed',
    errorMessage: null,
    completedAt: now,
    createdAt: now,
  }).run();

  return c.json({
    id,
    status: 'completed',
    systemsAnalyzed: systems.length,
    systemsImpacted,
    overallRiskLevel: overallRisk,
    estimatedRemediationCost: costDecimal,
  }, 201);
});

// List simulations for the org
simulationRoutes.get('/', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const status = c.req.query('status');
  const signalId = c.req.query('signalId');
  const limit = Math.min(Math.max(safeParseInt(c.req.query('limit'), 50), 1), 200);

  let sims = db.select().from(simulationRuns)
    .where(eq(simulationRuns.orgId, orgId))
    .orderBy(desc(simulationRuns.createdAt))
    .all();

  if (status) sims = sims.filter((s) => s.status === status);
  if (signalId) sims = sims.filter((s) => s.signalId === signalId);

  // JSON columns are served parsed, as GET /:id serves them; the list sent
  // strings and the Simulations page crashed calling .map on '[]'.
  const parse = (v: string): unknown[] => { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } };

  return c.json({
    count: sims.length,
    simulations: sims.slice(0, limit).map((s) => ({
      ...s,
      impactDetails: parse(s.impactDetails),
      remediationRoadmap: parse(s.remediationRoadmap),
    })),
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// Get single simulation with full impact details
simulationRoutes.get('/:id', (c) => {
  const db = getDb();
  const orgId = c.get('orgId')!;
  const id = c.req.param('id');

  const sim = db.select().from(simulationRuns)
    .where(and(eq(simulationRuns.id, id), eq(simulationRuns.orgId, orgId)))
    .get();

  if (!sim) return c.json({ error: 'Simulation not found' }, 404);

  return c.json({
    ...sim,
    impactDetails: (() => { try { return JSON.parse(sim.impactDetails); } catch { return []; } })(),
    remediationRoadmap: (() => { try { return JSON.parse(sim.remediationRoadmap); } catch { return []; } })(),
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// Auto-simulate for all active Scout signals with likelihood > 50%
simulationRoutes.post('/auto-simulate', async (c) => {
  const scopes = c.get('scopes') || [];
  if (!scopes.includes('admin')) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const orgId = c.get('orgId')!;
  const db = getDb();

  // Find signals at/above the auto-simulation threshold.
  const signals = db.select().from(regulatorySignals)
    .where(gte(regulatorySignals.likelihoodPercent, AUTO_SIMULATION_LIKELIHOOD_THRESHOLD))
    .all();

  if (signals.length === 0) {
    return c.json({
      message: `No signals with likelihood >= ${AUTO_SIMULATION_LIKELIHOOD_THRESHOLD}%`,
      simulationsCreated: 0,
    });
  }

  // Fetch org's AI-BOM systems once
  const systems = db.select().from(aiBomSystems)
    .where(and(eq(aiBomSystems.orgId, orgId), eq(aiBomSystems.isActive, true)))
    .all();

  const now = new Date().toISOString();
  const created: string[] = [];

  for (const signal of signals) {
    // Skip if a completed simulation already exists for this signal+org
    const existing = db.select().from(simulationRuns)
      .where(and(
        eq(simulationRuns.orgId, orgId),
        eq(simulationRuns.signalId, signal.id),
        eq(simulationRuns.status, 'completed'),
      ))
      .get();

    if (existing) continue;

    const id = randomUUID();
    const { impactDetails, roadmap, overallRisk, totalCost } = evaluateImpact(signal, systems);
    const systemsImpacted = impactDetails.filter((d) => d.impact !== 'none').length;
    const costDecimal = centsToNumeric8(totalCost);

    db.insert(simulationRuns).values({
      id,
      orgId,
      signalId: signal.id,
      signalTitle: signal.title,
      signalJurisdiction: signal.jurisdiction,
      signalLikelihood: signal.likelihoodPercent,
      systemsAnalyzed: systems.length,
      systemsImpacted,
      impactDetails: JSON.stringify(impactDetails),
      overallRiskLevel: overallRisk as 'critical' | 'high' | 'medium' | 'low' | 'none',
      estimatedRemediationCost: costDecimal,
      remediationRoadmap: JSON.stringify(roadmap),
      status: 'completed',
      errorMessage: null,
      completedAt: now,
      createdAt: now,
    }).run();

    created.push(id);
  }

  return c.json({
    message: `Auto-simulation complete`,
    signalsEvaluated: signals.length,
    simulationsCreated: created.length,
    simulationIds: created,
  });
});

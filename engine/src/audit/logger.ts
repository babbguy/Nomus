import { desc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { pipelineRuns, policyEvents, shadowTestResults, regulatorySources } from '../db/schema.js';

/**
 * Get recent pipeline runs for audit display, with source name joined.
 */
export function getRecentPipelineRuns(limit = 50) {
  const db = getDb();
  return db.select({
    id: pipelineRuns.id,
    sourceId: pipelineRuns.sourceId,
    sourceName: regulatorySources.name,
    status: pipelineRuns.status,
    stepReached: pipelineRuns.stepReached,
    diffDetected: pipelineRuns.diffDetected,
    classification: pipelineRuns.classification,
    rulesCreated: pipelineRuns.rulesCreated,
    rulesUpdated: pipelineRuns.rulesUpdated,
    llmProvider: pipelineRuns.llmProvider,
    llmModel: pipelineRuns.llmModel,
    llmTokensIn: pipelineRuns.llmTokensIn,
    llmTokensOut: pipelineRuns.llmTokensOut,
    llmCostCents: pipelineRuns.llmCostCents,
    errorMessage: pipelineRuns.errorMessage,
    durationMs: pipelineRuns.durationMs,
    startedAt: pipelineRuns.startedAt,
    completedAt: pipelineRuns.completedAt,
  }).from(pipelineRuns)
    .leftJoin(regulatorySources, eq(pipelineRuns.sourceId, regulatorySources.id))
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(limit)
    .all();
}

/**
 * Get recent policy events for audit display.
 */
export function getRecentPolicyEvents(limit = 100) {
  const db = getDb();
  return db.select().from(policyEvents)
    .orderBy(desc(policyEvents.sequence))
    .limit(limit)
    .all()
    .map((e) => ({
      ...e,
      payload: JSON.parse(e.payload),
    }));
}

/**
 * Get latest shadow test results.
 */
export function getLatestShadowTests(limit = 50) {
  const db = getDb();
  return db.select().from(shadowTestResults)
    .orderBy(desc(shadowTestResults.runAt))
    .limit(limit)
    .all()
    .map((t) => ({
      ...t,
      inputContext: JSON.parse(t.inputContext),
    }));
}

import { resolveProvider } from '../llm/provider.js';
import { logger } from '../logger.js';
import { broadcastEvent } from '../sse/manager.js';
import { randomUUID } from 'node:crypto';

interface CandidateRule {
  ruleKey: string;
  jurisdiction: string;
  category: string;
  conditions: Record<string, string>;
  effect: string;
  severity: string;
  humanSummary: string;
  legalReference: string;
  effectiveDate: string;
  expiresAt: string | null;
  industries: string[];
  industryScope: string;
  industryNotes: string;
}

export interface ScoreResult {
  rules: CandidateRule[];
  overallScore: number;
  rejected: string[];       // ruleKeys that were removed
  tokensIn: number;
  tokensOut: number;
}

const SCORE_PROMPT = `You are a regulatory compliance quality auditor. Review these AI-extracted policy rules for accuracy.

For each rule, evaluate:
1. Is the legal reference real and specific? (not vague or made up)
2. Is the effect (deny/allow_with_audit/require_disclosure/flag) appropriate for the requirement?
3. Is the severity (critical/high/medium/low) proportionate?
4. Does the humanSummary accurately describe a real regulatory requirement?

Output JSON:
{"overallScore": 1-10, "reject": ["ruleKey1", "ruleKey2"], "adjustments": [{"ruleKey": "...", "field": "severity|effect", "from": "...", "to": "..."}]}

Rules to REJECT (false positives):
- Vague/generic rules that don't reference a specific article or requirement
- Duplicate rules that say the same thing as another rule
- Rules with hallucinated legal references
- Rules that describe context/background, not an actionable requirement

Rules to ADJUST:
- Wrong severity (e.g., a disclosure requirement marked as "critical")
- Wrong effect (e.g., a penalty marked as "flag" instead of "deny")

Be conservative — keep rules unless clearly wrong. Output ONLY the JSON.`;

/** Max rules per scoring batch — keeps token count safe for any LLM */
const SCORING_BATCH_SIZE = 50;

/** Delay between scoring batches to avoid rate limiting */
const SCORING_BATCH_DELAY = 2000;

/** Timeout per scoring batch */
const SCORING_TIMEOUT_MS = 60_000;

/** Max retries per batch before accepting without scoring */
const MAX_RETRIES = 3;

/** Delay between retries (doubles each attempt) */
const RETRY_BASE_DELAY_MS = 5_000;

/**
 * Score and clean candidate rules using Haiku as a quality agent.
 * Processes in batches of 50 for large rule sets.
 * Removes false positives, adjusts severity/effect errors.
 */
export async function scoreRules(
  candidates: CandidateRule[],
  sourceName: string,
  jurisdiction: string,
  context?: { sourceId?: string; sourceName?: string },
): Promise<ScoreResult> {
  if (candidates.length === 0) {
    return { rules: [], overallScore: 0, rejected: [], tokensIn: 0, tokensOut: 0 };
  }

  const { provider, model } = await resolveProvider('classifier');

  // Process in batches
  const totalBatches = Math.ceil(candidates.length / SCORING_BATCH_SIZE);
  const allAccepted: CandidateRule[] = [];
  const allRejected: string[] = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let scoreSum = 0;
  let scoredBatches = 0;

  logger.info({ candidates: candidates.length, batches: totalBatches, batchSize: SCORING_BATCH_SIZE },
    `Scoring ${candidates.length} rules in ${totalBatches} batches`);

  for (let i = 0; i < candidates.length; i += SCORING_BATCH_SIZE) {
    const batch = candidates.slice(i, i + SCORING_BATCH_SIZE);
    const batchNum = Math.floor(i / SCORING_BATCH_SIZE) + 1;

    // Broadcast scoring progress
    broadcastEvent({
      id: randomUUID(),
      type: 'pipeline.progress',
      data: {
        sourceId: context?.sourceId,
        sourceName: context?.sourceName ?? sourceName,
        step: 4,
        stepName: `Scoring rules`,
        candidateRules: candidates.length,
        batch: batchNum,
        totalBatches,
        percentComplete: Math.round((batchNum / totalBatches) * 100),
      },
      jurisdiction,
    });

    const result = await scoreBatchWithRetry(batch, sourceName, jurisdiction, provider, model, batchNum, totalBatches);

    allAccepted.push(...result.accepted);
    allRejected.push(...result.rejected);
    totalTokensIn += result.tokensIn;
    totalTokensOut += result.tokensOut;
    if (result.score > 0) {
      scoreSum += result.score;
      scoredBatches++;
    }

    // Delay between batches
    if (i + SCORING_BATCH_SIZE < candidates.length) {
      await new Promise((r) => setTimeout(r, SCORING_BATCH_DELAY));
    }
  }

  const overallScore = scoredBatches > 0 ? Math.round(scoreSum / scoredBatches) : 7;

  logger.info({
    accepted: allAccepted.length,
    rejected: allRejected.length,
    overallScore,
    totalTokensIn,
    totalTokensOut,
    batches: totalBatches,
  }, `Rule scoring complete: ${allAccepted.length} accepted, ${allRejected.length} rejected`);

  return {
    rules: allAccepted,
    overallScore,
    rejected: allRejected,
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
  };
}

/**
 * Score a batch with retry logic. Retries up to MAX_RETRIES times with
 * exponential backoff. On final failure, accepts all rules in the batch
 * (the extraction already validated them — scoring is a quality pass, not a gate).
 */
async function scoreBatchWithRetry(
  batch: CandidateRule[],
  sourceName: string,
  jurisdiction: string,
  provider: { generate: (system: string, user: string, model: string) => Promise<{ content: string; tokensIn: number; tokensOut: number }> },
  model: string,
  batchNum: number,
  totalBatches: number,
): Promise<{
  accepted: CandidateRule[];
  rejected: string[];
  score: number;
  tokensIn: number;
  tokensOut: number;
}> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await scoreBatch(batch, sourceName, jurisdiction, provider, model, batchNum, totalBatches);
    } catch (err) {
      const msg = (err as Error).message;
      logger.warn({ batch: batchNum, attempt, maxRetries: MAX_RETRIES, error: msg },
        `Score batch ${batchNum} attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`);

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.info({ batch: batchNum, retryIn: delay }, `Retrying batch ${batchNum} in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // All retries exhausted — accept batch without scoring rather than losing the rules.
  // The extraction LLM already validated these are real requirements.
  // Scoring is a quality refinement pass, not a safety gate.
  logger.error({ batch: batchNum, totalBatches, rulesInBatch: batch.length },
    `Score batch ${batchNum} failed after ${MAX_RETRIES} retries — accepting all rules (extraction already validated them)`);
  return { accepted: batch, rejected: [], score: 0, tokensIn: 0, tokensOut: 0 };
}

/**
 * Score a single batch of rules. Returns accepted rules and rejected keys.
 * Throws on timeout/error so the retry wrapper can handle it.
 */
async function scoreBatch(
  batch: CandidateRule[],
  sourceName: string,
  jurisdiction: string,
  provider: { generate: (system: string, user: string, model: string) => Promise<{ content: string; tokensIn: number; tokensOut: number }> },
  model: string,
  batchNum: number,
  totalBatches: number,
): Promise<{
  accepted: CandidateRule[];
  rejected: string[];
  score: number;
  tokensIn: number;
  tokensOut: number;
}> {
  // Build compact rule summary for scoring (minimize tokens)
  const rulesForScoring = batch.map((r) => ({
    ruleKey: r.ruleKey,
    effect: r.effect,
    severity: r.severity,
    ref: r.legalReference,
    summary: r.humanSummary.slice(0, 150),
  }));

  const userMessage = `Source: ${sourceName} (${jurisdiction})\nBatch ${batchNum}/${totalBatches}\n\nRules to review (${batch.length}):\n${JSON.stringify(rulesForScoring, null, 1)}`;

  // 60-second timeout per attempt
  const response = await Promise.race([
    provider.generate(SCORE_PROMPT, userMessage, model),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Scoring batch timeout (60s)')), SCORING_TIMEOUT_MS)
    ),
  ]);

  // Parse JSON — throw on invalid so retry kicks in
  const jsonStr = response.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  let scoreData: {
    overallScore?: number;
    reject?: string[];
    adjustments?: Array<{ ruleKey: string; field: string; to: string }>;
  };

  try {
    scoreData = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Invalid JSON from scorer: ${jsonStr.slice(0, 100)}`);
  }

  const rejectSet = new Set(scoreData.reject ?? []);

  // Apply adjustments to surviving rules
  const adjustments = scoreData.adjustments ?? [];
  const adjustMap = new Map(adjustments.map((a) => [a.ruleKey, a]));

  const accepted = batch
    .filter((r) => !rejectSet.has(r.ruleKey))
    .map((r) => {
      const adj = adjustMap.get(r.ruleKey);
      if (adj) {
        if (adj.field === 'severity') r.severity = adj.to;
        if (adj.field === 'effect') r.effect = adj.to;
      }
      return r;
    });

  logger.info({
    batch: batchNum,
    totalBatches,
    accepted: accepted.length,
    rejected: rejectSet.size,
    adjusted: adjustments.length,
    score: scoreData.overallScore,
  }, `Scoring batch ${batchNum}/${totalBatches}: ${accepted.length} accepted, ${rejectSet.size} rejected`);

  return {
    accepted,
    rejected: Array.from(rejectSet),
    score: scoreData.overallScore ?? 7,
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
  };
}

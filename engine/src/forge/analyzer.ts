/**
 * Pre-Commit Analyzer
 *
 * Runs before any rules touch the database. All checks are local — zero LLM cost.
 * Catches duplicates, garbage, hallucinated references, and bloat.
 *
 * Four layers of defense:
 *   1. Hash dedup — exact ruleKey match against existing DB
 *   2. Semantic dedup — Jaccard similarity on humanSummary + legalReference
 *   3. Garbage detection — too short, missing refs, empty conditions
 *   4. Bloat prevention — flag if a single doc would insert too many rules
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { policyRules } from '../db/schema.js';
import { logger } from '../logger.js';
import type { AnalyzerRule, CommitDecision } from './types.js';

// ─── Constants ───────────────────────────────────────────────

/** Jaccard similarity threshold — above this, rules are considered duplicates */
const SIMILARITY_THRESHOLD = 0.85;

/** Maximum rules from a single document before flagging for review */
const MAX_RULES_PER_DOC = 500;

/** Minimum length for humanSummary to be considered valid */
const MIN_SUMMARY_LENGTH = 20;

/** Minimum length for legalReference to be considered valid */
const MIN_REFERENCE_LENGTH = 3;

/** Patterns that indicate a real legal reference */
const LEGAL_REF_PATTERNS = [
  /article\s+\d/i,
  /section\s+\d/i,
  /§\s*\d/,
  /regulation\s+\d/i,
  /directive\s+\d/i,
  /chapter\s+\d/i,
  /part\s+\d/i,
  /annex\s+[ivxlcdm\d]/i,
  /recital\s+\d/i,
  /rule\s+\d/i,
  /paragraph\s+\d/i,
  /schedule\s+\d/i,
  /title\s+[ivxlcdm\d]/i,
  /\d+\s*cfr\s*\d/i,        // US Code of Federal Regulations
  /\d+\s*u\.?s\.?c/i,       // US Code
  /s\.?\s*\d+/i,            // UK Section numbering
  /a\d{1,2}/i,              // OWASP A01-A10 style
  /0x\d{2}/i,               // OWASP 0x00 style
];

// ─── Utility Functions ───────────────────────────────────────

/**
 * Tokenize text into a set of normalized words.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/**
 * Compute Jaccard similarity between two word sets.
 * Returns 0-1 where 1 means identical.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Check if a legal reference looks real (not hallucinated).
 */
function isValidLegalReference(ref: string): boolean {
  if (!ref || ref.length < MIN_REFERENCE_LENGTH) return false;
  return LEGAL_REF_PATTERNS.some((pattern) => pattern.test(ref));
}

// ─── Main Analyzer ───────────────────────────────────────────

/**
 * Analyze candidate rules before committing to the database.
 * Returns a CommitDecision with approved, duplicate, flagged, and rejected rules.
 *
 * All operations are local — zero LLM cost, runs in milliseconds.
 */
export function analyzeRules(
  candidates: AnalyzerRule[],
  jurisdiction: string,
): CommitDecision {
  const db = getDb();
  const startTime = performance.now();

  const approved: AnalyzerRule[] = [];
  const duplicates: AnalyzerRule[] = [];
  const flagged: AnalyzerRule[] = [];
  const rejected: AnalyzerRule[] = [];

  // Load existing rules for this jurisdiction (for dedup)
  const existingRules = db.select({
    ruleKey: policyRules.ruleKey,
    humanSummary: policyRules.humanSummary,
    legalReference: policyRules.legalReference,
  }).from(policyRules)
    .where(eq(policyRules.jurisdiction, jurisdiction))
    .all();

  // Pre-tokenize existing rules for similarity comparison
  const existingTokens = existingRules.map((r) => ({
    ruleKey: r.ruleKey,
    tokens: tokenize(`${r.humanSummary} ${r.legalReference}`),
  }));

  // Also track within-batch duplicates
  const batchTokens: Array<{ ruleKey: string; tokens: Set<string> }> = [];
  const batchKeys = new Set<string>();

  for (const rule of candidates) {
    let status: 'approved' | 'duplicate' | 'flagged' | 'rejected' = 'approved';
    const reasons: string[] = [];

    // ─── Layer 1: Hash Dedup (exact ruleKey match) ─────────
    const existsInDb = existingRules.some((r) => r.ruleKey === rule.ruleKey);
    if (existsInDb) {
      // Not necessarily rejected — could be an update. But for initial Forge load,
      // we don't want to overwrite existing rules. Flag for review.
      status = 'duplicate';
      reasons.push(`ruleKey already exists in DB: ${rule.ruleKey}`);
    }

    // Within-batch dedup
    if (batchKeys.has(rule.ruleKey)) {
      status = 'duplicate';
      reasons.push(`Duplicate ruleKey within batch: ${rule.ruleKey}`);
    }

    // ─── Layer 2: Semantic Dedup (Jaccard similarity) ──────
    if (status === 'approved') {
      const candidateTokens = tokenize(`${rule.humanSummary} ${rule.legalReference}`);

      // Check against existing DB rules
      for (const existing of existingTokens) {
        const similarity = jaccardSimilarity(candidateTokens, existing.tokens);
        if (similarity >= SIMILARITY_THRESHOLD) {
          status = 'duplicate';
          reasons.push(
            `Semantically similar to existing rule ${existing.ruleKey} ` +
            `(Jaccard: ${(similarity * 100).toFixed(1)}%)`,
          );
          break;
        }
      }

      // Check against other candidates in this batch
      if (status === 'approved') {
        for (const batch of batchTokens) {
          const similarity = jaccardSimilarity(candidateTokens, batch.tokens);
          if (similarity >= SIMILARITY_THRESHOLD) {
            status = 'duplicate';
            reasons.push(
              `Semantically similar to batch rule ${batch.ruleKey} ` +
              `(Jaccard: ${(similarity * 100).toFixed(1)}%)`,
            );
            break;
          }
        }
      }

      // Track for within-batch dedup
      batchTokens.push({ ruleKey: rule.ruleKey, tokens: candidateTokens });
    }

    // ─── Layer 3: Garbage Detection ───────────────────────
    if (status === 'approved') {
      // Too short summary
      if (rule.humanSummary.length < MIN_SUMMARY_LENGTH) {
        status = 'rejected';
        reasons.push(`Summary too short (${rule.humanSummary.length} chars, min ${MIN_SUMMARY_LENGTH})`);
      }

      // Missing or invalid legal reference
      if (!isValidLegalReference(rule.legalReference)) {
        if (status !== 'rejected') {
          status = 'flagged';
          reasons.push(`Legal reference may be invalid: "${rule.legalReference}"`);
        }
      }

      // Empty or generic conditions
      const conditionValues = Object.values(rule.conditions).filter(Boolean);
      if (conditionValues.length === 0) {
        if (status !== 'rejected') {
          status = 'flagged';
          reasons.push('No conditions specified');
        }
      }

      // Summary is just a copy of the legal reference (common LLM failure)
      if (rule.humanSummary.toLowerCase().trim() === rule.legalReference.toLowerCase().trim()) {
        status = 'rejected';
        reasons.push('Summary is identical to legal reference');
      }

      // Check for generic/vague summaries
      const vaguePhrases = [
        'this article', 'this section', 'this regulation',
        'see above', 'as mentioned', 'n/a', 'not applicable',
        'general requirement', 'various requirements',
      ];
      const summaryLower = rule.humanSummary.toLowerCase();
      for (const phrase of vaguePhrases) {
        if (summaryLower === phrase || (summaryLower.length < 40 && summaryLower.includes(phrase))) {
          status = 'rejected';
          reasons.push(`Vague/generic summary: "${rule.humanSummary}"`);
          break;
        }
      }
    }

    // ─── Categorize ──────────────────────────────────────
    batchKeys.add(rule.ruleKey);

    if (status === 'approved') approved.push(rule);
    else if (status === 'duplicate') duplicates.push(rule);
    else if (status === 'flagged') flagged.push(rule);
    else rejected.push(rule);

    if (reasons.length > 0 && status !== 'approved') {
      logger.debug({ ruleKey: rule.ruleKey, status, reasons },
        `Analyzer: ${status} — ${rule.ruleKey}`);
    }
  }

  // ─── Layer 4: Bloat Prevention ──────────────────────────
  if (approved.length > MAX_RULES_PER_DOC) {
    logger.warn({
      jurisdiction,
      approved: approved.length,
      threshold: MAX_RULES_PER_DOC,
    }, `Bloat warning: ${approved.length} approved rules exceeds threshold — flagging excess for review`);

    // Move excess rules to flagged
    const excess = approved.splice(MAX_RULES_PER_DOC);
    flagged.push(...excess);
  }

  const decision: CommitDecision = {
    approved,
    duplicates,
    flagged,
    rejected,
    stats: {
      total: candidates.length,
      approved: approved.length,
      duplicates: duplicates.length,
      flagged: flagged.length,
      rejected: rejected.length,
    },
  };

  const durationMs = Math.round(performance.now() - startTime);
  logger.info({
    jurisdiction,
    ...decision.stats,
    durationMs,
  }, `Analyzer: ${decision.stats.approved}/${decision.stats.total} approved ` +
    `(${decision.stats.duplicates} dup, ${decision.stats.flagged} flagged, ${decision.stats.rejected} rejected) ` +
    `in ${durationMs}ms`);

  return decision;
}

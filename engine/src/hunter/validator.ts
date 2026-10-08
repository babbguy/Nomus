import { resolveProvider } from '../llm/provider.js';
import type { TranslatedRule } from './translator.js';
import type { ExtractedRequirement } from './bulk-extractor.js';
import { logger } from '../logger.js';

export interface ValidationResult {
  score: number;           // 1-10
  missing: string[];       // source requirements not covered by rules
  errors: string[];        // rules that seem wrong
  notes: string;
  tokensIn: number;
  tokensOut: number;
}

const VALIDATE_PROMPT = `You are a regulatory compliance quality auditor.

Compare the generated policy rules against the source requirements they were derived from.

Score 1-10 on:
- COMPLETENESS: Are all source requirements covered by at least one rule? (most important)
- ACCURACY: Are the effects (deny, allow_with_audit, require_disclosure, flag) correct for each rule?
- SPECIFICITY: Are the conditions precise enough to be actionable?

Output JSON:
{"score": N, "missing": ["requirement X from Article Y not covered"], "errors": ["rule Z has wrong effect"], "notes": "overall assessment"}

Output ONLY the JSON object.`;

/**
 * Stage 5b: Validate translated rules against source requirements.
 * Uses Haiku as a critic — cheap quality gate.
 */
export async function validateRules(
  rules: TranslatedRule[],
  sourceRequirements: ExtractedRequirement[],
): Promise<ValidationResult> {
  const { provider, model } = await resolveProvider('classifier');

  // Build comparison input
  const rulesJson = JSON.stringify(rules.map((r) => ({
    ruleKey: r.ruleKey,
    effect: r.effect,
    severity: r.severity,
    summary: r.humanSummary,
    ref: r.legalReference,
  })), null, 1);

  const reqsJson = JSON.stringify(sourceRequirements.map((r) => ({
    ref: r.ref,
    type: r.type,
    what: r.what,
    severity: r.severity,
  })), null, 1);

  const userMessage = `SOURCE REQUIREMENTS (${sourceRequirements.length} items):\n${reqsJson}\n\nGENERATED RULES (${rules.length} items):\n${rulesJson}`;

  // If input is too large, truncate requirements (keep first 50 + last 10 for coverage)
  let finalMessage = userMessage;
  if (finalMessage.length > 60000) {
    const truncReqs = [...sourceRequirements.slice(0, 50), ...sourceRequirements.slice(-10)];
    const truncJson = JSON.stringify(truncReqs.map((r) => ({ ref: r.ref, type: r.type, what: r.what.slice(0, 100) })), null, 1);
    finalMessage = `SOURCE REQUIREMENTS (${truncReqs.length} of ${sourceRequirements.length} sampled):\n${truncJson}\n\nGENERATED RULES (${rules.length} items):\n${rulesJson}`;
  }

  const response = await provider.generate(VALIDATE_PROMPT, finalMessage, model);

  let result: ValidationResult = {
    score: 7,
    missing: [],
    errors: [],
    notes: 'Validation parsing failed — defaulting to acceptable',
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
  };

  try {
    const jsonStr = response.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    result = {
      score: Number(parsed.score) || 7,
      missing: Array.isArray(parsed.missing) ? parsed.missing : [],
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      notes: String(parsed.notes ?? ''),
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
    };
  } catch {
    logger.warn('Validator returned invalid JSON — accepting current rules');
  }

  logger.info({
    score: result.score,
    missing: result.missing.length,
    errors: result.errors.length,
  }, `Validation score: ${result.score}/10`);

  return result;
}

/**
 * Build feedback context from validation for retry prompt injection.
 */
export function buildValidationFeedback(validation: ValidationResult): string {
  if (validation.score >= 8 && validation.missing.length === 0) return '';

  let feedback = '\n\nVALIDATION FEEDBACK — Previous attempt scored ${validation.score}/10. Fix these issues:\n';

  if (validation.missing.length > 0) {
    feedback += '\nMISSING REQUIREMENTS (must add rules for these):\n';
    for (const m of validation.missing.slice(0, 10)) {
      feedback += `- ${m}\n`;
    }
  }

  if (validation.errors.length > 0) {
    feedback += '\nERRORS TO FIX:\n';
    for (const e of validation.errors.slice(0, 5)) {
      feedback += `- ${e}\n`;
    }
  }

  return feedback;
}

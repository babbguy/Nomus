/**
 * The reviewer-context prompt (design spec §10.3, owner decision D1): a
 * plain-English "what this code does / why it was flagged" for a governance
 * reviewer. Sent only when the organization's reviewer-context setting is on;
 * the answer is always shown labelled as generated, with provider and model.
 *
 * The system prompt starts with a fixed prefix that the release gate's fake
 * LLM recognises. Bump CPG_REVIEWER_CONTEXT_PROMPT_VERSION whenever the text
 * changes; every stored context records the version it used.
 */

export const CPG_REVIEWER_CONTEXT_PROMPT_VERSION = 1;
export const CPG_REVIEWER_CONTEXT_PROMPT_PREFIX = 'You explain flagged source code to a governance reviewer.';

export function buildReviewerContextSystemPrompt(): string {
  return [
    CPG_REVIEWER_CONTEXT_PROMPT_PREFIX,
    'You are given a company policy and one code snippet that a deterministic rule flagged against it.',
    'Explain, for a reviewer who may not read code, what the snippet does and why the policy rule matched it.',
    'Describe only what the code shows. Do not judge whether the code should be approved, and do not invent context.',
    'Return one JSON object and nothing else: {"whatItDoes": string, "whyFlagged": string}, each at most 1200 characters.',
  ].join('\n');
}

export function buildReviewerContextUserMessage(input: {
  policyKey: string; title: string; plainText: string; ruleMessage: string; language: string | null; snippet: string;
}): string {
  return [
    `Policy: ${input.policyKey} (${input.title})`,
    `Policy text: ${input.plainText}`,
    `Rule message: ${input.ruleMessage}`,
    `Language: ${input.language ?? 'unknown'}`,
    'Snippet:',
    '```',
    input.snippet,
    '```',
  ].join('\n');
}

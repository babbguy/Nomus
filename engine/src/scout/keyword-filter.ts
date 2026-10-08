/**
 * Tier 1: Free keyword-based relevance filter.
 * Scores items 0-1 based on keyword density and specificity.
 * Items below the threshold are rejected without any LLM cost.
 */

/** High-weight terms — specific to AI regulation */
const HIGH_WEIGHT_TERMS = [
  'eu ai act',
  'ai act',
  'artificial intelligence act',
  'nist ai',
  'ai risk management',
  'algorithmic accountability',
  'automated decision',
  'foundation model',
  'general-purpose ai',
  'gpai',
  'high-risk ai',
  'ai governance',
  'ai safety',
  'ai regulation',
  'ai compliance',
  'ai policy',
  'ai oversight',
  'ai transparency',
  'ai audit',
  'ai liability',
  'ai ethics',
  'aida',
  'c-27',
  'executive order 14110',
  'ai executive order',
  'digital services act',
  'digital markets act',
  'ai bill of rights',
  'ai standards',
  'machine learning regulation',
  'algorithmic regulation',
  'algorithmic transparency',
  'ai impact assessment',
  'conformity assessment',
  'ai sandbox',
  'regulatory sandbox',
];

/** Medium-weight terms — regulatory context */
const MEDIUM_WEIGHT_TERMS = [
  'artificial intelligence',
  'machine learning',
  'facial recognition',
  'biometric',
  'deepfake',
  'synthetic media',
  'data protection',
  'gdpr',
  'compliance',
  'regulation',
  'legislation',
  'proposed bill',
  'enacted',
  'amended',
  'mandate',
  'prohibition',
  'directive',
  'framework',
  'public consultation',
  'notice of proposed rulemaking',
  'standards body',
  'iso 42001',
  'ieee',
];

/** Low-weight terms — very broad, only count if combined with others */
const LOW_WEIGHT_TERMS = [
  'algorithm',
  'automation',
  'transparency',
  'accountability',
  'risk assessment',
  'tech policy',
  'digital regulation',
  'data governance',
  'privacy',
  'surveillance',
  'chatbot',
  'large language model',
  'generative ai',
  'llm',
];

const HIGH_WEIGHT = 0.15;
const MEDIUM_WEIGHT = 0.08;
const LOW_WEIGHT = 0.03;

/**
 * Score an item's relevance to AI regulation based on keyword matching.
 * Returns 0-1 (capped). Higher = more relevant.
 */
export function scoreKeywords(title: string, snippet: string): number {
  const text = `${title} ${snippet}`.toLowerCase();
  let score = 0;

  // Title matches get a 2x bonus
  const titleLower = title.toLowerCase();

  for (const term of HIGH_WEIGHT_TERMS) {
    if (text.includes(term)) {
      score += HIGH_WEIGHT;
      if (titleLower.includes(term)) score += HIGH_WEIGHT; // title bonus
    }
  }

  for (const term of MEDIUM_WEIGHT_TERMS) {
    if (text.includes(term)) {
      score += MEDIUM_WEIGHT;
      if (titleLower.includes(term)) score += MEDIUM_WEIGHT;
    }
  }

  for (const term of LOW_WEIGHT_TERMS) {
    if (text.includes(term)) {
      score += LOW_WEIGHT;
    }
  }

  return Math.min(score, 1);
}

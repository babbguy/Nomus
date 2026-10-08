import { logger } from '../logger.js';

export interface DocumentQuality {
  structureScore: number;   // 0-1: heading density, HTML tag quality
  textScore: number;        // 0-1: dictionary word ratio, encoding health
  overallGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  issues: string[];
  headingCount: number;
  wordCount: number;
  estimatedTokens: number;
}

// Common English words for text quality detection (top 500 — covers ~80% of English text)
const COMMON_WORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i', 'it', 'for', 'not', 'on',
  'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his', 'by', 'from', 'they', 'we',
  'say', 'her', 'she', 'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their',
  'what', 'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when',
  'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take', 'people', 'into',
  'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other', 'than', 'then', 'now',
  'look', 'only', 'come', 'its', 'over', 'think', 'also', 'back', 'after', 'use', 'two',
  'how', 'our', 'work', 'first', 'well', 'way', 'even', 'new', 'want', 'because', 'any',
  'these', 'give', 'day', 'most', 'us', 'shall', 'must', 'may', 'such', 'should', 'each',
  'where', 'under', 'article', 'section', 'paragraph', 'regulation', 'law', 'act', 'member',
  'state', 'states', 'commission', 'authority', 'system', 'systems', 'data', 'risk', 'high',
  'provide', 'provider', 'providers', 'person', 'persons', 'information', 'requirements',
  'required', 'national', 'public', 'accordance', 'pursuant', 'referred', 'ensure', 'without',
  'including', 'applicable', 'measures', 'assessment', 'purpose', 'market', 'body', 'bodies',
  'decision', 'set', 'within', 'point', 'based', 'part', 'union', 'european', 'parliament',
  'council', 'artificial', 'intelligence', 'model', 'models', 'general', 'purpose', 'rights',
  'fundamental', 'safety', 'security', 'transparency', 'human', 'oversight', 'compliance',
  'obligation', 'obligations', 'penalty', 'penalties', 'enforcement', 'effective', 'date',
  'has', 'had', 'been', 'are', 'was', 'were', 'is', 'being', 'does', 'did', 'doing',
  'more', 'between', 'through', 'during', 'before', 'after', 'above', 'below', 'both',
  'same', 'different', 'those', 'own', 'off', 'while', 'against', 'further', 'once',
  'here', 'why', 'whether', 'much', 'still', 'however', 'therefore', 'shall', 'order',
  'upon', 'respect', 'case', 'cases', 'necessary', 'appropriate', 'relevant', 'specific',
  'particular', 'significant', 'level', 'management', 'monitor', 'monitoring', 'report',
  'reporting', 'process', 'processing', 'technical', 'documentation', 'product', 'service',
  // Legal/regulatory vocabulary — common across jurisdictions
  'controller', 'processor', 'consent', 'lawful', 'legitimate', 'proportionate',
  'notification', 'breach', 'supervisory', 'designation', 'delegated', 'implementing',
  'directive', 'regulation', 'recital', 'annex', 'chapter', 'title', 'preamble',
  'prohibition', 'prohibited', 'restriction', 'restricted', 'exemption', 'derogation',
  'infringement', 'sanction', 'administrative', 'judicial', 'remedy', 'compensation',
  'liability', 'damages', 'fine', 'fines', 'certification', 'conformity', 'notified',
  'market', 'surveillance', 'placing', 'withdrawal', 'recall', 'operator', 'operators',
  'deployer', 'deployers', 'importer', 'importers', 'distributor', 'distributors',
  'manufacturer', 'representative', 'authorized', 'competent', 'designated', 'authority',
  'registration', 'registry', 'database', 'establish', 'established', 'establishing',
  'protect', 'protection', 'privacy', 'confidential', 'confidentiality', 'integrity',
  'availability', 'resilience', 'incident', 'response', 'recovery', 'continuity',
  'audit', 'review', 'inspection', 'investigation', 'cooperation', 'mutual',
  'cross-border', 'jurisdiction', 'territorial', 'scope', 'applies', 'application',
  'third', 'country', 'transfer', 'adequate', 'adequacy', 'safeguard', 'safeguards',
  'binding', 'corporate', 'standard', 'standards', 'contractual', 'clauses',
  'legitimate', 'interest', 'interests', 'balance', 'proportionality', 'subsidiarity',
  'transparency', 'accountability', 'fairness', 'non-discrimination', 'explainability',
  'automated', 'profiling', 'decision-making', 'high-risk', 'prohibited', 'general-purpose',
  'foundation', 'systemic', 'biometric', 'sensitive', 'special', 'categories',
  'child', 'children', 'minor', 'vulnerable', 'consumer', 'individual', 'natural',
  'legal', 'entity', 'entities', 'organization', 'undertaking', 'enterprise',
  'healthcare', 'financial', 'education', 'employment', 'critical', 'infrastructure',
  'essential', 'sector', 'sectors', 'covered', 'applies', 'applicable', 'implementation',
  'implement', 'implemented', 'comply', 'compliant', 'non-compliant', 'violation',
  'enforce', 'enforced', 'enforcement', 'power', 'powers', 'duty', 'duties',
  'right', 'rights', 'access', 'rectification', 'erasure', 'restriction', 'portability',
  'object', 'objection', 'withdraw', 'withdrawal', 'exercise', 'exercising',
  'record', 'records', 'log', 'logging', 'retain', 'retention', 'deletion', 'destroy',
]);

// Garbage/encoding detection patterns
const GARBAGE_PATTERNS = [
  /[\x00-\x08\x0E-\x1F]/,           // control characters
  /\uFFFD{2,}/,                       // replacement characters
  /[\u0080-\u009F]{3,}/,             // C1 control characters (mojibake)
  /[^\x20-\x7E\n\r\t\u00A0-\uFFFF]{5,}/, // long non-printable runs
];

/**
 * Score document quality to determine the optimal processing pipeline.
 * Free, local, no LLM calls. Runs in <10ms.
 */
export function scoreDocumentQuality(
  content: string,
  rawHtml?: string,
): DocumentQuality {
  const issues: string[] = [];

  // ─── Structure Score ──────────────────────────────────────────
  let structureScore = 0;
  let headingCount = 0;

  if (rawHtml) {
    // Count HTML heading elements
    const h1Count = (rawHtml.match(/<h1[\s>]/gi) ?? []).length;
    const h2Count = (rawHtml.match(/<h2[\s>]/gi) ?? []).length;
    const h3Count = (rawHtml.match(/<h3[\s>]/gi) ?? []).length;
    const h4Count = (rawHtml.match(/<h4[\s>]/gi) ?? []).length;
    const sectionCount = (rawHtml.match(/<section[\s>]/gi) ?? []).length;
    const articleCount = (rawHtml.match(/<article[\s>]/gi) ?? []).length;
    const tableCount = (rawHtml.match(/<table[\s>]/gi) ?? []).length;
    const listCount = (rawHtml.match(/<[ou]l[\s>]/gi) ?? []).length;

    headingCount = h1Count + h2Count + h3Count + h4Count;
    const structuralElements = headingCount + sectionCount + articleCount + tableCount + listCount;

    // Rich structure: lots of headings relative to content size
    const paragraphCount = (rawHtml.match(/<p[\s>]/gi) ?? []).length || 1;
    const headingDensity = headingCount / paragraphCount;

    if (headingDensity > 0.1 && headingCount > 5) structureScore = 1.0;
    else if (headingDensity > 0.05 && headingCount > 3) structureScore = 0.8;
    else if (structuralElements > 5) structureScore = 0.6;
    else if (structuralElements > 0) structureScore = 0.3;
    else structureScore = 0.1;
  } else {
    // No raw HTML — check plain text for markdown-like structure
    // parseHtml produces markdown headings (# / ## / ### / ####), so this is the primary path
    const markdownHeadings = (content.match(/^#{1,5}\s/gm) ?? []).length;
    const allCapsLines = (content.match(/^[A-Z][A-Z\s]{10,}$/gm) ?? []).length;
    const articleRefs = (content.match(/^(?:#{1,5}\s+)?(?:Article|Section|Chapter|Title|Recital|Annex)\s+\d/gim) ?? []).length;
    headingCount = markdownHeadings + allCapsLines;

    if (headingCount > 20 || articleRefs > 10) structureScore = 1.0;
    else if (headingCount > 10 || articleRefs > 5) structureScore = 0.8;
    else if (headingCount > 3) structureScore = 0.6;
    else if (headingCount > 0) structureScore = 0.3;
    else {
      structureScore = 0.1;
      issues.push('No heading structure detected');
    }
  }

  // ─── Text Quality Score ───────────────────────────────────────
  const words = content.split(/\s+/).filter((w) => w.length > 1);
  const wordCount = words.length;

  if (wordCount < 50) {
    return {
      structureScore: 0, textScore: 0, overallGrade: 'F',
      issues: ['Content too short for analysis'],
      headingCount, wordCount, estimatedTokens: Math.ceil(content.length / 3.5),
    };
  }

  // Sample words for quality check (check every 3rd word for speed on large docs)
  const sampleSize = Math.min(words.length, 1000);
  const step = Math.max(1, Math.floor(words.length / sampleSize));
  let recognizedCount = 0;
  let totalSampled = 0;

  for (let i = 0; i < words.length; i += step) {
    const word = words[i].toLowerCase().replace(/[^a-z]/g, '');
    if (word.length < 2) continue;
    totalSampled++;
    if (COMMON_WORDS.has(word) || word.length <= 3) {
      recognizedCount++;
    }
  }

  const dictionaryScore = totalSampled > 0 ? recognizedCount / totalSampled : 0;

  // Word-shape score: the share of tokens that are natural-language words
  // (letters in any script, optionally joined by an apostrophe or hyphen),
  // ignoring numbers and citations like "42/5)" or "(a)". The dictionary above
  // holds ~500 EU-flavoured terms, so clean statutes with ordinary vocabulary
  // ("employer", "applicant", "interview") or in another language scored
  // grade D and were rejected; garbage (binary, mojibake, base64, OCR merges)
  // still fails this check.
  let wordLike = 0;
  let shapeSampled = 0;
  for (let i = 0; i < words.length; i += step) {
    const token = words[i].replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
    if (!token || /^[\p{N}\p{P}\p{S}]+$/u.test(token)) continue;
    shapeSampled++;
    if (token.length <= 24 && /^\p{L}+(?:['’-]\p{L}+)*$/u.test(token)) wordLike++;
  }
  const shapeScore = shapeSampled > 0 ? wordLike / shapeSampled : 0;

  const textScore = Math.max(dictionaryScore, shapeScore);

  // Check for garbage patterns
  let garbageDetected = false;
  for (const pattern of GARBAGE_PATTERNS) {
    if (pattern.test(content.slice(0, 5000))) {
      garbageDetected = true;
      issues.push(`Encoding issue detected: ${pattern.source.slice(0, 30)}`);
    }
  }

  // Check for OCR artifacts (words with numbers mixed in, unusual char patterns)
  const ocrArtifacts = (content.match(/\b\w*\d+\w*\b/g) ?? []).length;
  const ocrRatio = ocrArtifacts / Math.max(wordCount, 1);
  if (ocrRatio > 0.1) {
    issues.push(`High OCR artifact ratio: ${(ocrRatio * 100).toFixed(1)}%`);
  }

  // Average word length check (OCR merges produce very long "words")
  const avgWordLen = words.reduce((s, w) => s + w.length, 0) / Math.max(words.length, 1);
  if (avgWordLen > 12) {
    issues.push(`Abnormal average word length: ${avgWordLen.toFixed(1)} (possible OCR merge)`);
  }

  // ─── Overall Grade ────────────────────────────────────────────
  let adjustedTextScore = textScore;
  if (garbageDetected) adjustedTextScore *= 0.7;
  if (ocrRatio > 0.15) adjustedTextScore *= 0.8;

  const combined = (structureScore * 0.4) + (adjustedTextScore * 0.6);
  let overallGrade: 'A' | 'B' | 'C' | 'D' | 'F';

  if (combined >= 0.7 && structureScore >= 0.6) overallGrade = 'A';
  else if (combined >= 0.5 && adjustedTextScore >= 0.7) overallGrade = 'B';
  else if (adjustedTextScore >= 0.6) overallGrade = 'C';
  else if (adjustedTextScore >= 0.4) overallGrade = 'D';
  else overallGrade = 'F';

  const result: DocumentQuality = {
    structureScore: Math.round(structureScore * 100) / 100,
    textScore: Math.round(adjustedTextScore * 100) / 100,
    overallGrade,
    issues,
    headingCount,
    wordCount,
    estimatedTokens: Math.ceil(content.length / 3.5),
  };

  logger.info({
    grade: overallGrade,
    structure: result.structureScore,
    text: result.textScore,
    headings: headingCount,
    words: wordCount,
    tokens: result.estimatedTokens,
    issues: issues.length > 0 ? issues : undefined,
  }, `Document quality: Grade ${overallGrade}`);

  return result;
}

// ─── CAPTCHA / challenge page markers ──────────────────────────
const CAPTCHA_MARKERS = [
  'cf-browser-verification', 'cf-challenge', 'cf-turnstile',
  'captcha', 'recaptcha', 'hcaptcha', 'g-recaptcha',
  'challenge-form', 'challenge-running', 'please verify you are a human',
  'checking your browser', 'just a moment', 'enable javascript and cookies',
  'attention required', 'cloudflare', 'ddos protection',
];

const PAYWALL_MARKERS = [
  'subscribe to continue', 'sign in to read', 'log in to access',
  'create a free account', 'premium content', 'members only',
  'paywall', 'subscription required', 'register to download',
  'sign up for free', 'unlock this article',
];

const MAINTENANCE_MARKERS = [
  'under maintenance', 'temporarily unavailable', 'scheduled maintenance',
  'be right back', 'down for maintenance', 'service unavailable',
  '503 service', '502 bad gateway', 'site is offline',
];

/**
 * Diagnose WHY a document scored poorly. Returns a single clear,
 * actionable diagnostic string that an admin can act on.
 *
 * No LLM calls — pure pattern matching. Runs in <1ms.
 */
export function diagnoseQualityFailure(content: string, quality: DocumentQuality): string {
  const lowerContent = content.toLowerCase();
  const contentLen = content.length;

  // 1. CAPTCHA / challenge page detection
  const captchaHits = CAPTCHA_MARKERS.filter((m) => lowerContent.includes(m));
  if (captchaHits.length >= 2 || (captchaHits.length >= 1 && quality.wordCount < 200)) {
    return `CAPTCHA detected: Content appears to be a challenge/verification page (markers: ${captchaHits.slice(0, 3).join(', ')})`;
  }

  // 2. Paywall / login wall
  const paywallHits = PAYWALL_MARKERS.filter((m) => lowerContent.includes(m));
  if (paywallHits.length >= 2 || (paywallHits.length >= 1 && quality.wordCount < 300)) {
    return `Paywall/login wall: Content is behind an access gate (markers: ${paywallHits.slice(0, 3).join(', ')})`;
  }

  // 3. Maintenance page
  const maintenanceHits = MAINTENANCE_MARKERS.filter((m) => lowerContent.includes(m));
  if (maintenanceHits.length >= 1) {
    return `Maintenance page: Site appears to be down for maintenance (markers: ${maintenanceHits.slice(0, 2).join(', ')})`;
  }

  // 4. Empty / minimal content
  if (quality.wordCount < 50) {
    return `Empty/minimal content: Only ${quality.wordCount} words extracted — page may not have loaded or content is missing`;
  }

  // 5. Partial load / truncation
  if (quality.wordCount < 200 && quality.wordCount > 50) {
    return `Partial load: Content is only ${quality.wordCount} words, likely truncated or incomplete`;
  }

  // 6. Encoding corruption — check ratio of non-printable / replacement chars
  const replacementCount = (content.match(/\uFFFD/g) ?? []).length;
  const controlCount = (content.match(/[\x00-\x08\x0E-\x1F]/g) ?? []).length;
  const corruptionRatio = (replacementCount + controlCount) / Math.max(contentLen, 1);
  if (corruptionRatio > 0.02) {
    const pct = (corruptionRatio * 100).toFixed(1);
    return `Encoding corruption: ${pct}% of content contains non-printable/replacement characters`;
  }

  // 7. PDF extraction failure — high OCR artifact ratio
  const ocrArtifacts = (content.match(/\b\w*\d+\w*\b/g) ?? []).length;
  const ocrRatio = ocrArtifacts / Math.max(quality.wordCount, 1);
  if (ocrRatio > 0.15) {
    const pct = (ocrRatio * 100).toFixed(0);
    return `PDF extraction failure: Content contains high OCR artifact ratio (${pct}%)`;
  }

  // 8. Excessive non-English / mojibake (C1 control chars)
  const mojibakeCount = (content.match(/[\u0080-\u009F]/g) ?? []).length;
  const mojibakeRatio = mojibakeCount / Math.max(contentLen, 1);
  if (mojibakeRatio > 0.01) {
    const pct = (mojibakeRatio * 100).toFixed(1);
    return `Mojibake/encoding issue: ${pct}% C1 control characters detected — possible charset mismatch`;
  }

  // 9. Very long average word length (OCR merges)
  const words = content.split(/\s+/).filter((w) => w.length > 1);
  const avgLen = words.reduce((s, w) => s + w.length, 0) / Math.max(words.length, 1);
  if (avgLen > 14) {
    return `OCR merge artifacts: Average word length is ${avgLen.toFixed(1)} characters — text extraction likely merged words`;
  }

  // 10. Low text quality but no specific pattern — generic
  if (quality.textScore < 0.4) {
    return `Low text quality: Text score ${(quality.textScore * 100).toFixed(0)}% — content may not be natural language regulatory text`;
  }

  // 11. Low structure score (no headings)
  if (quality.structureScore < 0.2 && quality.textScore >= 0.4) {
    return `Missing document structure: No headings or sections detected — may be a plain text dump or error page`;
  }

  // Fallback
  return `General quality failure: Grade ${quality.overallGrade}, structure=${(quality.structureScore * 100).toFixed(0)}%, text=${(quality.textScore * 100).toFixed(0)}%, issues: ${quality.issues.join('; ') || 'none identified'}`;
}

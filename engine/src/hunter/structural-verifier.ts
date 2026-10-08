/**
 * Structural Verifier — Pipeline Step 3
 * =======================================
 * Performs structural verification of cleaned regulatory text before extraction.
 *
 * Checks:
 *   - Article/section numbering is sequential (no gaps)
 *   - Content length is reasonable for the type of law
 *   - Cross-references between articles resolve
 *   - No truncation (content doesn't end mid-sentence)
 *   - LLM spot-check ONLY on flagged sections (no LLM if structure passes)
 *
 * Pass = verified text ready for extraction.
 * Fail = rejection with specific reasons.
 */

import { logger } from '../logger.js';
import { generateWithFallback } from '../llm/provider.js';
import { calculateCostCents } from '../llm/pricing.js';

// ─── Types ──────────────────────────────────────────────────────

export interface VerificationResult {
  passed: boolean;
  verifiedText: string;
  issues: VerificationIssue[];
  stats: {
    articlesFound: number;
    sectionsFound: number;
    crossRefsFound: number;
    crossRefsResolved: number;
    estimatedCompleteness: number;
  };
  llmSpotCheckUsed: boolean;
  llmSpotCheckResult?: string;
  llmTokensIn: number;
  llmTokensOut: number;
  llmCostCents: number;
}

export interface VerificationIssue {
  type: 'gap' | 'truncation' | 'cross_ref_unresolved' | 'numbering' | 'suspicious_content' | 'too_short';
  severity: 'error' | 'warning';
  description: string;
  location?: string;
}

// ─── Article parsing ────────────────────────────────────────────

interface ParsedRef {
  type: string;      // "Article", "Section", "Chapter", etc.
  number: string;    // "1", "2", "I", "3.2"
  numericValue: number;
  raw: string;       // Full matched text: "Article 1"
  lineIndex: number; // Line position in text
}

const ROMAN_MAP: Record<string, number> = {
  I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10,
  XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15, XVI: 16, XVII: 17, XVIII: 18, XIX: 19, XX: 20,
  XXI: 21, XXII: 22, XXIII: 23, XXIV: 24, XXV: 25, XXX: 30, XL: 40, L: 50,
  LX: 60, LXX: 70, LXXX: 80, XC: 90, C: 100,
};

function romanToNum(roman: string): number {
  return ROMAN_MAP[roman.toUpperCase()] ?? -1;
}

function toNumericValue(num: string): number {
  // Try direct integer
  const n = parseInt(num, 10);
  if (!isNaN(n)) return n;

  // Try roman numeral
  const r = romanToNum(num);
  if (r > 0) return r;

  // Try dotted: "3.2" -> 3.2
  const dotted = parseFloat(num);
  if (!isNaN(dotted)) return dotted;

  return -1;
}

/**
 * Parse the main structural references from the text. These are article-level
 * headings that define the document structure (not inline references).
 */
function parseStructuralRefs(text: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  const lines = text.split('\n');

  // Patterns for structural headings (must be at start of line or after markdown markers)
  const patterns = [
    // "Article 1" or "Art. 1" at start of line or heading
    /^(?:#{1,6}\s+)?(Article|Art\.?)\s+(\d+[a-z]?)\b/i,
    // "Section 1" or "Section 3.2"
    /^(?:#{1,6}\s+)?(Section)\s+(\d+(?:\.\d+)*[a-z]?)\b/i,
    // "Chapter I" or "Chapter 1"
    /^(?:#{1,6}\s+)?(Chapter)\s+([IVXLCDM]+|\d+)\b/i,
    // "Title I" or "Title 1"
    /^(?:#{1,6}\s+)?(Title)\s+([IVXLCDM]+|\d+)\b/i,
    // "Annex I" or "Annex 1"
    /^(?:#{1,6}\s+)?(Annex)\s+([IVXLCDM]+|\d+)\b/i,
    // "Recital 1"
    /^(?:#{1,6}\s+)?(Recital)\s+(\d+)\b/i,
    // "Part 1"
    /^(?:#{1,6}\s+)?(Part)\s+([IVXLCDM]+|\d+)\b/i,
    // "§ 1" or "§1"
    /^(?:#{1,6}\s+)?(§)\s*(\d+[a-z]?)\b/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        const type = match[1] === '§' ? 'Section' : match[1].replace(/\.$/, '');
        const number = match[2];
        const numericValue = toNumericValue(number);
        if (numericValue > 0) {
          refs.push({
            type,
            number,
            numericValue,
            raw: `${type} ${number}`,
            lineIndex: i,
          });
        }
        break; // Only match one pattern per line
      }
    }
  }

  return refs;
}

// ─── Cross-reference detection ──────────────────────────────────

interface CrossRef {
  raw: string;       // "Article 6", "Section 3"
  type: string;      // "Article", "Section"
  number: string;    // "6", "3"
}

/**
 * Find inline cross-references in the text.
 * E.g., "as referred to in Article 6", "pursuant to Section 3".
 */
function findCrossRefs(text: string): CrossRef[] {
  const refs: CrossRef[] = [];
  const seen = new Set<string>();

  const patterns = [
    /(?:referred?\s+to\s+in|pursuant\s+to|under|in\s+accordance\s+with|as\s+(?:defined|set\s+out|described|provided|specified|mentioned)\s+in|within\s+the\s+meaning\s+of|subject\s+to)\s+(Article|Art\.?|Section|Chapter|Annex|Title|Part|Recital|§)\s*(\d+[a-z]?(?:\s*\(\d+\))?)/gi,
    // Direct cross-refs: "Article 6(2)", "Article 6, paragraph 2"
    /(Article|Art\.?|Section|Chapter|Annex|Title|Part|Recital|§)\s*(\d+[a-z]?)(?:\s*\(\d+\)|\s*,\s*paragraph\s+\d+)?/gi,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const type = m[1] === '§' ? 'Section' : m[1].replace(/\.$/, '');
      const number = m[2];
      const key = `${type}:${number}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ raw: `${type} ${number}`, type, number });
      }
    }
  }

  return refs;
}

// ─── Truncation detection ───────────────────────────────────────

function checkTruncation(text: string): VerificationIssue | null {
  const trimmed = text.trimEnd();
  if (!trimmed) return null;

  // Check if text ends mid-sentence (no terminal punctuation)
  const lastChar = trimmed[trimmed.length - 1];
  const terminalPunctuation = new Set(['.', ';', ':', ')', ']', '"', '\u201D', '\u2019']);

  if (!terminalPunctuation.has(lastChar)) {
    // Could be a heading or section marker at the end — check last line
    const lastLine = trimmed.split('\n').pop()?.trim() ?? '';

    // If last line is a heading marker, that's likely truncation
    if (/^#{1,6}\s/.test(lastLine) || /^(Article|Section|Chapter|Part|Title|Annex)\s+\d/i.test(lastLine)) {
      return {
        type: 'truncation',
        severity: 'error',
        description: `Document appears truncated: ends with an article/section heading "${lastLine.slice(0, 60)}" with no content following it.`,
        location: 'end of document',
      };
    }

    // Ends mid-sentence on a word character with no terminal punctuation. This
    // is a completeness failure regardless of how LONG the final line is — a
    // mid-paragraph cutoff often leaves a long final line, which previously
    // went completely undetected. Any mid-sentence end is now a hard error.
    if (lastLine.length > 5 && /\w/.test(lastChar)) {
      return {
        type: 'truncation',
        severity: 'error',
        description: `Document appears truncated: it ends mid-sentence with no terminal punctuation: "…${lastLine.slice(-80)}"`,
        location: 'end of document',
      };
    }
  }

  return null;
}

/**
 * Issue types that represent a COMPLETENESS failure (the stored text is not the
 * whole regulation). These are terminal: the deterministic checks are the
 * authority, and the LLM spot-check may NEVER downgrade them from error to
 * warning. The LLM may only ADD concerns, never clear a completeness failure.
 */
const TERMINAL_COMPLETENESS_TYPES: ReadonlySet<VerificationIssue['type']> = new Set([
  'truncation',
  'gap',
  'too_short',
]);

// ─── Main verifier ──────────────────────────────────────────────

const MIN_WORD_COUNT = 100;

export async function verifyStructure(
  cleanText: string,
  sourceName: string,
  jurisdiction: string,
): Promise<VerificationResult> {
  const issues: VerificationIssue[] = [];
  let llmSpotCheckUsed = false;
  let llmSpotCheckResult: string | undefined;
  let llmTokensIn = 0;
  let llmTokensOut = 0;
  let llmCostCents = 0;

  const wordCount = cleanText.split(/\s+/).filter(Boolean).length;

  // ─── Check 1: Minimum content length ──────────────────────────
  if (wordCount < MIN_WORD_COUNT) {
    issues.push({
      type: 'too_short',
      severity: 'error',
      description: `Document has only ${wordCount} words. Regulatory documents typically contain at least ${MIN_WORD_COUNT} words. This may indicate a failed scrape or partial content.`,
    });
  }

  // ─── Check 2: Parse structural references ─────────────────────
  const structuralRefs = parseStructuralRefs(cleanText);

  // Group by type for sequential checking
  const refsByType = new Map<string, ParsedRef[]>();
  for (const ref of structuralRefs) {
    const key = ref.type.toLowerCase().replace(/art$/, 'article');
    if (!refsByType.has(key)) refsByType.set(key, []);
    refsByType.get(key)!.push(ref);
  }

  let totalArticles = 0;
  let totalSections = 0;

  for (const [type, refs] of refsByType.entries()) {
    if (type === 'article' || type === 'recital') totalArticles += refs.length;
    else if (type === 'section') totalSections += refs.length;
    else totalSections += refs.length;

    // Check sequential numbering
    if (refs.length >= 2) {
      const sorted = [...refs].sort((a, b) => a.numericValue - b.numericValue);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1].numericValue;
        const curr = sorted[i].numericValue;
        const gap = curr - prev;

        // Allow gap of 1 (sequential) or same number (sub-sections under same article)
        if (gap > 1 && Number.isInteger(prev) && Number.isInteger(curr)) {
          // Gap detected
          const missingRange = gap === 2
            ? `${type} ${prev + 1}`
            : `${type} ${prev + 1} through ${type} ${curr - 1}`;

          issues.push({
            type: 'gap',
            severity: gap > 5 ? 'error' : 'warning',
            description: `Sequential gap: found ${type} ${prev} then ${type} ${curr} (missing ${missingRange}).`,
            location: `between ${sorted[i - 1].raw} and ${sorted[i].raw}`,
          });
        }
      }
    }
  }

  // ─── Check 3: Cross-reference resolution ──────────────────────
  const crossRefs = findCrossRefs(cleanText);
  const structuralSet = new Set(structuralRefs.map(r => `${r.type.toLowerCase()}:${r.number}`));
  // Also add Art -> Article mapping
  for (const ref of structuralRefs) {
    if (ref.type.toLowerCase() === 'article') {
      structuralSet.add(`art:${ref.number}`);
    }
  }

  let crossRefsResolved = 0;
  const unresolvedRefs: CrossRef[] = [];

  for (const cr of crossRefs) {
    const lookupKey = `${cr.type.toLowerCase().replace(/art$/, 'article')}:${cr.number}`;
    const altKey = `${cr.type.toLowerCase()}:${cr.number}`;
    if (structuralSet.has(lookupKey) || structuralSet.has(altKey)) {
      crossRefsResolved++;
    } else {
      unresolvedRefs.push(cr);
    }
  }

  // Only flag unresolved cross-refs as issues if they reference article types
  // present in the document (don't flag cross-refs to external laws)
  const presentTypes = new Set(structuralRefs.map(r => r.type.toLowerCase()));
  for (const cr of unresolvedRefs) {
    const crType = cr.type.toLowerCase().replace(/art$/, 'article');
    if (presentTypes.has(crType)) {
      issues.push({
        type: 'cross_ref_unresolved',
        severity: 'warning',
        description: `Cross-reference to "${cr.raw}" could not be resolved in the document.`,
        location: cr.raw,
      });
    }
  }

  // ─── Check 4: Truncation ─────────────────────────────────────
  const truncation = checkTruncation(cleanText);
  if (truncation) {
    issues.push(truncation);
  }

  // ─── Check 5: Suspicious content indicators ──────────────────
  const suspiciousPatterns = [
    { pattern: /cookie|consent\s+to\s+cookies/i, label: 'cookie consent text' },
    { pattern: /sign\s+in|log\s+in|create\s+an?\s+account/i, label: 'login/auth text' },
    { pattern: /subscribe\s+to|newsletter/i, label: 'newsletter/subscribe text' },
    { pattern: /page\s+not\s+found|404|error\s+occurred/i, label: '404/error page' },
    { pattern: /captcha|verify\s+you\s+are\s+human|robot/i, label: 'CAPTCHA/bot check' },
    { pattern: /access\s+denied|forbidden|unauthorized/i, label: 'access denied' },
  ];

  for (const { pattern, label } of suspiciousPatterns) {
    // Only flag if the suspicious text appears in the first 500 chars (likely page chrome)
    // or if the document is very short (likely an error page)
    const first500 = cleanText.slice(0, 500);
    if (pattern.test(first500) || (wordCount < 200 && pattern.test(cleanText))) {
      issues.push({
        type: 'suspicious_content',
        severity: wordCount < 200 ? 'error' : 'warning',
        description: `Suspicious content detected: ${label}. This may not be regulatory text.`,
      });
    }
  }

  // ─── Compute estimated completeness ──────────────────────────
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  let estimatedCompleteness = 1.0;
  if (errors.length > 0) estimatedCompleteness -= 0.3 * errors.length;
  if (warnings.length > 0) estimatedCompleteness -= 0.05 * warnings.length;
  // Unresolved cross-refs reduce completeness
  if (crossRefs.length > 0) {
    const resolveRate = crossRefsResolved / crossRefs.length;
    estimatedCompleteness *= (0.5 + 0.5 * resolveRate);
  }
  estimatedCompleteness = Math.max(0, Math.min(1, estimatedCompleteness));

  // ─── LLM Spot-Check (only if there are errors) ───────────────
  if (errors.length > 0) {
    llmSpotCheckUsed = true;

    const flaggedDescriptions = errors.map(e => `- ${e.type}: ${e.description}`).join('\n');

    // Extract the relevant portions of text for the flagged issues
    const relevantSnippets: string[] = [];
    for (const err of errors) {
      if (err.type === 'truncation') {
        // Last 500 chars
        relevantSnippets.push('END OF DOCUMENT:\n' + cleanText.slice(-500));
      } else if (err.type === 'too_short') {
        // Entire text (it's short anyway)
        relevantSnippets.push('FULL TEXT:\n' + cleanText.slice(0, 2000));
      } else if (err.type === 'gap' && err.location) {
        // Find the text around the gap
        const parts = err.location.match(/between (.+) and (.+)/);
        if (parts) {
          const beforeRef = parts[1];
          const afterRef = parts[2];
          const beforeIdx = cleanText.indexOf(beforeRef);
          const afterIdx = cleanText.indexOf(afterRef);
          if (beforeIdx >= 0 && afterIdx >= 0) {
            relevantSnippets.push(`AROUND GAP (${err.location}):\n` + cleanText.slice(Math.max(0, beforeIdx - 100), afterIdx + 300));
          }
        }
      } else if (err.type === 'suspicious_content') {
        relevantSnippets.push('FIRST 500 CHARS:\n' + cleanText.slice(0, 500));
      }
    }

    const snippetText = relevantSnippets.length > 0
      ? relevantSnippets.join('\n\n---\n\n').slice(0, 4000)
      : cleanText.slice(0, 2000);

    const systemPrompt = `You are a regulatory document verification assistant. You verify whether excerpts from regulatory/legal documents are complete and authentic.
Answer with a JSON object: {"is_real_regulation": boolean, "issues_confirmed": string[], "issues_dismissed": string[], "explanation": string}
- is_real_regulation: true if this appears to be genuine regulatory/legal text
- issues_confirmed: list of issue descriptions that are genuine problems
- issues_dismissed: list of issue descriptions that are false alarms
- explanation: brief explanation of your assessment`;

    const userMessage = `Document: "${sourceName}" (${jurisdiction})

The following structural issues were flagged during verification:
${flaggedDescriptions}

Here are the relevant sections of the document for you to check:

${snippetText}

Are these issues real problems, or false alarms? Is this genuine regulatory text?`;

    try {
      const llmResponse = await generateWithFallback('classifier', systemPrompt, userMessage);
      llmTokensIn = llmResponse.tokensIn;
      llmTokensOut = llmResponse.tokensOut;
      llmCostCents = calculateCostCents(llmResponse.tokensIn, llmResponse.tokensOut, llmResponse.model, llmResponse.provider);

      // Parse LLM response
      let spotCheck: {
        is_real_regulation: boolean;
        issues_confirmed: string[];
        issues_dismissed: string[];
        explanation: string;
      };

      try {
        const jsonMatch = llmResponse.content.match(/\{[\s\S]*\}/);
        spotCheck = jsonMatch ? JSON.parse(jsonMatch[0]) : { is_real_regulation: true, issues_confirmed: [], issues_dismissed: [], explanation: llmResponse.content };
      } catch {
        spotCheck = { is_real_regulation: true, issues_confirmed: [], issues_dismissed: [], explanation: llmResponse.content };
      }

      llmSpotCheckResult = spotCheck.explanation;

      // If LLM says it's not real regulation, keep all errors
      if (!spotCheck.is_real_regulation) {
        issues.push({
          type: 'suspicious_content',
          severity: 'error',
          description: `LLM spot-check confirms this is not genuine regulatory text: ${spotCheck.explanation}`,
        });
      } else {
        // Dismiss false-alarm errors — but ONLY non-completeness ones. A
        // genuine completeness failure (truncation / gap / too_short) is
        // terminal: the deterministic check is the authority and the LLM
        // cannot flip FAIL→PASS by claiming it is a false alarm. This closes
        // the hole where a hallucinated dismissal promoted incomplete text.
        const dismissedSet = new Set(spotCheck.issues_dismissed.map(d => d.toLowerCase().slice(0, 50)));

        for (let i = issues.length - 1; i >= 0; i--) {
          const issue = issues[i];
          if (issue.severity === 'error' && !TERMINAL_COMPLETENESS_TYPES.has(issue.type)) {
            const descLower = issue.description.toLowerCase().slice(0, 50);
            const isDismissed = Array.from(dismissedSet).some(d => descLower.includes(d) || d.includes(descLower));
            if (isDismissed) {
              // Downgrade from error to warning
              issues[i] = { ...issue, severity: 'warning', description: issue.description + ' [LLM: false alarm]' };
            }
          }
        }
      }

      logger.info({
        sourceName,
        isRealRegulation: spotCheck.is_real_regulation,
        confirmed: spotCheck.issues_confirmed.length,
        dismissed: spotCheck.issues_dismissed.length,
        tokensIn: llmTokensIn,
        tokensOut: llmTokensOut,
      }, `Structural verification LLM spot-check completed`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ sourceName, error: errMsg }, 'LLM spot-check failed — keeping original issues');
      llmSpotCheckResult = `LLM spot-check failed: ${errMsg}`;
    }
  }

  // ─── Final pass/fail determination ────────────────────────────
  const remainingErrors = issues.filter(i => i.severity === 'error');
  const passed = remainingErrors.length === 0;

  // Recompute completeness after LLM adjustments
  const finalErrors = issues.filter(i => i.severity === 'error').length;
  const finalWarnings = issues.filter(i => i.severity === 'warning').length;
  let finalCompleteness = 1.0;
  if (finalErrors > 0) finalCompleteness -= 0.3 * finalErrors;
  if (finalWarnings > 0) finalCompleteness -= 0.05 * finalWarnings;
  if (crossRefs.length > 0) {
    finalCompleteness *= (0.5 + 0.5 * (crossRefsResolved / crossRefs.length));
  }
  finalCompleteness = Math.max(0, Math.min(1, finalCompleteness));

  const result: VerificationResult = {
    passed,
    verifiedText: cleanText,
    issues,
    stats: {
      articlesFound: totalArticles,
      sectionsFound: totalSections,
      crossRefsFound: crossRefs.length,
      crossRefsResolved,
      estimatedCompleteness: Math.round(finalCompleteness * 100) / 100,
    },
    llmSpotCheckUsed,
    llmSpotCheckResult,
    llmTokensIn,
    llmTokensOut,
    llmCostCents,
  };

  logger.info({
    sourceName,
    jurisdiction,
    passed,
    issueCount: issues.length,
    errorCount: remainingErrors.length,
    articles: totalArticles,
    sections: totalSections,
    crossRefs: crossRefs.length,
    crossRefsResolved,
    completeness: finalCompleteness,
    llmUsed: llmSpotCheckUsed,
  }, `Structural verification ${passed ? 'PASSED' : 'FAILED'}: ${issues.length} issues (${remainingErrors.length} errors)`);

  return result;
}

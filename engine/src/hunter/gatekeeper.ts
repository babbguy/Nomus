/**
 * Gatekeeper — LLM Quality Gate for Regulation Content
 * =====================================================
 * Inspects scraped regulation content for contamination (page chrome,
 * social buttons, metadata, etc.) and strips it before extraction begins.
 *
 * Regulations are LAW — exact copies only. The Gatekeeper ensures nothing
 * but the actual legal text reaches the extraction pipeline.
 *
 * Cost: ~$0.0015 per call (one Haiku call per source per scrape).
 */

import { createHash } from 'node:crypto';
import { resolveProvider } from '../llm/provider.js';
import { logger } from '../logger.js';

// ─── Types ───────────────────────────────────────────────────────

// 'skipped' = the contamination gate could NOT actually run (LLM error, parse
// failure, or content too short to inspect). Fail-closed labelling: we do not
// stamp content 'verified' when the gate never inspected it. The gate is
// non-load-bearing for what gets promoted, so 'skipped' still passes through —
// it just never claims a verification it did not perform.
export type VerificationStatus = 'verified' | 'cleaned' | 'failed' | 'skipped';

export interface GatekeeperIssue {
  type: 'page_chrome' | 'social_sharing' | 'site_metadata' | 'image_artifact'
    | 'duplicate_content' | 'foreign_preamble' | 'blog_wrapper' | 'pdf_artifact'
    | 'structural_gap' | 'truncation';
  description: string;
  location: 'start' | 'middle' | 'end';
}

export interface GatekeeperResult {
  status: VerificationStatus;
  issues: GatekeeperIssue[];
  strippedContent: string | null;
  strippedBytes: number;
  structureValid: boolean;
  tokensIn: number;
  tokensOut: number;
}

// ─── Constants ───────────────────────────────────────────────────

const SAMPLE_START_CHARS = 1500;
const SAMPLE_MIDDLE_CHARS = 750;
const SAMPLE_END_CHARS = 750;
const MIN_CONTENT_FOR_INSPECTION = 500;
const MAX_STRIP_RATIO = 0.5; // Fail if stripping removes >50%

// ─── System Prompt ───────────────────────────────────────────────

const SYSTEM_PROMPT = `You inspect scraped regulatory text for contamination. Regulations are EXACT LEGAL TEXT — any non-legal content is contamination that must be identified.

You will receive three samples from a scraped regulation: START (first ~2000 chars), MIDDLE (~1000 chars from the center), and END (last ~1000 chars).

Report ONLY contamination you can SEE in the provided samples. Do not guess or infer — only flag what is visibly present.

Contamination types:
- page_chrome: Navigation menus, breadcrumbs, language pickers, login/register links, site headers/footers
- social_sharing: Social media buttons/links (Facebook, Twitter/X, LinkedIn, Share, Print, Email)
- site_metadata: Cookie banners, "About us" text, copyright from wrapper sites (not from the regulation itself), topic tags
- image_artifact: Image references like ![alt](url), [img], or image file paths
- duplicate_content: Same title or heading block repeated 3+ times
- foreign_preamble: Non-English text appearing before the English regulation content
- blog_wrapper: Author bylines, "Published: date", tags/categories from blog platforms hosting the regulation
- pdf_artifact: Excessive whitespace (10+ blank lines), garbled/mojibake text, standalone page numbers between paragraphs

Also verify legal structure:
- starts_with_title: Does START begin with a regulation/law title or official preamble?
- has_legal_structure: Do samples contain articles, sections, chapters, recitals, or numbered provisions?
- proper_ending: Does END contain final provisions, annexes, or formal closing — not a truncated sentence or site footer?

Respond ONLY with valid JSON — no markdown, no explanation:
{"issues":[{"type":"...","description":"...","location":"start|middle|end"}],"structure":{"starts_with_title":true,"has_legal_structure":true,"proper_ending":true}}

If content is clean, return: {"issues":[],"structure":{"starts_with_title":true,"has_legal_structure":true,"proper_ending":true}}`;

// ─── Main Function ───────────────────────────────────────────────

export async function runGatekeeper(
  content: string,
  sourceName: string,
  jurisdiction: string,
): Promise<GatekeeperResult> {
  // Skip for very short content
  if (content.length < MIN_CONTENT_FOR_INSPECTION) {
    logger.info({ sourceName, contentLength: content.length },
      'Gatekeeper: content too short for inspection — gate skipped (not verified)');
    return {
      status: 'skipped',
      issues: [],
      strippedContent: null,
      strippedBytes: 0,
      structureValid: true,
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  // Build content sample
  const sample = buildSample(content);
  const userMessage = `Source: ${sourceName} (${jurisdiction})\n\n--- START ---\n${sample.start}\n\n--- MIDDLE ---\n${sample.middle}\n\n--- END ---\n${sample.end}`;

  let llmResponse;
  try {
    const { provider, model } = await resolveProvider('classifier');
    llmResponse = await provider.generate(SYSTEM_PROMPT, userMessage, model);
  } catch (err) {
    // The gate could not run. Pass through (it is non-load-bearing for promoted
    // text) but record 'skipped' — never claim 'verified' when we did not inspect.
    logger.warn({ sourceName, error: (err as Error).message },
      'Gatekeeper: LLM call failed — gate skipped (not verified)');
    return {
      status: 'skipped',
      issues: [],
      strippedContent: null,
      strippedBytes: 0,
      structureValid: true,
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  // Parse LLM response
  let parsed: {
    issues: Array<{ type: string; description: string; location: string }>;
    structure: { starts_with_title: boolean; has_legal_structure: boolean; proper_ending: boolean };
  };

  try {
    const jsonStr = llmResponse.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed.issues) || !parsed.structure) {
      throw new Error('Invalid response structure');
    }
  } catch (err) {
    logger.warn({ sourceName, response: llmResponse.content.slice(0, 200), error: (err as Error).message },
      'Gatekeeper: failed to parse LLM response — gate skipped (not verified)');
    return {
      status: 'skipped',
      issues: [],
      strippedContent: null,
      strippedBytes: 0,
      structureValid: true,
      tokensIn: llmResponse.tokensIn,
      tokensOut: llmResponse.tokensOut,
    };
  }

  const issues: GatekeeperIssue[] = parsed.issues.map((i) => ({
    type: i.type as GatekeeperIssue['type'],
    description: i.description,
    location: i.location as GatekeeperIssue['location'],
  }));

  // has_legal_structure is the critical check — starts_with_title and proper_ending are soft signals
  // (PDFs often end with signature pages/appendices that don't look like "final provisions")
  const structureValid = parsed.structure.has_legal_structure;

  // No issues found — content is verified clean
  if (issues.length === 0 && structureValid) {
    logger.info({ sourceName, jurisdiction },
      'Gatekeeper: content verified clean');
    return {
      status: 'verified',
      issues: [],
      strippedContent: null,
      strippedBytes: 0,
      structureValid: true,
      tokensIn: llmResponse.tokensIn,
      tokensOut: llmResponse.tokensOut,
    };
  }

  // Issues found — attempt to strip contamination
  logger.warn({ sourceName, issueCount: issues.length, issues: issues.map((i) => `${i.type}@${i.location}`) },
    `Gatekeeper: ${issues.length} contamination issues detected — stripping`);

  const originalLength = content.length;
  let cleaned = content;

  for (const issue of issues) {
    cleaned = applyStrip(cleaned, issue);
  }

  cleaned = cleaned.replace(/\n{4,}/g, '\n\n\n').trim();
  const strippedBytes = originalLength - cleaned.length;

  // Safety check: if stripping removed too much, something is fundamentally wrong
  if (strippedBytes > originalLength * MAX_STRIP_RATIO) {
    logger.error({ sourceName, strippedBytes, originalLength, ratio: strippedBytes / originalLength },
      'Gatekeeper: stripping removed >50% of content — failing source');
    return {
      status: 'failed',
      issues,
      strippedContent: null,
      strippedBytes,
      structureValid: false,
      tokensIn: llmResponse.tokensIn,
      tokensOut: llmResponse.tokensOut,
    };
  }

  // If no structure and nothing was stripped, fail
  if (!structureValid && strippedBytes === 0) {
    logger.error({ sourceName, structure: parsed.structure },
      'Gatekeeper: content lacks legal structure and no junk to strip — failing');
    return {
      status: 'failed',
      issues,
      strippedContent: null,
      strippedBytes: 0,
      structureValid: false,
      tokensIn: llmResponse.tokensIn,
      tokensOut: llmResponse.tokensOut,
    };
  }

  return {
    status: 'cleaned',
    issues,
    strippedContent: cleaned,
    strippedBytes,
    structureValid: true,
    tokensIn: llmResponse.tokensIn,
    tokensOut: llmResponse.tokensOut,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

function buildSample(content: string): { start: string; middle: string; end: string } {
  const start = content.slice(0, SAMPLE_START_CHARS);
  const midPoint = Math.floor(content.length * 0.4);
  const middle = content.slice(midPoint, midPoint + SAMPLE_MIDDLE_CHARS);
  const end = content.slice(-SAMPLE_END_CHARS);
  return { start, middle, end };
}

/**
 * Apply deterministic stripping based on LLM-identified issue.
 * Only removes content matching the specific contamination pattern.
 */
function applyStrip(content: string, issue: GatekeeperIssue): string {
  const lines = content.split('\n');

  switch (issue.type) {
    case 'page_chrome': {
      if (issue.location === 'start') {
        // Find first line that looks like regulation content
        const startIdx = lines.findIndex((line) =>
          /^#{1,5}\s/.test(line.trim()) ||
          /^(?:Article|Section|Chapter|Title|Recital|REGULATION|DIRECTIVE|ACT|Part)\s/i.test(line.trim()) ||
          /^(?:THE\s+EUROPEAN|REGULATION\s+\()/i.test(line.trim())
        );
        if (startIdx > 0) return lines.slice(startIdx).join('\n');
      }
      if (issue.location === 'end') {
        // Find last line that looks like regulation content
        for (let i = lines.length - 1; i >= 0; i--) {
          const trimmed = lines[i].trim();
          if (trimmed.length > 20 && !/^[-•]/.test(trimmed) && !/^\s*$/.test(trimmed)) {
            return lines.slice(0, i + 1).join('\n');
          }
        }
      }
      break;
    }

    case 'social_sharing': {
      return lines.filter((line) => {
        const t = line.trim();
        if (/^[-•]\s*(Facebook|Twitter|LinkedIn|Email|Share|Print|X)$/i.test(t)) return false;
        if (/^#{1,5}\s*(Share|Follow us|Connect)/i.test(t)) return false;
        return true;
      }).join('\n');
    }

    case 'image_artifact': {
      return lines.filter((line) => {
        const t = line.trim();
        if (/^!\[.*\]\(.*\)$/.test(t)) return false;
        if (/^\[img\]|\[image\]/i.test(t)) return false;
        return true;
      }).join('\n');
    }

    case 'duplicate_content': {
      // Deduplicate consecutive identical heading blocks
      const seen = new Set<string>();
      return lines.filter((line) => {
        const t = line.trim();
        if (/^#{1,5}\s/.test(t) || /^[A-Z][A-Z\s]{15,}$/.test(t)) {
          if (seen.has(t)) return false;
          seen.add(t);
        }
        return true;
      }).join('\n');
    }

    case 'foreign_preamble': {
      // Find first line that's predominantly ASCII/English
      const startIdx = lines.findIndex((line) => {
        const t = line.trim();
        if (t.length < 10) return false;
        const asciiRatio = (t.match(/[\x20-\x7E]/g)?.length ?? 0) / t.length;
        return asciiRatio > 0.8;
      });
      if (startIdx > 0) return lines.slice(startIdx).join('\n');
      break;
    }

    case 'blog_wrapper': {
      return lines.filter((line) => {
        const t = line.trim();
        if (/^(?:Published|Author|By|Tags|Categories|Posted|Updated)\s*[:—]/i.test(t) && t.length < 100) return false;
        return true;
      }).join('\n');
    }

    case 'pdf_artifact': {
      // Collapse excessive blank line runs
      return content.replace(/\n{5,}/g, '\n\n');
    }

    case 'site_metadata':
    case 'structural_gap':
    case 'truncation':
      // These are informational — logged but not auto-stripped
      break;
  }

  return content;
}

/**
 * Self-Healing Scraper — Automated Content Repair Pipeline
 * =========================================================
 * Runs AFTER a scrape scores D/F on quality. Attempts to fix the content
 * before escalating to manual intervention.
 *
 * Tier 1 — Content Repair (free, instant, no LLM):
 *   - Encoding repair (mojibake, BOM, unicode normalization)
 *   - HTML repair (strip nav/header/footer/scripts/cookie banners)
 *   - OCR artifact repair (merged words, number-letter substitutions)
 *   - Sanitization (CAPTCHA elements, Cloudflare tokens, bot detection)
 *
 * Tier 2 — Alternative Fetch (free, seconds):
 *   - Wayback Machine
 *   - Direct PDF (if selector config has a PDF URL)
 *   (Google Cache tier removed 2026-07-25 — the service was decommissioned
 *   in 2024; the tier could never succeed.)
 *
 * Provenance (G3): alternative fetches return full HTTP provenance of the
 * ALTERNATIVE source (wayback URL, its bytes, its hash) so healed snapshots
 * never carry the failed primary fetch's provenance fields.
 *
 * Rules:
 *   - No infinite loops. Each strategy tried ONCE.
 *   - No LLM calls. All local/free.
 *   - No CAPTCHA solving.
 *   - Total max: 1 repair attempt + 2 alternative fetches = 3 tries, then stop.
 *   - Detailed logging of every attempt and result.
 */

import { createHash } from 'node:crypto';
import { scoreDocumentQuality, type DocumentQuality } from './quality-scorer.js';
import { parseHtml } from './sources/parsers/html-parser.js';
import { logger } from '../logger.js';

// ─── Types ───────────────────────────────────────────────────────

export type HealingStrategy = 'direct' | 'repaired' | 'wayback' | 'pdf_direct';

export interface HealingAttempt {
  strategy: HealingStrategy | string;
  result: 'success' | 'failed' | 'skipped';
  grade: string | null;
  durationMs: number;
  error?: string;
}

/**
 * HTTP provenance of an ALTERNATIVE fetch (wayback/pdf_direct). Null for
 * 'repaired' — repair transforms the original fetch's content, so the
 * original raw provenance remains the true record.
 */
export interface HealedProvenance {
  fetchedUrl: string;
  rawContent: string;
  rawBytesHash: string;
  rawBytesSize: number;
  httpStatus: number;
  contentType: string;
}

export interface HealingResult {
  healed: boolean;
  content: string | null;
  contentHash: string | null;
  wordCount: number;
  grade: string | null;
  strategy: HealingStrategy | null;
  attempts: HealingAttempt[];
  provenance: HealedProvenance | null;
}

interface HealerContext {
  sourceId: string;
  sourceName: string;
  url: string;
  selectorConfig: Record<string, unknown>;
  parserType: 'html' | 'pdf';
}

// ─── Alternative Fetch Timeout ───────────────────────────────────

const ALT_FETCH_TIMEOUT_MS = 10_000;

// ─── Tier 1: Content Repair (free, instant, no LLM) ─────────────

/**
 * Detect charset issues, fix mojibake, strip BOM, normalize unicode.
 */
export function repairEncoding(content: string): string {
  let repaired = content;

  // Strip UTF-8 BOM
  if (repaired.charCodeAt(0) === 0xFEFF) {
    repaired = repaired.slice(1);
  }

  // Replace common mojibake sequences (UTF-8 interpreted as Latin-1)
  const mojibakeMap: Array<[RegExp, string]> = [
    [/Ã¡/g, 'a'], [/Ã©/g, 'e'], [/Ã­/g, 'i'], [/Ã³/g, 'o'], [/Ãº/g, 'u'],
    [/Ã±/g, 'n'], [/Ã¼/g, 'u'], [/Ã¶/g, 'o'], [/Ã¤/g, 'a'], [/Ã«/g, 'e'],
    [/Ã¯/g, 'i'], [/Ã§/g, 'c'], [/Ã¨/g, 'e'], [/Ã¢/g, 'a'], [/Ã´/g, 'o'],
    [/Ã®/g, 'i'], [/Ã»/g, 'u'], [/Ãª/g, 'e'], [/Ã\u0080/g, 'A'],
    [/â€™/g, "'"], [/â€œ/g, '"'], [/â€\u009D/g, '"'], [/â€"/g, '—'],
    [/â€"/g, '–'], [/â€¦/g, '...'], [/Â§/g, '§'], [/Â©/g, '©'],
    [/Â®/g, '®'], [/Â°/g, '°'], [/Â·/g, '·'],
    [/Â /g, ' '], // Non-breaking space mojibake
  ];

  for (const [pattern, replacement] of mojibakeMap) {
    repaired = repaired.replace(pattern, replacement);
  }

  // Remove C1 control characters (U+0080-U+009F) which are mojibake artifacts
  repaired = repaired.replace(/[\u0080-\u009F]/g, '');

  // Remove null bytes and other control characters (except tab, newline, carriage return)
  repaired = repaired.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  // Replace Unicode replacement character runs with a single space
  repaired = repaired.replace(/\uFFFD+/g, ' ');

  // Normalize unicode (NFC form — canonical decomposition + composition)
  repaired = repaired.normalize('NFC');

  // Collapse multiple spaces into one
  repaired = repaired.replace(/  +/g, ' ');

  return repaired;
}

/**
 * Strip non-content HTML elements. Keep only main content area.
 * Uses regex patterns since we're working on extracted text that
 * may still contain HTML fragments.
 */
export function repairHtml(content: string): string {
  let repaired = content;

  // If content looks like raw HTML, do full HTML stripping
  if (repaired.includes('<html') || repaired.includes('<body') || repaired.includes('<!DOCTYPE')) {
    // Remove script and style blocks entirely
    repaired = repaired.replace(/<script[\s\S]*?<\/script>/gi, '');
    repaired = repaired.replace(/<style[\s\S]*?<\/style>/gi, '');
    repaired = repaired.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

    // Remove navigation, header, footer, sidebar elements
    repaired = repaired.replace(/<nav[\s\S]*?<\/nav>/gi, '');
    repaired = repaired.replace(/<header[\s\S]*?<\/header>/gi, '');
    repaired = repaired.replace(/<footer[\s\S]*?<\/footer>/gi, '');
    repaired = repaired.replace(/<aside[\s\S]*?<\/aside>/gi, '');

    // Remove elements with common non-content class/id patterns
    const nonContentPatterns = [
      /cookie/i, /consent/i, /banner/i, /sidebar/i, /navbar/i,
      /menu/i, /breadcrumb/i, /social/i, /share/i, /advertisement/i,
      /popup/i, /modal/i, /overlay/i, /notification/i,
    ];

    for (const pattern of nonContentPatterns) {
      // Remove divs/sections with matching class or id
      const classRegex = new RegExp(
        `<(?:div|section|aside|span)[^>]*(?:class|id)="[^"]*${pattern.source}[^"]*"[^>]*>[\\s\\S]*?<\\/(?:div|section|aside|span)>`,
        'gi',
      );
      repaired = repaired.replace(classRegex, '');
    }

    // Remove all remaining HTML tags to get plain text
    repaired = repaired.replace(/<[^>]+>/g, ' ');

    // Decode common HTML entities
    repaired = repaired
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
      .replace(/&[a-zA-Z]+;/g, ' '); // remaining entities
  }

  // Even for non-HTML content, strip residual fragments
  // Remove inline script/style fragments
  repaired = repaired.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  repaired = repaired.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Remove standalone HTML tags that may have leaked through
  repaired = repaired.replace(/<\/?(?:div|span|p|br|img|a|ul|ol|li|table|tr|td|th|form|input|button|iframe|link|meta)[^>]*>/gi, ' ');

  // Collapse whitespace
  repaired = repaired.replace(/\n{3,}/g, '\n\n');
  repaired = repaired.replace(/  +/g, ' ');
  repaired = repaired.trim();

  return repaired;
}

/**
 * Fix common OCR issues without LLM:
 * - Merged words (insert spaces before uppercase in middle of lowercase)
 * - Number-letter substitutions (0→O, 1→l, 5→S in word context)
 * - Line break artifacts (hyphenated words at line breaks)
 */
export function repairOcrArtifacts(content: string): string {
  let repaired = content;

  // Fix hyphenated line breaks: "regu-\nlation" → "regulation"
  repaired = repaired.replace(/(\w)-\s*\n\s*(\w)/g, '$1$2');

  // Fix merged words: insert space before uppercase letter in middle of lowercase
  // e.g., "theRegulation" → "the Regulation"
  repaired = repaired.replace(/([a-z])([A-Z][a-z])/g, '$1 $2');

  // Fix common OCR number-letter substitutions in word contexts
  // Only fix when surrounded by letters (not in actual numbers)
  repaired = repaired.replace(/\b([a-zA-Z]+)0([a-zA-Z]+)\b/g, '$1o$2'); // 0 → o in words
  repaired = repaired.replace(/\b([a-zA-Z]+)1([a-zA-Z]+)\b/g, '$1l$2'); // 1 → l in words
  repaired = repaired.replace(/\brn\b/g, (match, offset: number) => {
    // "rn" → "m" only when it looks like part of a word
    const before = repaired[offset - 1];
    const after = repaired[offset + 2];
    if (before && /[a-zA-Z]/.test(before) && after && /[a-zA-Z]/.test(after)) {
      return 'm';
    }
    return match;
  });

  // Fix double spaces that OCR creates
  repaired = repaired.replace(/  +/g, ' ');

  // Fix missing spaces after periods (OCR artifact)
  repaired = repaired.replace(/\.([A-Z])/g, '. $1');

  return repaired;
}

/**
 * Remove CAPTCHA/challenge page elements, Cloudflare tokens, bot detection scripts.
 * This works on content that may have CAPTCHA fragments mixed with real content.
 */
export function sanitizeContent(content: string): string {
  let repaired = content;

  // Remove Cloudflare challenge fragments
  const cloudflarePatterns = [
    /cf-browser-verification[^]*/i,
    /Checking your browser before accessing[^.]*\./gi,
    /This process is automatic\. Your browser will redirect[^.]*\./gi,
    /Please allow up to \d+ seconds[^.]*\./gi,
    /DDoS protection by Cloudflare[^.]*\./gi,
    /Ray ID: [a-f0-9]+/gi,
    /Performance & security by Cloudflare/gi,
  ];

  for (const pattern of cloudflarePatterns) {
    repaired = repaired.replace(pattern, '');
  }

  // Remove CAPTCHA-related text
  const captchaPatterns = [
    /Please verify you are a human[^.]*\./gi,
    /Please complete the security check[^.]*\./gi,
    /Why do I have to complete a CAPTCHA\?[^.]*\./gi,
    /I am not a robot/gi,
    /reCAPTCHA[^.]*\./gi,
    /hCaptcha[^.]*\./gi,
  ];

  for (const pattern of captchaPatterns) {
    repaired = repaired.replace(pattern, '');
  }

  // Remove JavaScript-required notices
  repaired = repaired.replace(/(?:Please )?[Ee]nable [Jj]ava[Ss]cript[^.]*\./g, '');
  repaired = repaired.replace(/This site requires JavaScript[^.]*\./gi, '');

  // Remove cookie consent fragments
  repaired = repaired.replace(/(?:We use|This (?:site|website) uses) cookies[^.]*\./gi, '');
  repaired = repaired.replace(/Accept (?:all )?cookies/gi, '');
  repaired = repaired.replace(/Cookie (?:policy|preferences|settings)/gi, '');

  // Collapse resulting whitespace
  repaired = repaired.replace(/\n{3,}/g, '\n\n');
  repaired = repaired.replace(/  +/g, ' ');
  repaired = repaired.trim();

  return repaired;
}

// ─── Tier 2: Alternative Fetch (free, seconds) ──────────────────
// (Google Cache tier removed 2026-07-25 — webcache.googleusercontent.com was
// decommissioned by Google in 2024 and could never return content.)

interface AltFetchResult {
  content: string;
  provenance: HealedProvenance;
}

/**
 * Try fetching from the Wayback Machine (latest snapshot).
 * Returns the extracted content AND the wayback fetch's own HTTP provenance
 * so the healed snapshot records what was actually fetched, from where.
 */
async function fetchFromWaybackMachine(url: string): Promise<AltFetchResult | null> {
  const waybackUrl = `https://web.archive.org/web/2/${url}`;
  try {
    const response = await fetch(waybackUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(ALT_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.debug({ url: waybackUrl, status: response.status }, 'Wayback Machine: not available');
      return null;
    }

    const rawBuffer = Buffer.from(await response.arrayBuffer());
    const html = rawBuffer.toString('utf-8');
    if (html.length < 500) return null;

    // Parse out the Wayback Machine toolbar/banner before extracting
    const content = parseHtml(html, {
      removeSelectors: ['#wm-ipp-base', '#wm-ipp', '.wb-autocomplete-suggestions', '#donato', '#wm-btns'],
    });
    if (content.split(/\s+/).filter(Boolean).length < 100) return null;

    return {
      content,
      provenance: {
        fetchedUrl: response.url,
        rawContent: html,
        rawBytesHash: createHash('sha256').update(rawBuffer).digest('hex'),
        rawBytesSize: rawBuffer.length,
        httpStatus: response.status,
        contentType: response.headers.get('content-type') ?? 'text/html',
      },
    };
  } catch (err) {
    logger.debug({ url: waybackUrl, error: (err as Error).message }, 'Wayback Machine: fetch failed');
    return null;
  }
}

/**
 * Try fetching a direct PDF if the selector config has a known PDF URL.
 */
async function fetchDirectPdf(
  _url: string,
  selectorConfig: Record<string, unknown>,
): Promise<AltFetchResult | null> {
  const pdfUrl = selectorConfig.pdfUrl as string | undefined;
  if (!pdfUrl) return null;

  try {
    const response = await fetch(pdfUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/pdf',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(ALT_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.debug({ url: pdfUrl, status: response.status }, 'Direct PDF: not available');
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const { parsePdf } = await import('./sources/parsers/pdf-parser.js');
    const content = await parsePdf(buffer, selectorConfig);

    if (content.split(/\s+/).filter(Boolean).length < 100) return null;

    return {
      content,
      provenance: {
        fetchedUrl: response.url,
        rawContent: buffer.toString('base64'),
        rawBytesHash: createHash('sha256').update(buffer).digest('hex'),
        rawBytesSize: buffer.length,
        httpStatus: response.status,
        contentType: response.headers.get('content-type') ?? 'application/pdf',
      },
    };
  } catch (err) {
    logger.debug({ url: pdfUrl, error: (err as Error).message }, 'Direct PDF: fetch failed');
    return null;
  }
}

// ─── Quality Check Helper ────────────────────────────────────────

function isAcceptableGrade(grade: DocumentQuality['overallGrade']): boolean {
  return grade === 'A' || grade === 'B';
}

// ─── Main Healing Pipeline ───────────────────────────────────────

/**
 * Run the self-healing pipeline on content that scored D/F.
 *
 * Flow:
 *   1. Tier 1: Try content repair (encoding + HTML + OCR + sanitize)
 *   2. Re-score. If A/B → return repaired content.
 *   3. Tier 2: Try alternative fetches (Wayback, PDF)
 *   4. Each alternative is quality scored. First A/B wins.
 *   5. If all fail → return failure result.
 *
 * Max attempts: 1 repair + 2 alternative fetches = 3 total.
 */
export async function healContent(
  originalContent: string,
  ctx: HealerContext,
): Promise<HealingResult> {
  const attempts: HealingAttempt[] = [];

  logger.info({
    sourceId: ctx.sourceId,
    sourceName: ctx.sourceName,
    url: ctx.url,
    originalWordCount: originalContent.split(/\s+/).filter(Boolean).length,
  }, 'Healing pipeline started');

  // ─── Tier 1: Content Repair ────────────────────────────────────
  const repairStart = performance.now();
  try {
    let repaired = originalContent;

    // Apply all repair stages in sequence
    repaired = repairEncoding(repaired);
    repaired = repairHtml(repaired);
    repaired = repairOcrArtifacts(repaired);
    repaired = sanitizeContent(repaired);

    const quality = scoreDocumentQuality(repaired);
    const durationMs = Math.round(performance.now() - repairStart);

    attempts.push({
      strategy: 'repaired',
      result: isAcceptableGrade(quality.overallGrade) ? 'success' : 'failed',
      grade: quality.overallGrade,
      durationMs,
    });

    if (isAcceptableGrade(quality.overallGrade)) {
      const contentHash = createHash('sha256').update(repaired).digest('hex');
      logger.info({
        sourceId: ctx.sourceId,
        strategy: 'repaired',
        grade: quality.overallGrade,
        durationMs,
      }, 'Healing succeeded via content repair');

      return {
        healed: true,
        content: repaired,
        contentHash,
        wordCount: quality.wordCount,
        grade: quality.overallGrade,
        strategy: 'repaired',
        attempts,
        // Repair transformed the ORIGINAL fetch's content — its raw
        // provenance remains the true record, so no replacement here.
        provenance: null,
      };
    }

    logger.info({
      sourceId: ctx.sourceId,
      grade: quality.overallGrade,
      durationMs,
    }, 'Tier 1 repair did not improve grade sufficiently — trying alternative fetches');
  } catch (err) {
    const durationMs = Math.round(performance.now() - repairStart);
    attempts.push({
      strategy: 'repaired',
      result: 'failed',
      grade: null,
      durationMs,
      error: (err as Error).message,
    });
    logger.warn({ sourceId: ctx.sourceId, error: (err as Error).message }, 'Tier 1 repair threw error');
  }

  // ─── Tier 2: Alternative Fetches ───────────────────────────────

  // 2a. Wayback Machine
  const wbStart = performance.now();
  try {
    const archived = await fetchFromWaybackMachine(ctx.url);
    if (archived) {
      const quality = scoreDocumentQuality(archived.content);
      const durationMs = Math.round(performance.now() - wbStart);

      attempts.push({
        strategy: 'wayback',
        result: isAcceptableGrade(quality.overallGrade) ? 'success' : 'failed',
        grade: quality.overallGrade,
        durationMs,
      });

      if (isAcceptableGrade(quality.overallGrade)) {
        const contentHash = createHash('sha256').update(archived.content).digest('hex');
        logger.info({
          sourceId: ctx.sourceId,
          strategy: 'wayback',
          grade: quality.overallGrade,
          wordCount: quality.wordCount,
          fetchedUrl: archived.provenance.fetchedUrl,
          durationMs,
        }, 'Healing succeeded via Wayback Machine');

        return {
          healed: true,
          content: archived.content,
          contentHash,
          wordCount: quality.wordCount,
          grade: quality.overallGrade,
          strategy: 'wayback',
          attempts,
          provenance: archived.provenance,
        };
      }
    } else {
      const durationMs = Math.round(performance.now() - wbStart);
      attempts.push({
        strategy: 'wayback',
        result: 'failed',
        grade: null,
        durationMs,
        error: 'No content returned',
      });
    }
  } catch (err) {
    const durationMs = Math.round(performance.now() - wbStart);
    attempts.push({
      strategy: 'wayback',
      result: 'failed',
      grade: null,
      durationMs,
      error: (err as Error).message,
    });
  }

  // 2b. Direct PDF
  const pdfStart = performance.now();
  try {
    const pdfResult = await fetchDirectPdf(ctx.url, ctx.selectorConfig);
    if (pdfResult) {
      const quality = scoreDocumentQuality(pdfResult.content);
      const durationMs = Math.round(performance.now() - pdfStart);

      attempts.push({
        strategy: 'pdf_direct',
        result: isAcceptableGrade(quality.overallGrade) ? 'success' : 'failed',
        grade: quality.overallGrade,
        durationMs,
      });

      if (isAcceptableGrade(quality.overallGrade)) {
        const contentHash = createHash('sha256').update(pdfResult.content).digest('hex');
        logger.info({
          sourceId: ctx.sourceId,
          strategy: 'pdf_direct',
          grade: quality.overallGrade,
          wordCount: quality.wordCount,
          fetchedUrl: pdfResult.provenance.fetchedUrl,
          durationMs,
        }, 'Healing succeeded via direct PDF');

        return {
          healed: true,
          content: pdfResult.content,
          contentHash,
          wordCount: quality.wordCount,
          grade: quality.overallGrade,
          strategy: 'pdf_direct',
          attempts,
          provenance: pdfResult.provenance,
        };
      }
    } else {
      const durationMs = Math.round(performance.now() - pdfStart);
      attempts.push({
        strategy: 'pdf_direct',
        result: 'skipped',
        grade: null,
        durationMs,
        error: ctx.selectorConfig.pdfUrl ? 'No content returned' : 'No PDF URL configured',
      });
    }
  } catch (err) {
    const durationMs = Math.round(performance.now() - pdfStart);
    attempts.push({
      strategy: 'pdf_direct',
      result: 'failed',
      grade: null,
      durationMs,
      error: (err as Error).message,
    });
  }

  // ─── All strategies exhausted ──────────────────────────────────
  logger.warn({
    sourceId: ctx.sourceId,
    sourceName: ctx.sourceName,
    attemptCount: attempts.length,
    attempts: attempts.map((a) => `${a.strategy}: ${a.result} (grade=${a.grade ?? 'N/A'}, ${a.durationMs}ms)`),
  }, 'Healing pipeline exhausted — all strategies failed');

  return {
    healed: false,
    content: null,
    contentHash: null,
    wordCount: 0,
    grade: null,
    strategy: null,
    attempts,
    provenance: null,
  };
}

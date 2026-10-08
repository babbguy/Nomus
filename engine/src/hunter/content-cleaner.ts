/**
 * Content Cleaner — Pipeline Step 2
 * ==================================
 * Takes raw scraped HTML/text and outputs pure verbatim regulatory text.
 *
 * The law text is NEVER paraphrased or summarized. Only non-content elements
 * are stripped: HTML tags, navigation, headers, footers, sidebars, scripts,
 * styles, cookie banners, ads, boilerplate. The output is the exact legal
 * text as published, with structural markers preserved.
 */

import { logger } from '../logger.js';
import { normalizeProvenanceMode } from './provenance.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CleanResult {
  cleanText: string;
  wordCount: number;
  articlesFound: string[];
  removedElements: string[];
  warnings: string[];
}

/**
 * Which cleaning profile to apply to a document.
 *
 *   html_scrape — the aggressive profile for content that was SCRAPED from an
 *                 HTML/PDF web page: strips nav/header/footer/aside/scripts/
 *                 cookie-banners/ads/social/images and other page chrome, then
 *                 converts the surviving markup to verbatim text. This is the
 *                 correct, unchanged behaviour for scraped pages.
 *
 *   structured  — the LIGHT profile for content an official-API adapter already
 *                 extracted from an authoritative STRUCTURED artifact (eCFR XML,
 *                 Federal Register XML, EUR-Lex Cellar XHTML, NIST OSCAL JSON,
 *                 legislation.gov.uk CLML XML). That text is byte_exact against
 *                 the government-served body and contains NO page chrome, so the
 *                 HTML-chrome/nav/social/image stripping must NOT run — it would
 *                 risk deleting or mangling legitimate regulatory text (a real
 *                 regulation's recitals/preamble are CONTENT, not chrome).
 *                 Only whitespace/encoding normalization, consecutive-line
 *                 dedupe, and hyphenation rejoin are applied.
 */
export type CleaningProfile = 'html_scrape' | 'structured';

/**
 * Ingestion channels whose content is an already-clean text extraction of an
 * authoritative STRUCTURED artifact (never a scraped web page). Content on these
 * channels receives the LIGHT ('structured') cleaning profile.
 */
const STRUCTURED_CHANNELS = new Set(['official_api', 'bulk']);

/**
 * Decide which cleaning profile a staged document should receive, from the
 * channel/provenance signals carried on the staged row (set by the API-first
 * ingestion work). Structured-artifact content (official-API-derived, byte_exact)
 * gets the LIGHT profile; everything else — including plain byte_exact HTML
 * scrapes (channel unset/`scrape`) — keeps the aggressive HTML/PDF profile.
 *
 * This is the single decision point; the Step 2 call site passes the result
 * into {@link cleanContent}.
 */
export function selectCleaningProfile(signal: {
  ingestionChannel?: string | null;
  provenanceMode?: string | null;
}): CleaningProfile {
  const { ingestionChannel, provenanceMode } = signal;
  if (
    ingestionChannel &&
    STRUCTURED_CHANNELS.has(ingestionChannel) &&
    normalizeProvenanceMode(provenanceMode) === 'byte_exact'
  ) {
    return 'structured';
  }
  return 'html_scrape';
}

// ─── Element removal patterns ───────────────────────────────────

/** Tags whose entire subtree should be removed (content and all). */
const REMOVE_TAGS = new Set([
  'script', 'style', 'noscript', 'iframe', 'svg', 'canvas',
  'nav', 'header', 'footer', 'aside',
  'button', 'input', 'select', 'textarea', 'form',
  'img', 'video', 'audio', 'source', 'picture', 'figure',
  'dialog', 'template',
]);

/**
 * Class/id substrings that indicate non-content elements.
 * Matching is case-insensitive against the full class or id attribute.
 */
const NOISE_PATTERNS = [
  'sidebar', 'side-bar', 'menu', 'navigation', 'nav-',
  'cookie', 'consent', 'gdpr', 'banner',
  'advertisement', 'advert', 'ad-slot', 'ad-container', 'ads-',
  'social', 'share', 'sharing',
  'print-only', 'print-button', 'print-version',
  'breadcrumb', 'bread-crumb',
  'pagination', 'pager',
  'search-form', 'search-box', 'searchbar',
  'toolbar', 'toolbox',
  'newsletter', 'subscribe',
  'popup', 'modal', 'overlay',
  'skip-to', 'skipnav',
  'footer-', 'header-',
  'related-', 'recommended',
  'comment', 'discussion',
  'tooltip',
];

const NOISE_RE = new RegExp(NOISE_PATTERNS.map(p => p.replace(/-/g, '[\\-_]?')).join('|'), 'i');

// ─── Article detection ──────────────────────────────────────────

const ARTICLE_PATTERNS = [
  // EU/UK: "Article 1", "Art. 1", "Recital 1", "Chapter I"
  /\b(Article|Art\.?|Recital|Chapter|Annex|Title|Section|Paragraph|Regulation|Directive)\s+(\d+[a-z]?|[IVXLCDM]+)\b/gi,
  // US: "Section 1", "§ 1", "Part 1"
  /\b(Section|Part)\s+(\d+[a-zA-Z.]*)\b/gi,
  /§\s*(\d+[a-zA-Z.]*)/gi,
  // Numbered: "1.2.3" style at start of line
  /^(\d+(?:\.\d+)+)\s/gm,
];

function extractArticleRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const pattern of ARTICLE_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      refs.add(m[0].trim());
    }
  }
  return Array.from(refs).sort();
}

// ─── HTML cleaning ──────────────────────────────────────────────

/**
 * Decode common HTML entities. Handles both named and numeric entities.
 */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&apos;': "'", '&nbsp;': ' ', '&ndash;': '\u2013', '&mdash;': '\u2014',
    '&lsquo;': '\u2018', '&rsquo;': '\u2019', '&ldquo;': '\u201C', '&rdquo;': '\u201D',
    '&bull;': '\u2022', '&hellip;': '\u2026', '&copy;': '\u00A9', '&reg;': '\u00AE',
    '&sect;': '\u00A7', '&para;': '\u00B6', '&euro;': '\u20AC', '&pound;': '\u00A3',
    '&trade;': '\u2122', '&times;': '\u00D7', '&divide;': '\u00F7',
  };

  let result = text;
  for (const [entity, char] of Object.entries(named)) {
    result = result.split(entity).join(char);
  }

  // Numeric entities: &#123; and &#x1F;
  result = result.replace(/&#(\d+);/g, (_, code) => {
    const n = parseInt(code, 10);
    return n > 0 && n < 0x10FFFF ? String.fromCodePoint(n) : '';
  });
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const n = parseInt(hex, 16);
    return n > 0 && n < 0x10FFFF ? String.fromCodePoint(n) : '';
  });

  return result;
}

/**
 * Check whether a tag block (opening tag string) has a class or id matching noise patterns.
 */
function isNoiseByAttribute(openingTag: string): boolean {
  const classMatch = openingTag.match(/class\s*=\s*["']([^"']*)["']/i);
  const idMatch = openingTag.match(/id\s*=\s*["']([^"']*)["']/i);
  const attrText = (classMatch?.[1] ?? '') + ' ' + (idMatch?.[1] ?? '');
  return NOISE_RE.test(attrText);
}

/**
 * Remove entire tag subtrees for tags in the REMOVE_TAGS set, including their content.
 * Also removes elements whose class/id matches noise patterns.
 */
function removeTagSubtrees(html: string): { cleaned: string; removed: string[] } {
  const removed: string[] = [];
  let result = html;

  // Build pattern for self-closing tags first
  for (const tag of REMOVE_TAGS) {
    const selfClose = new RegExp(`<${tag}\\b[^>]*/\\s*>`, 'gi');
    const matches = result.match(selfClose);
    if (matches && matches.length > 0) {
      removed.push(`${tag} (${matches.length} self-closing)`);
      result = result.replace(selfClose, '');
    }
  }

  // Remove opening+content+closing for known bad tags.
  // Use a non-greedy approach with nesting awareness for common cases.
  for (const tag of REMOVE_TAGS) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
    const matches = result.match(pattern);
    if (matches && matches.length > 0) {
      removed.push(`<${tag}> (${matches.length})`);
      result = result.replace(pattern, '');
    }
  }

  // Remove elements with noise class/id patterns (div, section, span, etc.)
  // This is a best-effort regex approach; not a full DOM parse.
  const noiseTagPattern = /<(div|section|span|ul|ol|p|a|li|table|tr|td|th|dl|dt|dd)\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  const noiseOpeningPositions: Array<{ tag: string; start: number; attrText: string }> = [];

  // Collect noise element positions
  const tempResult = result;
  noiseTagPattern.lastIndex = 0;
  while ((match = noiseTagPattern.exec(tempResult)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    if (isNoiseByAttribute(`<${tag} ${attrs}>`)) {
      noiseOpeningPositions.push({ tag, start: match.index, attrText: attrs });
    }
  }

  // Remove noise elements from end to start to preserve indices
  for (let i = noiseOpeningPositions.length - 1; i >= 0; i--) {
    const { tag, start } = noiseOpeningPositions[i];
    const closingTag = `</${tag}>`;
    const closingIdx = result.indexOf(closingTag, start);
    if (closingIdx !== -1) {
      const before = result.slice(0, start);
      const after = result.slice(closingIdx + closingTag.length);
      result = before + after;
      removed.push(`noise element <${tag}> (class/id match)`);
    }
  }

  return { cleaned: result, removed };
}

/**
 * Convert HTML heading tags to plain text markers preserving hierarchy.
 */
function convertHeadings(html: string): string {
  let result = html;
  result = result.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n');
  result = result.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
  result = result.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n');
  result = result.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n\n');
  result = result.replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, '\n\n##### $1\n\n');
  result = result.replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, '\n\n###### $1\n\n');
  return result;
}

/**
 * Convert structural HTML elements to text with preserved meaning.
 */
function convertStructure(html: string): string {
  let result = html;

  // Table cells: separate with tabs, rows with newlines
  result = result.replace(/<\/td>\s*<td\b[^>]*>/gi, '\t');
  result = result.replace(/<\/th>\s*<th\b[^>]*>/gi, '\t');
  result = result.replace(/<\/tr>/gi, '\n');
  result = result.replace(/<\/?table\b[^>]*>/gi, '\n');
  result = result.replace(/<\/?thead\b[^>]*>/gi, '');
  result = result.replace(/<\/?tbody\b[^>]*>/gi, '');
  result = result.replace(/<\/?tfoot\b[^>]*>/gi, '');

  // Lists: preserve as indented items
  result = result.replace(/<li\b[^>]*>/gi, '\n  - ');
  result = result.replace(/<\/li>/gi, '');
  result = result.replace(/<\/?[ou]l\b[^>]*>/gi, '\n');
  result = result.replace(/<\/?dl\b[^>]*>/gi, '\n');
  result = result.replace(/<dt\b[^>]*>/gi, '\n');
  result = result.replace(/<\/dt>/gi, ': ');
  result = result.replace(/<dd\b[^>]*>/gi, '');
  result = result.replace(/<\/dd>/gi, '\n');

  // Paragraphs and divs: ensure paragraph breaks
  result = result.replace(/<\/p>/gi, '\n\n');
  result = result.replace(/<p\b[^>]*>/gi, '');
  result = result.replace(/<br\s*\/?>/gi, '\n');
  result = result.replace(/<hr\s*\/?>/gi, '\n---\n');
  result = result.replace(/<\/div>/gi, '\n');
  result = result.replace(/<div\b[^>]*>/gi, '');

  // Blockquotes
  result = result.replace(/<blockquote\b[^>]*>/gi, '\n> ');
  result = result.replace(/<\/blockquote>/gi, '\n');

  // Inline elements: just remove tags, keep content
  result = result.replace(/<\/?(?:span|strong|b|em|i|u|s|strike|del|ins|mark|small|sub|sup|a|abbr|cite|code|dfn|kbd|q|samp|var|time|data|ruby|rt|rp|bdi|bdo|wbr)\b[^>]*>/gi, '');

  // Remove all remaining tags
  result = result.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  return result;
}

/**
 * Normalize whitespace: collapse runs of spaces, normalize line breaks,
 * preserve paragraph boundaries (double newlines).
 */
function normalizeWhitespace(text: string): string {
  let result = text;

  // Replace tabs with spaces
  result = result.replace(/\t/g, '    ');

  // Collapse multiple spaces (not newlines) into single space
  result = result.replace(/[^\S\n]+/g, ' ');

  // Collapse 3+ newlines into double newline (paragraph break)
  result = result.replace(/\n{3,}/g, '\n\n');

  // Strip trailing whitespace per line but preserve leading indentation —
  // legal sub-clauses use indentation to indicate hierarchy and we must not
  // flatten it.
  result = result.split('\n').map(line => line.trimEnd()).join('\n');

  // Remove leading/trailing whitespace from entire document
  result = result.trim();

  return result;
}

/**
 * Collapse runs of identical, consecutive non-empty lines down to one. This is
 * the ONLY structural change the light ('structured') profile makes beyond
 * whitespace/encoding normalization — some official artifacts repeat a heading
 * line (e.g. a part title echoed by an enclosing section). It never removes
 * distinct content, only exact adjacent duplicates.
 */
function dedupeConsecutiveLines(text: string): string {
  const out: string[] = [];
  let prev: string | null = null;
  for (const line of text.split('\n')) {
    const key = line.trim();
    if (key !== '' && key === prev) continue; // drop exact adjacent duplicate
    out.push(line);
    prev = key === '' ? null : key;
  }
  return out.join('\n');
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Clean raw content into pure verbatim regulatory text.
 *
 * The cleaning is CHANNEL-APPROPRIATE (see {@link CleaningProfile}):
 *
 *   - 'html_scrape' (default): aggressive profile for SCRAPED pages. For HTML it
 *     strips all non-content chrome (nav/header/footer/aside/scripts/cookie
 *     banners/ads/social/images) and converts surviving markup to text. For PDF
 *     it does light PDF-artifact repair. UNCHANGED behaviour.
 *
 *   - 'structured': LIGHT profile for official-API-derived text (byte_exact from
 *     an adapter). Applies whitespace/encoding normalization, consecutive-line
 *     dedupe, and hyphenation rejoin ONLY — never the HTML-chrome/nav/social/
 *     image stripping, which would damage legitimate regulatory text. The
 *     adapter already produced clean text from the authoritative artifact.
 *
 * Cleaning is ALWAYS a real step — the 'structured' profile makes it appropriate
 * for pre-cleaned official text, it does NOT skip it. Quality scoring (Step 2),
 * structural verification (Step 3), and the promotion gate (Step 5) remain
 * unconditional for all profiles.
 *
 * The output text is the EXACT legal text as published, never paraphrased.
 */
export function cleanContent(
  rawContent: string,
  parserType: 'html' | 'pdf',
  profile: CleaningProfile = 'html_scrape',
): CleanResult {
  const warnings: string[] = [];
  let removedElements: string[] = [];
  let text: string;

  if (profile === 'structured') {
    // LIGHT profile — content is already clean text extracted from an
    // authoritative structured artifact (official-API adapter). Do NOT run the
    // HTML-chrome/nav/social/image stripping: it would delete or mangle
    // legitimate regulatory text (recitals/preambles are CONTENT). Apply only
    // encoding/whitespace normalization, dedupe, and hyphenation rejoin.
    text = rawContent;

    // Encoding normalization: decode any stray entities that survived the
    // adapter's extraction (e.g. &amp; in an XML/JSON text node).
    text = decodeEntities(text);

    // Rejoin hyphenated line breaks (word- \n continuation).
    text = text.replace(/(\w)-\s*\n\s*(\w)/g, '$1$2');

    // Collapse exact adjacent duplicate lines only.
    text = dedupeConsecutiveLines(text);

    // Whitespace normalization (preserves paragraph/indentation structure).
    text = normalizeWhitespace(text);

    removedElements.push('structured: light normalization (no HTML-chrome stripping)');
  } else if (parserType === 'html') {
    // Step 1: Remove entire subtrees of non-content tags
    const { cleaned, removed } = removeTagSubtrees(rawContent);
    removedElements = removed;

    // Step 2: Convert headings to text markers
    text = convertHeadings(cleaned);

    // Step 3: Convert structural elements (tables, lists, paragraphs)
    text = convertStructure(text);

    // Step 4: Decode HTML entities
    text = decodeEntities(text);

    // Step 5: Normalize whitespace
    text = normalizeWhitespace(text);
  } else {
    // PDF: already extracted as text by the PDF parser.
    // Normalize whitespace and structure only.
    text = rawContent;

    // Fix common PDF extraction artifacts
    // Rejoin hyphenated line breaks (word- \n continuation)
    text = text.replace(/(\w)-\s*\n\s*(\w)/g, '$1$2');

    // Normalize whitespace
    text = normalizeWhitespace(text);

    removedElements.push('pdf: whitespace normalized');
  }

  // Detect if the cleaning was too aggressive (removed too much). This warning
  // is specific to the aggressive HTML profile — the light 'structured' profile
  // never strips chrome, so a low retention ratio there would be meaningless.
  if (profile === 'html_scrape' && parserType === 'html') {
    const rawWordCount = rawContent.split(/\s+/).filter(Boolean).length;
    const cleanWordCount = text.split(/\s+/).filter(Boolean).length;
    const retentionRatio = rawWordCount > 0 ? cleanWordCount / rawWordCount : 1;

    if (retentionRatio < 0.05 && rawWordCount > 100) {
      warnings.push(`Very low text retention (${Math.round(retentionRatio * 100)}%). The content selector may need adjustment or the page may be JavaScript-rendered.`);
    }

    if (cleanWordCount < 50 && rawWordCount > 500) {
      warnings.push(`Cleaned text is very short (${cleanWordCount} words from ${rawWordCount} raw words). May need manual review.`);
    }
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const articlesFound = extractArticleRefs(text);

  if (articlesFound.length === 0 && wordCount > 200) {
    warnings.push('No article/section references detected in cleaned text. The document may use an unusual structure.');
  }

  logger.info({
    parserType,
    profile,
    rawLength: rawContent.length,
    cleanLength: text.length,
    wordCount,
    articlesFound: articlesFound.length,
    removedCount: removedElements.length,
    warningCount: warnings.length,
  }, `Content cleaned (${profile}): ${rawContent.length} chars -> ${text.length} chars, ${articlesFound.length} articles found`);

  return {
    cleanText: text,
    wordCount,
    articlesFound,
    removedElements,
    warnings,
  };
}

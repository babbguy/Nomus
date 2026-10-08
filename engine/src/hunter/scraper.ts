/**
 * Self-Healing Regulatory Scraper
 * ================================
 * Fetches regulatory content with automatic fallback chain:
 *
 *   1. Live URL with rotating User-Agents
 *   2. Live URL through configured proxy
 *   3. Local content cache (from previous successful scrape)
 *   4. Escalate with notification
 *
 * Tiered notification system:
 *   Tier 1 (auto-fix, silent): redirects, timeouts, rate limits
 *   Tier 2 (auto-fix, notify): UA rotation, cache fallback, URL changes
 *   Tier 3 (escalate, urgent): all methods exhausted, needs human action
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { logger } from '../logger.js';
import { parseHtml } from './sources/parsers/html-parser.js';
import { parsePdf } from './sources/parsers/pdf-parser.js';
import { getScraperProfile, detectStrategy, detectNavigation, type ScraperProfile } from '../forge/harvester.js';
import { selectAdapter } from './sources/adapters/registry.js';
import type { PointInTimeCoordinate } from './sources/adapters/types.js';
import { fetchHeadless } from './headless-fetch.js';
import type { SelectorConfig } from '@nomus/shared';

// ─── Types ───────────────────────────────────────────────────────

export interface ScrapeResult {
  content: string;
  contentHash: string;
  contentQuality: 'valid' | 'suspicious' | 'rejected';
  fetchedAt: string;
  wordCount: number;
  rejectionReason?: string;
  /** How the content was obtained */
  source: 'live' | 'proxy' | 'cache' | 'upload' | 'headless';
  /** User-Agent that succeeded (for debugging) */
  userAgent?: string;
  // ─── Provenance (added 2026-04-07) ────────────────────────────
  // Captured BEFORE any parsing/cleaning so we can prove the stored
  // regulation matches what the source served at scrape time.
  /** SHA-256 of the unmodified HTTP response body */
  rawBytesHash?: string;
  /** Size of the unmodified HTTP response body in bytes */
  rawBytesSize?: number;
  /** Full unmodified HTTP body (HTML text, or base64 for PDF) */
  rawContent?: string;
  /** Final URL after redirects */
  fetchedUrl?: string;
  /** HTTP status code */
  httpStatus?: number;
  /** Content-Type response header */
  contentType?: string;
  // ─── Provenance honesty (canonical model — see hunter/provenance.ts) ──────
  /**
   * 'byte_exact': rawContent is one unmodified HTTP body — rawBytesHash proves
   *   the server's bytes. 'assembled': rawContent is Nomus's concatenation of
   *   multiple fetches — rawBytesHash covers OUR assembly, and the per-fetch
   *   server hashes are in provenanceManifest (only produced when EVERY expected
   *   section was captured). 'stale_cache': served from the local content cache;
   *   no live HTTP provenance exists, and it is NEVER promotable as current law.
   */
  provenanceMode?: 'byte_exact' | 'assembled' | 'healed' | 'rendered' | 'stale_cache' | 'upload';
  /** Per-fetch provenance for assembled results (multi-page, GitHub repos) */
  provenanceManifest?: Array<{ url: string; bytesHash: string; bytesSize: number; status: number }>;
  // ─── ACCESS-ESCALATION: manual-upload terminal tier ────────────────────────
  /**
   * True when every automated tier (polite scrape + headless) was exhausted and
   * the source must be captured by MANUAL UPLOAD. Set on a held stale_cache
   * result; when there is no cache at all, scrapeSource throws a
   * ManualUploadRequiredError instead. The pipeline surfaces this as
   * source.needsManualUpload for the admin UI/API.
   */
  needsManualUpload?: boolean;
  /** Human-facing reason for the manual-upload hold. */
  manualUploadReason?: string;
  // ─── Official-API ingestion (adapter framework) ───────────────────────────
  /**
   * Which ingestion channel produced this result. `official_api` means the
   * content came from a government API/bulk feed (byte-exact against the served
   * artifact) rather than HTML scraping. Undefined for the scraper path.
   */
  channel?: 'official_api' | 'bulk' | 'rss' | 'scrape';
  /**
   * The official immutable version coordinate (eCFR date + title/part, FR
   * document number + publication date, EUR-Lex CELEX version). Serialized to
   * JSON and persisted so every stored regulation cites an official version.
   */
  pointInTimeCoordinate?: PointInTimeCoordinate;
  /**
   * True when an official-API conditional fetch determined the content is
   * unchanged since the last promoted snapshot (contentHash is set to the prior
   * hash so the pipeline's change-detection short-circuits to no_change). The
   * heavy artifact was NOT re-downloaded.
   */
  notModified?: boolean;
}

export interface ScrapeContext {
  sourceId: string;
  sourceName: string;
  /** Optional HTTP proxy URL: http://proxy:port or socks5://proxy:port.
   *  Passed to the headless browser context (NOMUS_HEADLESS_PROXY). */
  proxyUrl?: string;
  /** ACCESS-ESCALATION: the source is JS-rendered / bot-walled — skip the plain
   *  HTTP scrape and go straight to a headless browser capture. */
  needsHeadless?: boolean;
  /** Max acceptable cache age in hours before marking content as suspicious (default: 168 = 7 days) */
  maxCacheAgeHours?: number;
  /** Callback for tiered notifications */
  onEvent?: (tier: 1 | 2 | 3, message: string, details?: Record<string, unknown>) => void;
  // ─── Official-API conditional fetch (adapter framework) ──────────────────
  /** Content hash of the last promoted snapshot — enables an adapter to skip
   *  re-downloading unchanged official content. */
  lastContentHash?: string | null;
  /** Point-in-time coordinate of the last promoted snapshot (JSON-parsed) —
   *  enables an adapter's conditional-fetch decision. */
  lastCoordinate?: PointInTimeCoordinate | null;
}

// ─── User-Agent Rotation ─────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
];

let _uaIndex = 0;
function nextUserAgent(): string {
  const ua = USER_AGENTS[_uaIndex % USER_AGENTS.length];
  _uaIndex++;
  return ua;
}

// ─── Content Validation ──────────────────────────────────────────

const GARBAGE_PATTERNS = [
  /page\s*not\s*found/i,
  /404\s*(error|not found)/i,
  /403\s*forbidden/i,
  /access\s*denied/i,
  /service\s*unavailable/i,
  /captcha/i,
  /please\s*verify\s*(you are|that you)/i,
  /enable\s*javascript/i,
  /cloudflare/i,
  /rate\s*limit(ed)?/i,
  /too\s*many\s*requests/i,
  /under\s*maintenance/i,
  /sign\s*in\s*(to|required)/i,
  /login\s*required/i,
  /paywall/i,
  /subscribe\s*to\s*(access|continue)/i,
];

const CAPTCHA_PATTERNS = [
  /captcha/i,
  /please\s*verify/i,
  /challenge-platform/i,
  /cf-browser-verification/i,
  /recaptcha/i,
  /hcaptcha/i,
];

const MIN_WORD_COUNT = 100;
const MIN_CHAR_COUNT = 500;

/**
 * True when a fetch error message looks like an anti-bot BLOCK (403/WAF/CAPTCHA)
 * rather than a plain outage (timeout/404/DNS). Only a block is worth escalating
 * to a headless browser capture — a real browser fingerprint + JS execution can
 * beat a block, but not a genuinely-down or missing page.
 */
function looksBlockedError(msg: string): boolean {
  return /\b403\b|\b429\b|forbidden|challenge|captcha|\bwaf\b|blocked|access denied|cloudflare|datadome/i.test(msg);
}

interface ValidationResult {
  quality: 'valid' | 'suspicious' | 'rejected';
  reason?: string;
  isCaptcha?: boolean;
  isBlocked?: boolean;
  isRateLimited?: boolean;
}

function validateContent(content: string): ValidationResult {
  const wordCount = content.split(/\s+/).filter(Boolean).length;

  if (content.length < MIN_CHAR_COUNT) {
    return { quality: 'rejected', reason: `Content too short (${content.length} chars, min ${MIN_CHAR_COUNT})`, isBlocked: content.length === 0 };
  }

  if (wordCount < MIN_WORD_COUNT) {
    return { quality: 'rejected', reason: `Too few words (${wordCount}, min ${MIN_WORD_COUNT})` };
  }

  // Check for CAPTCHA specifically
  const head = content.slice(0, 3000);
  for (const pattern of CAPTCHA_PATTERNS) {
    if (pattern.test(head)) {
      return { quality: 'rejected', reason: `CAPTCHA/challenge detected: ${pattern.source}`, isCaptcha: true };
    }
  }

  // Check for error/garbage patterns
  for (const pattern of GARBAGE_PATTERNS) {
    if (pattern.test(head)) {
      return { quality: 'rejected', reason: `Error pattern detected: ${pattern.source}` };
    }
  }

  return { quality: 'valid' };
}

// ─── Fetch with Options ──────────────────────────────────────────

interface FetchOptions {
  url: string;
  userAgent: string;
  parserType: 'html' | 'pdf';
  selectorConfig: SelectorConfig;
  timeoutMs?: number;
  proxyUrl?: string;
  followRedirects?: boolean;
  /** Profile-specific headers (override the defaults; e.g. the cellar's exact-Accept requirement) */
  extraHeaders?: Record<string, string>;
}

async function fetchAndParse(opts: FetchOptions): Promise<{
  content: string;
  finalUrl: string;
  statusCode: number;
  redirected: boolean;
  /** Unmodified HTTP body — HTML as text, PDF as base64. */
  rawContent: string;
  /** SHA-256 of the unmodified HTTP body bytes. */
  rawBytesHash: string;
  /** Size of unmodified HTTP body in bytes. */
  rawBytesSize: number;
  /** Content-Type header from the response. */
  contentType: string;
}> {
  const headers: Record<string, string> = {
    'User-Agent': opts.userAgent,
    'Accept': opts.parserType === 'pdf'
      ? 'application/pdf'
      : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    // Profile headers win: some hosts (EU cellar) need an EXACT Accept value
    // and serve RDF metadata instead of the document with the defaults above.
    // — previously profile headers were only applied on
    // the multi-page path, so every single-page EUR-Lex fetch got RDF.)
    ...(opts.extraHeaders ?? {}),
  };

  // Note: Node.js native fetch doesn't support proxies directly.
  // For proxy support, we'd need undici ProxyAgent or similar.
  // For now, we use the standard fetch with enhanced headers.
  const response = await fetch(opts.url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });

  const redirected = response.redirected;
  const finalUrl = response.url;
  const contentType = response.headers.get('content-type') ?? '';

  if (!response.ok) {
    if (response.status === 429) {
      throw Object.assign(new Error(`Rate limited (429)`), { statusCode: 429, isRateLimited: true });
    }
    if (response.status === 403) {
      throw Object.assign(new Error(`Forbidden (403) — likely blocked`), { statusCode: 403, isBlocked: true });
    }
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  // Capture the raw response body BEFORE any parsing — this is the
  // byte-level provenance we need to prove "matches source exactly".
  const rawBuffer = Buffer.from(await response.arrayBuffer());
  const rawBytesSize = rawBuffer.length;
  const rawBytesHash = createHash('sha256').update(rawBuffer).digest('hex');

  // Detect WAF/bot challenges that respond 200/202 with an empty body and a
  // challenge action header. Treat as blocked immediately so the caller can
  // skip UA rotation (which never beats AWS WAF) and surface a clear error.
  const wafAction = response.headers.get('x-amzn-waf-action');
  if (rawBytesSize === 0 || (wafAction && wafAction !== '')) {
    throw Object.assign(
      new Error(`WAF/bot challenge detected (status ${response.status}, body ${rawBytesSize}B${wafAction ? `, x-amzn-waf-action=${wafAction}` : ''})`),
      { statusCode: response.status, isBlocked: true, isChallenge: true },
    );
  }

  let content: string;
  let rawContent: string;
  if (opts.parserType === 'pdf') {
    rawContent = rawBuffer.toString('base64');
    content = await parsePdf(rawBuffer, opts.selectorConfig);
  } else {
    rawContent = rawBuffer.toString('utf-8');
    content = parseHtml(rawContent, opts.selectorConfig);
  }

  return {
    content,
    finalUrl,
    statusCode: response.status,
    redirected,
    rawContent,
    rawBytesHash,
    rawBytesSize,
    contentType,
  };
}

// ─── Strategy Helpers ────────────────────────────────────────

/**
 * Merge a scraper profile's selectors with the registry's SelectorConfig.
 * Profile selectors take precedence (more domain-specific).
 */
function profileToSelectorConfig(
  profile: ScraperProfile | null,
  fallback: SelectorConfig,
): SelectorConfig {
  if (!profile) return fallback;
  return {
    contentSelector: profile.contentSelector ?? fallback.contentSelector,
    removeSelectors: profile.removeSelectors ?? fallback.removeSelectors,
    pageRange: fallback.pageRange,
  };
}

/**
 * Extract links from a profile-specific CSS selector.
 * Used for sites like OWASP GenAI where nav links aren't in standard nav elements.
 */
function extractLinksFromSelector(
  html: string,
  baseUrl: string,
  selector: string,
): Array<{ text: string; href: string; isAnchor: boolean }> {
  const $ = cheerio.load(html);
  const parsedBase = new URL(baseUrl);
  const links: Array<{ text: string; href: string; isAnchor: boolean }> = [];

  // Selector may match <a> elements directly or containers with <a> children
  $(selector).each((_, el) => {
    const $el = $(el);
    const tagName = (el as Element).tagName?.toLowerCase();
    const anchors = tagName === 'a' ? $el : $el.find('a[href]');

    anchors.each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href');
      const text = $a.text().trim();
      if (!href || !text || text.length < 2) return;

      let resolved: URL;
      try {
        resolved = new URL(href, baseUrl);
      } catch {
        return;
      }

      // Only same-domain links
      if (resolved.hostname !== parsedBase.hostname) return;

      const isAnchor = resolved.pathname === parsedBase.pathname && resolved.hash.length > 1;
      links.push({ text, href: resolved.href, isAnchor });
    });
  });

  return links;
}

/**
 * Result of a multi-page fetch — extracted text plus full per-section provenance
 * so that storage layers can prove the regulation matches the source byte-for-byte.
 */
interface MultiPageResult {
  text: string;
  finalUrl: string;
  /** Concatenated raw HTML of every section in fetch order, separated by \n--- URL ---\n */
  rawContent: string;
  /** SHA-256 of rawContent (deterministic per scrape if sources are stable) */
  rawBytesHash: string;
  rawBytesSize: number;
  contentType: string;
  /** Per-section manifest for granular verification */
  manifest: Array<{ url: string; bytesHash: string; bytesSize: number; status: number }>;
  sectionsRequested: number;
  sectionsFetched: number;
  sectionsSkipped: number;
}

const MULTI_PAGE_HARD_CAP = 1000; // hard limit; warn at 500

/**
 * Thrown when a multi-page assembly could not capture EVERY expected section.
 * Under refuse-to-guess we never promote a partial multi-page document as the
 * regulation — the whole fetch fails so the source is held for intervention.
 */
export class MultiPageIncompleteError extends Error {
  readonly sectionsRequested: number;
  readonly sectionsFetched: number;
  readonly sectionsSkipped: number;
  readonly skippedUrls: string[];
  constructor(sectionsRequested: number, sectionsFetched: number, skippedUrls: string[]) {
    super(
      `Multi-page capture incomplete: ${sectionsFetched}/${sectionsRequested} sections captured, ` +
      `${skippedUrls.length} skipped (${skippedUrls.slice(0, 5).join(', ')}${skippedUrls.length > 5 ? ', …' : ''}). ` +
      `Refusing to promote a partial regulation.`,
    );
    this.name = 'MultiPageIncompleteError';
    this.sectionsRequested = sectionsRequested;
    this.sectionsFetched = sectionsFetched;
    this.sectionsSkipped = skippedUrls.length;
    this.skippedUrls = skippedUrls;
  }
}

export async function fetchMultiPageContent(
  url: string,
  profile: ScraperProfile | null,
  selectorConfig: SelectorConfig,
  emit: (tier: 1 | 2 | 3, message: string, details?: Record<string, unknown>) => void,
): Promise<MultiPageResult> {
  const ua = nextUserAgent();
  const effectiveConfig = profileToSelectorConfig(profile, selectorConfig);

  // Fetch landing page
  const response = await fetch(url, {
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache',
      ...(profile?.headers ?? {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const landingBuffer = Buffer.from(await response.arrayBuffer());
  const html = landingBuffer.toString('utf-8');
  const finalUrl = response.url;
  const contentType = response.headers.get('content-type') ?? '';

  // Detect navigation links — profile navSelector first, then generic detection
  let navLinks: Array<{ text: string; href: string; isAnchor: boolean }> = [];

  if (profile?.navSelector) {
    navLinks = extractLinksFromSelector(html, finalUrl, profile.navSelector);
    logger.info({ selector: profile.navSelector, links: navLinks.length },
      `Profile nav selector found ${navLinks.length} links`);
  }

  if (navLinks.length === 0) {
    const navResult = detectNavigation(html, finalUrl);
    navLinks = navResult.links;
  }

  const pageLinks = navLinks.filter((l) => !l.isAnchor);

  if (pageLinks.length === 0) {
    // No multi-page nav found — extract as single page
    logger.info({ url }, 'Multi-page strategy: no nav links found, extracting as single page');
    const text = parseHtml(html, effectiveConfig);
    const landingHash = createHash('sha256').update(landingBuffer).digest('hex');
    return {
      text,
      finalUrl,
      rawContent: html,
      rawBytesHash: landingHash,
      rawBytesSize: landingBuffer.length,
      contentType,
      manifest: [{ url: finalUrl, bytesHash: landingHash, bytesSize: landingBuffer.length, status: response.status }],
      sectionsRequested: 0,
      sectionsFetched: 1,
      sectionsSkipped: 0,
    };
  }

  // Hard cap with WARN — prevents accidentally trying to scrape a 10k-page site
  // but does not silently drop content for normal regulatory documents.
  if (pageLinks.length > MULTI_PAGE_HARD_CAP) {
    emit(2, `Source has ${pageLinks.length} sections — capping at ${MULTI_PAGE_HARD_CAP}. Increase MULTI_PAGE_HARD_CAP if needed.`);
    logger.warn({ url, sections: pageLinks.length, cap: MULTI_PAGE_HARD_CAP },
      `Multi-page: ${pageLinks.length} sections exceeds hard cap`);
  } else if (pageLinks.length > 500) {
    emit(1, `Source has ${pageLinks.length} sections — large fetch ahead`);
  }

  const capped = pageLinks.slice(0, MULTI_PAGE_HARD_CAP);
  emit(1, `Fetching ${capped.length} section pages`);
  logger.info({ url, sections: capped.length }, `Multi-page: fetching ${capped.length} sections`);

  const sections: string[] = [];
  // Concatenated raw HTML of every section, in fetch order, with URL fences.
  // This is the byte-level provenance for multi-page sources.
  const rawConcat: string[] = [`<!-- LANDING ${finalUrl} -->\n${html}`];
  const manifest: MultiPageResult['manifest'] = [{
    url: finalUrl,
    bytesHash: createHash('sha256').update(landingBuffer).digest('hex'),
    bytesSize: landingBuffer.length,
    status: response.status,
  }];
  const skippedUrls: string[] = [];
  const delay = profile?.interPageDelayMs ?? 2_000;

  for (let i = 0; i < capped.length; i++) {
    const link = capped[i];
    try {
      const pageResponse = await fetch(link.href, {
        headers: {
          'User-Agent': nextUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          ...(profile?.headers ?? {}),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });

      if (!pageResponse.ok) {
        logger.warn({ url: link.href, status: pageResponse.status }, 'Multi-page: section fetch failed');
        skippedUrls.push(`${link.href} (HTTP ${pageResponse.status})`);
        continue;
      }

      const pageBuffer = Buffer.from(await pageResponse.arrayBuffer());
      const pageHtml = pageBuffer.toString('utf-8');
      const text = parseHtml(pageHtml, effectiveConfig);
      const wordCount = text.split(/\s+/).filter(Boolean).length;

      if (wordCount < 50) {
        logger.warn({ url: link.href, words: wordCount }, `Multi-page: thin section (${wordCount} words)`);
        skippedUrls.push(`${link.href} (thin: ${wordCount} words)`);
        continue;
      }

      sections.push(`\n--- ${link.text} ---\n\n${text}`);
      rawConcat.push(`<!-- SECTION ${link.href} -->\n${pageHtml}`);
      manifest.push({
        url: pageResponse.url,
        bytesHash: createHash('sha256').update(pageBuffer).digest('hex'),
        bytesSize: pageBuffer.length,
        status: pageResponse.status,
      });

      // Rate limiting between page fetches
      if (i < capped.length - 1) {
        await new Promise((r) => setTimeout(r, delay));
      }
    } catch (err) {
      logger.warn({ url: link.href, error: (err as Error).message }, 'Multi-page: section fetch error');
      skippedUrls.push(`${link.href} (${(err as Error).message})`);
      // Do NOT continue as if partial is acceptable — completeness is enforced
      // after the loop. We still finish the loop to collect the full skip list.
    }
  }

  // COMPLETENESS-OR-FAIL: under refuse-to-guess, if ANY expected section was
  // skipped (transient error, non-OK status, or too-thin) we do NOT promote
  // whatever we managed to get, and we NEVER fall back to the landing/ToC page
  // as if it were the regulation. The whole fetch fails so the source is held
  // for intervention with a clear reason.
  if (skippedUrls.length > 0) {
    logger.error(
      { url, fetched: sections.length, requested: capped.length, skipped: skippedUrls.length },
      `Multi-page: ${skippedUrls.length}/${capped.length} sections missing — failing (refuse to promote partial)`,
    );
    throw new MultiPageIncompleteError(capped.length, sections.length, skippedUrls);
  }

  logger.info({ url, fetched: sections.length, total: capped.length },
    `Multi-page: captured all ${sections.length}/${capped.length} sections`);

  const concatRaw = rawConcat.join('\n');
  return {
    text: sections.join('\n'),
    finalUrl,
    rawContent: concatRaw,
    rawBytesHash: createHash('sha256').update(concatRaw).digest('hex'),
    rawBytesSize: Buffer.byteLength(concatRaw, 'utf-8'),
    contentType,
    manifest,
    sectionsRequested: capped.length,
    sectionsFetched: sections.length,
    sectionsSkipped: 0,
  };
}

interface GitHubFetchResult {
  text: string;
  rawContent: string;
  rawBytesHash: string;
  rawBytesSize: number;
  contentType: string;
  /** Per-file provenance — the concat above is Nomus's assembly, not server bytes */
  manifest: Array<{ url: string; bytesHash: string; bytesSize: number; status: number }>;
}

/**
 * Fetch content from a GitHub repository directory.
 * Lists files via GitHub API, fetches raw content, concatenates.
 *
 * Returns a richer object with provenance so the caller can populate
 * raw_bytes_hash and friends in the rawSnapshots row, matching the
 * single-page and multi-page strategies.
 */
async function fetchGitHubContent(url: string): Promise<GitHubFetchResult> {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)/);
  if (!match) throw new Error(`Invalid GitHub repo URL: ${url}`);

  const [, owner, repo, branch, dirPath] = match;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}?ref=${branch}`;

  logger.info({ owner, repo, branch, dirPath }, 'Fetching GitHub repo content');

  const response = await fetch(apiUrl, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Nomus-Engine/1.0',
      ...(process.env.GITHUB_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const files = (await response.json()) as Array<{
    name: string;
    type: string;
    download_url: string | null;
  }>;

  const supported = files
    .filter((f) => f.type === 'file' && /\.(md|html|htm|txt|json|xml|yaml|yml)$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (supported.length === 0) {
    throw new Error(`No supported files found in GitHub directory`);
  }

  logger.info({ fileCount: supported.length }, `GitHub: found ${supported.length} files`);

  const sections: string[] = [];
  const rawConcat: string[] = [];
  const manifest: GitHubFetchResult['manifest'] = [];

  for (const file of supported) {
    if (!file.download_url) continue;
    try {
      const raw = await fetch(file.download_url, {
        headers: { 'User-Agent': 'Nomus-Engine/1.0', Accept: '*/*' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!raw.ok) continue;
      const text = await raw.text();
      if (text.split(/\s+/).filter(Boolean).length < 10) continue;
      sections.push(`\n--- ${file.name} ---\n\n${text}`);
      // Capture raw byte-level provenance for every file fetched.
      rawConcat.push(`<!-- FILE ${file.download_url} -->\n${text}`);
      manifest.push({
        url: file.download_url,
        bytesHash: createHash('sha256').update(text).digest('hex'),
        bytesSize: Buffer.byteLength(text, 'utf-8'),
        status: raw.status,
      });

      // Polite GitHub rate limiting
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      logger.warn({ file: file.name, error: (err as Error).message }, 'GitHub: file fetch failed');
    }
  }

  if (sections.length === 0) {
    throw new Error(`GitHub fetch produced zero content from ${supported.length} files`);
  }

  logger.info({ fetched: sections.length, total: supported.length },
    `GitHub: fetched ${sections.length}/${supported.length} files`);

  const text = sections.join('\n');
  const rawContent = rawConcat.join('\n');
  return {
    text,
    rawContent,
    rawBytesHash: createHash('sha256').update(rawContent).digest('hex'),
    rawBytesSize: Buffer.byteLength(rawContent, 'utf-8'),
    contentType: 'text/plain; github-repo-concat',
    manifest,
  };
}

// ─── ACCESS-ESCALATION: headless capture + manual-upload terminal tier ───────

/**
 * Thrown when EVERY automated ingestion tier (polite HTTP scrape + headless
 * browser capture) has been exhausted and no cached copy exists. This is the
 * terminal state of the refuse-to-guess pipeline: the source cannot be captured
 * automatically and must be supplied by MANUAL UPLOAD. The pipeline catches this
 * and flags source.needsManualUpload so the admin UI/API can surface it. The
 * last known-good promoted snapshot keeps serving in the meantime.
 */
export class ManualUploadRequiredError extends Error {
  /** Stable token so logs/consumers can detect the manual-upload terminal state. */
  readonly code = 'needs_manual_upload';
  readonly reason: string;
  readonly attempts: string;
  constructor(reason: string, attempts: string) {
    super(`${reason} Held for MANUAL UPLOAD (needs_manual_upload).`);
    this.name = 'ManualUploadRequiredError';
    this.reason = reason;
    this.attempts = attempts;
  }
}

/**
 * Attempt a headless browser capture and shape it into a ScrapeResult.
 *
 * Returns `{ result }` on a usable rendered capture (provenance 'rendered'), or
 * `{ result: null, note }` when headless was unavailable (disabled / browser not
 * installed) or blocked (anti-bot challenge / navigation failure). A challenge
 * page is NEVER returned as content — refuse-to-guess.
 */
async function tryHeadlessCapture(
  url: string,
  selectorConfig: SelectorConfig,
  parserType: 'html' | 'pdf',
  ctx: ScrapeContext | undefined,
  emit: (tier: 1 | 2 | 3, message: string, details?: Record<string, unknown>) => void,
): Promise<{ result: ScrapeResult | null; note: string }> {
  // Headless captures the rendered DOM (HTML). A PDF source has no JS-rendered
  // DOM to capture — headless does not apply; hold for manual upload directly.
  if (parserType === 'pdf') {
    return { result: null, note: 'headless not applicable to PDF sources' };
  }

  const outcome = await fetchHeadless(url, {
    proxyUrl: ctx?.proxyUrl,
    emit,
  });

  if (outcome.kind === 'unavailable') {
    logger.warn({ url, reason: outcome.reason }, 'Headless unavailable — escalating to manual upload');
    return { result: null, note: `headless unavailable: ${outcome.reason}` };
  }

  if (outcome.kind === 'blocked') {
    logger.warn({ url, reason: outcome.reason }, 'Headless blocked — escalating to manual upload');
    return { result: null, note: `headless blocked: ${outcome.reason}` };
  }

  // Parse the rendered DOM into clean text and validate it like any HTML fetch.
  const content = parseHtml(outcome.renderedHtml, selectorConfig);
  const validation = validateContent(content);
  if (validation.quality === 'rejected') {
    // The rendered page parsed to garbage (still a shell / slipped-through
    // challenge). Do NOT promote it — treat as blocked, hold for manual upload.
    logger.warn({ url, reason: validation.reason }, 'Headless capture failed validation — escalating to manual upload');
    return { result: null, note: `headless produced unusable content: ${validation.reason}` };
  }

  const contentHash = createHash('sha256').update(content).digest('hex');
  emit(2, 'Captured via headless browser (rendered DOM)', { url: outcome.finalUrl });
  return {
    result: {
      content,
      contentHash,
      contentQuality: validation.quality,
      fetchedAt: new Date().toISOString(),
      wordCount: content.split(/\s+/).filter(Boolean).length,
      rejectionReason: validation.reason,
      source: 'headless',
      // Rendered DOM is NOT the raw HTTP body — its own promotable-but-not-
      // byte-exact provenance tier (see hunter/provenance.ts).
      rawBytesHash: outcome.rawBytesHash,
      rawBytesSize: outcome.rawBytesSize,
      rawContent: outcome.renderedHtml,
      fetchedUrl: outcome.finalUrl,
      httpStatus: 200,
      contentType: outcome.contentType,
      provenanceMode: 'rendered',
    },
    note: 'headless capture succeeded',
  };
}

// ─── Main Scraper (Self-Healing) ─────────────────────────────────

/**
 * Scrape a regulatory source with automatic fallback chain.
 *
 * Strategy-aware: detects whether a source needs single-page fetch,
 * multi-page navigation following, or GitHub API fetching based on
 * scraper profiles from the Harvester.
 *
 * Fallback chain (all strategies):
 *   1. Live fetch with strategy-specific logic
 *   2. Local content cache (from previous successful scrape)
 *   3. Escalate with notification
 */
export async function scrapeSource(
  url: string,
  parserType: 'html' | 'pdf',
  selectorConfig: SelectorConfig,
  ctx?: ScrapeContext,
): Promise<ScrapeResult> {
  const emit = ctx?.onEvent ?? (() => {});
  const attempts: Array<{ method: string; ua?: string; error: string }> = [];

  // ─── API-FIRST: official ingestion adapter takes precedence ─────────────
  // The best regulatory scraper does NOT scrape when an official structured
  // source exists. If an adapter (eCFR / Federal Register / EUR-Lex Cellar)
  // handles this URL, we pull the government's own artifact (byte_exact + an
  // official point-in-time coordinate) instead of HTML scraping.
  //
  // HARD-FAIL, NOT FALLBACK: a thrown adapter error propagates out of
  // scrapeSource so the pipeline HOLDS the source. We never silently fall back
  // to scraping stale HTML and present it as current law (refuse-to-guess).
  const adapter = selectAdapter(url);
  if (adapter) {
    logger.info({ adapter: adapter.id, channel: adapter.channel, url },
      `Ingestion adapter selected: ${adapter.label} (${adapter.channel})`);
    const outcome = await adapter.fetch(url, {
      sourceId: ctx?.sourceId,
      sourceName: ctx?.sourceName,
      lastContentHash: ctx?.lastContentHash,
      lastCoordinate: ctx?.lastCoordinate,
      emit,
    });

    if (outcome.kind === 'not_modified') {
      // Signal no-change WITHOUT re-downloading: set contentHash to the prior
      // hash so the pipeline's change-detection short-circuits to no_change.
      return {
        content: '[official-api: not modified]',
        contentHash: ctx?.lastContentHash ?? '',
        contentQuality: 'valid',
        fetchedAt: new Date().toISOString(),
        wordCount: 0,
        source: 'live',
        provenanceMode: 'byte_exact',
        channel: outcome.channel,
        pointInTimeCoordinate: outcome.pointInTimeCoordinate,
        notModified: true,
      };
    }

    const validation = validateContent(outcome.content);
    if (validation.quality === 'rejected') {
      // An official artifact that fails validation is a hard fail — the source
      // is held for intervention, never scraped as a fallback.
      throw new Error(
        `Official API (${adapter.id}) returned unusable content for ${outcome.pointInTimeCoordinate.citation}: ${validation.reason}. ` +
        `Refusing to fall back to HTML scraping — source held.`,
      );
    }

    return {
      content: outcome.content,
      contentHash: outcome.contentHash,
      contentQuality: validation.quality,
      fetchedAt: outcome.fetchedAt,
      wordCount: outcome.wordCount,
      source: 'live',
      rawBytesHash: outcome.rawBytesHash,
      rawBytesSize: outcome.rawBytesSize,
      rawContent: outcome.rawContent,
      fetchedUrl: outcome.sourceUrl,
      httpStatus: 200,
      contentType: outcome.contentType,
      provenanceMode: 'byte_exact',
      channel: outcome.channel,
      pointInTimeCoordinate: outcome.pointInTimeCoordinate,
    };
  }

  // ─── Strategy Detection ─────────────────────────────────────
  const profile = getScraperProfile(url);

  // EUR-Lex sources: resolve the as-adopted CELEX to the newest retrievable
  // consolidated version and surface pending amendments as events. Falls back
  // to the original URL on any resolver failure (never blocks the scrape).
  let workingUrl = url;
  if (profile?.celexResolve) {
    const { resolveEurLexUrl } = await import('./sources/celex-resolver.js');
    const resolution = await resolveEurLexUrl(url, { emit });
    workingUrl = resolution.url;
  }

  const effectiveUrl = profile?.transformUrl ? profile.transformUrl(workingUrl) : workingUrl;
  const effectiveConfig = profileToSelectorConfig(profile, selectorConfig);

  // Determine strategy: profile override → URL pattern → single_page default
  let strategy: 'single_page' | 'multi_page' | 'github_repo' = 'single_page';
  if (profile?.strategy === 'github_repo' || detectStrategy(effectiveUrl) === 'github_repo') {
    strategy = 'github_repo';
  } else if (profile?.strategy === 'multi_page') {
    strategy = 'multi_page';
  }

  if (profile) {
    logger.info({ profile: profile.label, strategy, originalUrl: url, effectiveUrl },
      `Scraper profile: ${profile.label} (strategy: ${strategy})`);
  }

  // ─── ACCESS-ESCALATION escalation state ─────────────────────
  // blockedSignal: a plain scrape hit a 403/WAF/CAPTCHA — a headless capture may
  //   beat it (real browser fingerprint + JS execution).
  // headlessTried: guards against launching a browser twice.
  let blockedSignal = false;
  let headlessTried = false;
  let headlessNote = '';

  // ACCESS-ESCALATION: a source KNOWN to be JS-rendered / bot-walled skips the
  // plain HTTP scrape entirely and goes straight to a headless browser capture.
  if (ctx?.needsHeadless) {
    emit(1, 'Source flagged needsHeadless — escalating directly to headless browser capture');
    logger.info({ url: effectiveUrl }, 'needsHeadless — skipping plain HTTP scrape, trying headless');
    const h = await tryHeadlessCapture(effectiveUrl, effectiveConfig, parserType, ctx, emit);
    headlessTried = true;
    headlessNote = h.note;
    if (h.result) return h.result;
    attempts.push({ method: 'headless', error: h.note });
  }

  // ─── Strategy: GitHub Repo ──────────────────────────────────
  else if (strategy === 'github_repo') {
    try {
      emit(1, `Fetching GitHub repository content`);
      const ghResult = await fetchGitHubContent(effectiveUrl);
      const validation = validateContent(ghResult.text);
      const contentHash = createHash('sha256').update(ghResult.text).digest('hex');

      if (validation.quality !== 'rejected') {
        return {
          content: ghResult.text,
          contentHash,
          contentQuality: validation.quality,
          fetchedAt: new Date().toISOString(),
          wordCount: ghResult.text.split(/\s+/).filter(Boolean).length,
          rejectionReason: validation.reason,
          source: 'live',
          rawBytesHash: ghResult.rawBytesHash,
          rawBytesSize: ghResult.rawBytesSize,
          rawContent: ghResult.rawContent,
          fetchedUrl: effectiveUrl,
          httpStatus: 200,
          contentType: ghResult.contentType,
          provenanceMode: 'assembled',
          provenanceManifest: ghResult.manifest,
        };
      }
      attempts.push({ method: 'github_repo', error: validation.reason ?? 'Content rejected' });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      attempts.push({ method: 'github_repo', error });
      if (looksBlockedError(error)) blockedSignal = true;
      logger.warn({ url: effectiveUrl, error }, 'GitHub fetch failed');
    }
  }

  // ─── Strategy: Multi-Page (follow sidebar/nav links) ────────
  else if (strategy === 'multi_page' && parserType === 'html') {
    try {
      emit(1, `Fetching multi-page source (profile: ${profile?.label})`);
      const mp = await fetchMultiPageContent(effectiveUrl, profile, selectorConfig, emit);
      const validation = validateContent(mp.text);
      const contentHash = createHash('sha256').update(mp.text).digest('hex');

      if (validation.quality !== 'rejected') {
        return {
          content: mp.text,
          contentHash,
          contentQuality: validation.quality,
          fetchedAt: new Date().toISOString(),
          wordCount: mp.text.split(/\s+/).filter(Boolean).length,
          rejectionReason: validation.reason,
          source: 'live',
          // Per-section concatenated raw HTML and manifest — full provenance
          // for multi-page documents like GDPR-info.eu and law.cornell.edu CFR.
          rawBytesHash: mp.rawBytesHash,
          rawBytesSize: mp.rawBytesSize,
          rawContent: mp.rawContent,
          fetchedUrl: mp.finalUrl,
          httpStatus: 200,
          contentType: mp.contentType,
          // One fetch (landing only) is a genuine single body; 2+ is our assembly.
          provenanceMode: mp.manifest.length > 1 ? 'assembled' : 'byte_exact',
          provenanceManifest: mp.manifest,
        };
      }
      attempts.push({ method: 'multi_page', error: validation.reason ?? 'Content rejected' });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      attempts.push({ method: 'multi_page', error });
      if (looksBlockedError(error)) blockedSignal = true;
      logger.warn({ url: effectiveUrl, error }, 'Multi-page fetch failed');
    }
  }

  // ─── Strategy: Single Page (UA rotation with retries) ───────
  else {
    for (let i = 0; i < USER_AGENTS.length; i++) {
      const ua = nextUserAgent();
      try {
        const result = await fetchAndParse({
          url: effectiveUrl,
          userAgent: ua,
          parserType,
          selectorConfig: effectiveConfig,
          timeoutMs: 30_000,
          extraHeaders: profile?.headers,
        });

        // Check for redirects (Tier 1 auto-fix)
        if (result.redirected && result.finalUrl !== effectiveUrl) {
          emit(1, `Source URL redirected: ${effectiveUrl} → ${result.finalUrl}`);
          logger.info({ from: effectiveUrl, to: result.finalUrl }, 'Source URL redirected — following');
        }

        // Validate content
        const validation = validateContent(result.content);

        if (validation.quality === 'valid') {
          if (i > 0) {
            emit(2, `Source required User-Agent rotation (attempt ${i + 1})`, { userAgent: ua });
          }

          const contentHash = createHash('sha256').update(result.content).digest('hex');
          return {
            content: result.content,
            contentHash,
            contentQuality: 'valid',
            fetchedAt: new Date().toISOString(),
            wordCount: result.content.split(/\s+/).filter(Boolean).length,
            source: 'live',
            userAgent: ua,
            rawBytesHash: result.rawBytesHash,
            rawBytesSize: result.rawBytesSize,
            rawContent: result.rawContent,
            fetchedUrl: result.finalUrl,
            httpStatus: result.statusCode,
            contentType: result.contentType,
            provenanceMode: 'byte_exact',
          };
        }

        if (validation.isCaptcha) {
          blockedSignal = true; // a headless real-browser capture may beat a CAPTCHA wall
          attempts.push({ method: `live (UA ${i + 1})`, ua, error: 'CAPTCHA detected' });
          logger.warn({ url: effectiveUrl, ua: ua.slice(0, 30) }, 'CAPTCHA detected — trying next User-Agent');
          continue;
        }

        if (validation.isBlocked) {
          blockedSignal = true;
          attempts.push({ method: `live (UA ${i + 1})`, ua, error: 'Empty/blocked response' });
          logger.warn({ url: effectiveUrl, ua: ua.slice(0, 30) }, 'Empty response — trying next User-Agent');
          continue;
        }

        // Content rejected for other reasons — let the pipeline decide
        const contentHash = createHash('sha256').update(result.content).digest('hex');
        return {
          content: result.content,
          contentHash,
          contentQuality: validation.quality,
          fetchedAt: new Date().toISOString(),
          wordCount: result.content.split(/\s+/).filter(Boolean).length,
          rejectionReason: validation.reason,
          source: 'live',
          userAgent: ua,
          rawBytesHash: result.rawBytesHash,
          rawBytesSize: result.rawBytesSize,
          rawContent: result.rawContent,
          fetchedUrl: result.finalUrl,
          httpStatus: result.statusCode,
          contentType: result.contentType,
          provenanceMode: 'byte_exact',
        };

      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // Fetch/scrape errors may carry custom flags set by the HTTP layer.
        const errObj = err as { isChallenge?: boolean; isBlocked?: boolean; statusCode?: number; isRateLimited?: boolean };

        // WAF/bot challenge — UA rotation will never beat this. Bail out
        // immediately so the caller can escalate to a headless capture.
        if (errObj.isChallenge) {
          blockedSignal = true;
          attempts.push({ method: `live (UA ${i + 1})`, ua, error: 'WAF challenge' });
          logger.warn({ url: effectiveUrl, status: errObj.statusCode },
            'WAF challenge detected — skipping remaining UA rotation');
          break;
        }

        // 403 Forbidden — a bot block. A real browser fingerprint may beat it.
        if (errObj.isBlocked || errObj.statusCode === 403) {
          blockedSignal = true;
          attempts.push({ method: `live (UA ${i + 1})`, ua, error: `Blocked (${errObj.statusCode ?? '403'})` });
          logger.warn({ url: effectiveUrl, status: errObj.statusCode }, 'Blocked response — will escalate to headless');
          continue;
        }

        if (errObj.isRateLimited) {
          const backoff = 5000 * Math.pow(2, i);
          emit(1, `Rate limited — backing off ${backoff / 1000}s`);
          logger.warn({ url: effectiveUrl, backoffMs: backoff }, 'Rate limited — backing off');
          await new Promise((r) => setTimeout(r, backoff));
          attempts.push({ method: `live (UA ${i + 1})`, ua, error: 'Rate limited (429)' });
          continue;
        }

        if (error.message.includes('timeout') || error.name === 'TimeoutError' || error.name === 'AbortError') {
          emit(1, `Timeout on attempt ${i + 1}`);
          attempts.push({ method: `live (UA ${i + 1})`, ua, error: 'Timeout' });
          continue;
        }

        attempts.push({ method: `live (UA ${i + 1})`, ua, error: error.message });
        logger.warn({ url: effectiveUrl, attempt: i + 1, error: error.message }, `Scrape attempt ${i + 1} failed`);

        if (i < USER_AGENTS.length - 1) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
  }

  // ─── ACCESS-ESCALATION: headless capture after a scrape BLOCK ───────────────
  // A plain scrape that hit a 403/WAF/CAPTCHA gets exactly one headless attempt
  // (a real browser fingerprint + JS execution can beat a bot wall) before we
  // hold the source for manual upload. A plain outage (timeout/404/DNS) does NOT
  // trigger headless — a browser can't reach a down page either.
  if (!headlessTried && blockedSignal && parserType === 'html') {
    emit(1, 'Scrape hit a block/challenge — escalating to headless browser capture');
    const h = await tryHeadlessCapture(effectiveUrl, effectiveConfig, parserType, ctx, emit);
    headlessTried = true;
    headlessNote = h.note;
    if (h.result) return h.result;
    attempts.push({ method: 'headless', error: h.note });
  }

  // Every automated tier is now exhausted — MANUAL UPLOAD is the terminal tier.
  const automatedNote = headlessTried
    ? `Automated capture exhausted (scrape + headless${headlessNote ? ` — ${headlessNote}` : ''}).`
    : 'Automated scrape exhausted.';

  // ─── Cache Fallback (all strategies) ────────────────────────
  logger.warn({ url: effectiveUrl, sourceId: ctx?.sourceId, strategy, attempts: attempts.length },
    'All live scrape attempts failed — checking content cache');

  try {
    const { getCachedContent, getCacheAge } = await import('./content-cache.js');
    const cacheEntry = ctx?.sourceId ? getCachedContent(ctx.sourceId) : null;

    if (cacheEntry) {
      const cacheAge = ctx?.sourceId ? (getCacheAge(ctx.sourceId) ?? 0) : 0;
      const maxCacheAge = ctx?.maxCacheAgeHours ?? 168; // 7 days default
      const isStale = cacheAge > maxCacheAge;

      if (isStale) {
        emit(2, `Live source unreachable — using STALE cached copy (${Math.round(cacheAge)}h old, limit ${maxCacheAge}h)`, {
          sourceId: ctx?.sourceId,
          cacheAgeHours: Math.round(cacheAge),
          maxCacheAgeHours: maxCacheAge,
          stale: true,
        });
        logger.warn({ sourceId: ctx?.sourceId, cacheAgeHours: Math.round(cacheAge), maxCacheAge },
          'Using STALE cached content — exceeds max cache age');
      } else {
        emit(2, `Live source unreachable — using cached copy (${Math.round(cacheAge)}h old)`, {
          sourceId: ctx?.sourceId,
          cacheAgeHours: Math.round(cacheAge),
        });
        logger.info({ sourceId: ctx?.sourceId, cacheAgeHours: Math.round(cacheAge) },
          'Using cached content — live source unreachable');
      }

      const content = cacheEntry.content;
      const contentHash = createHash('sha256').update(content).digest('hex');
      return {
        content,
        contentHash,
        contentQuality: isStale ? 'suspicious' : 'valid',
        fetchedAt: new Date().toISOString(),
        wordCount: content.split(/\s+/).filter(Boolean).length,
        source: 'cache',
        // No live HTTP provenance exists for cached content — it is NEVER
        // promotable as current law. The pipeline holds it and keeps serving
        // the last known-good promoted snapshot.
        provenanceMode: 'stale_cache',
        // ACCESS-ESCALATION terminal tier: automated capture failed, so the
        // source needs a MANUAL UPLOAD to produce a fresh promotable snapshot.
        // The stale copy keeps serving (held) until then.
        needsManualUpload: true,
        manualUploadReason:
          `${automatedNote} Serving the last cached copy (held, not promoted). ` +
          `Upload the document manually to restore a promotable capture.`,
      };
    }
  } catch {
    // Cache module not available — skip
  }

  // ─── Escalation → MANUAL UPLOAD (terminal tier) ─────────────
  // No automated tier produced a capture and no cached copy exists. Under
  // refuse-to-guess we NEVER return a partial/guessed page — we throw the typed
  // ManualUploadRequiredError so the pipeline flags the source needsManualUpload
  // while the last known-good promoted snapshot keeps serving.
  const attemptSummary = attempts.map((a) => `${a.method}: ${a.error}`).join('; ');

  emit(3, `Source unreachable after ${attempts.length} attempts. No cached copy available. MANUAL UPLOAD needed.`, {
    sourceId: ctx?.sourceId,
    sourceName: ctx?.sourceName,
    url: effectiveUrl,
    attempts: attemptSummary,
    needsManualUpload: true,
  });

  logger.error({
    url: effectiveUrl,
    sourceId: ctx?.sourceId,
    sourceName: ctx?.sourceName,
    strategy,
    attempts: attempts.length,
    attemptDetails: attempts,
  }, 'ESCALATION: Source unreachable — all automated tiers exhausted, holding for manual upload');

  throw new ManualUploadRequiredError(
    `${automatedNote} Failed to capture ${ctx?.sourceName ?? effectiveUrl} after ${attempts.length} attempts ` +
    `(strategy: ${ctx?.needsHeadless ? 'headless' : strategy}). ${attemptSummary}. ` +
    `Upload content manually via the admin dashboard.`,
    attemptSummary,
  );
}

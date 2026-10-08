/**
 * The Harvester — Automated Document Acquisition Agent
 *
 * Fetches regulatory documents from known URLs and saves them to the
 * regulations directory. Handles three fetch strategies:
 *
 *   1. Single-page: All content on one page (e.g., gov.uk white papers)
 *   2. Multi-page:  Sidebar/nav links to separate pages on same domain
 *   3. GitHub repo:  Multiple files in a GitHub directory
 *
 * Government regulation sites often have sidebar navigation (left or right)
 * linking to different parts/chapters of a regulation. The Harvester detects
 * these navigation structures, follows the links, and concatenates content
 * into a single combined document.
 *
 * Idempotent: re-running skips already-fetched documents (by content hash).
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { logger } from '../logger.js';
import {
  ensureRegulationsDir,
  getDocumentDir,
  writeManifest,
  readManifest,
  saveDocumentContent,
  hashString,
} from './manifest.js';
import type {
  HarvestSource,
  HarvestResult,
  HarvestManifest,
  HarvestStrategy,
  DetectedNavLink,
  NavDetectionResult,
  DocumentManifest,
} from './types.js';
import { broadcastEvent } from '../sse/manager.js';
import { randomUUID } from 'node:crypto';

// ─── User-Agent Rotation (same pool as scraper) ──────────────

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

// ─── Constants ───────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 30_000;
const INTER_PAGE_DELAY_MS = 2_000;
const MAX_NAV_PAGES = 100; // Safety cap: never follow more than 100 sidebar links
const MIN_CONTENT_WORDS = 50; // Minimum words for a page to count as content

// ─── Scraper Profiles ────────────────────────────────────────
// Domain-specific extraction configs for clean, reliable scraping.
// Matched by domain substring — first match wins.

export interface ScraperProfile {
  /** Domain pattern to match (substring of hostname) */
  domain: string;
  /** CSS selector for main content */
  contentSelector?: string;
  /** Selectors to strip from content */
  removeSelectors?: string[];
  /** Extra HTTP headers (e.g., proper Accept for EUR-Lex) */
  headers?: Record<string, string>;
  /** Transform the URL before fetching (e.g., EUR-Lex HTML → TXT) */
  transformUrl?: (url: string) => string;
  /**
   * Resolve the CELEX in the URL to the newest retrievable consolidated
   * version before fetching (see hunter/sources/celex-resolver.ts). Without
   * this, EUR-Lex sources fetch the as-adopted act forever and never see
   * amendments.
   */
  celexResolve?: boolean;
  /** Force a specific strategy instead of auto-detecting */
  strategy?: HarvestStrategy;
  /** Override inter-page delay (ms) for rate-sensitive sites */
  interPageDelayMs?: number;
  /** CSS selector to find nav links (overrides NAV_SELECTORS probing) */
  navSelector?: string;
  /** Human-readable label for this profile */
  label: string;
}

export const SCRAPER_PROFILES: ScraperProfile[] = [
  // EUR-Lex via the cellar endpoint — bypasses the AWS WAF JavaScript challenge
  // that blocks the public eur-lex.europa.eu domain. The publications.europa.eu
  // cellar serves the same authoritative XHTML directly with no bot protection.
  // (Fix for QA finding 2026-04-07: WAF blocked EU AI Act, DORA, NIS2, GDPR.)
  {
    domain: 'eur-lex.europa.eu',
    label: 'EUR-Lex',
    // The XHTML returned by cellar wraps the regulation in <body>; we extract
    // from body since there's no .eli-container wrapper at this endpoint.
    contentSelector: 'body',
    removeSelectors: [
      'nav', 'footer', 'header', 'script', 'style', 'noscript',
      '.note', '.footnote', 'iframe', 'svg', 'img', 'button', 'input', 'form',
    ],
    // Accept MUST be exactly application/xhtml+xml. With a multi-type Accept
    // (anything including */*) the cellar serves the work's RDF metadata
    // instead of the document body (verified live 2026-07-24) — which parses
    // to nothing and rejects every scrape.
    headers: {
      'Accept': 'application/xhtml+xml',
      'Accept-Language': 'en',
    },
    celexResolve: true,
    transformUrl: (url: string) => {
      // Extract CELEX number (as-adopted or dated consolidated form) and
      // rewrite to publications.europa.eu/resource/celex which 303-redirects
      // to the cellar XHTML document. Native fetch follows the redirects.
      const m = url.match(/CELEX(?::|%3A)([0-9A-Z()]+(?:-[0-9]{8})?)/i);
      if (m) {
        return `https://publications.europa.eu/resource/celex/${m[1]}`;
      }
      return url;
    },
  },
  // publications.europa.eu — the cellar endpoint where EUR-Lex transformUrl
  // sends us. Same selector strategy; same exact-Accept requirement as above.
  {
    domain: 'publications.europa.eu',
    label: 'EU Publications Cellar',
    contentSelector: 'body',
    removeSelectors: [
      'nav', 'footer', 'header', 'script', 'style', 'noscript',
      'iframe', 'svg', 'img', 'button', 'input', 'form',
    ],
    headers: {
      'Accept': 'application/xhtml+xml',
      'Accept-Language': 'en',
    },
  },
  // GOV.UK — clean structure, use govspeak selector
  {
    domain: 'gov.uk',
    label: 'GOV.UK',
    contentSelector: '.govuk-govspeak, .gem-c-govspeak',
    removeSelectors: [
      'nav', 'footer', 'header', '.gem-c-print-link', '.govuk-breadcrumbs',
      '.govuk-back-link', '.gem-c-metadata', '.gem-c-share-links',
      '.gem-c-related-navigation', '.gem-c-contextual-sidebar',
      '.govuk-phase-banner', '.govuk-width-container > .govuk-grid-row > .govuk-grid-column-one-third',
    ],
  },
  // Cornell LII — eCFR / CFR sections, multi-page via section links
  {
    domain: 'law.cornell.edu',
    label: 'Cornell LII',
    contentSelector: '#content, .field-items, main',
    removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar', '#sidebar', '.breadcrumb'],
    strategy: 'multi_page',
    navSelector: '.toc-nav, #toc, .table-of-contents, .toc, aside nav',
    interPageDelayMs: 3_000,
  },
  // eCFR — federal regulations
  {
    domain: 'ecfr.gov',
    label: 'eCFR',
    contentSelector: 'main, .document-content, article',
    removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar'],
    strategy: 'multi_page',
    navSelector: '.toc-nav, .document-toc, aside nav',
    interPageDelayMs: 2_000,
  },
  // GDPR Info — multi-page with ~100 chapters, needs aggressive rate limiting
  {
    domain: 'gdpr-info.eu',
    label: 'GDPR Info',
    contentSelector: '.entry-content, article, main',
    removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar', '.comments', '.cookie-banner', '.wp-block-navigation'],
    strategy: 'multi_page',
    navSelector: '.sidebar nav, #sidebar ul, .widget_nav_menu ul, aside ul',
    interPageDelayMs: 3_000,
  },
  // LGPD Brazil — TOC links to individual article pages
  // Note: site wraps content in .frame — do NOT remove .frame
  {
    domain: 'lgpd-brazil.info',
    label: 'LGPD Brazil',
    contentSelector: '.content',
    removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar', '.comments', '.cookie-banner'],
    strategy: 'multi_page',
    navSelector: '#toc a',
    interPageDelayMs: 3_000,
  },
  // OWASP genai — tiles linking to individual LLM risk pages (Elementor/WordPress site)
  {
    domain: 'genai.owasp.org',
    label: 'OWASP GenAI',
    contentSelector: '#content, .entry-content, article, main',
    removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar', '.cookie-banner', '.ast-scroll-top-icon'],
    strategy: 'multi_page',
    navSelector: 'a[href*="/llmrisk/"]',
    interPageDelayMs: 2_000,
  },
  // GovInfo — US federal register
  {
    domain: 'govinfo.gov',
    label: 'GovInfo',
    contentSelector: 'pre, body',
    removeSelectors: ['head', 'script', 'style', 'nav', 'footer'],
  },
  // Australia gov — industry publications
  {
    domain: 'industry.gov.au',
    label: 'Australia Gov',
    contentSelector: 'main, article, .field--name-body',
    removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar', '.breadcrumb', 'img'],
  },
  // NIST publications — direct PDF, no special handling needed
  {
    domain: 'nvlpubs.nist.gov',
    label: 'NIST Pubs',
  },
  // Singapore PDPC
  {
    domain: 'pdpc.gov.sg',
    label: 'Singapore PDPC',
    headers: {
      'Accept': 'application/pdf,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  },
  // Cooley CCPA/CPRA compilation
  {
    domain: 'cdp.cooley.com',
    label: 'Cooley CCPA',
    contentSelector: 'article, .entry-content, main',
    removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar', '.comments', '.wp-block-navigation'],
  },
  // Stanford DigiChina
  {
    domain: 'digichina.stanford.edu',
    label: 'Stanford DigiChina',
    contentSelector: 'article, .entry-content, main',
    removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar', '.share-buttons'],
  },
  // China Law Translate — WordPress with full English translations of Chinese regulations
  {
    domain: 'chinalawtranslate.com',
    label: 'China Law Translate',
    contentSelector: '.entry-content',
    removeSelectors: [
      'nav', 'footer', 'script', 'style', '.sidebar', '.comments', '.cookie-banner',
      '.sharedaddy', '.sd-sharing', '.jp-relatedposts', '.post-navigation',
      '.author-info', '.molongui-authorship', 'img', '.wp-block-image',
    ],
  },
  // California Legislature
  {
    domain: 'leginfo.legislature.ca.gov',
    label: 'California Legislature',
    contentSelector: '#bill_all',
    removeSelectors: ['script', 'style', 'nav', 'footer', '.header', '#header'],
  },
  // GitHub repositories
  {
    domain: 'github.com',
    label: 'GitHub',
    strategy: 'github_repo',
  },
];

/**
 * Find a matching scraper profile for a given URL.
 */
export function getScraperProfile(url: string): ScraperProfile | null {
  try {
    const hostname = new URL(url).hostname;
    return SCRAPER_PROFILES.find((p) => hostname.includes(p.domain)) ?? null;
  } catch {
    return null;
  }
}

// CSS selectors to probe for navigation structures (ordered by specificity)
const NAV_SELECTORS = [
  // GOV.UK patterns
  '.gem-c-contents-list',
  '.govuk-grid-column-one-third nav',
  '.govuk-grid-column-one-quarter nav',
  // Common government site patterns
  'nav[aria-label*="contents"]',
  'nav[aria-label*="table of contents"]',
  'nav[aria-label*="navigation"]',
  'nav[role="navigation"]',
  '[role="navigation"]',
  // Sidebar patterns
  'aside nav',
  'aside ul',
  '.sidebar nav',
  '.sidebar ul',
  '.side-nav',
  '.sidenav',
  '#sidebar nav',
  '#sidebar ul',
  '#toc',
  '.toc',
  '.table-of-contents',
  '#table-of-contents',
  // EUR-Lex / EU patterns
  '.TOC',
  '.eli-main-title + nav',
  // US patterns (eCFR, congress.gov)
  '.toc-nav',
  '.document-toc',
  '.bill-text-toc',
  // Generic patterns
  'nav ul',
  'aside',
];

// ─── Fetch Helpers ───────────────────────────────────────────

async function fetchPage(url: string, extraHeaders?: Record<string, string>): Promise<{ html: string; finalUrl: string }> {
  const ua = nextUserAgent();
  const response = await fetch(url, {
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache',
      ...extraHeaders,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return { html: await response.text(), finalUrl: response.url };
}

async function fetchRawContent(url: string): Promise<string> {
  const ua = nextUserAgent();
  const response = await fetch(url, {
    headers: { 'User-Agent': ua, 'Accept': '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return response.text();
}

async function fetchBinary(url: string): Promise<Buffer> {
  const ua = nextUserAgent();
  const response = await fetch(url, {
    headers: { 'User-Agent': ua, 'Accept': 'application/pdf,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

// ─── Strategy Detection ──────────────────────────────────────

/**
 * Auto-detect the fetch strategy based on URL pattern.
 */
export function detectStrategy(url: string): HarvestStrategy {
  // GitHub repository pattern
  if (/^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+\/tree\//i.test(url)) {
    return 'github_repo';
  }
  // Default: we'll fetch the page and inspect for multi-page nav
  return 'single_page'; // Upgraded to multi_page if nav links to other pages are found
}

/**
 * Detect navigation structure in a fetched HTML page.
 * Probes known CSS selectors for sidebar/TOC elements and extracts links.
 */
export function detectNavigation(html: string, baseUrl: string): NavDetectionResult {
  const $ = cheerio.load(html);
  const parsedBase = new URL(baseUrl);
  const baseDomain = parsedBase.hostname;
  // Path prefix: allow links under the same path hierarchy
  const pathParts = parsedBase.pathname.split('/').filter(Boolean);
  const basePathPrefix = pathParts.length > 1
    ? '/' + pathParts.slice(0, -1).join('/')
    : '/';

  for (const selector of NAV_SELECTORS) {
    const navEl = $(selector).first();
    if (navEl.length === 0) continue;

    const links: DetectedNavLink[] = [];
    let order = 0;

    navEl.find('a[href]').each((_, el) => {
      const $a = $(el);
      const href = $a.attr('href');
      const text = $a.text().trim();
      if (!href || !text || text.length < 2) return;

      // Resolve relative URLs
      let resolved: URL;
      try {
        resolved = new URL(href, baseUrl);
      } catch {
        return; // Skip malformed URLs
      }

      // Only follow links on the same domain
      if (resolved.hostname !== baseDomain) return;

      // Only follow links under the same path prefix (prevent crawling off-topic)
      if (!resolved.pathname.startsWith(basePathPrefix)) return;

      const isAnchor = resolved.pathname === parsedBase.pathname && resolved.hash.length > 1;

      links.push({
        text,
        href: resolved.href,
        isAnchor,
        order: order++,
      });
    });

    if (links.length < 2) continue; // Need at least 2 nav links to be meaningful

    // Determine if single-page (all anchors) or multi-page (links to other URLs)
    const externalLinks = links.filter((l) => !l.isAnchor);
    const isSinglePage = externalLinks.length === 0;

    logger.info({
      selector,
      totalLinks: links.length,
      anchorLinks: links.length - externalLinks.length,
      pageLinks: externalLinks.length,
    }, `Nav detected via "${selector}": ${links.length} links (${externalLinks.length} to other pages)`);

    return {
      strategy: isSinglePage ? 'single_page' : 'multi_page',
      links,
      matchedSelector: selector,
      isSinglePage,
    };
  }

  // No navigation structure found
  return {
    strategy: 'single_page',
    links: [],
    isSinglePage: true,
  };
}

// ─── Extract Content (without stripping nav first) ───────────

/**
 * Extract the main text content from HTML, preserving headings as markdown.
 * This is a simplified version of the existing html-parser that doesn't
 * strip nav elements (since we already extracted nav info separately).
 */
function extractTextContent(html: string, profile?: ScraperProfile | null): string {
  const $ = cheerio.load(html);

  // Remove noise but keep navigation for structure context
  const baseRemoveSelectors = [
    'script', 'style', 'noscript', 'iframe', 'svg', 'img',
    'button', 'input', 'form', '.cookie-banner',
    'footer', 'header',
  ];
  // Merge profile-specific remove selectors
  const allRemoveSelectors = [...baseRemoveSelectors, ...(profile?.removeSelectors ?? [])];
  for (const sel of allRemoveSelectors) {
    $(sel).remove();
  }

  // Also remove nav/sidebar now that we've already detected links
  $('nav').remove();
  $('aside').remove();
  $('.sidebar').remove();

  const lines: string[] = [];
  const seen = new Set<string>();

  // Use profile content selector to narrow scope, falling back to body
  const root = profile?.contentSelector ? $(profile.contentSelector).first() : $('body');
  const searchRoot = root.length > 0 ? root : $('body');

  searchRoot.find('h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote, pre').each((_, el) => {
    const node = $(el);
    const tag = (el as Element).tagName?.toLowerCase();
    if (!tag) return;

    const text = node.text().replace(/\s+/g, ' ').trim();
    if (!text || text.length < 3) return;

    // Dedup within page
    const key = text.slice(0, 100);
    if (seen.has(key)) return;
    seen.add(key);

    if (tag === 'h1') lines.push(`\n# ${text}\n`);
    else if (tag === 'h2') lines.push(`\n## ${text}\n`);
    else if (tag === 'h3') lines.push(`\n### ${text}\n`);
    else if (tag === 'h4') lines.push(`\n#### ${text}\n`);
    else if (tag === 'h5' || tag === 'h6') lines.push(`\n##### ${text}\n`);
    else if (tag === 'li') lines.push(`- ${text}`);
    else if (tag === 'blockquote') lines.push(`> ${text}`);
    else lines.push(text);
  });

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── Strategy Implementations ────────────────────────────────

/**
 * Strategy 1: Single-page fetch.
 * All content is on one page. Just fetch and extract.
 */
async function harvestSinglePage(
  source: HarvestSource,
  profile?: ScraperProfile | null,
): Promise<{ content: string; pageCount: number }> {
  logger.info({ url: source.url, name: source.name, profile: profile?.label }, 'Harvesting single page');

  if (source.fileType === 'pdf') {
    const buffer = await fetchBinary(source.url);
    // Return raw PDF as base64 — the PVS worker will parse it
    return { content: buffer.toString('base64'), pageCount: 1 };
  }

  const { html } = await fetchPage(source.url, profile?.headers);
  const content = extractTextContent(html, profile);
  return { content, pageCount: 1 };
}

/**
 * Strategy 2: Multi-page sidebar navigation.
 * Fetch main page, detect nav, follow links, concatenate content.
 */
async function harvestMultiPage(
  source: HarvestSource,
  navLinks: DetectedNavLink[],
  profile?: ScraperProfile | null,
): Promise<{ content: string; pageCount: number }> {
  const pageLinks = navLinks.filter((l) => !l.isAnchor);
  const cappedLinks = pageLinks.slice(0, MAX_NAV_PAGES);

  logger.info({
    url: source.url,
    name: source.name,
    totalLinks: pageLinks.length,
    capped: cappedLinks.length,
  }, 'Harvesting multi-page document');

  const sections: string[] = [];
  let fetched = 0;

  for (const link of cappedLinks) {
    try {
      const { html } = await fetchPage(link.href, profile?.headers);
      const text = extractTextContent(html, profile);
      const wordCount = text.split(/\s+/).filter(Boolean).length;

      if (wordCount < MIN_CONTENT_WORDS) {
        logger.warn({ url: link.href, words: wordCount },
          `Skipping thin page (${wordCount} words): ${link.text}`);
        continue;
      }

      // Add section separator with breadcrumb
      sections.push(`\n\n--- Section: ${link.text} ---\n\n${text}`);
      fetched++;

      // Rate limit: don't hammer the server (profile may override delay)
      if (fetched < cappedLinks.length) {
        await new Promise((r) => setTimeout(r, profile?.interPageDelayMs ?? INTER_PAGE_DELAY_MS));
      }

      broadcastEvent({
        type: 'forge.progress',
        data: {
          phase: 'harvest',
          documentName: source.name,
          detail: `Fetched page ${fetched}/${cappedLinks.length}: ${link.text}`,
          percentComplete: Math.round((fetched / cappedLinks.length) * 100),
        },
        jurisdiction: source.jurisdiction,
      });
    } catch (err) {
      logger.warn({ url: link.href, error: (err as Error).message },
        `Failed to fetch nav page: ${link.text}`);
      // Continue with other pages — partial fetch is better than nothing
    }
  }

  if (sections.length === 0) {
    throw new Error(`Multi-page harvest produced zero content from ${cappedLinks.length} links`);
  }

  return { content: sections.join('\n'), pageCount: fetched };
}

/**
 * Strategy 3: GitHub repository directory.
 * Lists files via GitHub API, fetches raw content of each, concatenates in order.
 */
async function harvestGitHubRepo(
  source: HarvestSource,
): Promise<{ content: string; pageCount: number; fileType: 'md' | 'html' }> {
  // Parse GitHub URL: https://github.com/{owner}/{repo}/tree/{branch}/{path}
  const match = source.url.match(
    /github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)/,
  );
  if (!match) throw new Error(`Invalid GitHub repo URL: ${source.url}`);

  const [, owner, repo, branch, dirPath] = match;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}?ref=${branch}`;

  logger.info({ owner, repo, branch, dirPath }, 'Harvesting GitHub repo directory');

  const response = await fetch(apiUrl, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Nomus-Forge/1.0',
      ...(process.env.GITHUB_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const files = (await response.json()) as Array<{
    name: string;
    type: string;
    download_url: string | null;
    path: string;
  }>;

  // Filter to supported files and sort by name (uses numbered prefixes)
  // Includes .json and .xml for structured data sources (OSCAL, etc.)
  const supportedFiles = files
    .filter((f) => f.type === 'file' && /\.(md|html|htm|txt|json|xml|yaml|yml)$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (supportedFiles.length === 0) {
    throw new Error(`No supported files found in ${source.url}`);
  }

  logger.info({ fileCount: supportedFiles.length, files: supportedFiles.map((f) => f.name) },
    `Found ${supportedFiles.length} files to fetch`);

  const sections: string[] = [];
  let fetched = 0;

  // Detect primary file type from first file
  const primaryExt = supportedFiles[0].name.match(/\.(md|html|htm)$/i)?.[1]?.toLowerCase();
  const detectedType: 'md' | 'html' = primaryExt === 'md' ? 'md' : 'html';

  for (const file of supportedFiles) {
    if (!file.download_url) {
      logger.warn({ file: file.name }, 'No download URL — skipping');
      continue;
    }

    try {
      const raw = await fetchRawContent(file.download_url);
      const wordCount = raw.split(/\s+/).filter(Boolean).length;

      if (wordCount < 10) {
        logger.warn({ file: file.name, words: wordCount }, 'Skipping near-empty file');
        continue;
      }

      sections.push(`\n\n--- File: ${file.name} ---\n\n${raw}`);
      fetched++;

      // Polite rate limiting for GitHub
      if (fetched < supportedFiles.length) {
        await new Promise((r) => setTimeout(r, 500));
      }

      broadcastEvent({
        type: 'forge.progress',
        data: {
          phase: 'harvest',
          documentName: source.name,
          detail: `Fetched file ${fetched}/${supportedFiles.length}: ${file.name}`,
          percentComplete: Math.round((fetched / supportedFiles.length) * 100),
        },
        jurisdiction: source.jurisdiction,
      });
    } catch (err) {
      logger.warn({ file: file.name, error: (err as Error).message },
        `Failed to fetch file: ${file.name}`);
    }
  }

  if (sections.length === 0) {
    throw new Error(`GitHub harvest produced zero content from ${supportedFiles.length} files`);
  }

  return { content: sections.join('\n'), pageCount: fetched, fileType: detectedType };
}

// ─── Main Harvest Function ───────────────────────────────────

/**
 * Harvest a single regulatory source.
 * Auto-detects strategy, fetches content, saves to regulations directory.
 */
export async function harvestSource(source: HarvestSource): Promise<HarvestResult> {
  const startTime = performance.now();

  try {
    const docDir = getDocumentDir(source.jurisdiction, source.name);
    const existingManifest = readManifest(docDir);

    // Look up scraper profile for this domain
    const profile = getScraperProfile(source.url);
    if (profile) {
      logger.info({ profile: profile.label, url: source.url }, `Using scraper profile: ${profile.label}`);
    }

    // Apply URL transformation from profile (e.g., EUR-Lex HTML → TXT)
    const effectiveUrl = profile?.transformUrl ? profile.transformUrl(source.url) : source.url;

    // Determine strategy — profile can force a strategy, otherwise auto-detect
    let strategy: HarvestStrategy = source.strategy ?? profile?.strategy ?? detectStrategy(effectiveUrl);
    let content: string;
    let pageCount: number;
    let fileType: 'html' | 'pdf' | 'md' = source.fileType ?? 'html';

    if (strategy === 'github_repo') {
      const result = await harvestGitHubRepo({ ...source, url: effectiveUrl });
      content = result.content;
      pageCount = result.pageCount;
      fileType = result.fileType;
    } else {
      // Fetch main page first to detect navigation
      if (fileType === 'pdf') {
        const result = await harvestSinglePage({ ...source, url: effectiveUrl }, profile);
        content = result.content;
        pageCount = result.pageCount;
        strategy = 'single_page';
      } else {
        const { html, finalUrl } = await fetchPage(effectiveUrl, profile?.headers);

        // Use profile's navSelector if available, otherwise probe all selectors
        const navResult = detectNavigation(html, finalUrl);
        strategy = profile?.strategy ?? navResult.strategy;

        if (strategy === 'multi_page' && navResult.links.length > 0) {
          const result = await harvestMultiPage({ ...source, url: effectiveUrl }, navResult.links, profile);
          content = result.content;
          pageCount = result.pageCount;
        } else {
          // Single page — extract content from already-fetched HTML
          content = extractTextContent(html, profile);
          pageCount = 1;
        }
      }
    }

    // Compute hash for dedup
    const contentHash = hashString(content);

    // Check if already fetched with same content
    if (existingManifest && existingManifest.contentHash === contentHash) {
      const duration = Math.round(performance.now() - startTime);
      logger.info({ name: source.name, hash: contentHash.slice(0, 12) },
        'Document unchanged — skipping');
      return {
        source,
        status: 'skipped',
        contentHash,
        durationMs: duration,
      };
    }

    // Save content
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    saveDocumentContent(docDir, content, fileType);

    // Write manifest
    const manifest: DocumentManifest = {
      sourceId: source.sourceId,
      name: source.name,
      jurisdiction: source.jurisdiction,
      url: source.url,
      fileType,
      fetchedAt: new Date().toISOString(),
      contentHash,
      wordCount,
      pageCount,
      strategy,
    };
    writeManifest(docDir, manifest);

    const duration = Math.round(performance.now() - startTime);

    logger.info({
      name: source.name,
      jurisdiction: source.jurisdiction,
      strategy,
      pages: pageCount,
      words: wordCount,
      hash: contentHash.slice(0, 12),
      durationMs: duration,
    }, `Harvested: ${source.name} (${strategy}, ${pageCount} pages, ${wordCount} words)`);

    return {
      source,
      status: 'fetched',
      savedPath: docDir,
      contentHash,
      pageCount,
      wordCount,
      strategy,
      durationMs: duration,
    };
  } catch (err) {
    const duration = Math.round(performance.now() - startTime);
    const error = err instanceof Error ? err.message : String(err);

    logger.error({ name: source.name, url: source.url, error },
      `Harvest failed: ${source.name}`);

    return {
      source,
      status: 'failed',
      error,
      durationMs: duration,
    };
  }
}

/**
 * Harvest all sources from a list.
 * Returns a manifest with results for each source.
 */
export async function harvestAll(
  sources: HarvestSource[],
  onProgress?: (completed: number, total: number, current: HarvestResult) => void,
): Promise<HarvestManifest> {
  ensureRegulationsDir();
  const results: HarvestResult[] = [];

  for (let i = 0; i < sources.length; i++) {
    const result = await harvestSource(sources[i]);
    results.push(result);

    onProgress?.(i + 1, sources.length, result);

    broadcastEvent({
      type: 'forge.progress',
      data: {
        phase: 'harvest',
        documentName: sources[i].name,
        detail: `Harvested ${i + 1}/${sources.length}: ${sources[i].name} (${result.status})`,
        percentComplete: Math.round(((i + 1) / sources.length) * 100),
      },
      jurisdiction: sources[i].jurisdiction,
    });

    // Rate limit between sources
    if (i < sources.length - 1 && result.status === 'fetched') {
      await new Promise((r) => setTimeout(r, INTER_PAGE_DELAY_MS));
    }
  }

  const manifest: HarvestManifest = {
    harvestedAt: new Date().toISOString(),
    totalSources: sources.length,
    fetched: results.filter((r) => r.status === 'fetched').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results,
  };

  logger.info({
    total: manifest.totalSources,
    fetched: manifest.fetched,
    failed: manifest.failed,
    skipped: manifest.skipped,
  }, 'Harvest complete');

  return manifest;
}

/**
 * Build a harvest source list from the existing regulatory sources in the DB.
 */
export async function buildSourceListFromDb(): Promise<HarvestSource[]> {
  const { getDb } = await import('../db/client.js');
  const { regulatorySources } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');

  const db = getDb();
  const sources = db.select({
    id: regulatorySources.id,
    name: regulatorySources.name,
    jurisdiction: regulatorySources.jurisdiction,
    url: regulatorySources.url,
    parserType: regulatorySources.parserType,
  }).from(regulatorySources)
    .where(eq(regulatorySources.isActive, true))
    .all();

  return sources.map((s) => ({
    url: s.url,
    name: s.name,
    jurisdiction: s.jurisdiction,
    fileType: s.parserType as 'html' | 'pdf',
    sourceId: s.id,
  }));
}

/**
 * Get the list of sources that failed to harvest (the "missing" list).
 */
export function getMissingSources(manifest: HarvestManifest): Array<{
  name: string;
  jurisdiction: string;
  url: string;
  error: string;
}> {
  return manifest.results
    .filter((r) => r.status === 'failed')
    .map((r) => ({
      name: r.source.name,
      jurisdiction: r.source.jurisdiction,
      url: r.source.url,
      error: r.error ?? 'Unknown error',
    }));
}

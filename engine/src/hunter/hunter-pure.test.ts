/**
 * Hunter pure-function tests — covers scrape-healer repair functions,
 * structural-verifier (no-LLM happy path), and content-cache hit/miss.
 *
 * Closes a chunk of the UNTESTED-but-probably-works gap from the 2026-04-07
 * end-to-end audit. These functions are pure or filesystem-only — no LLM,
 * no network, no DB.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// vi.mock the LLM provider so structural-verifier's spot-check path is
// neutralized — it will always throw, which is the documented fail-open
// behavior. We test the path that doesn't trigger the spot-check anyway.
vi.mock('../llm/provider.js', () => ({
  resolveProvider: vi.fn().mockRejectedValue(new Error('LLM disabled in tests')),
}));

import {
  repairEncoding,
  repairHtml,
  repairOcrArtifacts,
  sanitizeContent,
} from './scrape-healer.js';
import { verifyStructure } from './structural-verifier.js';
import {
  saveCacheContent,
  getCachedContent,
  hasCachedContent,
  getCacheAge,
  clearCache,
  getCacheSummary,
} from './content-cache.js';

// ════════════════════════════════════════════════════════════════════
// scrape-healer repair functions (pure)
// ════════════════════════════════════════════════════════════════════

describe('repairEncoding', () => {
  it('strips UTF-8 BOM', () => {
    const input = '\uFEFFArticle 1';
    const out = repairEncoding(input);
    expect(out.charCodeAt(0)).not.toBe(0xFEFF);
    expect(out).toBe('Article 1');
  });

  it('replaces common mojibake sequences', () => {
    const input = 'Article cinquiÃ¨me'; // "cinquième" mojibake
    const out = repairEncoding(input);
    expect(out).not.toMatch(/Ã/);
  });

  it('replaces smart quote mojibake (â€™ → apostrophe)', () => {
    // Real-world: UTF-8 right single quote (\u2019) interpreted as Latin-1
    // produces the byte sequence 0xE2 0x80 0x99 which renders as â€™
    const input = 'The Commissionâ€™s decision';
    const out = repairEncoding(input);
    expect(out).not.toMatch(/â€/);
    expect(out).toBe("The Commission's decision");
  });

  it('removes null bytes and C0 control characters', () => {
    const input = 'Article\x00 1\x07';
    const out = repairEncoding(input);
    expect(out).not.toMatch(/[\x00\x07]/);
  });

  it('replaces Unicode replacement char runs with single space', () => {
    const input = 'Article\uFFFD\uFFFD\uFFFD1';
    const out = repairEncoding(input);
    expect(out).not.toMatch(/\uFFFD/);
    expect(out).toBe('Article 1');
  });

  it('collapses double spaces', () => {
    const input = 'Article  1   text';
    const out = repairEncoding(input);
    expect(out).toBe('Article 1 text');
  });

  it('is idempotent', () => {
    const input = 'Article cinquiÃ¨me\uFEFF';
    const once = repairEncoding(input);
    const twice = repairEncoding(once);
    expect(twice).toBe(once);
  });
});

describe('repairHtml', () => {
  it('strips script and style blocks entirely from full HTML', () => {
    const input = '<html><body><script>alert("xss")</script>Real text<style>body{}</style></body></html>';
    const out = repairHtml(input);
    expect(out).not.toMatch(/script|style|alert/);
    expect(out).toContain('Real text');
  });

  it('strips nav, header, footer from full HTML', () => {
    const input = '<html><body><nav>menu</nav><header>top</header>Real text<footer>bot</footer></body></html>';
    const out = repairHtml(input);
    expect(out).not.toContain('menu');
    expect(out).not.toContain('top');
    expect(out).not.toContain('bot');
    expect(out).toContain('Real text');
  });

  it('decodes common HTML entities', () => {
    const input = '<html><body>Article &amp; recital &nbsp; 1 &lt;5&gt;</body></html>';
    const out = repairHtml(input);
    expect(out).toContain('&');
    expect(out).toContain('<5>');
  });

  it('removes residual standalone tags from non-HTML content', () => {
    const input = 'Article 1<br>continues<p>text</p>';
    const out = repairHtml(input);
    expect(out).not.toMatch(/<\/?[a-z]+>/i);
  });
});

describe('repairOcrArtifacts', () => {
  it('rejoins hyphenated line breaks', () => {
    const input = 'regu-\nlation';
    const out = repairOcrArtifacts(input);
    expect(out).toContain('regulation');
  });

  it('inserts space between merged words', () => {
    const input = 'theRegulation';
    const out = repairOcrArtifacts(input);
    expect(out).toBe('the Regulation');
  });

  it('fixes missing space after period', () => {
    const input = 'one.Two three.Four';
    const out = repairOcrArtifacts(input);
    expect(out).toContain('one. Two');
    expect(out).toContain('three. Four');
  });
});

describe('sanitizeContent', () => {
  it('removes Cloudflare challenge fragments', () => {
    const input = 'Real content\nChecking your browser before accessing example.com.\nMore content';
    const out = sanitizeContent(input);
    expect(out).not.toMatch(/Checking your browser/i);
    expect(out).toContain('Real content');
    expect(out).toContain('More content');
  });

  it('removes Cloudflare Ray ID', () => {
    const input = 'Document text. Ray ID: abc123def456';
    const out = sanitizeContent(input);
    expect(out).not.toMatch(/Ray ID/);
  });

  it('removes CAPTCHA prompts', () => {
    const input = 'Real text. I am not a robot. More text.';
    const out = sanitizeContent(input);
    expect(out).not.toMatch(/I am not a robot/i);
  });

  it('removes "enable JavaScript" notices', () => {
    const input = 'Document. Please enable JavaScript to continue.';
    const out = sanitizeContent(input);
    expect(out).not.toMatch(/enable JavaScript/i);
  });

  it('removes cookie consent fragments', () => {
    const input = 'Article 1. We use cookies to enhance your experience. Article 2.';
    const out = sanitizeContent(input);
    expect(out).not.toMatch(/We use cookies/i);
    expect(out).toContain('Article 1');
    expect(out).toContain('Article 2');
  });
});

// ════════════════════════════════════════════════════════════════════
// structural-verifier (no-LLM happy path)
// ════════════════════════════════════════════════════════════════════

function makeRegulationText(articles: number): string {
  // Build a synthetic regulatory document that passes the structural checks:
  // > 100 words, sequential articles, plausible legal vocabulary, no
  // suspicious content in the first 500 chars.
  const parts: string[] = ['REGULATION (EU) 2024/1689 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL'];
  parts.push('THE EUROPEAN PARLIAMENT AND THE COUNCIL OF THE EUROPEAN UNION,');
  parts.push('Having regard to the Treaty on the Functioning of the European Union,');
  parts.push('HAVE ADOPTED THIS REGULATION:');
  for (let i = 1; i <= articles; i++) {
    parts.push(`Article ${i}`);
    parts.push(`This article sets out the obligations of providers and users with respect to compliance, monitoring, transparency, and enforcement under this Regulation. Member States shall ensure adequate measures are in place. The Commission shall publish guidance.`);
  }
  parts.push('Done at Brussels.');
  return parts.join('\n\n');
}

describe('verifyStructure', () => {
  it('passes a well-structured document with sequential articles', async () => {
    const text = makeRegulationText(15);
    const result = await verifyStructure(text, 'EU AI Act', 'EU');
    // No errors should be raised on a clean sequential document.
    // The LLM spot-check may still get triggered by warnings — vi.mock above
    // makes resolveProvider throw, which is the documented fail-open path.
    expect(result.issues.filter((i) => i.severity === 'error').length).toBe(0);
    expect(result.stats.articlesFound).toBeGreaterThanOrEqual(15);
  });

  it('flags too-short documents as too_short error', async () => {
    const text = 'Article 1. Short.';
    const result = await verifyStructure(text, 'Test', 'EU');
    expect(result.issues.some((i) => i.type === 'too_short')).toBe(true);
  });

  it('detects sequential gaps in article numbering', async () => {
    // Build a document missing articles 5-9
    const parts: string[] = ['REGULATION 2024/1689 EUROPEAN PARLIAMENT'];
    parts.push('Having regard to the Treaty on the Functioning of the European Union,');
    parts.push('HAVE ADOPTED THIS REGULATION:');
    for (const i of [1, 2, 3, 4, 10, 11, 12, 13, 14, 15]) {
      parts.push(`Article ${i}`);
      parts.push(`This article sets out the obligations of providers and users with respect to compliance, monitoring, transparency, and enforcement under this Regulation. Member States shall ensure adequate measures are in place.`);
    }
    const text = parts.join('\n\n');
    const result = await verifyStructure(text, 'Test EU Regulation', 'EU');
    const gapIssue = result.issues.find((i) => i.type === 'gap');
    expect(gapIssue).toBeDefined();
    expect(gapIssue!.description).toMatch(/article\s*4/i);
    expect(gapIssue!.description).toMatch(/10/);
  });

  it('flags suspicious content in the first 500 chars', async () => {
    const text = 'We use cookies to enhance your experience. ' + makeRegulationText(15);
    const result = await verifyStructure(text, 'Test', 'EU');
    const susp = result.issues.find((i) => i.type === 'suspicious_content');
    expect(susp).toBeDefined();
  });

  it('returns a stats object with article and section counts', async () => {
    const text = makeRegulationText(20);
    const result = await verifyStructure(text, 'EU AI Act', 'EU');
    expect(result.stats).toBeDefined();
    expect(typeof result.stats.articlesFound).toBe('number');
    expect(typeof result.stats.estimatedCompleteness).toBe('number');
    expect(result.stats.articlesFound).toBeGreaterThanOrEqual(20);
    expect(result.stats.estimatedCompleteness).toBeGreaterThan(0);
    expect(result.stats.estimatedCompleteness).toBeLessThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// content-cache (filesystem)
// ════════════════════════════════════════════════════════════════════

describe('content-cache', () => {
  let tmp: string;
  const sourceId = 'test-source-' + Date.now();

  beforeEach(() => {
    // Redirect the cache to a fresh temp dir per test via the env var.
    // The lazy getCacheDir() reads this on every call, so test isolation
    // is guaranteed without process.chdir tricks.
    tmp = mkdtempSync(join(tmpdir(), 'nomus-cache-test-'));
    process.env.NOMUS_CONTENT_CACHE_DIR = tmp;
  });

  afterEach(() => {
    delete process.env.NOMUS_CONTENT_CACHE_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('round-trips HTML content (save → has → get)', () => {
    const html = '<html><body><h1>Test</h1>' + 'Article 1 lorem ipsum dolor sit amet '.repeat(20) + '</body></html>';
    saveCacheContent(sourceId, html, 'html', 'https://example.com');
    expect(hasCachedContent(sourceId)).toBe(true);
    const entry = getCachedContent(sourceId);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe(html);
    expect(entry!.metadata.sourceUrl).toBe('https://example.com');
    expect(entry!.metadata.contentHash).toBeTruthy();
    expect(entry!.metadata.wordCount).toBeGreaterThan(50);
  });

  it('returns null for missing source', () => {
    expect(getCachedContent('does-not-exist')).toBeNull();
    expect(hasCachedContent('does-not-exist')).toBe(false);
    expect(getCacheAge('does-not-exist')).toBeNull();
  });

  it('reports cache age in hours', () => {
    saveCacheContent(sourceId, 'x'.repeat(500), 'html');
    const age = getCacheAge(sourceId);
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
    expect(age!).toBeLessThan(0.01); // just-saved → near zero
  });

  it('clearCache removes content + meta files', () => {
    saveCacheContent(sourceId, 'x'.repeat(500), 'html');
    expect(hasCachedContent(sourceId)).toBe(true);
    expect(clearCache(sourceId)).toBe(true);
    expect(hasCachedContent(sourceId)).toBe(false);
    expect(getCachedContent(sourceId)).toBeNull();
  });

  it('clearCache returns false when nothing to delete', () => {
    expect(clearCache('never-cached')).toBe(false);
  });

  it('getCacheSummary lists every cached source', () => {
    saveCacheContent(`${sourceId}-a`, 'x'.repeat(500), 'html');
    saveCacheContent(`${sourceId}-b`, 'y'.repeat(500), 'html');
    const summary = getCacheSummary();
    const ids = summary.map((s) => s.sourceId);
    expect(ids).toContain(`${sourceId}-a`);
    expect(ids).toContain(`${sourceId}-b`);
    for (const item of summary) {
      expect(item.sizeBytes).toBeGreaterThan(0);
      expect(item.wordCount).toBeGreaterThanOrEqual(0);
      expect(item.contentHash).toBeTruthy();
    }
  });

  it('uses .pdf extension when parserType is pdf', () => {
    const base64Pdf = Buffer.from('%PDF-1.4\nfake pdf bytes here for testing purposes only and we need this string to be substantially long to pass the cache write min length checks if any apply').toString('base64');
    saveCacheContent(sourceId, base64Pdf, 'pdf');
    expect(existsSync(join(tmp, `${sourceId}.pdf`))).toBe(true);
  });
});

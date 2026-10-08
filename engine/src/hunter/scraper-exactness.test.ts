/**
 * Scraper completeness + provenance tests.
 *
 *   - Multi-page assembly is completeness-or-fail: if ANY expected section is
 *     skipped, the whole fetch fails (MultiPageIncompleteError). It NEVER falls
 *     back to the landing/ToC page as if it were the regulation.
 *   - A cache fallback carries 'stale_cache' provenance (non-promotable).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { fetchMultiPageContent, MultiPageIncompleteError, scrapeSource } from './scraper.js';
import { saveCacheContent } from './content-cache.js';
import { isPromotableProvenance } from './provenance.js';
import type { ScraperProfile } from '../forge/harvester.js';

const LANDING_URL = 'https://law.example.gov/reg';

const PROFILE: ScraperProfile = {
  domain: 'law.example.gov',
  label: 'test multipage',
  contentSelector: 'body',
  strategy: 'multi_page',
  navSelector: 'nav.toc a',
  interPageDelayMs: 0,
};

function longParagraph(marker: string): string {
  return `<p>${marker} The provider of a high-risk artificial intelligence system shall establish implement document and maintain a risk management system in relation to the high-risk AI system throughout its entire lifecycle ensuring that Member States and the Commission are able to verify compliance with every applicable obligation set out under this Regulation.</p>`;
}

const LANDING_HTML = `<html><body>
  <nav class="toc">
    <a href="/reg/a">Section A</a>
    <a href="/reg/b">Section B</a>
    <a href="/reg/c">Section C</a>
  </nav>
</body></html>`;

function makeResp(url: string, status: number, html: string) {
  const buf = Buffer.from(html, 'utf-8');
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    redirected: false,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('fetchMultiPageContent completeness-or-fail', () => {
  const emit = () => {};

  it('returns assembled text when EVERY section is captured', async () => {
    const pages: Record<string, { status: number; html: string }> = {
      [LANDING_URL]: { status: 200, html: LANDING_HTML },
      'https://law.example.gov/reg/a': { status: 200, html: `<html><body>${longParagraph('AAA-CONTENT')}</body></html>` },
      'https://law.example.gov/reg/b': { status: 200, html: `<html><body>${longParagraph('BBB-CONTENT')}</body></html>` },
      'https://law.example.gov/reg/c': { status: 200, html: `<html><body>${longParagraph('CCC-CONTENT')}</body></html>` },
    };
    global.fetch = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      const p = pages[url];
      return makeResp(url, p?.status ?? 404, p?.html ?? '') as any;
    });

    const result = await fetchMultiPageContent(LANDING_URL, PROFILE, {}, emit);
    expect(result.sectionsSkipped).toBe(0);
    expect(result.sectionsFetched).toBe(3);
    expect(result.text).toContain('AAA-CONTENT');
    expect(result.text).toContain('BBB-CONTENT');
    expect(result.text).toContain('CCC-CONTENT');
    // Per-section manifest is present (landing + 3 sections).
    expect(result.manifest.length).toBe(4);
  });

  it('HARD-FAILS when a single section is missing (never promotes partial)', async () => {
    const pages: Record<string, { status: number; html: string }> = {
      [LANDING_URL]: { status: 200, html: LANDING_HTML },
      'https://law.example.gov/reg/a': { status: 200, html: `<html><body>${longParagraph('AAA-CONTENT')}</body></html>` },
      'https://law.example.gov/reg/b': { status: 503, html: '' }, // transient failure
      'https://law.example.gov/reg/c': { status: 200, html: `<html><body>${longParagraph('CCC-CONTENT')}</body></html>` },
    };
    global.fetch = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      const p = pages[url];
      return makeResp(url, p?.status ?? 404, p?.html ?? '') as any;
    });

    await expect(fetchMultiPageContent(LANDING_URL, PROFILE, {}, emit))
      .rejects.toBeInstanceOf(MultiPageIncompleteError);
  });

  it('NEVER falls back to the landing/ToC page when all sections fail', async () => {
    const pages: Record<string, { status: number; html: string }> = {
      [LANDING_URL]: { status: 200, html: LANDING_HTML },
      'https://law.example.gov/reg/a': { status: 503, html: '' },
      'https://law.example.gov/reg/b': { status: 503, html: '' },
      'https://law.example.gov/reg/c': { status: 503, html: '' },
    };
    global.fetch = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      const p = pages[url];
      return makeResp(url, p?.status ?? 404, p?.html ?? '') as any;
    });

    // The old behaviour returned the landing page as `contentQuality: valid`.
    // Now it must throw rather than promote a table of contents as the law.
    await expect(fetchMultiPageContent(LANDING_URL, PROFILE, {}, emit))
      .rejects.toThrow(/incomplete/i);
  });
});

describe('scrapeSource cache fallback provenance', () => {
  let tmp: string;
  const sourceId = 'stale-cache-test-' + Date.now();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomus-cache-'));
    process.env.NOMUS_CONTENT_CACHE_DIR = tmp;
  });

  afterEach(() => {
    delete process.env.NOMUS_CONTENT_CACHE_DIR;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('marks a cache hit as stale_cache (non-promotable) when live is unreachable', async () => {
    saveCacheContent(
      sourceId,
      'Article 1\nThis regulation lays down harmonised rules on artificial intelligence and applies throughout the Union.',
      'html',
    );

    // Every live fetch fails fast (AbortError → no inter-attempt backoff sleep).
    global.fetch = vi.fn(async () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    }) as any;

    const result = await scrapeSource('https://unreachable.example.gov/reg', 'html', {}, {
      sourceId,
      sourceName: 'Unreachable Source',
    });

    expect(result.source).toBe('cache');
    expect(result.provenanceMode).toBe('stale_cache');
    expect(isPromotableProvenance(result.provenanceMode)).toBe(false);
  });
});

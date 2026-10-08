/**
 * CELEX resolver tests.
 *
 * Verifies the consolidated-version resolution and amendment-awareness logic
 * against mocked Cellar responses shaped exactly like the live ones observed
 * on 2026-07-24 (EU AI Act: one consolidated version 02024R1689-20240712 with
 * no retrievable content yet, one amending act 32026R1744 — the Digital
 * Omnibus — dated 2026-07-08).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  extractCelex,
  resolveEurLexUrl,
  listConsolidatedCelex,
  listAmendingActs,
} from './sources/celex-resolver.js';

const EU_AI_ACT_URL = 'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32024R1689';

function sparqlResponse(bindings: Array<Record<string, string>>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: {
        bindings: bindings.map((row) =>
          Object.fromEntries(Object.entries(row).map(([k, v]) => [k, { value: v }])),
        ),
      },
    }),
  };
}

function probeResponse(ok: boolean) {
  return {
    ok,
    status: ok ? 200 : 404,
    body: { cancel: async () => {} },
  };
}

/**
 * Mock fetch routing on URL + query content:
 *  - SPARQL with STRSTARTS → consolidated-version listing
 *  - SPARQL with amends    → amending-acts listing
 *  - resource/celex/<id>   → content probe
 */
function mockCellar(opts: {
  versions: string[];
  amendments: Array<{ celex: string; date?: string }>;
  retrievable: Set<string>;
}) {
  return vi.fn(async (input: any) => {
    const url = String(input);
    if (url.includes('/webapi/rdf/sparql')) {
      const query = decodeURIComponent(url);
      if (query.includes('STRSTARTS')) {
        return sparqlResponse(opts.versions.map((celex) => ({ celex })));
      }
      if (query.includes('amends')) {
        return sparqlResponse(
          opts.amendments.map((a): Record<string, string> =>
            a.date ? { celex: a.celex, date: a.date } : { celex: a.celex },
          ),
        );
      }
      throw new Error(`Unexpected SPARQL query: ${query.slice(0, 120)}`);
    }
    const m = url.match(/resource\/celex\/(.+)$/);
    if (m) return probeResponse(opts.retrievable.has(m[1]));
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe('extractCelex', () => {
  it('extracts an as-adopted CELEX from a EUR-Lex URL', () => {
    expect(extractCelex(EU_AI_ACT_URL)).toBe('32024R1689');
  });

  it('extracts a dated consolidated CELEX', () => {
    expect(
      extractCelex('https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02024R1689-20240712'),
    ).toBe('02024R1689-20240712');
  });

  it('handles percent-encoded colons', () => {
    expect(
      extractCelex('https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32022R2554'),
    ).toBe('32022R2554');
  });

  it('returns null when no CELEX is present', () => {
    expect(extractCelex('https://www.gov.uk/ai-regulation')).toBeNull();
  });
});

describe('resolveEurLexUrl', () => {
  it('rewrites to the newest consolidated version when its content is retrievable', async () => {
    const fetchImpl = mockCellar({
      versions: ['02024R1689-20240712', '02024R1689-20270101'],
      amendments: [{ celex: '32026R1744', date: '2026-07-08' }],
      retrievable: new Set(['02024R1689-20240712', '02024R1689-20270101']),
    });

    const res = await resolveEurLexUrl(EU_AI_ACT_URL, { fetchImpl });
    expect(res.consolidated).toBe(true);
    expect(res.resolvedCelex).toBe('02024R1689-20270101');
    expect(res.url).toContain('CELEX:02024R1689-20270101');
    // 2026-07-08 amendment is INSIDE the 2027-01-01 consolidation — not pending.
    expect(res.pendingAmendments).toEqual([]);
  });

  it('falls back to an older consolidated version when the newest has no content yet', async () => {
    const fetchImpl = mockCellar({
      versions: ['02024R1689-20240712', '02024R1689-20270101'],
      amendments: [{ celex: '32026R1744', date: '2026-07-08' }],
      retrievable: new Set(['02024R1689-20240712']),
    });

    const res = await resolveEurLexUrl(EU_AI_ACT_URL, { fetchImpl });
    expect(res.resolvedCelex).toBe('02024R1689-20240712');
    // The omnibus postdates the fetched consolidation → pending.
    expect(res.pendingAmendments).toEqual([{ celex: '32026R1744', date: '2026-07-08' }]);
  });

  it('falls back to the as-adopted text and flags pending amendments when no consolidation is retrievable (live 2026-07-24 shape)', async () => {
    const events: Array<{ tier: number; message: string }> = [];
    const fetchImpl = mockCellar({
      versions: ['02024R1689-20240712'],
      amendments: [{ celex: '32026R1744', date: '2026-07-08' }],
      retrievable: new Set(),
    });

    const res = await resolveEurLexUrl(EU_AI_ACT_URL, {
      fetchImpl,
      emit: (tier, message) => events.push({ tier, message }),
    });

    expect(res.consolidated).toBe(false);
    expect(res.resolvedCelex).toBe('32024R1689');
    expect(res.url).toBe(EU_AI_ACT_URL);
    expect(res.pendingAmendments.map((a) => a.celex)).toEqual(['32026R1744']);
    // Law-changed-but-text-lags must be surfaced, not silent (tier 2).
    const tier2 = events.filter((e) => e.tier === 2);
    expect(tier2).toHaveLength(1);
    expect(tier2[0].message).toContain('32026R1744');
  });

  it('returns the original URL and emits tier 2 when SPARQL fails', async () => {
    const events: Array<{ tier: number; message: string }> = [];
    const failing = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;

    const res = await resolveEurLexUrl(EU_AI_ACT_URL, {
      fetchImpl: failing,
      emit: (tier, message) => events.push({ tier, message }),
    });

    expect(res.url).toBe(EU_AI_ACT_URL);
    expect(res.consolidated).toBe(false);
    expect(events.some((e) => e.tier === 2 && e.message.includes('resolution failed'))).toBe(true);
  });

  it('does not resolve non-CELEX or non-sector-3 URLs', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const res = await resolveEurLexUrl('https://www.gov.uk/ai-regulation', { fetchImpl });
    expect(res.url).toBe('https://www.gov.uk/ai-regulation');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('listConsolidatedCelex / listAmendingActs', () => {
  it('sorts consolidated versions ascending by date suffix', async () => {
    const fetchImpl = mockCellar({
      versions: ['02024R1689-20270101', '02024R1689-20240712'],
      amendments: [],
      retrievable: new Set(),
    });
    const versions = await listConsolidatedCelex('32024R1689', fetchImpl);
    expect(versions).toEqual(['02024R1689-20240712', '02024R1689-20270101']);
  });

  it('returns amendments with null dates when Cellar has no date', async () => {
    const fetchImpl = mockCellar({
      versions: [],
      amendments: [{ celex: '32026R1744' }],
      retrievable: new Set(),
    });
    const acts = await listAmendingActs('32024R1689', fetchImpl);
    expect(acts).toEqual([{ celex: '32026R1744', date: null }]);
  });
});

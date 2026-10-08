import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TIER_1_STATES,
  TIER_2_STATES,
  shouldFetchTier2,
  fetchStateLegislature,
  type StateFetcherOptions,
} from './state-fetcher.js';
import { DEFAULT_SCOUT_FEEDS } from './default-feeds.js';

// ── Tier Lists ──────────────────────────────────────────────────

describe('TIER_1_STATES', () => {
  it('contains exactly the 10 high-activity states', () => {
    const expected = ['CA', 'NY', 'CO', 'CT', 'IL', 'TX', 'VA', 'WA', 'MA', 'NJ'];
    expect([...TIER_1_STATES]).toEqual(expected);
    expect(TIER_1_STATES).toHaveLength(10);
  });
});

describe('TIER_2_STATES', () => {
  it('includes DC', () => {
    expect([...TIER_2_STATES]).toContain('DC');
  });

  it('covers all remaining states not in Tier 1', () => {
    const allTier = new Set([...TIER_1_STATES, ...TIER_2_STATES]);
    // 50 states + DC = 51
    expect(allTier.size).toBe(51);
  });

  it('does not overlap with Tier 1', () => {
    const tier1Set = new Set<string>([...TIER_1_STATES]);
    for (const state of TIER_2_STATES) {
      expect(tier1Set.has(state)).toBe(false);
    }
  });
});

// ── shouldFetchTier2 ────────────────────────────────────────────

describe('shouldFetchTier2', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true on Sunday (UTC day 0)', () => {
    // 2026-04-05 is a Sunday
    vi.setSystemTime(new Date('2026-04-05T12:00:00Z'));
    expect(shouldFetchTier2()).toBe(true);
  });

  it('returns false on non-Sunday days', () => {
    // 2026-04-06 is a Monday
    vi.setSystemTime(new Date('2026-04-06T12:00:00Z'));
    expect(shouldFetchTier2()).toBe(false);
  });
});

// ── fetchStateLegislature ───────────────────────────────────────

describe('fetchStateLegislature', () => {
  const originalEnv = process.env.OPENSTATES_API_KEY;

  beforeEach(() => {
    delete process.env.OPENSTATES_API_KEY;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.OPENSTATES_API_KEY = originalEnv;
    } else {
      delete process.env.OPENSTATES_API_KEY;
    }
    vi.restoreAllMocks();
  });

  it('returns empty result when no API key is configured', async () => {
    const result = await fetchStateLegislature();
    expect(result.items).toHaveLength(0);
    expect(result.statesProcessed).toBe(0);
    expect(result.statesErrored).toBe(0);
    expect(result.totalBills).toBe(0);
  });

  it('parses OpenStates response into ScoutRawItem format', async () => {
    const mockBill = {
      id: 'ocd-bill/12345',
      identifier: 'SB-1047',
      title: 'California AI Transparency Act',
      session: '2025-2026',
      jurisdiction: { name: 'California', classification: 'state' },
      openstates_url: 'https://openstates.org/ca/bills/2025-2026/SB1047/',
      latest_action_date: '2026-03-15',
      latest_action_description: 'Passed committee',
      abstract: 'An act to require transparency in AI systems.',
      sponsorships: [
        { name: 'Sen. Smith', entity_type: 'person' },
        { name: 'Sen. Jones', entity_type: 'person' },
      ],
    };

    const emptyResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        results: [],
        pagination: { total_items: 0, per_page: 20, page: 1, max_page: 1 },
      }),
    };

    // Return the CA bill only for the first request (CA), empty for the rest
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      callCount++;
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('jurisdiction=ca')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [mockBill],
            pagination: { total_items: 1, per_page: 20, page: 1, max_page: 1 },
          }),
        } as Response;
      }
      return emptyResponse as Response;
    });

    const result = await fetchStateLegislature({
      apiKey: 'test-key',
      tier1Only: true,
    });

    // Should have at least one bill from the CA mock
    const caBill = result.items.find((i) => i.title === 'California AI Transparency Act');
    expect(caBill).toBeDefined();
    expect(caBill!.url).toBe('https://openstates.org/ca/bills/2025-2026/SB1047/');
    expect(caBill!.publishedAt).toBe('2026-03-15');
    expect(caBill!.snippet).toBe('An act to require transparency in AI systems.');

    // Verify metadata uses bill URL as key
    const meta = result.metadata.get(caBill!.url);
    expect(meta).toBeDefined();
    expect(meta!.billNumber).toBe('SB-1047');
    expect(meta!.jurisdiction).toBe('US-CA');
    expect(meta!.session).toBe('2025-2026');
    expect(meta!.sponsors).toEqual(['Sen. Smith', 'Sen. Jones']);
  }, 60_000);

  it('gracefully handles API failure without throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network failure'));

    const result = await fetchStateLegislature({
      apiKey: 'test-key',
      tier1Only: true,
    });

    // Should not throw, should count errored states
    expect(result.statesErrored).toBeGreaterThan(0);
    expect(result.items).toBeDefined();
  }, 60_000);

  it('handles rate limit (429) responses gracefully', async () => {
    const mockResponse = {
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({}),
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as Response);

    const result = await fetchStateLegislature({
      apiKey: 'test-key',
      tier1Only: true,
    });

    // Should not throw — rate limits are handled internally
    expect(result).toBeDefined();
    expect(result.items).toBeDefined();
  }, 60_000);

  it('uses bill title as snippet when abstract is null', async () => {
    const mockBill = {
      id: 'ocd-bill/99999',
      identifier: 'HB-500',
      title: 'AI Accountability Standards',
      session: '2025-2026',
      jurisdiction: { name: 'Colorado', classification: 'state' },
      openstates_url: 'https://openstates.org/co/bills/2025-2026/HB500/',
      latest_action_date: null,
      latest_action_description: null,
      abstract: null,
      sponsorships: [],
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [mockBill],
        pagination: { total_items: 1, per_page: 20, page: 1, max_page: 1 },
      }),
    } as Response);

    const result = await fetchStateLegislature({
      apiKey: 'test-key',
      tier1Only: true,
    });

    const coBill = result.items.find((i) => i.title === 'AI Accountability Standards');
    expect(coBill).toBeDefined();
    expect(coBill!.snippet).toBe('AI Accountability Standards');
    expect(coBill!.publishedAt).toBeNull();
  }, 30_000);
});

// ── Default Feeds Verification ──────────────────────────────────

describe('DEFAULT_SCOUT_FEEDS', () => {
  const feedNames = DEFAULT_SCOUT_FEEDS.map((f) => f.name);
  const feedUrls = DEFAULT_SCOUT_FEEDS.map((f) => f.url);

  it('includes HHS HIPAA feed', () => {
    expect(feedNames.some((n) => n.includes('HIPAA'))).toBe(true);
  });

  it('includes NIST AI RMF feed', () => {
    expect(feedNames.some((n) => n.includes('NIST AI RMF'))).toBe(true);
  });

  it('includes FTC enforcement feed', () => {
    expect(feedNames.some((n) => n.includes('FTC') && n.includes('Enforcement'))).toBe(true);
  });

  it('includes Congress.gov feeds', () => {
    expect(feedUrls.some((u) => u.includes('congress.gov'))).toBe(true);
  });

  it('includes Federal Register feeds', () => {
    expect(feedUrls.some((u) => u.includes('federalregister.gov'))).toBe(true);
  });

  it('includes UK Parliament feeds', () => {
    expect(feedUrls.some((u) => u.includes('parliament.uk'))).toBe(true);
  });

  it('includes EUR-Lex feeds', () => {
    expect(feedUrls.some((u) => u.includes('eur-lex.europa.eu'))).toBe(true);
  });

  it('includes state AG feeds', () => {
    const agFeeds = DEFAULT_SCOUT_FEEDS.filter((f) => f.category === 'us_state_ag');
    expect(agFeeds.length).toBeGreaterThanOrEqual(3);
    const jurisdictions = agFeeds.map((f) => f.jurisdiction);
    expect(jurisdictions).toContain('US-CA');
    expect(jurisdictions).toContain('US-NY');
    expect(jurisdictions).toContain('US-TX');
  });

  it('all feeds have required fields', () => {
    for (const feed of DEFAULT_SCOUT_FEEDS) {
      expect(feed.name).toBeTruthy();
      expect(feed.url).toBeTruthy();
      expect(feed.feedType).toBeTruthy();
      expect(feed.category).toBeTruthy();
      expect(feed.jurisdiction).toBeTruthy();
    }
  });

  it('all feed URLs are valid', () => {
    for (const feed of DEFAULT_SCOUT_FEEDS) {
      expect(() => new URL(feed.url)).not.toThrow();
    }
  });
});

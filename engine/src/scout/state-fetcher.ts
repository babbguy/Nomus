/**
 * State Legislature Fetcher — integrates with OpenStates.org API (v3)
 * for tracking AI-related state bills across all US jurisdictions.
 *
 * Tier 1 states (high AI legislative activity): fetched every cycle.
 * Tier 2 states (remaining + DC): fetched weekly.
 */

import { logger } from '../logger.js';
import type { ScoutRawItem } from './feed-fetcher.js';

// ── Configuration ────────────────────────────────────────────────

const OPENSTATES_API_BASE = 'https://v3.openstates.org';
const AI_SEARCH_QUERY = 'artificial+intelligence';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESULTS_PER_STATE = 20;

/** User-Agent for OpenStates requests */
const USER_AGENT = 'Nomus-Scout/2.0 (Regulatory Signal Discovery)';

/** Tier 1: high AI legislative activity — fetched every cycle */
export const TIER_1_STATES = [
  'CA', 'NY', 'CO', 'CT', 'IL', 'TX', 'VA', 'WA', 'MA', 'NJ',
] as const;

/** Tier 2: all remaining US states + DC — fetched weekly */
export const TIER_2_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MI', 'MN', 'MS',
  'MO', 'MT', 'NE', 'NV', 'NH', 'NM', 'NC', 'ND', 'OH', 'OK',
  'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'UT', 'VT', 'WI', 'WV',
  'WY',
] as const;

// ── Types ────────────────────────────────────────────────────────

interface OpenStatesBill {
  id: string;
  identifier: string;
  title: string;
  session: string;
  jurisdiction: { name: string; classification: string };
  openstates_url: string;
  latest_action_date: string | null;
  latest_action_description: string | null;
  abstract: string | null;
  sponsorships?: Array<{ name: string; entity_type: string }>;
}

interface OpenStatesResponse {
  results: OpenStatesBill[];
  pagination: {
    total_items: number;
    per_page: number;
    page: number;
    max_page: number;
  };
}

export interface StateFetcherOptions {
  /** OpenStates API key. Falls back to OPENSTATES_API_KEY env var. */
  apiKey?: string;
  /** Only fetch Tier 1 states (for non-weekly cycles). Default: false */
  tier1Only?: boolean;
}

export interface StateBillMetadata {
  billNumber: string;
  jurisdiction: string;
  session: string;
  sponsors: string[];
}

export interface StateFetchResult {
  items: ScoutRawItem[];
  metadata: Map<string, StateBillMetadata>;
  statesProcessed: number;
  statesErrored: number;
  totalBills: number;
}

// ── Rate Limiting ────────────────────────────────────────────────

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 500; // 2 requests/sec max

async function rateLimitedDelay(): Promise<void> {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

// ── Core Fetch ───────────────────────────────────────────────────

/**
 * Fetch AI-related bills for a single state from OpenStates API.
 */
async function fetchStateBills(
  state: string,
  apiKey: string,
): Promise<{ bills: OpenStatesBill[]; rateLimited: boolean }> {
  await rateLimitedDelay();

  const url = `${OPENSTATES_API_BASE}/bills?jurisdiction=${state.toLowerCase()}&q=${AI_SEARCH_QUERY}&sort=updated_desc&per_page=${MAX_RESULTS_PER_STATE}`;

  const response = await fetch(url, {
    headers: {
      'X-API-KEY': apiKey,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 429) {
    logger.warn({ state }, 'Scout/State: Rate limited by OpenStates — backing off');
    return { bills: [], rateLimited: true };
  }

  if (!response.ok) {
    throw new Error(`OpenStates API ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as OpenStatesResponse;
  return { bills: data.results ?? [], rateLimited: false };
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Determine whether Tier 2 states should be fetched based on day of week.
 * Tier 2 states run on Sundays (day 0) to spread the load.
 */
export function shouldFetchTier2(): boolean {
  return new Date().getUTCDay() === 0;
}

/**
 * Fetch AI-related state legislature bills from OpenStates.org.
 *
 * Gracefully degrades: if OpenStates is unavailable or no API key is set,
 * returns empty results without throwing.
 */
export async function fetchStateLegislature(
  options: StateFetcherOptions = {},
): Promise<StateFetchResult> {
  const apiKey = options.apiKey ?? process.env.OPENSTATES_API_KEY;

  const result: StateFetchResult = {
    items: [],
    metadata: new Map(),
    statesProcessed: 0,
    statesErrored: 0,
    totalBills: 0,
  };

  if (!apiKey) {
    logger.info('Scout/State: No OPENSTATES_API_KEY configured — skipping state legislature fetch');
    return result;
  }

  const tier1Only = options.tier1Only ?? false;
  const states: string[] = tier1Only
    ? [...TIER_1_STATES]
    : [...TIER_1_STATES, ...(shouldFetchTier2() ? TIER_2_STATES : [])];

  logger.info(
    { stateCount: states.length, tier1Only },
    'Scout/State: Starting state legislature fetch',
  );

  let consecutiveRateLimits = 0;
  const MAX_CONSECUTIVE_RATE_LIMITS = 3;
  const RATE_LIMIT_BACKOFF_MS = 10_000;

  for (const state of states) {
    // Abort if we're being heavily rate-limited
    if (consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
      logger.warn(
        { state, consecutiveRateLimits },
        'Scout/State: Too many consecutive rate limits — stopping state fetch',
      );
      break;
    }

    try {
      const { bills, rateLimited } = await fetchStateBills(state, apiKey);

      if (rateLimited) {
        consecutiveRateLimits++;
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS));
        continue;
      }

      consecutiveRateLimits = 0;
      result.statesProcessed++;
      result.totalBills += bills.length;

      for (const bill of bills) {
        const itemUrl = bill.openstates_url || `${OPENSTATES_API_BASE}/bills/${bill.id}`;
        const content = bill.abstract ?? bill.title;
        const sponsors = (bill.sponsorships ?? []).map((s) => s.name);

        const item: ScoutRawItem = {
          title: bill.title,
          url: itemUrl,
          publishedAt: bill.latest_action_date ?? null,
          snippet: content.slice(0, 500),
        };

        result.items.push(item);

        // Store metadata keyed by URL for downstream pipeline use
        result.metadata.set(itemUrl, {
          billNumber: bill.identifier,
          jurisdiction: `US-${state}`,
          session: bill.session,
          sponsors,
        });
      }
    } catch (err) {
      result.statesErrored++;
      logger.warn(
        { state, error: (err as Error).message },
        'Scout/State: Failed to fetch state bills',
      );
    }
  }

  logger.info(
    {
      statesProcessed: result.statesProcessed,
      statesErrored: result.statesErrored,
      totalBills: result.totalBills,
      itemsReturned: result.items.length,
    },
    'Scout/State: State legislature fetch complete',
  );

  return result;
}

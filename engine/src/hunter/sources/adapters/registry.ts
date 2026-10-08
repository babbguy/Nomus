/**
 * Adapter Registry + Channel-Hierarchy Router.
 * ============================================
 *
 * Holds every ingestion adapter and picks the highest-priority channel that
 * can handle a given source URL:
 *
 *     official_api  >  bulk  >  rss  >  scrape
 *
 * `selectAdapter(url)` returns the winning adapter, or `null` when no adapter
 * applies — in which case the caller falls through to the existing self-healing
 * HTML/PDF scraper path, completely unchanged. This is the seam that makes
 * "don't scrape when an official structured source exists" a routing decision
 * rather than a special case buried in the scraper.
 */

import { CHANNEL_PRIORITY, type IngestionAdapter, type IngestionChannel } from './types.js';
import { ecfrAdapter } from './ecfr.js';
import { federalRegisterAdapter } from './federal-register.js';
import { eurLexAdapter } from './eur-lex.js';
import { nistOscalAdapter } from './nist-oscal.js';
import { legislationUkAdapter } from './legislation-uk.js';

/**
 * Registered adapters. CELEX/EUR-Lex is folded in here as one adapter among
 * several (it is no longer special-cased in the scraper).
 */
const ADAPTERS: IngestionAdapter[] = [
  ecfrAdapter,
  federalRegisterAdapter,
  eurLexAdapter,
  nistOscalAdapter,
  legislationUkAdapter,
];

function channelRank(channel: IngestionChannel): number {
  const idx = CHANNEL_PRIORITY.indexOf(channel);
  return idx === -1 ? CHANNEL_PRIORITY.length : idx;
}

/** All registered adapters, sorted by descending channel priority. */
export function listAdapters(): IngestionAdapter[] {
  return [...ADAPTERS].sort((a, b) => channelRank(a.channel) - channelRank(b.channel));
}

/**
 * Pick the highest-priority adapter that can handle this URL, or null when the
 * source should fall through to the existing scraper path.
 */
export function selectAdapter(url: string): IngestionAdapter | null {
  let best: IngestionAdapter | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const adapter of ADAPTERS) {
    if (!adapter.canHandle(url)) continue;
    const rank = channelRank(adapter.channel);
    if (rank < bestRank) {
      best = adapter;
      bestRank = rank;
    }
  }
  return best;
}

/** True when any registered adapter can ingest this URL via an official channel. */
export function hasAdapter(url: string): boolean {
  return selectAdapter(url) !== null;
}

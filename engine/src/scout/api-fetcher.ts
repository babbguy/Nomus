import { eq } from 'drizzle-orm';
import { logger } from '../logger.js';
import { getDb } from '../db/client.js';
import { platformSettings } from '../db/schema.js';
import { decryptFromStorage } from '../core/crypto.js';
import { env } from '../config/env.js';
import type { ScoutRawItem } from './feed-fetcher.js';

/**
 * Government API configuration stored as JSON in scoutFeeds.apiConfig.
 * Each provider has its own query parameters and auth requirements.
 */
export interface GovApiConfig {
  provider: 'congress_gov' | 'federal_register' | 'uk_parliament' | 'eurlex';
  /** Search terms — each queried separately, results merged + deduped */
  queryTerms: string[];
  /** Max results per query term (default 25) */
  maxResults?: number;
}

const GOV_API_TIMEOUT = 20_000;
const MAX_SNIPPET_CHARS = 500;
const DEFAULT_MAX_RESULTS = 25;

const GOV_API_USER_AGENT = 'Nomus-Scout/1.0 (Regulatory Signal Discovery; +https://github.com/babbguy/Nomus)';

// ── Congress.gov API ─────────────────────────────────────────────
// Docs: https://api.congress.gov/
// Free API key required — get one at https://api.congress.gov/sign-up/
// Falls back to DEMO_KEY (rate-limited) if no key configured.

interface CongressBill {
  congress: number;
  type: string;
  number: number;
  title: string;
  url: string;
  latestAction?: { actionDate: string; text: string };
  introducedDate?: string;
  policyArea?: { name: string };
}

async function fetchCongressGov(
  queryTerms: string[],
  maxResults: number,
  apiKey: string,
): Promise<ScoutRawItem[]> {
  const items: ScoutRawItem[] = [];
  const seenUrls = new Set<string>();

  for (const term of queryTerms) {
    try {
      const params = new URLSearchParams({
        query: term,
        limit: String(Math.min(maxResults, 50)),
        sort: 'updateDate+desc',
        api_key: apiKey,
      });

      const response = await fetch(
        `https://api.congress.gov/v3/bill?${params}`,
        {
          headers: { Accept: 'application/json', 'User-Agent': GOV_API_USER_AGENT },
          signal: AbortSignal.timeout(GOV_API_TIMEOUT),
        },
      );

      if (!response.ok) {
        logger.warn({ status: response.status, term }, 'Scout API: Congress.gov request failed');
        continue;
      }

      const data = await response.json() as { bills?: CongressBill[] };
      for (const bill of data.bills ?? []) {
        const billUrl = bill.url ?? `https://www.congress.gov/bill/${bill.congress}th-congress/${bill.type.toLowerCase()}-bill/${bill.number}`;
        if (seenUrls.has(billUrl)) continue;
        seenUrls.add(billUrl);

        const snippet = [
          bill.policyArea?.name ? `Policy Area: ${bill.policyArea.name}.` : '',
          bill.latestAction?.text ? `Latest Action (${bill.latestAction.actionDate}): ${bill.latestAction.text}` : '',
          `Congress ${bill.congress}, ${bill.type} ${bill.number}`,
        ].filter(Boolean).join(' ').slice(0, MAX_SNIPPET_CHARS);

        items.push({
          title: bill.title,
          url: billUrl,
          publishedAt: bill.latestAction?.actionDate ?? bill.introducedDate ?? null,
          snippet,
        });
      }
    } catch (err) {
      logger.warn({ term, error: (err as Error).message }, 'Scout API: Congress.gov query failed');
    }
  }

  return items;
}

// ── Federal Register API ─────────────────────────────────────────
// Docs: https://www.federalregister.gov/developers/documentation/api/v1
// No auth required. Returns proposed rules, final rules, notices.

interface FederalRegisterDoc {
  title: string;
  html_url: string;
  publication_date: string;
  abstract?: string;
  type: string;
  agencies: Array<{ name: string }>;
  document_number: string;
}

async function fetchFederalRegister(
  queryTerms: string[],
  maxResults: number,
): Promise<ScoutRawItem[]> {
  const items: ScoutRawItem[] = [];
  const seenUrls = new Set<string>();

  for (const term of queryTerms) {
    try {
      const params = new URLSearchParams({
        'conditions[term]': term,
        'conditions[type][]': 'RULE',
        per_page: String(Math.min(maxResults, 50)),
        order: 'newest',
      });
      // Federal Register accepts multiple type[] params — append proposed rules + notices
      const url = `https://www.federalregister.gov/api/v1/documents.json?${params}&conditions[type][]=PROPOSED_RULE&conditions[type][]=NOTICE`;

      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': GOV_API_USER_AGENT },
        signal: AbortSignal.timeout(GOV_API_TIMEOUT),
      });

      if (!response.ok) {
        logger.warn({ status: response.status, term }, 'Scout API: Federal Register request failed');
        continue;
      }

      const data = await response.json() as { results?: FederalRegisterDoc[] };
      for (const doc of data.results ?? []) {
        if (seenUrls.has(doc.html_url)) continue;
        seenUrls.add(doc.html_url);

        const agencies = doc.agencies.map((a) => a.name).join(', ');
        const snippet = [
          `[${doc.type}] ${agencies}.`,
          doc.abstract ?? '',
          `Document #${doc.document_number}`,
        ].filter(Boolean).join(' ').slice(0, MAX_SNIPPET_CHARS);

        items.push({
          title: doc.title,
          url: doc.html_url,
          publishedAt: doc.publication_date,
          snippet,
        });
      }
    } catch (err) {
      logger.warn({ term, error: (err as Error).message }, 'Scout API: Federal Register query failed');
    }
  }

  return items;
}

// ── UK Parliament Bills API ──────────────────────────────────────
// Docs: https://bills-api.parliament.uk/index.html
// No auth required. Returns current + historical bills.

interface UKBill {
  billId: number;
  shortTitle: string;
  longTitle?: string;
  currentHouse: string;
  originatingHouse: string;
  lastUpdate: string;
  billTypeId: number;
  currentStage?: { description: string; house: string };
}

async function fetchUKParliament(
  queryTerms: string[],
  maxResults: number,
): Promise<ScoutRawItem[]> {
  const items: ScoutRawItem[] = [];
  const seenUrls = new Set<string>();

  for (const term of queryTerms) {
    try {
      const params = new URLSearchParams({
        SearchTerm: term,
        Take: String(Math.min(maxResults, 50)),
        SortOrder: 'DateUpdatedDesc',
      });

      const response = await fetch(
        `https://bills-api.parliament.uk/api/v1/Bills?${params}`,
        {
          headers: { Accept: 'application/json', 'User-Agent': GOV_API_USER_AGENT },
          signal: AbortSignal.timeout(GOV_API_TIMEOUT),
        },
      );

      if (!response.ok) {
        logger.warn({ status: response.status, term }, 'Scout API: UK Parliament request failed');
        continue;
      }

      const data = await response.json() as { items?: Array<{ value: UKBill }> };
      for (const entry of data.items ?? []) {
        const bill = entry.value;
        const billUrl = `https://bills.parliament.uk/bills/${bill.billId}`;
        if (seenUrls.has(billUrl)) continue;
        seenUrls.add(billUrl);

        const snippet = [
          bill.longTitle ?? '',
          bill.currentStage ? `Current stage: ${bill.currentStage.description} (${bill.currentStage.house})` : '',
          `House: ${bill.currentHouse}. Origin: ${bill.originatingHouse}.`,
        ].filter(Boolean).join(' ').slice(0, MAX_SNIPPET_CHARS);

        items.push({
          title: bill.shortTitle,
          url: billUrl,
          publishedAt: bill.lastUpdate,
          snippet,
        });
      }
    } catch (err) {
      logger.warn({ term, error: (err as Error).message }, 'Scout API: UK Parliament query failed');
    }
  }

  return items;
}

// ── EUR-Lex Search API ───────────────────────────────────────────
// Uses the EUR-Lex search REST endpoint (public, no auth).
// Returns EU legislation, proposals, and preparatory documents.

interface EurLexResult {
  title: string;
  cellarId: string;
  date?: string;
  documentType?: string;
  identifier?: string;
}

async function fetchEurLex(
  queryTerms: string[],
  maxResults: number,
): Promise<ScoutRawItem[]> {
  const items: ScoutRawItem[] = [];
  const seenUrls = new Set<string>();

  for (const term of queryTerms) {
    try {
      // EUR-Lex expert search via their public search API
      // Returns HTML search results page — we parse structured data from it
      const searchQuery = encodeURIComponent(term);
      const url = `https://eur-lex.europa.eu/search.html?scope=EURLEX&text=${searchQuery}&type=quick&lang=en&page=1&pageSize=${Math.min(maxResults, 20)}`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': GOV_API_USER_AGENT,
          Accept: 'text/html',
        },
        signal: AbortSignal.timeout(GOV_API_TIMEOUT),
      });

      if (!response.ok) {
        logger.warn({ status: response.status, term }, 'Scout API: EUR-Lex request failed');
        continue;
      }

      const html = await response.text();

      // Extract search results from EUR-Lex HTML
      // Each result is in a <div class="SearchResult"> with title link and metadata
      const resultPattern = /<div[^>]*class="[^"]*SearchResult[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
      const titleLinkPattern = /<a[^>]*href="(\/legal-content\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
      const datePattern = /(\d{2}\/\d{2}\/\d{4})/;

      let match: RegExpExecArray | null;
      let count = 0;
      while ((match = resultPattern.exec(html)) !== null && count < maxResults) {
        const block = match[1];
        const linkMatch = titleLinkPattern.exec(block);
        if (!linkMatch) continue;

        const relativeUrl = linkMatch[1];
        const fullUrl = `https://eur-lex.europa.eu${relativeUrl}`;
        if (seenUrls.has(fullUrl)) continue;
        seenUrls.add(fullUrl);

        const title = linkMatch[2]
          .replace(/<[^>]*>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!title) continue;

        const dateMatch = datePattern.exec(block);
        const rawDate = dateMatch?.[1];
        // Convert DD/MM/YYYY to ISO
        let publishedAt: string | null = null;
        if (rawDate) {
          const [dd, mm, yyyy] = rawDate.split('/');
          publishedAt = `${yyyy}-${mm}-${dd}`;
        }

        const snippet = block
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_SNIPPET_CHARS);

        items.push({ title, url: fullUrl, publishedAt, snippet });
        count++;
      }
    } catch (err) {
      logger.warn({ term, error: (err as Error).message }, 'Scout API: EUR-Lex query failed');
    }
  }

  return items;
}

// ── Public Dispatcher ────────────────────────────────────────────

/** Resolve Congress.gov API key: DB setting → env var → DEMO_KEY */
function resolveCongressGovKey(): string {
  try {
    const db = getDb();
    const row = db.select().from(platformSettings)
      .where(eq(platformSettings.key, 'scout.apiKeys.congressGov')).get();
    if (row?.value) {
      try {
        return decryptFromStorage(row.value);
      } catch {
        return row.value; // Legacy unencrypted value
      }
    }
  } catch { /* DB not ready — fall through */ }
  return env().NOMUS_CONGRESS_GOV_API_KEY;
}

/**
 * Fetch items from a government API based on the feed's apiConfig.
 * Returns ScoutRawItem[] compatible with the existing Scout pipeline.
 */
export async function fetchGovApi(apiConfigJson: string): Promise<ScoutRawItem[]> {
  let config: GovApiConfig;
  try {
    config = JSON.parse(apiConfigJson) as GovApiConfig;
  } catch {
    logger.error({ apiConfigJson }, 'Scout API: Invalid apiConfig JSON');
    return [];
  }

  if (!config.provider || !config.queryTerms?.length) {
    logger.error({ config }, 'Scout API: Missing provider or queryTerms');
    return [];
  }

  const maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS;

  switch (config.provider) {
    case 'congress_gov':
      return fetchCongressGov(config.queryTerms, maxResults, resolveCongressGovKey());
    case 'federal_register':
      return fetchFederalRegister(config.queryTerms, maxResults);
    case 'uk_parliament':
      return fetchUKParliament(config.queryTerms, maxResults);
    case 'eurlex':
      return fetchEurLex(config.queryTerms, maxResults);
    default:
      logger.warn({ provider: config.provider }, 'Scout API: Unknown provider');
      return [];
  }
}

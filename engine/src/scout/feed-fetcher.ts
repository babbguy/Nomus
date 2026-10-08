import RssParser from 'rss-parser';
import { logger } from '../logger.js';
import { fetchGovApi } from './api-fetcher.js';

export interface ScoutRawItem {
  title: string;
  url: string;
  publishedAt: string | null;
  snippet: string;
}

const rssParser = new RssParser({
  timeout: 15_000,
  headers: {
    'User-Agent': 'Nomus-Scout/1.0 (Regulatory Signal Discovery)',
  },
});

/** Max snippet length to store — keeps DB lean and keyword filter fast */
const MAX_SNIPPET_CHARS = 500;

/**
 * Fetch items from an RSS/Atom feed URL.
 * Works for standard RSS, Atom, and Google News RSS feeds.
 */
export async function fetchRssFeed(url: string): Promise<ScoutRawItem[]> {
  const feed = await rssParser.parseURL(url);
  return (feed.items ?? []).map((item) => ({
    title: (item.title ?? '').trim(),
    url: (item.link ?? '').trim(),
    publishedAt: item.isoDate ?? item.pubDate ?? null,
    snippet: (item.contentSnippet ?? item.content ?? item.summary ?? '')
      .replace(/<[^>]*>/g, '')
      .slice(0, MAX_SNIPPET_CHARS)
      .trim(),
  })).filter((item) => item.url && item.title);
}

/**
 * Fetch a webpage URL and extract text content for Scout analysis.
 * Lightweight — just grabs title + first 500 chars of body text.
 */
export async function fetchWebpage(url: string): Promise<ScoutRawItem[]> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Nomus-Scout/1.0 (Regulatory Signal Discovery)',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();

    // Extract title
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
    const title = (titleMatch?.[1] ?? 'Untitled').replace(/<[^>]*>/g, '').trim();

    // Extract body text (strip all tags)
    const bodyMatch = html.match(/<body[^>]*>(.*?)<\/body>/is);
    const bodyText = (bodyMatch?.[1] ?? html)
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return [{
      title,
      url,
      publishedAt: new Date().toISOString(),
      snippet: bodyText.slice(0, MAX_SNIPPET_CHARS),
    }];
  } catch (err) {
    logger.warn({ url, error: (err as Error).message }, 'Scout: Failed to fetch webpage');
    return [];
  }
}

/**
 * Fetch items from any supported feed type.
 */
export async function fetchFeed(
  url: string,
  feedType: 'rss' | 'atom' | 'google_news' | 'webpage' | 'gov_api',
  apiConfig?: string | null,
): Promise<ScoutRawItem[]> {
  switch (feedType) {
    case 'rss':
    case 'atom':
    case 'google_news':
      return fetchRssFeed(url);
    case 'webpage':
      return fetchWebpage(url);
    case 'gov_api': {
      if (!apiConfig) {
        logger.warn({ url }, 'Scout: gov_api feed missing apiConfig');
        return [];
      }
      return fetchGovApi(apiConfig);
    }
    default:
      logger.warn({ feedType }, 'Scout: Unknown feed type');
      return [];
  }
}

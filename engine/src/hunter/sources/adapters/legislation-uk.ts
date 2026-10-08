/**
 * legislation.gov.uk Adapter — official UK legislation XML (channel: official_api).
 * ================================================================================
 *
 * legislation.gov.uk IS an API. Appending `/data.xml` to ANY legislation URL
 * returns the official Crown-copyright XML in the CLML schema (Crown Legislation
 * Markup Language) — the authoritative machine-readable text of the instrument,
 * complete by construction, with no page chrome:
 *
 *     GET https://www.legislation.gov.uk/{type}/{year}/{number}[/{version}]/data.xml
 *
 * Point-in-time is a PATH SEGMENT: `.../{type}/{year}/{number}/{YYYY-MM-DD}/…`
 * returns the law exactly as it stood on that date (an immutable coordinate).
 * With no date segment the API serves the latest available version, and its
 * validity date is read from the CLML metadata (`dct:valid`).
 *
 * We fetch the official XML, hash the served bytes (byte_exact), parse the CLML
 * into readable provision text (shared `clmlToText`), and store
 * `{uri, pointInTime, artifactUrl}` as the point-in-time coordinate.
 *
 * Conditional fetching: legislation.gov.uk serves ETag / Last-Modified. When we
 * hold a prior copy we send `If-None-Match` / `If-Modified-Since`; a 304 skips
 * the artifact download.
 *
 * HARD-FAIL, NOT FALLBACK: any failed fetch or an empty/unparseable body holds
 * the source — we never fall back to scraping HTML and presenting stale law as
 * current.
 *
 * SCOPE — honesty over coverage: this adapter covers ONLY genuine
 * legislation.gov.uk instruments. A gov.uk *policy paper* (e.g. the UK AI
 * Regulation White Paper on www.gov.uk) is NOT legislation and is deliberately
 * left on its existing scrape channel.
 *
 * Shape confirmed live 2026-07-26 against legislation.gov.uk `/data.xml`
 * (root <Legislation> CLML, namespace .../namespaces/legislation).
 */

import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { logger } from '../../../logger.js';
import { clmlToText, fetchOfficialBytes, sha256Hex, wordCount } from './shared.js';
import type {
  AdapterContext,
  AdapterOutcome,
  IngestionAdapter,
  PointInTimeCoordinate,
} from './types.js';

const UK_HOST = 'legislation.gov.uk';

/** A legislation path: /{type}/{year}/{number}[/...]. */
const LEG_PATH_RE = /^\/[a-z]+\/\d{4}\/[^/]+/i;
/** An explicit point-in-time version segment: /YYYY-MM-DD/. */
const DATE_SEGMENT_RE = /\/(\d{4}-\d{2}-\d{2})(?:\/|$)/;

interface UkTarget {
  /** The canonical instrument/provision URI (no /data.xml, no query). */
  uri: string;
  /** The official CLML artifact URL (…/data.xml). */
  dataXmlUrl: string;
  /** Explicit point-in-time date from the URL path, if present. */
  versionInUrl: string | null;
}

/** Parse a legislation.gov.uk URL into its official CLML artifact target. */
export function parseUkTarget(url: string): UkTarget | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!u.hostname.includes(UK_HOST)) return null;

  // Normalize: drop query/hash, strip a trailing /data.xml, strip trailing slash.
  let path = u.pathname;
  path = path.replace(/\/data\.xml$/i, '');
  path = path.replace(/\/+$/, '');
  if (!LEG_PATH_RE.test(path)) return null;

  const dateMatch = path.match(DATE_SEGMENT_RE);
  const uri = `https://www.legislation.gov.uk${path}`;
  return {
    uri,
    dataXmlUrl: `${uri}/data.xml`,
    versionInUrl: dateMatch ? dateMatch[1] : null,
  };
}

function isUkLegislationUrl(url: string): boolean {
  return parseUkTarget(url) !== null;
}

/** First element text by (possibly namespaced) local tag name. */
function firstTagText($: cheerio.CheerioAPI, localName: string): string {
  let value = '';
  const want = localName.toLowerCase();
  $('*').each((_, el) => {
    if (value) return;
    const tag = ((el as Element).tagName ?? '').toLowerCase();
    if (tag === want || tag.endsWith(`:${want}`)) {
      value = $(el).text().replace(/\s+/g, ' ').trim();
    }
  });
  return value;
}

export const legislationUkAdapter: IngestionAdapter = {
  id: 'legislation_gov_uk',
  channel: 'official_api',
  label: 'legislation.gov.uk (official UK legislation XML / CLML)',

  canHandle(url: string): boolean {
    return isUkLegislationUrl(url);
  },

  async fetch(url: string, ctx: AdapterContext = {}): Promise<AdapterOutcome> {
    const emit = ctx.emit ?? (() => {});
    const target = parseUkTarget(url);
    if (!target) {
      throw new Error(`legislation.gov.uk adapter: unrecognized legislation URL: ${url}`);
    }

    // ─── Conditional skip: HTTP validators against the CLML artifact ──────
    const priorEtag = (ctx.lastCoordinate?.fields?.httpEtag as string | null) ?? null;
    const priorLastModified =
      (ctx.lastCoordinate?.fields?.httpLastModified as string | null) ?? null;
    const conditional = ctx.lastContentHash ? { priorEtag, priorLastModified } : null;

    const fetched = await fetchOfficialBytes(target.dataXmlUrl, {
      accept: 'application/xml,text/xml',
      acceptLanguage: 'en-GB,en;q=0.9',
      fetchImpl: ctx.fetchImpl,
      ifNoneMatch: conditional?.priorEtag ?? null,
      ifModifiedSince: conditional?.priorLastModified ?? null,
    });

    if (!fetched) {
      // 304 Not Modified — carry the prior coordinate forward, no re-download.
      const coordinate: PointInTimeCoordinate = ctx.lastCoordinate ?? {
        authority: 'legislation_gov_uk',
        citation: `${target.uri}${target.versionInUrl ? ` @ ${target.versionInUrl}` : ''}`,
        fields: { uri: target.uri, pointInTime: target.versionInUrl, artifactUrl: target.dataXmlUrl },
      };
      emit(1, `${coordinate.citation}: CLML artifact unchanged (HTTP 304) — skipping re-download`, {
        uri: target.uri,
      });
      return {
        kind: 'not_modified',
        channel: 'official_api',
        pointInTimeCoordinate: coordinate,
        reason: `legislation.gov.uk artifact unchanged since prior ingestion (HTTP 304).`,
      };
    }

    // ─── Read the official CLML metadata for the coordinate ───────────────
    const $ = cheerio.load(fetched.text, { xml: true });
    const rootUri =
      $('Legislation').attr('DocumentURI') ||
      firstTagText($, 'identifier') ||
      target.uri;
    const title = firstTagText($, 'title');
    const valid = firstTagText($, 'valid'); // dct:valid — point-in-time validity
    const modified = firstTagText($, 'modified'); // dc:modified
    // Prefer the explicit URL date; else the CLML validity date; else modified.
    const pointInTime = target.versionInUrl || valid || modified || null;

    const coordinate: PointInTimeCoordinate = {
      authority: 'legislation_gov_uk',
      citation: `${title || rootUri}${pointInTime ? ` @ ${pointInTime}` : ''}`,
      fields: {
        uri: rootUri,
        pointInTime,
        title: title || null,
        modified: modified || null,
        versionInUrl: target.versionInUrl,
        artifactUrl: target.dataXmlUrl,
        httpEtag: fetched.etag,
        httpLastModified: fetched.lastModified,
      },
    };

    const content = clmlToText(fetched.text);
    if (content.length < 200) {
      // A CLML artifact this short is not usable legal text. HARD FAIL — never
      // fall back to scraping. Source held for intervention.
      throw new Error(
        `legislation.gov.uk adapter: CLML for ${coordinate.citation} extracted to only ${content.length} chars — refusing to promote (source held for intervention).`,
      );
    }

    logger.info(
      {
        citation: coordinate.citation,
        bytes: fetched.bytesSize,
        rawBytesHash: fetched.bytesHash.slice(0, 12),
        words: wordCount(content),
      },
      `legislation.gov.uk: ingested ${coordinate.citation} (byte_exact)`,
    );

    return {
      kind: 'fetched',
      content,
      contentHash: sha256Hex(content),
      rawContent: fetched.text,
      rawBytesHash: fetched.bytesHash,
      rawBytesSize: fetched.bytesSize,
      contentType: fetched.contentType || 'application/xml',
      provenanceMode: 'byte_exact',
      channel: 'official_api',
      pointInTimeCoordinate: coordinate,
      sourceUrl: fetched.finalUrl || target.dataXmlUrl,
      fetchedAt: new Date().toISOString(),
      wordCount: wordCount(content),
    };
  },
};

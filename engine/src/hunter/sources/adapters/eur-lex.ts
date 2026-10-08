/**
 * EUR-Lex Adapter — official EU legal text ingestion (channel: official_api).
 * ==========================================================================
 *
 * This adapter FOLDS the existing CELEX resolver (../celex-resolver.ts) into
 * the ingestion-adapter framework: CELEX becomes one adapter among several
 * rather than a special case wired directly into the scraper. It does NOT
 * rewrite the resolver's logic — it wraps `resolveEurLexUrl` (consolidated-
 * version selection + amendment awareness) and then pulls the official artifact
 * from the EU Publications Office Cellar:
 *
 *     GET https://publications.europa.eu/resource/celex/{CELEX}
 *         Accept: application/xhtml+xml
 *
 * The Cellar serves the authoritative XHTML of the act directly (bypassing the
 * eur-lex.europa.eu AWS-WAF JavaScript challenge). That single HTTP body is the
 * byte-exact source; we hash the served bytes and store the resolved CELEX
 * version IRI as the point-in-time coordinate. Amendments newer than the
 * fetched consolidated text are surfaced as tier-2 events by the resolver — the
 * law-changed-but-text-lags signal degrades loudly, never silently.
 *
 * Exactly the same Accept-header requirement and selector strategy as the
 * EUR-Lex scraper profile in forge/harvester.ts (a multi-type Accept makes the
 * Cellar serve RDF metadata instead of the document body).
 */

import { logger } from '../../../logger.js';
import { resolveEurLexUrl, extractCelex } from '../celex-resolver.js';
import { parseHtml } from '../parsers/html-parser.js';
import { fetchOfficialBytes, sha256Hex, wordCount } from './shared.js';
import type {
  AdapterContext,
  AdapterOutcome,
  IngestionAdapter,
  PointInTimeCoordinate,
} from './types.js';

const CELLAR_RESOURCE_BASE = 'https://publications.europa.eu/resource/celex/';

/** Selector strategy identical to the EUR-Lex/Cellar scraper profile. */
const CELLAR_SELECTORS = {
  contentSelector: 'body',
  removeSelectors: [
    'nav', 'footer', 'header', 'script', 'style', 'noscript',
    '.note', '.footnote', 'iframe', 'svg', 'img', 'button', 'input', 'form',
  ],
};

function isEurLexUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.includes('eur-lex.europa.eu') || host.includes('publications.europa.eu');
  } catch {
    return false;
  }
}

export const eurLexAdapter: IngestionAdapter = {
  id: 'eur_lex_cellar',
  channel: 'official_api',
  label: 'EUR-Lex (EU Publications Office Cellar)',

  canHandle(url: string): boolean {
    return isEurLexUrl(url) && extractCelex(url) !== null;
  },

  async fetch(url: string, ctx: AdapterContext = {}): Promise<AdapterOutcome> {
    const emit = ctx.emit ?? (() => {});

    // ─── Resolve to the newest retrievable consolidated CELEX ──────────
    // Reuses the existing resolver verbatim (consolidated-version selection +
    // pending-amendment tier-2 events). Never throws — falls back to as-adopted.
    const resolution = await resolveEurLexUrl(url, {
      emit,
      fetchImpl: ctx.fetchImpl,
    });

    const celex = resolution.resolvedCelex || extractCelex(url);
    if (!celex) {
      throw new Error(`EUR-Lex adapter: no CELEX identifier in URL: ${url}`);
    }

    const cellarUrl = `${CELLAR_RESOURCE_BASE}${celex}`;
    const coordinate: PointInTimeCoordinate = {
      authority: 'eur_lex_cellar',
      citation: `CELEX ${celex}${resolution.consolidated ? ' (consolidated)' : ' (as adopted)'}`,
      fields: {
        baseCelex: resolution.baseCelex,
        resolvedCelex: celex,
        consolidated: resolution.consolidated,
        versionIri: cellarUrl,
        pendingAmendments: resolution.pendingAmendments.length
          ? resolution.pendingAmendments.map((a) => `${a.celex}${a.date ? `@${a.date}` : ''}`).join(',')
          : null,
      },
    };

    // ─── Conditional skip: same resolved CELEX version already ingested ─
    const priorCelex = ctx.lastCoordinate?.fields?.resolvedCelex ?? null;
    if (
      ctx.lastContentHash &&
      priorCelex &&
      priorCelex === celex &&
      resolution.pendingAmendments.length === 0
    ) {
      emit(1, `${coordinate.citation}: same consolidated version already ingested — skipping re-download`, {
        resolvedCelex: celex,
      });
      return {
        kind: 'not_modified',
        channel: 'official_api',
        pointInTimeCoordinate: coordinate,
        reason: `EUR-Lex ${celex} already ingested and no pending amendments.`,
      };
    }

    // ─── Fetch the official Cellar XHTML (single body → byte_exact) ─────
    // The exact Accept header matters: a multi-type Accept makes the Cellar
    // serve RDF metadata instead of the document body.
    const fetched = await fetchOfficialBytes(cellarUrl, {
      accept: 'application/xhtml+xml',
      acceptLanguage: 'en',
      fetchImpl: ctx.fetchImpl,
    });
    if (!fetched) {
      throw new Error(`EUR-Lex adapter: unexpected 304 for Cellar resource ${cellarUrl}`);
    }

    const content = parseHtml(fetched.text, CELLAR_SELECTORS);
    if (content.length < 200) {
      throw new Error(
        `EUR-Lex adapter: Cellar artifact for ${coordinate.citation} extracted to only ${content.length} chars — refusing to promote (source held).`,
      );
    }

    logger.info(
      {
        citation: coordinate.citation,
        bytes: fetched.bytesSize,
        rawBytesHash: fetched.bytesHash.slice(0, 12),
        words: wordCount(content),
        pendingAmendments: resolution.pendingAmendments.length,
      },
      `EUR-Lex: ingested ${coordinate.citation} (byte_exact)`,
    );

    return {
      kind: 'fetched',
      content,
      contentHash: sha256Hex(content),
      rawContent: fetched.text,
      rawBytesHash: fetched.bytesHash,
      rawBytesSize: fetched.bytesSize,
      contentType: fetched.contentType || 'application/xhtml+xml',
      provenanceMode: 'byte_exact',
      channel: 'official_api',
      pointInTimeCoordinate: coordinate,
      sourceUrl: cellarUrl,
      fetchedAt: new Date().toISOString(),
      wordCount: wordCount(content),
    };
  },
};

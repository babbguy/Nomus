/**
 * NIST OSCAL Adapter — official machine-readable control catalogs.
 * ================================================================
 * (channel: official_api)
 *
 * NIST publishes its control catalogs as OFFICIAL OSCAL JSON in the
 * `usnistgov/oscal-content` GitHub repository. OSCAL (Open Security Controls
 * Assessment Language) is the authoritative machine-readable representation of
 * the catalog — the same content the PDF renders, but structured, complete by
 * construction, and free of PDF layout/column/OCR artifacts. This adapter
 * REPLACES PDF PARSING for those catalogs, which is the single worst source
 * format for byte-exactness.
 *
 *     GET https://raw.githubusercontent.com/usnistgov/oscal-content/main/
 *         nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json
 *     GET https://raw.githubusercontent.com/usnistgov/oscal-content/main/
 *         nist.gov/CSF/v2.0/json/NIST_CSF_v2.0_catalog.json
 *
 * We fetch the official JSON artifact, hash the served bytes (byte_exact), and
 * parse the OSCAL tree (groups → controls → parts) into readable control text
 * for storage/display. The byte_exact hash is over the official JSON artifact,
 * NOT the extracted text. The point-in-time coordinate is the OSCAL metadata
 * version + last-modified — an authoritative immutable version, never merely a
 * fetch timestamp.
 *
 * Conditional fetching: GitHub raw serves an ETag / Last-Modified. When we hold
 * a prior copy we send `If-None-Match` / `If-Modified-Since`; a 304 skips the
 * heavy artifact download entirely.
 *
 * HARD-FAIL, NOT FALLBACK: any failed fetch or an unparseable/empty catalog is a
 * hard failure that holds the source. We never silently fall back to scraping a
 * PDF and presenting stale controls as current.
 *
 * NOTE: There is deliberately NO OSCAL channel for the NIST AI Risk Management
 * Framework (AI 100-1) — NIST does not publish it as OSCAL content — so that
 * source stays on its existing PDF channel (honesty over coverage).
 *
 * Endpoints/paths confirmed live 2026-07-26 against usnistgov/oscal-content
 * (SP 800-53 Rev 5 catalog v5.2.0 / OSCAL 1.2.2; CSF v2.0 catalog).
 */

import { logger } from '../../../logger.js';
import { fetchOfficialBytes, sha256Hex, wordCount } from './shared.js';
import type {
  AdapterContext,
  AdapterOutcome,
  IngestionAdapter,
  PointInTimeCoordinate,
} from './types.js';

/** Only the official NIST OSCAL repository, JSON artifacts. */
const OSCAL_REPO = 'usnistgov/oscal-content';

// ─── OSCAL shape (only the fields we read) ───────────────────────────────────

interface OscalMetadata {
  title?: string;
  version?: string;
  'oscal-version'?: string;
  'last-modified'?: string;
}

interface OscalPart {
  id?: string;
  name?: string;
  title?: string;
  prose?: string;
  parts?: OscalPart[];
}

interface OscalControl {
  id: string;
  class?: string;
  title?: string;
  parts?: OscalPart[];
  controls?: OscalControl[];
}

interface OscalGroup {
  id?: string;
  class?: string;
  title?: string;
  groups?: OscalGroup[];
  controls?: OscalControl[];
}

interface OscalCatalogDoc {
  catalog?: {
    uuid?: string;
    metadata?: OscalMetadata;
    groups?: OscalGroup[];
    controls?: OscalControl[];
  };
}

/** Human catalog label from the well-known repo path, else the OSCAL title. */
function deriveCatalogName(url: string, metadata: OscalMetadata): string {
  if (/\/SP800-53\/rev5\//i.test(url)) return 'NIST SP 800-53 Rev 5';
  if (/\/SP800-171\//i.test(url)) return 'NIST SP 800-171';
  if (/\/SP800-172\//i.test(url)) return 'NIST SP 800-172';
  if (/\/SP800-218\//i.test(url)) return 'NIST SP 800-218 (SSDF)';
  if (/\/CSF\/v2\.0\//i.test(url)) return 'NIST Cybersecurity Framework 2.0';
  return (metadata.title ?? 'NIST OSCAL Catalog').replace(/\s+/g, ' ').trim();
}

function isOscalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const onGithub =
      host.includes('githubusercontent.com') || host.includes('github.com');
    return onGithub && u.pathname.includes(OSCAL_REPO) && /\.json$/i.test(u.pathname);
  } catch {
    return false;
  }
}

// ─── OSCAL → readable control text (mechanical, no interpolation) ─────────────

function walkParts(parts: OscalPart[] | undefined, out: string[]): void {
  if (!parts) return;
  for (const part of parts) {
    if (part.title) out.push(`**${part.title.trim()}**`);
    if (part.prose) {
      const prose = part.prose.replace(/\s+/g, ' ').trim();
      if (prose) out.push(prose);
    }
    walkParts(part.parts, out);
  }
}

function walkControl(control: OscalControl, out: string[]): void {
  const id = (control.id ?? '').toUpperCase();
  const title = (control.title ?? '').replace(/\s+/g, ' ').trim();
  out.push(`\n### ${[id, title].filter(Boolean).join(' — ')}\n`);
  walkParts(control.parts, out);
  // Control enhancements are nested controls.
  for (const child of control.controls ?? []) walkControl(child, out);
}

function walkGroup(group: OscalGroup, out: string[]): void {
  const id = (group.id ?? '').toUpperCase();
  const title = (group.title ?? '').replace(/\s+/g, ' ').trim();
  out.push(`\n## ${[id, title].filter(Boolean).join(' — ')}\n`);
  for (const control of group.controls ?? []) walkControl(control, out);
  for (const child of group.groups ?? []) walkGroup(child, out);
}

/**
 * Parse an OSCAL catalog document into document-ordered, readable control text.
 * Purely mechanical: it re-serializes prose that already exists in the OSCAL
 * JSON. `{{ insert: … }}` parameter placeholders are preserved verbatim — we do
 * not resolve or gap-fill them (refuse-to-guess).
 */
export function oscalCatalogToText(doc: OscalCatalogDoc): string {
  const catalog = doc.catalog;
  if (!catalog) return '';
  const out: string[] = [];
  const md = catalog.metadata ?? {};
  if (md.title) out.push(`# ${md.title.replace(/\s+/g, ' ').trim()}`);
  for (const group of catalog.groups ?? []) walkGroup(group, out);
  for (const control of catalog.controls ?? []) walkControl(control, out);
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const nistOscalAdapter: IngestionAdapter = {
  id: 'nist_oscal',
  channel: 'official_api',
  label: 'NIST OSCAL (machine-readable control catalogs)',

  canHandle(url: string): boolean {
    return isOscalUrl(url);
  },

  async fetch(url: string, ctx: AdapterContext = {}): Promise<AdapterOutcome> {
    const emit = ctx.emit ?? (() => {});

    // ─── Conditional skip: HTTP validators against the raw JSON artifact ──
    // Only when we already hold a promoted copy (refuse-to-guess contract).
    const priorEtag = (ctx.lastCoordinate?.fields?.httpEtag as string | null) ?? null;
    const priorLastModified =
      (ctx.lastCoordinate?.fields?.httpLastModified as string | null) ?? null;
    const conditional = ctx.lastContentHash ? { priorEtag, priorLastModified } : null;

    const fetched = await fetchOfficialBytes(url, {
      accept: 'application/json',
      fetchImpl: ctx.fetchImpl,
      ifNoneMatch: conditional?.priorEtag ?? null,
      ifModifiedSince: conditional?.priorLastModified ?? null,
    });

    if (!fetched) {
      // 304 Not Modified — carry the prior coordinate forward, no re-download.
      const coordinate: PointInTimeCoordinate = ctx.lastCoordinate ?? {
        authority: 'nist_oscal',
        citation: `NIST OSCAL catalog @ ${url}`,
        fields: { artifactUrl: url },
      };
      emit(1, `${coordinate.citation}: OSCAL artifact unchanged (HTTP 304) — skipping re-download`, {
        artifactUrl: url,
      });
      return {
        kind: 'not_modified',
        channel: 'official_api',
        pointInTimeCoordinate: coordinate,
        reason: `NIST OSCAL artifact unchanged since prior ingestion (HTTP 304).`,
      };
    }

    // ─── Parse the official OSCAL JSON (byte_exact hash is over the bytes) ─
    let parsed: OscalCatalogDoc;
    try {
      parsed = JSON.parse(fetched.text) as OscalCatalogDoc;
    } catch (err) {
      throw new Error(
        `NIST OSCAL adapter: official artifact at ${url} is not valid JSON (${(err as Error).message}) — refusing to promote (source held).`,
      );
    }
    if (!parsed.catalog) {
      throw new Error(
        `NIST OSCAL adapter: official artifact at ${url} has no OSCAL "catalog" root — refusing to promote (source held).`,
      );
    }

    const md = parsed.catalog.metadata ?? {};
    const catalogName = deriveCatalogName(url, md);
    const catalogVersion = md.version ?? null;
    const oscalVersion = md['oscal-version'] ?? null;
    const lastModified = md['last-modified'] ?? null;

    const coordinate: PointInTimeCoordinate = {
      authority: 'nist_oscal',
      citation: `${catalogName}${catalogVersion ? ` v${catalogVersion}` : ''}${
        lastModified ? ` @ ${lastModified}` : ''
      }`,
      fields: {
        catalog: catalogName,
        catalogVersion,
        oscalVersion,
        lastModified,
        artifactUrl: url,
        httpEtag: fetched.etag,
        httpLastModified: fetched.lastModified,
      },
    };

    const content = oscalCatalogToText(parsed);
    if (content.length < 200) {
      // An OSCAL catalog that extracts to almost nothing means the artifact is
      // not usable. HARD FAIL — never fall back to PDF scraping. Source held.
      throw new Error(
        `NIST OSCAL adapter: catalog for ${coordinate.citation} parsed to only ${content.length} chars of control text — refusing to promote (source held for intervention).`,
      );
    }

    logger.info(
      {
        citation: coordinate.citation,
        bytes: fetched.bytesSize,
        rawBytesHash: fetched.bytesHash.slice(0, 12),
        words: wordCount(content),
      },
      `NIST OSCAL: ingested ${coordinate.citation} (byte_exact)`,
    );

    return {
      kind: 'fetched',
      content,
      contentHash: sha256Hex(content),
      rawContent: fetched.text,
      rawBytesHash: fetched.bytesHash,
      rawBytesSize: fetched.bytesSize,
      contentType: fetched.contentType || 'application/json',
      provenanceMode: 'byte_exact',
      channel: 'official_api',
      pointInTimeCoordinate: coordinate,
      sourceUrl: fetched.finalUrl || url,
      fetchedAt: new Date().toISOString(),
      wordCount: wordCount(content),
    };
  },
};

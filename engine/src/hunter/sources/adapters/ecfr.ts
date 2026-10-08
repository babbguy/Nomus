/**
 * eCFR Adapter — official structured CFR ingestion (channel: official_api).
 * =========================================================================
 *
 * The Electronic Code of Federal Regulations (https://www.ecfr.gov) exposes a
 * free, key-less API that serves the FULL official XML of any CFR title (or a
 * scoped part/subpart/section) as it existed on any date:
 *
 *     GET /api/versioner/v1/full/{YYYY-MM-DD}/title-{n}.xml
 *         [?part={p}][&subpart={s}][&section={sec}]
 *
 * This XML IS the authoritative legal text — complete by construction, with no
 * page chrome, no navigation, no table-of-contents-as-content, no truncation.
 * We hash the served bytes (byte_exact) and store the eCFR date + title/part as
 * the point-in-time coordinate. This replaces the fragile Cornell LII HTML
 * scraping for CFR-based sources (HIPAA 45 CFR 164, FDA 21 CFR 11,
 * GLBA 16 CFR 314, FERPA 34 CFR 99).
 *
 * Point-in-time resolution: a registry URL may use the literal date `current`.
 * The adapter resolves it to the title's real `up_to_date_as_of` issue date via
 * the titles metadata endpoint, then fetches THAT dated XML — so the stored
 * coordinate is always a concrete immutable date, never the word "current".
 *
 * Conditional fetching: the part's last-amended date is read cheaply from the
 * versioner `versions` endpoint. If it matches the coordinate we already hold
 * (and we have prior content), the heavy full-XML download is skipped.
 *
 * Endpoints confirmed live 2026-07-26 (no API key required):
 *   - /api/versioner/v1/titles.json                         (title metadata)
 *   - /api/versioner/v1/versions/title-{n}.json?part={p}    (amendment dates)
 *   - /api/versioner/v1/full/{date}/title-{n}.xml?part={p}  (official XML)
 */

import { logger } from '../../../logger.js';
import {
  fetchOfficialBytes,
  fetchOfficialJson,
  officialXmlToText,
  sha256Hex,
  wordCount,
} from './shared.js';
import type {
  AdapterContext,
  AdapterOutcome,
  IngestionAdapter,
  PointInTimeCoordinate,
} from './types.js';

const ECFR_HOST = 'ecfr.gov';
const ECFR_API_BASE = 'https://www.ecfr.gov/api/versioner/v1';

/** Matches the official full-XML endpoint path we ingest from. */
const FULL_XML_RE =
  /\/api\/versioner\/v1\/full\/([^/]+)\/title-(\d+)\.xml/i;

interface EcfrTarget {
  date: string; // 'current' or YYYY-MM-DD
  title: number;
  part: string | null;
  subpart: string | null;
  section: string | null;
}

interface TitlesResponse {
  titles: Array<{
    number: number;
    name: string;
    latest_amended_on: string | null;
    latest_issue_date: string | null;
    up_to_date_as_of: string | null;
    reserved: boolean;
  }>;
}

interface VersionsResponse {
  content_versions: Array<{
    date: string;
    amendment_date: string;
    issue_date: string;
    identifier: string;
    part: string;
    subpart?: string;
    section?: string;
    substantive: boolean;
    removed: boolean;
  }>;
}

/** Parse title/part/subpart/section + date out of the official eCFR API URL. */
export function parseEcfrTarget(url: string): EcfrTarget | null {
  const m = url.match(FULL_XML_RE);
  if (!m) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const title = Number(m[2]);
  if (!Number.isInteger(title) || title < 1) return null;
  return {
    date: m[1],
    title,
    part: parsed.searchParams.get('part'),
    subpart: parsed.searchParams.get('subpart'),
    section: parsed.searchParams.get('section'),
  };
}

function buildFullXmlUrl(t: EcfrTarget, date: string): string {
  const qs = new URLSearchParams();
  if (t.part) qs.set('part', t.part);
  if (t.subpart) qs.set('subpart', t.subpart);
  if (t.section) qs.set('section', t.section);
  const query = qs.toString();
  return `${ECFR_API_BASE}/full/${date}/title-${t.title}.xml${query ? `?${query}` : ''}`;
}

function buildCitation(t: EcfrTarget, date: string): string {
  const parts = [`${t.title} CFR`];
  if (t.part) parts.push(`Part ${t.part}`);
  if (t.subpart) parts.push(`Subpart ${t.subpart}`);
  if (t.section) parts.push(`§ ${t.section}`);
  return `${parts.join(' ')} @ ${date}`;
}

/** Highest amendment date across a part's sections — the part-level "last amended". */
function partLatestAmendedOn(versions: VersionsResponse, part: string | null): string | null {
  const rows = versions.content_versions.filter(
    (v) => !part || v.part === part,
  );
  if (rows.length === 0) return null;
  return rows
    .map((v) => v.amendment_date)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
}

export const ecfrAdapter: IngestionAdapter = {
  id: 'ecfr',
  channel: 'official_api',
  label: 'eCFR (Electronic Code of Federal Regulations)',

  canHandle(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return host.includes(ECFR_HOST) && FULL_XML_RE.test(url);
    } catch {
      return false;
    }
  },

  async fetch(url: string, ctx: AdapterContext = {}): Promise<AdapterOutcome> {
    const emit = ctx.emit ?? (() => {});
    const target = parseEcfrTarget(url);
    if (!target) {
      throw new Error(`eCFR adapter: unrecognized eCFR API URL: ${url}`);
    }

    // ─── Resolve `current` → a concrete immutable issue date ───────────
    let resolvedDate = target.date;
    let partAmendedOn: string | null = null;

    if (target.date === 'current') {
      const titles = await fetchOfficialJson<TitlesResponse>(
        `${ECFR_API_BASE}/titles.json`,
        { fetchImpl: ctx.fetchImpl },
      );
      const meta = titles.titles.find((t) => t.number === target.title);
      if (!meta) {
        throw new Error(`eCFR adapter: title ${target.title} not found in titles metadata`);
      }
      // The date the content is authoritatively current through.
      resolvedDate = meta.up_to_date_as_of ?? meta.latest_issue_date ?? '';
      if (!resolvedDate) {
        throw new Error(`eCFR adapter: no issue date available for title ${target.title}`);
      }
    }

    // ─── Part-level last-amended date (coordinate + conditional fetch) ──
    try {
      const versions = await fetchOfficialJson<VersionsResponse>(
        `${ECFR_API_BASE}/versions/title-${target.title}.json${target.part ? `?part=${encodeURIComponent(target.part)}` : ''}`,
        { fetchImpl: ctx.fetchImpl },
      );
      partAmendedOn = partLatestAmendedOn(versions, target.part);
    } catch (err) {
      // Non-fatal: the coordinate still carries the resolved date. We just lose
      // the conditional-fetch optimization and the amendment-date field.
      logger.warn(
        { title: target.title, part: target.part, error: (err as Error).message },
        'eCFR adapter: versions endpoint failed — proceeding without amendment date',
      );
    }

    const coordinate: PointInTimeCoordinate = {
      authority: 'ecfr',
      citation: buildCitation(target, resolvedDate),
      fields: {
        title: target.title,
        part: target.part,
        subpart: target.subpart,
        section: target.section,
        date: resolvedDate,
        partLatestAmendedOn: partAmendedOn,
      },
    };

    // ─── Conditional skip: nothing changed since our last promoted copy ─
    const priorAmendedOn = ctx.lastCoordinate?.fields?.partLatestAmendedOn ?? null;
    if (
      ctx.lastContentHash &&
      partAmendedOn &&
      priorAmendedOn &&
      partAmendedOn === priorAmendedOn
    ) {
      emit(1, `${coordinate.citation}: unchanged since last ingestion (last amended ${partAmendedOn}) — skipping full-XML download`, {
        title: target.title,
        part: target.part,
        partLatestAmendedOn: partAmendedOn,
      });
      return {
        kind: 'not_modified',
        channel: 'official_api',
        pointInTimeCoordinate: coordinate,
        reason: `eCFR part last amended ${partAmendedOn}; unchanged since prior ingestion.`,
      };
    }

    // ─── Fetch the official full XML (the byte-exact legal artifact) ────
    const fullUrl = buildFullXmlUrl(target, resolvedDate);
    const fetched = await fetchOfficialBytes(fullUrl, {
      accept: 'application/xml',
      fetchImpl: ctx.fetchImpl,
    });
    // 304 is impossible here (we send no validators to the full endpoint), but
    // guard defensively so a null never leaks downstream.
    if (!fetched) {
      throw new Error(`eCFR adapter: unexpected 304 from full-XML endpoint ${fullUrl}`);
    }

    const content = officialXmlToText(fetched.text);
    if (content.length < 200) {
      // An official artifact this short for a CFR part means the fetch is not
      // usable. HARD FAIL — never fall back to scraping. Source is held.
      throw new Error(
        `eCFR adapter: official XML for ${coordinate.citation} extracted to only ${content.length} chars — refusing to promote (source held for intervention).`,
      );
    }

    logger.info(
      {
        citation: coordinate.citation,
        bytes: fetched.bytesSize,
        rawBytesHash: fetched.bytesHash.slice(0, 12),
        words: wordCount(content),
      },
      `eCFR: ingested ${coordinate.citation} (byte_exact)`,
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
      sourceUrl: fullUrl,
      fetchedAt: new Date().toISOString(),
      wordCount: wordCount(content),
    };
  },
};

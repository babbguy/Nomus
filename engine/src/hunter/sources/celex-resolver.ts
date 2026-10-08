/**
 * CELEX Resolver — consolidated-version + amendment awareness for EU sources.
 *
 * A registry URL like `...?uri=CELEX:32024R1689` points at an act AS ADOPTED —
 * a permanently frozen document. Amendments only ever appear in the CONSOLIDATED
 * text, which carries a dated CELEX in sector 0 (e.g. `02024R1689-20240712`).
 * Fetching only the sector-3 CELEX means never seeing an amendment: for
 * example, the Digital Omnibus (CELEX 32026R1744) would be invisible to the
 * pipeline.
 *
 * Before each scrape of a EUR-Lex source this module asks the Publications
 * Office Cellar (SPARQL):
 *   1. Which consolidated versions of the base act exist?
 *   2. Which acts amend the base act, and when?
 * It then rewrites the URL to the newest consolidated version whose content is
 * actually retrievable (consolidation content can lag its metadata), falling
 * back to the as-adopted text otherwise. Amendments newer than whatever text
 * we end up fetching are surfaced as tier-2 events — the law changed and the
 * fetched text does not include it yet — so "rules update when the law does"
 * degrades loudly, never silently.
 *
 * Resolution failures fall back to the original URL: fetching the as-adopted
 * text is still authoritative for what it is, and provenance records exactly
 * which CELEX was fetched.
 */

import { logger } from '../../logger.js';

const SPARQL_ENDPOINT = 'https://publications.europa.eu/webapi/rdf/sparql';
const CELLAR_RESOURCE_BASE = 'https://publications.europa.eu/resource/celex/';
const SPARQL_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 15_000;

export type EmitFn = (tier: 1 | 2 | 3, message: string, details?: Record<string, unknown>) => void;

export interface AmendingAct {
  celex: string;
  /** xsd:date of the amending act (YYYY-MM-DD), when Cellar has it */
  date: string | null;
}

export interface CelexResolution {
  /** URL to fetch (rewritten to the consolidated CELEX when one is retrievable) */
  url: string;
  baseCelex: string;
  /** The CELEX whose text will actually be fetched */
  resolvedCelex: string;
  consolidated: boolean;
  /** Amending acts NEWER than the resolved text — law changed, text lags */
  pendingAmendments: AmendingAct[];
}

/** Extract a CELEX identifier (as-adopted or dated consolidated) from a EUR-Lex URL. */
export function extractCelex(url: string): string | null {
  const m = url.match(/CELEX(?::|%3A)([0-9A-Z()]+(?:-[0-9]{8})?)/i);
  return m ? m[1] : null;
}

type FetchLike = typeof fetch;

async function sparqlSelect(
  query: string,
  fetchImpl: FetchLike,
): Promise<Array<Record<string, string>>> {
  const params = new URLSearchParams({
    query,
    format: 'application/sparql-results+json',
  });
  const res = await fetchImpl(`${SPARQL_ENDPOINT}?${params.toString()}`, {
    headers: {
      'Accept': 'application/sparql-results+json',
      'User-Agent': 'Nomus-Engine/1.0',
    },
    signal: AbortSignal.timeout(SPARQL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Cellar SPARQL HTTP ${res.status}`);
  const json = (await res.json()) as {
    results?: { bindings?: Array<Record<string, { value: string }>> };
  };
  return (json.results?.bindings ?? []).map((binding) =>
    Object.fromEntries(Object.entries(binding).map(([k, v]) => [k, v.value])),
  );
}

/**
 * All consolidated CELEX ids for a base act, ascending by consolidation date.
 * Base `32024R1689` → consolidated family prefix `02024R1689-`.
 */
export async function listConsolidatedCelex(
  baseCelex: string,
  fetchImpl: FetchLike = fetch,
): Promise<string[]> {
  const prefix = `0${baseCelex.slice(1)}-`;
  const query =
    `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#> ` +
    `SELECT DISTINCT ?celex WHERE { ?work cdm:resource_legal_id_celex ?celex . ` +
    `FILTER(STRSTARTS(STR(?celex), "${prefix}")) } ORDER BY ?celex`;
  const rows = await sparqlSelect(query, fetchImpl);
  // Same prefix on every id, so lexicographic order == date order (YYYYMMDD suffix).
  return rows.map((r) => r.celex).filter(Boolean).sort();
}

/** All acts that amend the base act, newest first. */
export async function listAmendingActs(
  baseCelex: string,
  fetchImpl: FetchLike = fetch,
): Promise<AmendingAct[]> {
  const query =
    `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#> ` +
    `SELECT DISTINCT ?celex ?date WHERE { ` +
    `?amending cdm:resource_legal_amends_resource_legal ?base . ` +
    `?base cdm:resource_legal_id_celex "${baseCelex}"^^<http://www.w3.org/2001/XMLSchema#string> . ` +
    `?amending cdm:resource_legal_id_celex ?celex . ` +
    `OPTIONAL { ?amending cdm:work_date_document ?date } } ORDER BY DESC(?date)`;
  const rows = await sparqlSelect(query, fetchImpl);
  return rows
    .filter((r) => r.celex)
    .map((r) => ({ celex: r.celex, date: r.date ?? null }));
}

/**
 * Whether the Cellar holds a retrievable XHTML body for this CELEX.
 * Consolidated versions get SPARQL metadata before their content is published,
 * so existence of the id does not imply fetchable text. Headers-only check:
 * the body stream is cancelled immediately.
 */
async function probeCellarContent(celex: string, fetchImpl: FetchLike): Promise<boolean> {
  try {
    const res = await fetchImpl(`${CELLAR_RESOURCE_BASE}${celex}`, {
      headers: {
        'Accept': 'application/xhtml+xml',
        'Accept-Language': 'en',
        'User-Agent': 'Nomus-Engine/1.0',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    try {
      await res.body?.cancel();
    } catch {
      // Body already consumed/closed — the status is all we need.
    }
    return res.ok;
  } catch {
    return false;
  }
}

/** YYYYMMDD sort key for comparing consolidation suffixes with amendment dates. */
function dateKey(isoOrCompact: string): string {
  return isoOrCompact.replace(/-/g, '');
}

/**
 * Resolve a EUR-Lex source URL to the newest retrievable text of the act.
 * Never throws — on any failure it returns the original URL so the scrape
 * proceeds against the as-adopted text (with a tier-2 event explaining why).
 */
export async function resolveEurLexUrl(
  url: string,
  opts?: { emit?: EmitFn; fetchImpl?: FetchLike },
): Promise<CelexResolution> {
  const emit = opts?.emit ?? (() => {});
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const baseCelex = extractCelex(url) ?? '';
  const unresolved: CelexResolution = {
    url,
    baseCelex,
    resolvedCelex: baseCelex,
    consolidated: false,
    pendingAmendments: [],
  };

  // Only sector-3 CELEX (legal acts) have consolidated families.
  if (!baseCelex || !baseCelex.startsWith('3')) return unresolved;

  let versions: string[];
  let amendments: AmendingAct[];
  try {
    [versions, amendments] = await Promise.all([
      listConsolidatedCelex(baseCelex, fetchImpl),
      listAmendingActs(baseCelex, fetchImpl),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(2, `CELEX resolution failed for ${baseCelex} — fetching as-adopted text`, {
      baseCelex,
      error: message,
    });
    logger.warn({ baseCelex, error: message }, 'CELEX resolution failed — falling back to as-adopted text');
    return unresolved;
  }

  // Newest consolidated version whose content actually exists in the Cellar.
  let resolvedCelex = baseCelex;
  let consolidated = false;
  for (let i = versions.length - 1; i >= 0; i--) {
    if (await probeCellarContent(versions[i], fetchImpl)) {
      resolvedCelex = versions[i];
      consolidated = true;
      break;
    }
  }

  // Amendments newer than the text we are about to fetch. For the as-adopted
  // text every dated amendment is pending by definition.
  const resolvedDateKey = consolidated
    ? dateKey(resolvedCelex.slice(resolvedCelex.lastIndexOf('-') + 1))
    : '00000000';
  const pendingAmendments = amendments.filter(
    (a) => a.date !== null && dateKey(a.date) > resolvedDateKey,
  );

  if (pendingAmendments.length > 0) {
    const list = pendingAmendments.map((a) => `${a.celex} (${a.date})`).join(', ');
    emit(2,
      `${baseCelex}: amended by ${list} but the consolidated text is not yet available — ` +
      `fetching ${resolvedCelex}. Rules derived from this source may lag the law.`,
      { baseCelex, resolvedCelex, consolidated, pendingAmendments },
    );
    logger.warn({ baseCelex, resolvedCelex, pendingAmendments },
      'Act has amendments newer than any retrievable text');
  }

  if (consolidated) {
    emit(1, `${baseCelex}: fetching consolidated version ${resolvedCelex}`, {
      baseCelex, resolvedCelex,
    });
  }

  return {
    url: consolidated ? url.replace(baseCelex, resolvedCelex) : url,
    baseCelex,
    resolvedCelex,
    consolidated,
    pendingAmendments,
  };
}

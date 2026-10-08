/**
 * Ingestion Adapter Framework — API-first regulatory ingestion.
 * ============================================================
 *
 * The best regulatory scraper does NOT scrape when an official structured
 * source exists. When a government publishes a machine-readable API or bulk
 * feed for the exact legal text (eCFR XML, Federal Register document XML,
 * EUR-Lex Cellar XHTML), we pull the official artifact directly and hash the
 * bytes the government served. That artifact is COMPLETE-BY-CONSTRUCTION — no
 * page chrome, no table-of-contents-as-content, no truncation — so it flows
 * through the refuse-to-guess pipeline as `byte_exact` and promotable.
 *
 * An adapter is selected for a source by a CHANNEL-HIERARCHY router:
 *
 *     official_api  >  bulk  >  rss  >  scrape
 *
 * The highest-priority adapter whose `canHandle(url)` returns true wins. A
 * source with NO adapter falls through to the existing self-healing HTML/PDF
 * scraper path, completely unchanged.
 *
 * HARD-FAIL, NOT FALLBACK: when an adapter is selected, a failed official
 * fetch is a HARD FAILURE. We never silently fall back to scraping stale HTML
 * and present it as current law. The source is held for intervention with a
 * clear reason (this is the refuse-to-guess contract — see hunter/provenance.ts).
 *
 * Every adapter result carries a POINT-IN-TIME COORDINATE: the official,
 * immutable reference for exactly which version of the law was ingested
 * (eCFR date + title/part, FR document number + publication date, EUR-Lex
 * CELEX version). Every stored regulation therefore cites an official
 * immutable version, not merely a fetch timestamp.
 */

/** Channels in descending priority. Lower index = higher priority. */
export const CHANNEL_PRIORITY = ['official_api', 'bulk', 'rss', 'scrape'] as const;

export type IngestionChannel = (typeof CHANNEL_PRIORITY)[number];

/** Emit tiered operational events (mirrors the scraper/CELEX resolver signature). */
export type EmitFn = (
  tier: 1 | 2 | 3,
  message: string,
  details?: Record<string, unknown>,
) => void;

/**
 * The official, immutable reference for exactly which version of the law was
 * ingested. Persisted alongside the snapshot so every stored regulation cites
 * an authoritative point-in-time coordinate, never just a fetch timestamp.
 */
export interface PointInTimeCoordinate {
  /** The authority/system the coordinate is expressed in. */
  authority:
    | 'ecfr'
    | 'federal_register'
    | 'eur_lex_cellar'
    | 'nist_oscal'
    | 'legislation_gov_uk';
  /** Human-readable immutable citation (e.g. "45 CFR Part 164 @ 2024-05-17"). */
  citation: string;
  /** Structured immutable fields (title, part, date, document number, CELEX…). */
  fields: Record<string, string | number | boolean | null>;
}

/**
 * A successful official-artifact fetch. `rawContent`/`rawBytesHash` are the
 * bytes the government served (the byte-exact proof); `content` is the text
 * extracted from that artifact for the downstream pipeline.
 */
export interface AdapterResult {
  kind: 'fetched';
  /** Text extracted from the official artifact (for cleaning/extraction). */
  content: string;
  /** sha256(content) — the extracted-text hash. */
  contentHash: string;
  /** The official artifact exactly as served (XML/XHTML/plain text). */
  rawContent: string;
  /** sha256 of the official artifact bytes — the byte-exact receipt. */
  rawBytesHash: string;
  /** Size of the official artifact in bytes. */
  rawBytesSize: number;
  /** Content-Type of the official artifact. */
  contentType: string;
  /** Official-API content is always byte-exact against the served body. */
  provenanceMode: 'byte_exact';
  /** Which channel produced this result. */
  channel: IngestionChannel;
  /** The official immutable version coordinate. */
  pointInTimeCoordinate: PointInTimeCoordinate;
  /** The official artifact URL that was fetched. */
  sourceUrl: string;
  fetchedAt: string;
  wordCount: number;
}

/**
 * A conditional-fetch skip: the authority reports the content is unchanged
 * since the coordinate we already hold, so the heavy artifact was NOT
 * re-downloaded. Only ever returned when a prior content hash exists.
 */
export interface AdapterNotModified {
  kind: 'not_modified';
  channel: IngestionChannel;
  pointInTimeCoordinate: PointInTimeCoordinate;
  reason: string;
}

export type AdapterOutcome = AdapterResult | AdapterNotModified;

export interface AdapterContext {
  sourceId?: string;
  sourceName?: string;
  jurisdiction?: string;
  /** Content hash of the last promoted snapshot (enables conditional skip). */
  lastContentHash?: string | null;
  /** Coordinate of the last promoted snapshot (enables conditional skip). */
  lastCoordinate?: PointInTimeCoordinate | null;
  emit?: EmitFn;
  /** Injectable fetch for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

export interface IngestionAdapter {
  /** Stable identifier (e.g. 'ecfr', 'federal_register', 'eur_lex_cellar'). */
  readonly id: string;
  /** The channel this adapter serves — drives router priority. */
  readonly channel: IngestionChannel;
  /** Human label for logs/dashboards. */
  readonly label: string;
  /** True when this adapter can ingest the given source URL. */
  canHandle(url: string): boolean;
  /**
   * Fetch the official artifact. MUST throw on any failure — a thrown error is
   * a hard fail that holds the source; it must NEVER be swallowed into an HTML
   * scrape fallback by the caller.
   */
  fetch(url: string, ctx?: AdapterContext): Promise<AdapterOutcome>;
}

/**
 * Honest User-Agent: identifies Nomus and carries a contact address so
 * publishers can reach us. Used for every official-API request.
 */
export const NOMUS_INGEST_UA =
  'Nomus-Regulatory-Ingestion/1.0 (+https://github.com/babbguy/Nomus)';

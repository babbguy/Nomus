/**
 * Shared helpers for official-API ingestion adapters.
 *
 *   - fetchOfficialBytes: a single HTTP fetch of an official artifact that
 *     captures the unmodified body bytes and their sha256 (the byte-exact
 *     receipt) BEFORE any parsing, plus ETag/Last-Modified for conditional
 *     re-fetching. Throws on any non-OK status — official fetches HARD FAIL.
 *   - officialXmlToText: deterministic, DOM-order text extraction from the
 *     government XML dialects (eCFR reg XML, Federal Register document XML).
 *     No LLM, no interpolation — it only re-serializes existing element text.
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { NOMUS_INGEST_UA } from './types.js';

const DEFAULT_TIMEOUT_MS = 45_000;

export interface OfficialFetch {
  /** Unmodified response body bytes. */
  bytes: Buffer;
  /** UTF-8 decoding of the body (safe for XML/XHTML/plain text artifacts). */
  text: string;
  /** sha256 of the unmodified body bytes — the byte-exact receipt. */
  bytesHash: string;
  bytesSize: number;
  contentType: string;
  status: number;
  finalUrl: string;
  etag: string | null;
  lastModified: string | null;
}

export interface FetchOptions {
  accept?: string;
  acceptLanguage?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Conditional-request validators (skip re-download when unchanged). */
  ifNoneMatch?: string | null;
  ifModifiedSince?: string | null;
  /** Extra headers merged last. */
  headers?: Record<string, string>;
}

/**
 * Fetch an official artifact and capture byte-level provenance.
 *
 * @returns the fetch result, or `null` when the server answers 304 Not
 *          Modified to a conditional request (caller treats as unchanged).
 * @throws  on any other non-OK status — official fetches never fall back.
 */
export async function fetchOfficialBytes(
  url: string,
  opts: FetchOptions = {},
): Promise<OfficialFetch | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    'User-Agent': NOMUS_INGEST_UA,
    'Accept': opts.accept ?? 'application/json',
    'Accept-Language': opts.acceptLanguage ?? 'en-US,en;q=0.9',
    ...(opts.ifNoneMatch ? { 'If-None-Match': opts.ifNoneMatch } : {}),
    ...(opts.ifModifiedSince ? { 'If-Modified-Since': opts.ifModifiedSince } : {}),
    ...(opts.headers ?? {}),
  };

  const res = await fetchImpl(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (res.status === 304) return null;

  if (!res.ok) {
    throw new Error(`Official fetch failed: HTTP ${res.status} for ${url}`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error(`Official fetch returned an empty body for ${url}`);
  }

  return {
    bytes,
    text: bytes.toString('utf-8'),
    bytesHash: createHash('sha256').update(bytes).digest('hex'),
    bytesSize: bytes.length,
    contentType: res.headers.get('content-type') ?? '',
    status: res.status,
    finalUrl: res.url || url,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

/** Fetch + parse an official JSON metadata endpoint. Throws on non-OK. */
export async function fetchOfficialJson<T>(
  url: string,
  opts: FetchOptions = {},
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url, {
    headers: {
      'User-Agent': NOMUS_INGEST_UA,
      'Accept': opts.accept ?? 'application/json',
      'Accept-Language': opts.acceptLanguage ?? 'en-US,en;q=0.9',
      ...(opts.headers ?? {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Official metadata fetch failed: HTTP ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}

/**
 * Leaf-level element tags that carry text in the US government XML dialects.
 * Heading tags become markdown headings so the downstream article-chunker can
 * see section boundaries; the rest become paragraphs. These tags do not nest
 * one another, so selecting them all yields DOM-ordered text with no
 * duplication and no dropped content.
 */
// Leaf content tags that carry text and do NOT nest one another (so selecting
// them all yields document-ordered text with no duplication). Container tags
// like AUTH/SOURCE are deliberately excluded — their inner HED/PSPACE/FP are
// captured directly, which would otherwise be double-counted.
const HEADING_TAGS = new Set(['HEAD', 'HED', 'HD', 'HD1', 'HD2', 'HD3', 'HD4', 'RESERVED']);
const PARAGRAPH_TAGS = new Set(['P', 'FP', 'PSPACE', 'NOTE', 'EXTRACT', 'STARS']);

/**
 * Deterministically extract text from a government XML artifact (eCFR reg XML
 * or Federal Register document XML), preserving document order and section
 * headings. Purely mechanical: it re-serializes text that already exists in
 * the artifact. It never invents, gap-fills, or paraphrases.
 */
export function officialXmlToText(xml: string): string {
  const $ = cheerio.load(xml, { xml: true });
  const lines: string[] = [];

  $('*').each((_, el) => {
    const tag = ((el as Element).tagName ?? '').toUpperCase();
    const isHeading = HEADING_TAGS.has(tag);
    const isParagraph = PARAGRAPH_TAGS.has(tag);
    if (!isHeading && !isParagraph) return;

    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;

    lines.push(isHeading ? `\n## ${text}\n` : text);
  });

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Text-carrying elements in the UK CLML dialect (Crown Legislation Markup
 * Language, served by legislation.gov.uk `/data.xml`). Headings (`Title`,
 * `Number`) become markdown headings so the article-chunker sees provision
 * boundaries; provision numbers (`Pnumber`) and prose (`Text`) become
 * paragraphs. None of these tags nests another in the set, and an explicit
 * ancestor guard drops the rare nested case (e.g. `<Title><Text>…`), so the
 * walk yields document-ordered text with no duplication and no dropped content.
 */
const CLML_HEADING_TAGS = new Set(['TITLE', 'NUMBER']);
const CLML_PARAGRAPH_TAGS = new Set(['PNUMBER', 'TEXT']);

/**
 * Deterministically extract the enacted legal text from a legislation.gov.uk
 * CLML artifact. Non-enacted apparatus — `Metadata`, `Commentaries` (amendment
 * footnotes), `Resources`, `Footnotes`, and empty `CommentaryRef` markers — is
 * stripped first so only the operative provision text survives. Purely
 * mechanical: it re-serializes text that already exists in the artifact and
 * never invents, gap-fills, or paraphrases.
 */
export function clmlToText(xml: string): string {
  const $ = cheerio.load(xml, { xml: true });

  // Drop non-enacted apparatus. Commentaries/Footnotes carry amendment notes
  // that also use <Text>; removing them keeps the operative body exact.
  $('Commentaries, Footnotes, Resources, CommentaryRef').remove();
  // Namespaced metadata (<ukm:Metadata>) — match by local name.
  $('*')
    .filter((_, el) => {
      const t = ((el as Element).tagName ?? '').toLowerCase();
      return t === 'metadata' || t.endsWith(':metadata');
    })
    .remove();

  const matched = new Set([...CLML_HEADING_TAGS, ...CLML_PARAGRAPH_TAGS]);
  const lines: string[] = [];

  $('*').each((_, el) => {
    const tag = ((el as Element).tagName ?? '').toUpperCase();
    if (!matched.has(tag)) return;

    // Skip when an ancestor is itself a matched tag (avoid double counting).
    let parent = (el as Element).parent as Element | null;
    while (parent) {
      if (matched.has(((parent as Element).tagName ?? '').toUpperCase())) return;
      parent = (parent as Element).parent as Element | null;
    }

    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;

    lines.push(CLML_HEADING_TAGS.has(tag) ? `\n## ${text}\n` : text);
  });

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

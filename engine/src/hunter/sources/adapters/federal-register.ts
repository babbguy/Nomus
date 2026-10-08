/**
 * Federal Register Adapter — official document ingestion (channel: official_api).
 * ==============================================================================
 *
 * The Federal Register (https://www.federalregister.gov) exposes a free,
 * key-less API. A single document's metadata is:
 *
 *     GET /api/v1/documents/{document_number}.json
 *
 * which returns, among other fields, the official full-text artifact URLs:
 *
 *     full_text_xml_url  → the authoritative document XML (preferred)
 *     raw_text_url       → the official plain-text rendering
 *     body_html_url      → the official HTML body
 *
 * plus `publication_date`, `document_number`, and `citation` (e.g. "88 FR
 * 75191"). We resolve the document to its `full_text_xml_url`, fetch that
 * official artifact, hash the served bytes (byte_exact), and store the FR
 * document number + publication date + citation as the point-in-time
 * coordinate. Used for EO 14110 and AI-related rules.
 *
 * A published Federal Register document is IMMUTABLE — corrections are issued
 * as new documents with new numbers. So conditional fetching is exact: if we
 * already hold this document number, the artifact is skipped.
 *
 * Endpoints confirmed live 2026-07-26 (no API key required).
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

const FR_API_BASE = 'https://www.federalregister.gov/api/v1';

interface FrDocument {
  document_number: string;
  publication_date: string | null;
  full_text_xml_url: string | null;
  raw_text_url: string | null;
  body_html_url: string | null;
  html_url: string | null;
  title: string | null;
  type: string | null;
  citation: string | null;
}

/**
 * Extract the FR document number from any recognized URL form:
 *   - .../api/v1/documents/2023-24283.json
 *   - .../documents/2023/11/01/2023-24283/safe-secure-...
 *   - govinfo.gov/content/pkg/FR-2023-11-01/html/2023-24283.htm
 * FR document numbers look like YYYY-NNNNN.
 */
export function extractFrDocumentNumber(url: string): string | null {
  // API form
  let m = url.match(/\/documents\/(\d{4}-\d{3,})\.json/i);
  if (m) return m[1];
  // Human document permalink form
  m = url.match(/federalregister\.gov\/documents\/\d{4}\/\d{2}\/\d{2}\/(\d{4}-\d{3,})/i);
  if (m) return m[1];
  // GovInfo FR package form
  m = url.match(/govinfo\.gov\/content\/pkg\/FR-[\d-]+\/[a-z]+\/(\d{4}-\d{3,})\./i);
  if (m) return m[1];
  return null;
}

function isFederalRegisterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    if (host.includes('federalregister.gov')) return true;
    // GovInfo FR packages are Federal Register documents too.
    if (host.includes('govinfo.gov') && /\/FR-/i.test(url)) return true;
    return false;
  } catch {
    return false;
  }
}

export const federalRegisterAdapter: IngestionAdapter = {
  id: 'federal_register',
  channel: 'official_api',
  label: 'Federal Register',

  canHandle(url: string): boolean {
    return isFederalRegisterUrl(url) && extractFrDocumentNumber(url) !== null;
  },

  async fetch(url: string, ctx: AdapterContext = {}): Promise<AdapterOutcome> {
    const emit = ctx.emit ?? (() => {});
    const docNumber = extractFrDocumentNumber(url);
    if (!docNumber) {
      throw new Error(`Federal Register adapter: no document number in URL: ${url}`);
    }

    // ─── Resolve the document → official artifact URLs ─────────────────
    const fields =
      'document_number,publication_date,full_text_xml_url,raw_text_url,body_html_url,html_url,title,type,citation';
    const metaUrl = `${FR_API_BASE}/documents/${docNumber}.json?${fields
      .split(',')
      .map((f) => `fields[]=${f}`)
      .join('&')}`;

    const doc = await fetchOfficialJson<FrDocument>(metaUrl, { fetchImpl: ctx.fetchImpl });

    const coordinate: PointInTimeCoordinate = {
      authority: 'federal_register',
      citation: doc.citation
        ? `${doc.citation} (FR doc ${doc.document_number}, ${doc.publication_date ?? 'n/d'})`
        : `FR doc ${doc.document_number} (${doc.publication_date ?? 'n/d'})`,
      fields: {
        documentNumber: doc.document_number,
        publicationDate: doc.publication_date,
        citation: doc.citation,
        title: doc.title,
        type: doc.type,
      },
    };

    // ─── Conditional skip: FR documents are immutable once published ───
    const priorDoc = ctx.lastCoordinate?.fields?.documentNumber ?? null;
    if (ctx.lastContentHash && priorDoc && priorDoc === doc.document_number) {
      emit(1, `${coordinate.citation}: immutable FR document already ingested — skipping re-download`, {
        documentNumber: doc.document_number,
      });
      return {
        kind: 'not_modified',
        channel: 'official_api',
        pointInTimeCoordinate: coordinate,
        reason: `Federal Register document ${doc.document_number} is immutable and already ingested.`,
      };
    }

    // ─── Choose the official artifact (prefer XML, then text, then HTML) ─
    const artifactUrl = doc.full_text_xml_url ?? doc.raw_text_url ?? doc.body_html_url;
    if (!artifactUrl) {
      throw new Error(
        `Federal Register adapter: document ${doc.document_number} exposes no full-text artifact URL — refusing to guess (source held).`,
      );
    }
    const artifactKind: 'xml' | 'text' | 'html' = doc.full_text_xml_url
      ? 'xml'
      : doc.raw_text_url
        ? 'text'
        : 'html';
    coordinate.fields.artifactKind = artifactKind;
    coordinate.fields.artifactUrl = artifactUrl;

    const fetched = await fetchOfficialBytes(artifactUrl, {
      accept:
        artifactKind === 'xml'
          ? 'application/xml,text/xml'
          : artifactKind === 'text'
            ? 'text/plain'
            : 'text/html',
      fetchImpl: ctx.fetchImpl,
    });
    if (!fetched) {
      throw new Error(`Federal Register adapter: unexpected 304 for artifact ${artifactUrl}`);
    }

    // XML/HTML → structured text; plain text is already verbatim.
    let content: string;
    if (artifactKind === 'xml') {
      content = officialXmlToText(fetched.text);
    } else if (artifactKind === 'html') {
      const { parseHtml } = await import('../parsers/html-parser.js');
      content = parseHtml(fetched.text, {
        contentSelector: undefined,
        removeSelectors: ['script', 'style', 'nav', 'footer', 'header'],
      });
    } else {
      content = fetched.text.replace(/\r\n/g, '\n').trim();
    }

    if (content.length < 200) {
      throw new Error(
        `Federal Register adapter: artifact for ${coordinate.citation} extracted to only ${content.length} chars — refusing to promote (source held).`,
      );
    }

    logger.info(
      {
        citation: coordinate.citation,
        artifact: artifactKind,
        bytes: fetched.bytesSize,
        rawBytesHash: fetched.bytesHash.slice(0, 12),
        words: wordCount(content),
      },
      `Federal Register: ingested ${coordinate.citation} (byte_exact, ${artifactKind})`,
    );

    return {
      kind: 'fetched',
      content,
      contentHash: sha256Hex(content),
      rawContent: fetched.text,
      rawBytesHash: fetched.bytesHash,
      rawBytesSize: fetched.bytesSize,
      contentType: fetched.contentType || (artifactKind === 'xml' ? 'application/xml' : 'text/plain'),
      provenanceMode: 'byte_exact',
      channel: 'official_api',
      pointInTimeCoordinate: coordinate,
      sourceUrl: artifactUrl,
      fetchedAt: new Date().toISOString(),
      wordCount: wordCount(content),
    };
  },
};

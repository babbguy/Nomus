/**
 * Ingestion adapter framework — public surface.
 *
 * API-first regulatory ingestion: when a government publishes the exact legal
 * text through an official API or bulk feed, Nomus pulls that artifact
 * directly (byte_exact + an official point-in-time coordinate) instead of
 * scraping HTML. Sources without an adapter fall through to the existing
 * self-healing scraper path unchanged.
 */

export * from './types.js';
export { selectAdapter, listAdapters, hasAdapter } from './registry.js';
export { ecfrAdapter, parseEcfrTarget } from './ecfr.js';
export { federalRegisterAdapter, extractFrDocumentNumber } from './federal-register.js';
export { eurLexAdapter } from './eur-lex.js';
export { nistOscalAdapter, oscalCatalogToText } from './nist-oscal.js';
export { legislationUkAdapter, parseUkTarget } from './legislation-uk.js';
export {
  fetchOfficialBytes,
  fetchOfficialJson,
  officialXmlToText,
  clmlToText,
} from './shared.js';

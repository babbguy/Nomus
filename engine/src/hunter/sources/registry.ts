import type { SelectorConfig } from '@nomus/shared';

export interface SourceDefinition {
  name: string;
  jurisdiction: string;
  url: string;
  parserType: 'html' | 'pdf';
  selectorConfig: SelectorConfig;
  /** Tier 1 = launch sources, Tier 2 = phase 20, Tier 3 = standards, Tier 4 = industry-specific */
  tier: 1 | 2 | 3 | 4;
  /** ISO category for industry filtering */
  category?: string;
  /** auto = can be scraped, manual = requires file upload (paywalled/login) */
  ingestionMode: 'auto' | 'manual';
  /**
   * ACCESS-ESCALATION: the source is JS-rendered or bot-walled and a plain HTTP
   * fetch cannot capture it. When true, the scraper goes straight to a headless
   * browser capture (provenance 'rendered'). If headless is disabled/unavailable
   * or hits an anti-bot challenge, the source is held for MANUAL UPLOAD — the
   * documented human fallback. Requires NOMUS_HEADLESS_ENABLED + a browser on
   * the host (`npx playwright install chromium`).
   */
  needsHeadless?: boolean;
  /** Scrape frequency in hours. Regulations don't change overnight.
   *  Default: 168 (7 days) for active legislation
   *  Draft bills: 72 (3 days) — committee amendments happen faster
   *  Standards: 336 (14 days) — version releases are announced
   */
  scrapeFrequencyHours?: number;
  /**
   * API-first ingestion channel this source resolves to (documentation only —
   * routing is decided at fetch time by hunter/sources/adapters). 'official_api'
   * means `url` points at a government API/bulk feed and Nomus pulls the
   * exact legal text byte-exact (eCFR XML, Federal Register document XML,
   * EUR-Lex Cellar XHTML) rather than scraping HTML.
   */
  channel?: 'official_api' | 'scrape';
  /**
   * The previous HTML/scrape URL, retained as the DOCUMENTED fallback for a
   * source migrated to an official API. Not used automatically — if the API is
   * unreachable the source is HELD (refuse-to-guess), never silently scraped.
   */
  fallbackUrl?: string;
}

/**
 * Registry of known regulatory sources.
 * These are seeded into the database on first boot.
 * New sources can be added via the admin API.
 *
 * Tier 1: Core AI regulations (launch)
 * Tier 2: Major data protection & privacy (Phase 20)
 * Tier 3: Security standards & frameworks (Phase 20)
 * Tier 4: Industry-specific regulations (Phase 20)
 *
 * URLs validated March 26, 2026 — see TASK-DOCUMENT-SCRAPING.md
 */
export const REGULATORY_SOURCES: SourceDefinition[] = [
  // ─── Tier 1: Core AI Regulation (Launch) ──────────────────────
  {
    name: 'EU AI Act',
    jurisdiction: 'EU',
    // API-first: the EUR-Lex adapter resolves this CELEX to the newest
    // retrievable consolidated version and pulls the official Cellar XHTML
    // (byte_exact), storing the resolved CELEX version as the coordinate.
    url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32024R1689',
    parserType: 'html',
    selectorConfig: {
      contentSelector: '.eli-container',
      removeSelectors: ['nav', 'footer', '.note', '.footnote'],
    },
    tier: 1,
    category: 'ai_regulation',
    ingestionMode: 'auto',
    channel: 'official_api',
  },
  {
    name: 'NIST AI Risk Management Framework',
    jurisdiction: 'NIST',
    // NOT migrated to OSCAL: NIST does NOT publish AI 100-1 (AI RMF) as OSCAL
    // content — usnistgov/oscal-content covers SP 800-53/171/172/218 and CSF 2.0
    // only. Honesty over coverage: this stays on the official NIST PDF channel.
    // (Verified 2026-07-26.)
    url: 'https://nvlpubs.nist.gov/nistpubs/ai/nist.ai.100-1.pdf',
    parserType: 'pdf',
    selectorConfig: {
      pageRange: '1-72',
    },
    tier: 1,
    category: 'ai_standards',
    ingestionMode: 'auto',
  },
  {
    name: 'UK AI Regulation White Paper',
    jurisdiction: 'UK',
    // NOT migrated to the legislation.gov.uk adapter: this is a gov.uk POLICY
    // PAPER on www.gov.uk, not a legislation.gov.uk instrument — there is no
    // official CLML /data.xml for a policy paper. Honesty over coverage: it
    // stays on the existing gov.uk scrape channel. (Verified 2026-07-26.)
    url: 'https://www.gov.uk/government/publications/ai-regulation-a-pro-innovation-approach/white-paper',
    parserType: 'html',
    selectorConfig: {
      contentSelector: '.govuk-govspeak',
      removeSelectors: ['nav', 'footer', '.gem-c-print-link'],
    },
    tier: 1,
    category: 'ai_regulation',
    ingestionMode: 'auto',
  },

  // ─── Tier 2: Data Protection & Privacy (Phase 20) ─────────────
  {
    name: 'GDPR (EU General Data Protection Regulation)',
    jurisdiction: 'EU',
    url: 'https://gdpr-info.eu/',
    parserType: 'html',
    selectorConfig: {
      contentSelector: '.entry-content, article, main',
      removeSelectors: ['nav', 'footer', '.sidebar', '.comments', '.cookie-banner'],
    },
    tier: 2,
    category: 'data_protection',
    ingestionMode: 'auto',
    scrapeFrequencyHours: 336, // stable law, check every 14 days
  },
  {
    name: 'CCPA / CPRA (California Consumer Privacy Act)',
    jurisdiction: 'US-CA',
    url: 'https://cdp.cooley.com/ccpa-2018/',
    parserType: 'html',
    selectorConfig: {
      contentSelector: 'article, .entry-content, main',
      removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar', '.comments', '.wp-block-navigation'],
    },
    tier: 2,
    category: 'data_protection',
    ingestionMode: 'auto',
  },
  {
    name: 'Brazil LGPD (Lei Geral de Protecao de Dados)',
    jurisdiction: 'BR',
    url: 'https://lgpd-brazil.info/',
    parserType: 'html',
    selectorConfig: {
      contentSelector: '.content',
      removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar', '.comments', '.cookie-banner'],
    },
    tier: 2,
    category: 'data_protection',
    ingestionMode: 'auto',
    scrapeFrequencyHours: 336,
  },
  {
    name: 'HIPAA Privacy Rule',
    jurisdiction: 'US-FED',
    // API-first: official eCFR XML of 45 CFR Part 164 Subpart E (Privacy of
    // Individually Identifiable Health Information) at the current issue date.
    // The XML is complete-by-construction — byte_exact, no HTML chrome.
    url: 'https://www.ecfr.gov/api/versioner/v1/full/current/title-45.xml?part=164&subpart=E',
    parserType: 'html',
    selectorConfig: {},
    tier: 2,
    category: 'healthcare',
    ingestionMode: 'auto',
    channel: 'official_api',
    fallbackUrl: 'https://www.law.cornell.edu/cfr/text/45/part-164/subpart-E',
  },
  {
    name: 'HIPAA Security Rule',
    jurisdiction: 'US-FED',
    // API-first: official eCFR XML of 45 CFR Part 164 Subpart C (Security
    // Standards for the Protection of Electronic PHI) at the current issue date.
    url: 'https://www.ecfr.gov/api/versioner/v1/full/current/title-45.xml?part=164&subpart=C',
    parserType: 'html',
    selectorConfig: {},
    tier: 2,
    category: 'healthcare',
    ingestionMode: 'auto',
    channel: 'official_api',
    fallbackUrl: 'https://www.law.cornell.edu/cfr/text/45/part-164/subpart-C',
  },
  {
    name: 'NIST Cybersecurity Framework 2.0',
    jurisdiction: 'NIST',
    // API-first: official NIST OSCAL JSON catalog (usnistgov/oscal-content).
    // REPLACES PDF parsing — byte_exact over the served JSON, point-in-time =
    // OSCAL version + last-modified. (Migrated 2026-07-26.)
    url: 'https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/CSF/v2.0/json/NIST_CSF_v2.0_catalog.json',
    parserType: 'html', // ignored — the NIST OSCAL adapter handles this URL
    selectorConfig: {},
    tier: 2,
    category: 'cybersecurity',
    ingestionMode: 'auto',
    channel: 'official_api',
    fallbackUrl: 'https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf',
  },
  {
    name: 'OWASP Top 10 (2025)',
    jurisdiction: 'INTL',
    url: 'https://github.com/OWASP/Top10/tree/master/2025/docs/en',
    parserType: 'html',
    selectorConfig: {
      contentSelector: 'main, article, .md-content',
      removeSelectors: ['nav', 'footer', 'script', 'style', '.md-sidebar', '.md-header', '.md-tabs'],
    },
    tier: 2,
    category: 'application_security',
    ingestionMode: 'auto',
  },
  {
    name: 'OWASP Top 10 for LLM Applications',
    jurisdiction: 'INTL',
    url: 'https://genai.owasp.org/llm-top-10/',
    parserType: 'html',
    selectorConfig: {
      contentSelector: '#content, .entry-content, article, main',
      removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar', '.cookie-banner', '.ast-scroll-top-icon'],
    },
    tier: 2,
    category: 'ai_security',
    ingestionMode: 'auto',
  },

  // ─── Tier 3: Security Standards & Frameworks ──────────────────
  // NOTE: Paywalled/login-gated standards are marked ingestionMode: 'manual'.
  // Customers upload their purchased copy via the Sources page.
  {
    name: 'NIST SP 800-53 Rev 5 (Security Controls)',
    jurisdiction: 'NIST',
    // API-first: official NIST OSCAL JSON catalog (usnistgov/oscal-content).
    // REPLACES PDF parsing — the OSCAL JSON is the authoritative machine-readable
    // catalog (complete by construction, no PDF layout/column/OCR artifacts). The
    // NIST OSCAL adapter hashes the served JSON bytes (byte_exact) and stores the
    // OSCAL version + last-modified as the point-in-time coordinate. (Migrated
    // 2026-07-26.)
    url: 'https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json',
    parserType: 'html', // ignored — the NIST OSCAL adapter handles this URL
    selectorConfig: {},
    tier: 3,
    category: 'cybersecurity',
    ingestionMode: 'auto',
    channel: 'official_api',
    fallbackUrl: 'https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-53r5.pdf',
  },
  {
    name: 'PCI-DSS v4.0 (Requires Registration)',
    jurisdiction: 'INTL',
    url: 'https://www.pcisecuritystandards.org/document_library/',
    parserType: 'pdf',
    selectorConfig: {
      contentSelector: 'main',
      removeSelectors: ['nav', 'footer', 'script', 'style'],
    },
    tier: 3,
    category: 'payment_security',
    ingestionMode: 'manual',
  },
  {
    name: 'SOC 2 Trust Services Criteria (Requires Purchase)',
    jurisdiction: 'INTL',
    url: 'https://us.aicpa.org/interestareas/frc/assuranceadvisoryservices/trustservicescriteria',
    parserType: 'html',
    selectorConfig: {
      contentSelector: 'main',
      removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar'],
    },
    tier: 3,
    category: 'audit_compliance',
    ingestionMode: 'manual',
  },
  {
    name: 'ISO 27001 Summary (Information Security)',
    jurisdiction: 'ISO',
    url: 'https://www.iso.org/standard/27001',
    parserType: 'html',
    selectorConfig: {
      contentSelector: 'main',
      removeSelectors: ['nav', 'footer', 'script', 'style'],
    },
    tier: 3,
    category: 'information_security',
    ingestionMode: 'manual',
  },
  {
    name: 'CIS Controls v8 (Requires Login)',
    jurisdiction: 'INTL',
    url: 'https://www.cisecurity.org/controls/v8',
    parserType: 'html',
    selectorConfig: {
      contentSelector: 'main',
      removeSelectors: ['nav', 'footer', 'script', 'style'],
    },
    tier: 3,
    category: 'cybersecurity',
    ingestionMode: 'manual',
  },

  {
    name: 'US FedRAMP Rev 5 Baselines (OSCAL)',
    jurisdiction: 'US-FED',
    url: 'https://github.com/GSA/fedramp-automation/tree/master/dist/content/rev5/baselines/json',
    parserType: 'html',
    selectorConfig: {},
    tier: 3,
    category: 'government',
    ingestionMode: 'manual', // GitHub repo (GSA/fedramp-automation) removed — needs manual upload
  },

  // ─── Tier 4: Industry-Specific & Regional ─────────────────────
  {
    name: 'EU DORA (Digital Operational Resilience Act)',
    jurisdiction: 'EU',
    url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022R2554',
    parserType: 'html',
    selectorConfig: {
      contentSelector: '.eli-container',
      removeSelectors: ['nav', 'footer', '.note', '.footnote'],
    },
    tier: 4,
    category: 'financial_services',
    ingestionMode: 'auto',
    channel: 'official_api', // EUR-Lex Cellar adapter (byte_exact)
  },
  {
    name: 'EU NIS2 Directive (Network & Information Security)',
    jurisdiction: 'EU',
    url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022L2555',
    parserType: 'html',
    selectorConfig: {
      contentSelector: '.eli-container',
      removeSelectors: ['nav', 'footer', '.note', '.footnote'],
    },
    tier: 4,
    category: 'cybersecurity',
    ingestionMode: 'auto',
    channel: 'official_api', // EUR-Lex Cellar adapter (byte_exact)
  },
  {
    name: 'FERPA (Family Educational Rights and Privacy Act)',
    jurisdiction: 'US-FED',
    // API-first: official eCFR XML of 34 CFR Part 99 at the current issue date.
    url: 'https://www.ecfr.gov/api/versioner/v1/full/current/title-34.xml?part=99',
    parserType: 'html',
    selectorConfig: {},
    tier: 4,
    category: 'education',
    ingestionMode: 'auto',
    channel: 'official_api',
    fallbackUrl: 'https://www.law.cornell.edu/cfr/text/34/part-99',
  },
  {
    name: 'GLBA (Gramm-Leach-Bliley Act) Safeguards Rule',
    jurisdiction: 'US-FED',
    // API-first: official eCFR XML of 16 CFR Part 314 (Safeguards Rule) at the
    // current issue date.
    url: 'https://www.ecfr.gov/api/versioner/v1/full/current/title-16.xml?part=314',
    parserType: 'html',
    selectorConfig: {},
    tier: 4,
    category: 'financial_services',
    ingestionMode: 'auto',
    channel: 'official_api',
    fallbackUrl: 'https://www.law.cornell.edu/cfr/text/16/part-314',
  },
  {
    name: 'Singapore AI Governance Framework',
    jurisdiction: 'SG',
    url: 'https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/resource-for-organisation/ai/sgmodelaigovframework2.pdf',
    parserType: 'pdf',
    selectorConfig: {
      pageRange: '1-60',
    },
    tier: 4,
    category: 'ai_regulation',
    ingestionMode: 'auto',
  },
  {
    name: 'Japan AI Guidelines',
    jurisdiction: 'JP',
    url: 'https://www.meti.go.jp/shingikai/mono_info_service/ai_shakai_jisso/pdf/20240419_14.pdf',
    parserType: 'pdf',
    selectorConfig: {
      pageRange: '1-40',
    },
    tier: 4,
    category: 'ai_regulation',
    ingestionMode: 'auto',
  },
  {
    name: 'China AI Governance Principles (Stanford Translation)',
    jurisdiction: 'CN',
    url: 'https://digichina.stanford.edu/work/translation-chinese-expert-group-offers-governance-principles-for-responsible-ai/',
    parserType: 'html',
    selectorConfig: {
      contentSelector: 'article, .entry-content, main',
      removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar', '.share-buttons'],
    },
    tier: 4,
    category: 'ai_regulation',
    ingestionMode: 'auto',
  },
  {
    name: 'India Digital Personal Data Protection Act 2023',
    jurisdiction: 'IN',
    url: 'https://www.indiacode.nic.in/bitstream/123456789/22037/1/a2023-22.pdf',
    parserType: 'pdf',
    selectorConfig: {
      pageRange: '1-25',
    },
    tier: 4,
    category: 'data_protection',
    ingestionMode: 'auto',
  },
  {
    name: 'Australia AI Ethics Framework',
    jurisdiction: 'AU',
    url: 'https://www.industry.gov.au/publications/australias-ai-ethics-principles',
    parserType: 'html',
    selectorConfig: {
      contentSelector: 'main, article, .field--name-body',
      removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar', '.breadcrumb', 'img'],
    },
    tier: 4,
    category: 'ai_regulation',
    ingestionMode: 'manual', // Australian gov site blocks VPS IPs — needs manual upload
  },

  // ─── China AI Regulations (Full Text Translations) ──────────────
  {
    name: 'China Deep Synthesis Provisions (Deepfakes/AI-Generated Content)',
    jurisdiction: 'CN',
    url: 'https://www.chinalawtranslate.com/en/deep-synthesis/',
    parserType: 'html',
    selectorConfig: {
      contentSelector: '.entry-content',
      removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar', '.comments', '.cookie-banner',
        '.sharedaddy', '.sd-sharing', '.jp-relatedposts', '.post-navigation', '.author-info',
        '.molongui-authorship', 'img', '.wp-block-image'],
    },
    tier: 1,
    category: 'ai_regulation',
    ingestionMode: 'manual', // chinalawtranslate.com blocks VPS IPs (403)
  },
  {
    name: 'China Generative AI Interim Measures',
    jurisdiction: 'CN',
    url: 'https://www.chinalawtranslate.com/en/generative-ai-interim/',
    parserType: 'html',
    selectorConfig: {
      contentSelector: '.entry-content',
      removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar', '.comments', '.cookie-banner',
        '.sharedaddy', '.sd-sharing', '.jp-relatedposts', '.post-navigation', '.author-info',
        '.molongui-authorship', 'img', '.wp-block-image'],
    },
    tier: 1,
    category: 'ai_regulation',
    ingestionMode: 'manual', // chinalawtranslate.com blocks VPS IPs (403)
  },

  // ─── US State AI Regulations ────────────────────────────────────
  {
    name: 'Colorado AI Act (SB 24-205)',
    jurisdiction: 'US-CO',
    url: 'https://leg.colorado.gov/sites/default/files/2024a_205_signed.pdf',
    parserType: 'pdf',
    selectorConfig: {},
    tier: 2,
    category: 'ai_regulation',
    ingestionMode: 'auto',
    scrapeFrequencyHours: 336,
  },
  {
    name: 'California Generative AI Training Data Transparency Act (AB 2013)',
    jurisdiction: 'US-CA',
    url: 'https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202320240AB2013',
    parserType: 'html',
    selectorConfig: {
      contentSelector: '#bill_all',
      removeSelectors: ['script', 'style', 'nav', 'footer', '.header', '#header'],
    },
    tier: 2,
    category: 'ai_regulation',
    // JSF/XHTML app renders bill text via JavaScript — a plain fetch returns an
    // empty shell. ACCESS-ESCALATION: try a headless browser capture first
    // (provenance 'rendered'); manual upload stays the documented fallback if
    // headless is disabled/unavailable or blocked.
    ingestionMode: 'auto',
    needsHeadless: true,
  },
  {
    name: 'Illinois AI Video Interview Act (820 ILCS 42)',
    jurisdiction: 'US-IL',
    url: 'https://www.ilga.gov/legislation/ilcs/ilcs3.asp?ActID=4015',
    parserType: 'html',
    selectorConfig: {
      contentSelector: 'main, .ilcs-content, body',
    },
    tier: 2,
    category: 'ai_regulation',
    ingestionMode: 'manual', // Illinois state site returns 404s intermittently
  },

  // ─── Tier 2: FDA & Medical Device Software (Healthcare) ────────
  {
    name: 'FDA 21 CFR Part 11',
    jurisdiction: 'US-FED',
    // API-first: the eCFR *versioner* API serves the official XML directly and
    // is NOT bot-blocked (unlike the ecfr.gov HTML site). Subpart B (Electronic
    // Records) covers § 11.10 controls and § 11.50 signature manifestations —
    // the AI compliance-relevant sections. Complete-by-construction byte_exact
    // XML replaces the Cornell LII HTML mirror. (Migrated 2026-07-26.)
    url: 'https://www.ecfr.gov/api/versioner/v1/full/current/title-21.xml?part=11&subpart=B',
    parserType: 'html',
    selectorConfig: {},
    tier: 2,
    category: 'medical_device',
    ingestionMode: 'auto',
    scrapeFrequencyHours: 336, // 14 days — CFR updates are infrequent
    channel: 'official_api',
    fallbackUrl: 'https://www.law.cornell.edu/cfr/text/21/part-11/subpart-B',
  },
  {
    name: 'FDA AI/ML-Based SaMD Action Plan',
    jurisdiction: 'US-FED',
    // Original URL (artificial-intelligence-and-machine-learning-aiml-software-medical-device)
    // returns 404 — FDA reorganized the page. The Good Machine Learning Practice
    // (GMLP) page is now the canonical reference. (Fixed 2026-04-07.)
    url: 'https://www.fda.gov/medical-devices/software-medical-device-samd/good-machine-learning-practice-medical-device-development-guiding-principles',
    parserType: 'html',
    selectorConfig: {
      contentSelector: 'article, .content-main, main',
      removeSelectors: ['nav', 'footer', 'script', 'style', '.usa-banner', '.fda-breadcrumb'],
    },
    tier: 2,
    category: 'medical_device',
    ingestionMode: 'auto',
    scrapeFrequencyHours: 336,
  },
  // NOTE: IEC 62304 is paywalled — seeded as inactive (tier 3).
  // Customers can upload their licensed copy via POST /sources/upload.
  {
    name: 'IEC 62304 Medical Device Software Lifecycle (Requires Purchase)',
    jurisdiction: 'INTL',
    url: 'https://www.iso.org/standard/71604.html',
    parserType: 'html',
    selectorConfig: {
      contentSelector: 'main',
      removeSelectors: ['nav', 'footer', 'script', 'style'],
    },
    tier: 3,
    category: 'medical_device',
    ingestionMode: 'manual', // Paywalled — manual upload only via POST /sources/upload
    scrapeFrequencyHours: 0,
  },

  // ─── Tier 3: AI Governance Frameworks ──────────────────────────
  {
    name: 'Gartner AI TRiSM Framework',
    jurisdiction: 'INTL',
    url: 'https://www.gartner.com/en/articles/what-is-ai-trism',
    parserType: 'html',
    selectorConfig: {},
    tier: 3,
    category: 'ai_governance',
    ingestionMode: 'manual', // Reference only — not actively scraped
    scrapeFrequencyHours: 0,
  },
];

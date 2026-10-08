/**
 * Default Scout feeds — seeded on first run via /api/v1/scout/feeds/seed.
 * Government RSS, Google News AI regulation queries, government APIs, and international bodies.
 */
import type { GovApiConfig } from './api-fetcher.js';

export interface DefaultFeed {
  name: string;
  url: string;
  feedType: 'rss' | 'atom' | 'google_news' | 'webpage' | 'gov_api';
  category: string;
  jurisdiction: string;
  /** Required for gov_api feeds — configures the API provider + query terms */
  apiConfig?: GovApiConfig;
}

export const DEFAULT_SCOUT_FEEDS: DefaultFeed[] = [
  // ── EU ──────────────────────────────────────────────────
  {
    name: 'EUR-Lex Official Journal',
    url: 'https://eur-lex.europa.eu/rss/all.xml',
    feedType: 'rss',
    category: 'eu_regulation',
    jurisdiction: 'EU',
  },
  {
    name: 'EUR-Lex AI Act Implementation',
    url: 'https://eur-lex.europa.eu/search.html?type=act&qid=AI_ACT&DTS_SUBDOM=LEGISLATION&sortOne=DD&sortOneOrder=desc&rss=true',
    feedType: 'rss',
    category: 'eu_regulation',
    jurisdiction: 'EU',
  },
  {
    name: 'European Parliament News',
    url: 'https://www.europarl.europa.eu/rss/doc/top-stories/en.xml',
    feedType: 'rss',
    category: 'eu_regulation',
    jurisdiction: 'EU',
  },

  // ── US ──────────────────────────────────────────────────
  {
    name: 'Congress.gov — AI Bills',
    url: 'https://www.congress.gov/rss/search?q=artificial+intelligence&s=relevance',
    feedType: 'rss',
    category: 'us_federal',
    jurisdiction: 'US-FED',
  },
  {
    name: 'Congress.gov — Most Viewed Bills',
    url: 'https://www.congress.gov/rss/most-viewed-bills.xml',
    feedType: 'rss',
    category: 'us_federal',
    jurisdiction: 'US-FED',
  },
  {
    name: 'Federal Register — AI Proposed Rules',
    url: 'https://www.federalregister.gov/documents/search.rss?conditions%5Bterm%5D=artificial+intelligence&conditions%5Btype%5D%5B%5D=PRORULE',
    feedType: 'rss',
    category: 'us_federal',
    jurisdiction: 'US-FED',
  },
  {
    name: 'Federal Register — AI Final Rules',
    url: 'https://www.federalregister.gov/documents/search.rss?conditions%5Bterm%5D=artificial+intelligence&conditions%5Btype%5D%5B%5D=RULE',
    feedType: 'rss',
    category: 'us_federal',
    jurisdiction: 'US-FED',
  },

  // ── UK ──────────────────────────────────────────────────
  {
    name: 'UK Parliament Research',
    url: 'https://www.parliament.uk/business/publications/research/rss/',
    feedType: 'rss',
    category: 'uk_regulation',
    jurisdiction: 'UK',
  },
  {
    name: 'UK Parliament Bills',
    url: 'https://bills.parliament.uk/rss/allbills.rss',
    feedType: 'rss',
    category: 'uk_regulation',
    jurisdiction: 'UK',
  },

  // ── Canada ──────────────────────────────────────────────
  {
    name: 'Canada Gazette',
    url: 'https://gazette.gc.ca/rss/index-eng.xml',
    feedType: 'rss',
    category: 'ca_regulation',
    jurisdiction: 'CA',
  },

  // ── Google News (AI regulation coverage) ────────────────
  {
    name: 'Google News: AI Regulation',
    url: 'https://news.google.com/rss/search?q=AI+regulation+law&hl=en',
    feedType: 'google_news',
    category: 'global_news',
    jurisdiction: 'global',
  },
  {
    name: 'Google News: EU AI Act',
    url: 'https://news.google.com/rss/search?q=%22EU+AI+Act%22&hl=en',
    feedType: 'google_news',
    category: 'eu_news',
    jurisdiction: 'EU',
  },
  {
    name: 'Google News: AI Governance',
    url: 'https://news.google.com/rss/search?q=AI+governance+policy&hl=en',
    feedType: 'google_news',
    category: 'global_news',
    jurisdiction: 'global',
  },
  {
    name: 'Google News: Algorithmic Regulation',
    url: 'https://news.google.com/rss/search?q=algorithmic+regulation+compliance&hl=en',
    feedType: 'google_news',
    category: 'global_news',
    jurisdiction: 'global',
  },
  {
    name: 'Google News: NIST AI Framework',
    url: 'https://news.google.com/rss/search?q=NIST+AI+framework&hl=en',
    feedType: 'google_news',
    category: 'us_news',
    jurisdiction: 'US-FED',
  },

  // ── HIPAA / NIST / FTC ──────────────────────────────────
  {
    name: 'HHS HIPAA Regulatory Updates',
    url: 'https://www.hhs.gov/hipaa/newsroom/index.html',
    feedType: 'webpage',
    category: 'us_healthcare',
    jurisdiction: 'US-FED',
  },
  {
    name: 'NIST AI RMF Updates',
    url: 'https://www.nist.gov/artificial-intelligence/rss.xml',
    feedType: 'rss',
    category: 'us_federal',
    jurisdiction: 'US-FED',
  },
  {
    name: 'FTC AI Enforcement Actions',
    url: 'https://www.ftc.gov/rss/press-releases.xml',
    feedType: 'rss',
    category: 'us_federal',
    jurisdiction: 'US-FED',
  },
  {
    name: 'FTC Tech Blog',
    url: 'https://www.ftc.gov/rss/tech-blog.xml',
    feedType: 'rss',
    category: 'us_federal',
    jurisdiction: 'US-FED',
  },

  // ── State Attorney General AI Enforcement ─────────────
  {
    name: 'CA AG AI Enforcement',
    url: 'https://news.google.com/rss/search?q=California+attorney+general+artificial+intelligence+enforcement&hl=en-US',
    feedType: 'google_news',
    category: 'us_state_ag',
    jurisdiction: 'US-CA',
  },
  {
    name: 'NY AG AI Enforcement',
    url: 'https://news.google.com/rss/search?q=New+York+attorney+general+artificial+intelligence+enforcement&hl=en-US',
    feedType: 'google_news',
    category: 'us_state_ag',
    jurisdiction: 'US-NY',
  },
  {
    name: 'TX AG AI Enforcement',
    url: 'https://news.google.com/rss/search?q=Texas+attorney+general+artificial+intelligence+enforcement&hl=en-US',
    feedType: 'google_news',
    category: 'us_state_ag',
    jurisdiction: 'US-TX',
  },

  // ── EU: NIS2 & DORA ────────────────────────────────────
  {
    name: 'Google News: NIS2 Directive',
    url: 'https://news.google.com/rss/search?q=%22NIS2+Directive%22+enforcement&hl=en',
    feedType: 'google_news',
    category: 'eu_cybersecurity',
    jurisdiction: 'EU',
  },
  {
    name: 'Google News: DORA Financial Regulation',
    url: 'https://news.google.com/rss/search?q=%22DORA%22+%22Digital+Operational+Resilience%22+regulation&hl=en',
    feedType: 'google_news',
    category: 'eu_financial',
    jurisdiction: 'EU',
  },
  {
    name: 'ENISA News',
    url: 'https://www.enisa.europa.eu/rss.xml',
    feedType: 'rss',
    category: 'eu_cybersecurity',
    jurisdiction: 'EU',
  },

  // ── US Finance ─────────────────────────────────────────
  {
    name: 'Google News: GLBA Safeguards Rule',
    url: 'https://news.google.com/rss/search?q=GLBA+Safeguards+Rule+financial+regulation&hl=en',
    feedType: 'google_news',
    category: 'us_finance',
    jurisdiction: 'US-FED',
  },
  {
    name: 'Google News: SOC 2 Compliance',
    url: 'https://news.google.com/rss/search?q=SOC+2+compliance+audit+updates&hl=en',
    feedType: 'google_news',
    category: 'audit_compliance',
    jurisdiction: 'INTL',
  },

  // ── ISO 27001 ──────────────────────────────────────────
  {
    name: 'Google News: ISO 27001 AI Security',
    url: 'https://news.google.com/rss/search?q=%22ISO+27001%22+%22artificial+intelligence%22&hl=en',
    feedType: 'google_news',
    category: 'international_standards',
    jurisdiction: 'INTL',
  },

  // ── CCPA / CPRA ────────────────────────────────────────
  {
    name: 'California Privacy Protection Agency',
    url: 'https://news.google.com/rss/search?q=%22California+Privacy+Protection+Agency%22+OR+%22CPRA%22+regulation&hl=en',
    feedType: 'google_news',
    category: 'us_state',
    jurisdiction: 'US-CA',
  },
  {
    name: 'Google News: CCPA AI Compliance',
    url: 'https://news.google.com/rss/search?q=%22CCPA%22+%22artificial+intelligence%22+compliance&hl=en',
    feedType: 'google_news',
    category: 'us_state',
    jurisdiction: 'US-CA',
  },

  // ── NIST ───────────────────────────────────────────────
  {
    name: 'NIST Computer Security Resource Center',
    url: 'https://csrc.nist.gov/csrc/feeds/news',
    feedType: 'rss',
    category: 'us_standards',
    jurisdiction: 'US-FED',
  },

  // ── International ───────────────────────────────────────
  {
    name: 'OECD AI Policy Observatory',
    url: 'https://oecd.ai/en/feed',
    feedType: 'rss',
    category: 'international',
    jurisdiction: 'global',
  },

  // ── Global Expansion: Australia ────────────────────────
  {
    name: 'Australia AI Ethics Framework Updates',
    url: 'https://news.google.com/rss/search?q=Australia+artificial+intelligence+regulation+ethics+framework&hl=en-AU',
    feedType: 'google_news',
    category: 'au_regulation',
    jurisdiction: 'AU',
  },

  // ── Global Expansion: Singapore ────────────────────────
  {
    name: 'Singapore AI Governance Framework',
    url: 'https://news.google.com/rss/search?q=Singapore+AI+governance+PDPA+regulation&hl=en-SG',
    feedType: 'google_news',
    category: 'sg_regulation',
    jurisdiction: 'SG',
  },

  // ── Global Expansion: Japan ────────────────────────────
  {
    name: 'Japan AI Regulation & Guidelines',
    url: 'https://news.google.com/rss/search?q=Japan+artificial+intelligence+regulation+guidelines&hl=en',
    feedType: 'google_news',
    category: 'jp_regulation',
    jurisdiction: 'JP',
  },

  // ── Global Expansion: South Korea ─────────────────────
  {
    name: 'South Korea AI Regulation & Digital Platform Act',
    url: 'https://news.google.com/rss/search?q=South+Korea+artificial+intelligence+regulation+digital+platform&hl=en',
    feedType: 'google_news',
    category: 'kr_regulation',
    jurisdiction: 'KR',
  },

  // ── US Healthcare / FDA ────────────────────────────────
  {
    name: 'Google News: FDA AI Medical Devices',
    url: 'https://news.google.com/rss/search?q=FDA+%22artificial+intelligence%22+%22medical+device%22&hl=en',
    feedType: 'google_news',
    category: 'us_healthcare',
    jurisdiction: 'US-FED',
  },
  {
    name: 'Google News: FDA Digital Health Center of Excellence',
    url: 'https://news.google.com/rss/search?q=FDA+%22Digital+Health+Center+of+Excellence%22&hl=en',
    feedType: 'google_news',
    category: 'us_healthcare',
    jurisdiction: 'US-FED',
  },

  // ── FERPA / Education ─────────────────────────────────
  {
    name: 'Google News: FERPA AI Education',
    url: 'https://news.google.com/rss/search?q=FERPA+artificial+intelligence+education&hl=en',
    feedType: 'google_news',
    category: 'us_education',
    jurisdiction: 'US-FED',
  },
  {
    name: 'Federal Register — Education Privacy',
    url: 'https://www.federalregister.gov/documents/search.rss?conditions%5Bterm%5D=FERPA+education+privacy',
    feedType: 'rss',
    category: 'us_education',
    jurisdiction: 'US-FED',
  },

  // ── TRiSM / AI Governance ────────────────────────────
  {
    name: 'Google News: AI TRiSM Governance',
    url: 'https://news.google.com/rss/search?q=AI+TRiSM+trust+risk+security+management&hl=en',
    feedType: 'google_news',
    category: 'ai_governance',
    jurisdiction: 'global',
  },

  // ── NIST CSF ─────────────────────────────────────────
  {
    name: 'Google News: NIST Cybersecurity Framework',
    url: 'https://news.google.com/rss/search?q=NIST+cybersecurity+framework+2.0&hl=en',
    feedType: 'google_news',
    category: 'us_cybersecurity',
    jurisdiction: 'US-FED',
  },

  // ── Government APIs (structured, authoritative) ─────────
  // These query legislative databases directly — months of lead time
  // over RSS/news, structured data, and authoritative sources.

  {
    name: 'Congress.gov — AI Bills',
    url: 'https://api.congress.gov/v3/bill',
    feedType: 'gov_api',
    category: 'us_federal',
    jurisdiction: 'US-FED',
    apiConfig: {
      provider: 'congress_gov',
      queryTerms: [
        'artificial intelligence',
        'algorithmic accountability',
        'automated decision',
        'foundation model',
        'machine learning',
      ],
      maxResults: 20,
    },
  },
  {
    name: 'Federal Register — AI Rulemaking',
    url: 'https://www.federalregister.gov/api/v1/documents.json',
    feedType: 'gov_api',
    category: 'us_federal',
    jurisdiction: 'US-FED',
    apiConfig: {
      provider: 'federal_register',
      queryTerms: [
        'artificial intelligence',
        'algorithmic system',
        'automated decision-making',
        'AI risk management',
      ],
      maxResults: 25,
    },
  },
  {
    name: 'UK Parliament — AI Bills',
    url: 'https://bills-api.parliament.uk/api/v1/Bills',
    feedType: 'gov_api',
    category: 'uk_regulation',
    jurisdiction: 'UK',
    apiConfig: {
      provider: 'uk_parliament',
      queryTerms: [
        'artificial intelligence',
        'algorithmic',
        'automated decision',
        'data protection',
      ],
      maxResults: 20,
    },
  },
  {
    name: 'EUR-Lex — AI Legislation',
    url: 'https://eur-lex.europa.eu/search.html',
    feedType: 'gov_api',
    category: 'eu_regulation',
    jurisdiction: 'EU',
    apiConfig: {
      provider: 'eurlex',
      queryTerms: [
        'artificial intelligence regulation',
        'AI Act',
        'algorithmic transparency',
        'high-risk AI system',
      ],
      maxResults: 15,
    },
  },
];

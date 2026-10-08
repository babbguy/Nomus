export type ParserType = 'html' | 'pdf';

export interface SelectorConfig {
  /** CSS selector for the main content area (HTML) */
  contentSelector?: string;
  /** CSS selectors to remove (nav, footer, etc.) */
  removeSelectors?: string[];
  /** Page range for PDFs (e.g., "1-50") */
  pageRange?: string;
}

export interface RegulatorySource {
  id: string;
  name: string;
  jurisdiction: string;
  url: string;
  parserType: ParserType;
  selectorConfig: SelectorConfig;
  scrapeFrequencyHours: number;
  isActive: boolean;
  lastScrapedAt: string | null;
  lastContentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

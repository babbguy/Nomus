export interface SourceFormData {
  name: string;
  jurisdiction: string;
  url: string;
  parserType: string;
  contentSelector: string;
  removeSelectors: string;
  scrapeFrequencyHours: number;
  ingestionMode: 'auto' | 'manual';
  category: string;
  tier: number;
  needsHeadless: boolean;
  isActive: boolean;
}

export const emptyForm: SourceFormData = {
  name: '', jurisdiction: 'EU', url: '', parserType: 'html',
  contentSelector: '', removeSelectors: '', scrapeFrequencyHours: 24,
  ingestionMode: 'auto', category: 'ai_regulation', tier: 1, needsHeadless: false,
  isActive: true,
};

/** Categories offered as suggestions; the field accepts any lowercase_snake value. */
export const KNOWN_CATEGORIES = [
  'ai_regulation', 'ai_standards', 'privacy', 'information_security', 'payment_security',
  'healthcare', 'financial_services', 'internal_policy',
];

export const JURISDICTION_CODE_RE = /^[A-Z0-9-]{1,16}$/;
export const CATEGORY_RE = /^[a-z0-9_]{1,64}$/;

/** Human labels for source ownership. */
export const ORIGIN_LABELS = {
  registry: { label: 'Built-in', variant: 'info' as const, hint: 'Tracks the built-in registry: URL and parsing settings are refreshed on every start.' },
  customized: { label: 'Customized', variant: 'warning' as const, hint: 'A built-in source you edited. Startup never overwrites it; use "Restore built-in defaults" to rejoin the registry.' },
  custom: { label: 'Custom', variant: 'accent' as const, hint: 'Added by an admin. Never changed by the built-in registry.' },
};

/** Per-source scrape result stored after the API call resolves. */
export interface ScrapeResult {
  status: string;
  rulesCreated?: number;
  rulesUpdated?: number;
  durationMs?: number;
  stepReached?: number;
  error?: string;
  noChanges?: boolean;
}

/** Detailed error info for modal display */
export interface ErrorDetail {
  sourceName: string;
  sourceUrl: string;
  sourceId: string;
  error: string;
  stepReached?: number;
  timestamp: string;
  consecutiveFailures: number;
}

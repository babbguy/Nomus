/**
 * Source Provenance Grading (A-G)
 * Scores regulatory sources on trustworthiness.
 */

export type ProvenanceGrade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

const GRADE_DESCRIPTIONS: Record<ProvenanceGrade, string> = {
  A: 'Official government source with API/RSS feed',
  B: 'Official government source, HTML only',
  C: 'Official standards body (ISO, NIST)',
  D: 'Official government secondary source (translations, summaries)',
  E: 'Reputable third-party (law firms, compliance organizations)',
  F: 'Unofficial aggregator',
  G: 'Unverified source',
};

/**
 * Compute provenance grade for a source based on its URL and characteristics.
 */
export function computeProvenanceGrade(url: string, parserType: string): ProvenanceGrade {
  const domain = new URL(url).hostname.toLowerCase();

  // A: Government with structured data (APIs, feeds)
  if (domain.includes('.gov') && (url.includes('/api/') || url.includes('/rss') || url.includes('/feed'))) return 'A';

  // B: Government direct
  if (domain.endsWith('.gov') || domain.endsWith('.gov.uk') || domain.endsWith('.europa.eu') ||
      domain.endsWith('.gc.ca') || domain.endsWith('.gov.au') || domain.endsWith('.parl.ca') ||
      domain.includes('federalregister') || domain.includes('eur-lex')) return 'B';

  // C: Standards bodies
  if (domain.includes('nist.gov') || domain.includes('iso.org') || domain.includes('iec.ch') ||
      domain.includes('ieee.org')) return 'C';

  // D: Government secondary
  if (domain.endsWith('.gov') || domain.includes('legislation')) return 'D';

  // E: Reputable third-party
  if (domain.includes('law') || domain.includes('compliance') || domain.includes('reuters') ||
      domain.includes('lexis') || domain.includes('westlaw')) return 'E';

  // F: Known aggregators
  if (domain.includes('wiki') || domain.includes('blog')) return 'F';

  return 'G';
}

export function getGradeDescription(grade: ProvenanceGrade): string {
  return GRADE_DESCRIPTIONS[grade] ?? 'Unknown';
}

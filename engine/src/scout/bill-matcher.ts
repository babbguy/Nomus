/**
 * Bill Identity Matching — deduplicates bills across multiple sources.
 *
 * Uses multi-signal confidence scoring with Jaro-Winkler string similarity.
 * Zero external dependencies — pure TypeScript implementation.
 */

import { logger } from '../logger.js';

// ── Types ────────────────────────────────────────────────────────

export interface BillCandidate {
  title: string;
  url: string;
  billNumber?: string | null;
  jurisdiction?: string | null;
}

export interface BillMatchSignals {
  billNumberMatch: number;
  titleSimilarity: number;
  jurisdictionMatch: number;
  urlDomainMatch: number;
}

export interface BillMatchScore {
  totalConfidence: number;
  signals: BillMatchSignals;
}

export interface BillMatchResult {
  match: BillCandidate;
  score: BillMatchScore;
}

// ── Jaro-Winkler Distance ────────────────────────────────────────

/**
 * Compute Jaro similarity between two strings.
 * Returns 0-1 where 1 = identical.
 */
function jaroSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);

  const s1Matches = new Array<boolean>(s1.length).fill(false);
  const s2Matches = new Array<boolean>(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Find matches
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (
    (matches / s1.length +
      matches / s2.length +
      (matches - transpositions / 2) / matches) /
    3
  );
}

/**
 * Compute Jaro-Winkler similarity between two strings.
 * Applies a prefix bonus for strings that share a common prefix.
 * Returns 0-1 where 1 = identical.
 */
export function jaroWinkler(s1: string, s2: string): number {
  const jaro = jaroSimilarity(s1, s2);

  // Count common prefix (up to 4 characters)
  const maxPrefix = Math.min(4, Math.min(s1.length, s2.length));
  let prefixLen = 0;
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) {
      prefixLen++;
    } else {
      break;
    }
  }

  // Winkler scaling factor (standard = 0.1)
  const p = 0.1;
  return jaro + prefixLen * p * (1 - jaro);
}

// ── Signal Scoring ───────────────────────────────────────────────

/** Extract domain from URL, returning empty string on failure */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Normalize bill number for comparison: strip whitespace, lowercase, remove punctuation */
function normalizeBillNumber(bill: string): string {
  return bill.toLowerCase().replace(/[\s.\-_]/g, '').trim();
}

/**
 * Score match confidence between an existing bill and a candidate.
 * Returns multi-signal breakdown with total confidence 0-1.
 */
export function scoreBillMatch(
  existing: BillCandidate,
  candidate: BillCandidate,
): BillMatchScore {
  const signals: BillMatchSignals = {
    billNumberMatch: 0,
    titleSimilarity: 0,
    jurisdictionMatch: 0,
    urlDomainMatch: 0,
  };

  // Signal 1: Bill number exact match (+0.8)
  if (existing.billNumber && candidate.billNumber) {
    const normExisting = normalizeBillNumber(existing.billNumber);
    const normCandidate = normalizeBillNumber(candidate.billNumber);
    if (normExisting && normCandidate && normExisting === normCandidate) {
      signals.billNumberMatch = 0.8;
    }
  }

  // Signal 2: Title similarity via Jaro-Winkler (+0.5 if > 0.85)
  const titleSim = jaroWinkler(
    existing.title.toLowerCase(),
    candidate.title.toLowerCase(),
  );
  if (titleSim > 0.85) {
    signals.titleSimilarity = 0.5;
  }

  // Signal 3: Jurisdiction match (+0.2)
  if (
    existing.jurisdiction &&
    candidate.jurisdiction &&
    existing.jurisdiction === candidate.jurisdiction
  ) {
    signals.jurisdictionMatch = 0.2;
  }

  // Signal 4: URL domain match (+0.3)
  const existingDomain = extractDomain(existing.url);
  const candidateDomain = extractDomain(candidate.url);
  if (existingDomain && candidateDomain && existingDomain === candidateDomain) {
    signals.urlDomainMatch = 0.3;
  }

  const totalConfidence = Math.min(
    1,
    signals.billNumberMatch +
      signals.titleSimilarity +
      signals.jurisdictionMatch +
      signals.urlDomainMatch,
  );

  return { totalConfidence, signals };
}

// ── Matching ─────────────────────────────────────────────────────

/** Confidence threshold above which we consider two items a match */
const MATCH_THRESHOLD = 0.7;

/**
 * Find the best matching existing bill for a candidate.
 * Returns the best match above threshold, or null if no match.
 */
export function matchBills(
  existingBills: BillCandidate[],
  candidate: BillCandidate,
): BillMatchResult | null {
  let bestMatch: BillMatchResult | null = null;

  for (const existing of existingBills) {
    const score = scoreBillMatch(existing, candidate);
    if (
      score.totalConfidence >= MATCH_THRESHOLD &&
      (!bestMatch || score.totalConfidence > bestMatch.score.totalConfidence)
    ) {
      bestMatch = { match: existing, score };
    }
  }

  if (bestMatch) {
    logger.debug(
      {
        candidate: candidate.title.slice(0, 80),
        matched: bestMatch.match.title.slice(0, 80),
        confidence: bestMatch.score.totalConfidence,
      },
      'Scout: Bill match found',
    );
  }

  return bestMatch;
}

/**
 * Deduplicate a list of bill candidates against an existing set.
 * Returns only candidates that do NOT match any existing bill.
 */
export function deduplicateBills<T extends BillCandidate>(
  existingBills: BillCandidate[],
  candidates: T[],
): { unique: T[]; duplicates: Array<{ candidate: T; matchedTo: BillCandidate; confidence: number }> } {
  const unique: T[] = [];
  const duplicates: Array<{ candidate: T; matchedTo: BillCandidate; confidence: number }> = [];

  // Also check within the candidates themselves to avoid intra-batch dupes
  const accepted: BillCandidate[] = [...existingBills];

  for (const candidate of candidates) {
    const match = matchBills(accepted, candidate);
    if (match) {
      duplicates.push({
        candidate,
        matchedTo: match.match,
        confidence: match.score.totalConfidence,
      });
    } else {
      unique.push(candidate);
      accepted.push(candidate);
    }
  }

  if (duplicates.length > 0) {
    logger.info(
      { unique: unique.length, duplicates: duplicates.length },
      'Scout: Bill deduplication complete',
    );
  }

  return { unique, duplicates };
}

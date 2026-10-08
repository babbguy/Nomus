import { describe, it, expect } from 'vitest';
import {
  jaroWinkler,
  scoreBillMatch,
  matchBills,
  deduplicateBills,
  type BillCandidate,
} from './bill-matcher.js';

// ── jaroWinkler ─────────────────────────────────────────────────

describe('jaroWinkler', () => {
  it('returns 1 for identical strings', () => {
    expect(jaroWinkler('artificial intelligence', 'artificial intelligence')).toBe(1);
  });

  it('returns 0 when one string is empty', () => {
    expect(jaroWinkler('', 'hello')).toBe(0);
    expect(jaroWinkler('hello', '')).toBe(0);
  });

  it('returns 0 for two empty strings treated as identical', () => {
    expect(jaroWinkler('', '')).toBe(1);
  });

  it('returns >0.85 for similar strings', () => {
    const score = jaroWinkler('California AI Safety Act', 'California AI Saftey Act');
    expect(score).toBeGreaterThan(0.85);
  });

  it('returns low score for very different strings', () => {
    const score = jaroWinkler('Artificial Intelligence Act', 'xyz qqq zzz');
    expect(score).toBeLessThan(0.5);
  });

  it('applies prefix bonus (Winkler component)', () => {
    // Two strings with same prefix should score higher than two with different prefixes
    const samePrefix = jaroWinkler('ABCD1234', 'ABCD5678');
    const diffPrefix = jaroWinkler('1234ABCD', '5678ABCD');
    expect(samePrefix).toBeGreaterThan(diffPrefix);
  });

  it('is symmetric', () => {
    const a = jaroWinkler('test string one', 'test string two');
    const b = jaroWinkler('test string two', 'test string one');
    expect(a).toBeCloseTo(b, 10);
  });
});

// ── scoreBillMatch ──────────────────────────────────────────────

describe('scoreBillMatch', () => {
  const baseBill: BillCandidate = {
    title: 'California AI Transparency Act',
    url: 'https://leginfo.ca.gov/bills/sb-1047',
    billNumber: 'SB-1047',
    jurisdiction: 'US-CA',
  };

  it('scores bill number exact match at +0.8', () => {
    const candidate: BillCandidate = {
      title: 'A different title entirely',
      url: 'https://example.com/bill',
      billNumber: 'SB-1047',
      jurisdiction: 'US-NY',
    };
    const { signals } = scoreBillMatch(baseBill, candidate);
    expect(signals.billNumberMatch).toBe(0.8);
  });

  it('normalizes bill numbers (whitespace, case, punctuation)', () => {
    const candidate: BillCandidate = {
      title: 'Unrelated title',
      url: 'https://example.com/x',
      billNumber: 'sb 1047',
      jurisdiction: 'US-NY',
    };
    const { signals } = scoreBillMatch(baseBill, candidate);
    expect(signals.billNumberMatch).toBe(0.8);
  });

  it('scores title similarity at +0.5 when >0.85 threshold', () => {
    const candidate: BillCandidate = {
      title: 'California AI Transparency Act',
      url: 'https://other.com/bill',
      billNumber: null,
      jurisdiction: null,
    };
    const { signals } = scoreBillMatch(baseBill, candidate);
    expect(signals.titleSimilarity).toBe(0.5);
  });

  it('scores 0 title similarity when below 0.85 threshold', () => {
    const candidate: BillCandidate = {
      title: 'Federal Water Protection Standards',
      url: 'https://other.com/bill',
      billNumber: null,
      jurisdiction: null,
    };
    const { signals } = scoreBillMatch(baseBill, candidate);
    expect(signals.titleSimilarity).toBe(0);
  });

  it('scores jurisdiction match at +0.2', () => {
    const candidate: BillCandidate = {
      title: 'Unrelated',
      url: 'https://example.com/x',
      billNumber: null,
      jurisdiction: 'US-CA',
    };
    const { signals } = scoreBillMatch(baseBill, candidate);
    expect(signals.jurisdictionMatch).toBe(0.2);
  });

  it('scores URL domain match at +0.3', () => {
    const candidate: BillCandidate = {
      title: 'Unrelated',
      url: 'https://leginfo.ca.gov/bills/other',
      billNumber: null,
      jurisdiction: null,
    };
    const { signals } = scoreBillMatch(baseBill, candidate);
    expect(signals.urlDomainMatch).toBe(0.3);
  });

  it('caps combined signals at 1.0', () => {
    const candidate: BillCandidate = {
      title: 'California AI Transparency Act',
      url: 'https://leginfo.ca.gov/bills/sb-1047-copy',
      billNumber: 'SB-1047',
      jurisdiction: 'US-CA',
    };
    const { totalConfidence } = scoreBillMatch(baseBill, candidate);
    // 0.8 + 0.5 + 0.2 + 0.3 = 1.8, should be capped at 1.0
    expect(totalConfidence).toBe(1);
  });

  it('returns 0 when no signals match', () => {
    const candidate: BillCandidate = {
      title: 'Completely unrelated bill about fishing',
      url: 'https://example.com/unrelated',
      billNumber: 'HR-9999',
      jurisdiction: 'US-TX',
    };
    const { totalConfidence } = scoreBillMatch(baseBill, candidate);
    expect(totalConfidence).toBe(0);
  });

  it('handles null/undefined optional fields gracefully', () => {
    const candidate: BillCandidate = {
      title: 'Something',
      url: 'https://example.com',
      billNumber: null,
      jurisdiction: null,
    };
    const { signals } = scoreBillMatch(baseBill, candidate);
    expect(signals.billNumberMatch).toBe(0);
    expect(signals.jurisdictionMatch).toBe(0);
  });
});

// ── matchBills ──────────────────────────────────────────────────

describe('matchBills', () => {
  const existing: BillCandidate[] = [
    {
      title: 'California AI Transparency Act',
      url: 'https://leginfo.ca.gov/bills/sb-1047',
      billNumber: 'SB-1047',
      jurisdiction: 'US-CA',
    },
    {
      title: 'New York Automated Decision Systems Act',
      url: 'https://nysenate.gov/bills/s-123',
      billNumber: 'S-123',
      jurisdiction: 'US-NY',
    },
  ];

  it('finds the best match above 0.7 threshold', () => {
    const candidate: BillCandidate = {
      title: 'California AI Transparency Act (Amended)',
      url: 'https://leginfo.ca.gov/bills/sb-1047',
      billNumber: 'SB-1047',
      jurisdiction: 'US-CA',
    };
    const result = matchBills(existing, candidate);
    expect(result).not.toBeNull();
    expect(result!.match.billNumber).toBe('SB-1047');
    expect(result!.score.totalConfidence).toBeGreaterThanOrEqual(0.7);
  });

  it('returns null when no match exceeds threshold', () => {
    const candidate: BillCandidate = {
      title: 'Federal Clean Air Standards Update',
      url: 'https://epa.gov/clean-air',
      billNumber: 'HR-5555',
      jurisdiction: 'US-FED',
    };
    const result = matchBills(existing, candidate);
    expect(result).toBeNull();
  });

  it('returns the highest-scoring match when multiple exist', () => {
    const candidate: BillCandidate = {
      title: 'California AI Transparency Act',
      url: 'https://leginfo.ca.gov/bills/sb-1047',
      billNumber: 'SB-1047',
      jurisdiction: 'US-CA',
    };
    const result = matchBills(existing, candidate);
    expect(result).not.toBeNull();
    // Should match the CA bill, not the NY one
    expect(result!.match.jurisdiction).toBe('US-CA');
  });

  it('returns null for empty existing list', () => {
    const candidate: BillCandidate = {
      title: 'Some Bill',
      url: 'https://example.com',
      billNumber: 'HB-1',
      jurisdiction: 'US-CA',
    };
    expect(matchBills([], candidate)).toBeNull();
  });
});

// ── deduplicateBills ────────────────────────────────────────────

describe('deduplicateBills', () => {
  const existing: BillCandidate[] = [
    {
      title: 'California AI Transparency Act',
      url: 'https://leginfo.ca.gov/bills/sb-1047',
      billNumber: 'SB-1047',
      jurisdiction: 'US-CA',
    },
  ];

  it('separates unique vs duplicate candidates', () => {
    const candidates: BillCandidate[] = [
      {
        title: 'California AI Transparency Act (Updated)',
        url: 'https://leginfo.ca.gov/bills/sb-1047',
        billNumber: 'SB-1047',
        jurisdiction: 'US-CA',
      },
      {
        title: 'Illinois AI Video Interview Act',
        url: 'https://ilga.gov/bills/hb-1234',
        billNumber: 'HB-1234',
        jurisdiction: 'US-IL',
      },
    ];

    const { unique, duplicates } = deduplicateBills(existing, candidates);
    expect(unique).toHaveLength(1);
    expect(unique[0].billNumber).toBe('HB-1234');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].candidate.billNumber).toBe('SB-1047');
    expect(duplicates[0].confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('handles intra-batch deduplication', () => {
    const candidates: BillCandidate[] = [
      {
        title: 'New Federal AI Act',
        url: 'https://congress.gov/bills/hr-100',
        billNumber: 'HR-100',
        jurisdiction: 'US-FED',
      },
      {
        title: 'New Federal AI Act',
        url: 'https://congress.gov/bills/hr-100',
        billNumber: 'HR-100',
        jurisdiction: 'US-FED',
      },
    ];

    const { unique, duplicates } = deduplicateBills([], candidates);
    expect(unique).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
  });

  it('returns all candidates as unique when none match existing', () => {
    const candidates: BillCandidate[] = [
      {
        title: 'Federal Water Safety Standards',
        url: 'https://epa.gov/water-safety',
        billNumber: 'HR-9000',
        jurisdiction: 'US-FED',
      },
      {
        title: 'Montana Agricultural Reform',
        url: 'https://mt.gov/ag-reform',
        billNumber: 'MT-500',
        jurisdiction: 'US-MT',
      },
    ];

    const { unique, duplicates } = deduplicateBills(existing, candidates);
    expect(unique).toHaveLength(2);
    expect(duplicates).toHaveLength(0);
  });

  it('returns empty arrays for empty candidates', () => {
    const { unique, duplicates } = deduplicateBills(existing, []);
    expect(unique).toHaveLength(0);
    expect(duplicates).toHaveLength(0);
  });

  it('includes matchedTo and confidence in duplicate entries', () => {
    const candidates: BillCandidate[] = [
      {
        title: 'California AI Transparency Act',
        url: 'https://leginfo.ca.gov/bills/sb-1047',
        billNumber: 'SB-1047',
        jurisdiction: 'US-CA',
      },
    ];

    const { duplicates } = deduplicateBills(existing, candidates);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].matchedTo).toBeDefined();
    expect(duplicates[0].matchedTo.billNumber).toBe('SB-1047');
    expect(typeof duplicates[0].confidence).toBe('number');
  });
});

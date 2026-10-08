import { describe, it, expect, vi } from 'vitest';

// Mock logger to suppress output during tests
vi.mock('../logger.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import {
  daysBetween,
  computeMomentum,
  computeBaseRate,
  computeSponsorStrength,
  computeSentiment,
  computePolitical,
  computeOpposition,
  computeStalenessPenalty,
  computePassageScore,
  type SponsorInfo,
  type NewsArticle,
  type BillContext,
} from './passage-score.js';

// ─── daysBetween ──────────────────────────────────────────────

describe('daysBetween', () => {
  it('returns 0 for the same day', () => {
    expect(daysBetween('2026-03-15', '2026-03-15')).toBe(0);
  });

  it('returns 1 for one day apart', () => {
    expect(daysBetween('2026-03-15', '2026-03-16')).toBe(1);
  });

  it('returns correct count for many days apart', () => {
    expect(daysBetween('2026-01-01', '2026-04-01')).toBe(90);
  });

  it('is order-independent (absolute difference)', () => {
    expect(daysBetween('2026-04-01', '2026-01-01')).toBe(90);
  });

  it('never returns negative', () => {
    expect(daysBetween('2026-12-31', '2026-01-01')).toBeGreaterThanOrEqual(0);
  });
});

// ─── computeMomentum ──────────────────────────────────────────

describe('computeMomentum', () => {
  const now = '2026-04-05T00:00:00Z';

  it('returns 95 for action within 7 days', () => {
    expect(computeMomentum('2026-04-01', now)).toBe(95);
  });

  it('returns 85 for action 8-14 days ago', () => {
    expect(computeMomentum('2026-03-25', now)).toBe(85);
  });

  it('returns 70 for action 15-30 days ago', () => {
    expect(computeMomentum('2026-03-10', now)).toBe(70);
  });

  it('returns 45 for action 31-60 days ago', () => {
    expect(computeMomentum('2026-02-15', now)).toBe(45);
  });

  it('returns 25 for action 61-90 days ago', () => {
    expect(computeMomentum('2026-01-15', now)).toBe(25);
  });

  it('returns 10 for action more than 90 days ago', () => {
    expect(computeMomentum('2025-12-01', now)).toBe(10);
  });

  it('returns 95 for same-day action', () => {
    expect(computeMomentum(now, now)).toBe(95);
  });
});

// ─── computeBaseRate ──────────────────────────────────────────

describe('computeBaseRate', () => {
  it('returns 5 for rumor stage', () => {
    expect(computeBaseRate('rumor')).toBe(5);
  });

  it('returns 12 for introduced stage', () => {
    expect(computeBaseRate('introduced')).toBe(12);
  });

  it('returns 50 for committee_passed stage', () => {
    expect(computeBaseRate('committee_passed')).toBe(50);
  });

  it('returns 100 for signed stage', () => {
    expect(computeBaseRate('signed')).toBe(100);
  });

  it('returns 0 for died stage', () => {
    expect(computeBaseRate('died')).toBe(0);
  });

  it('returns 0 for stalled stage', () => {
    expect(computeBaseRate('stalled')).toBe(0);
  });

  it('returns 10 as default for unknown stage', () => {
    expect(computeBaseRate('unknown_stage')).toBe(10);
  });

  it('normalizes spaces to underscores', () => {
    expect(computeBaseRate('committee passed')).toBe(50);
  });

  it('normalizes uppercase to lowercase', () => {
    expect(computeBaseRate('INTRODUCED')).toBe(12);
  });
});

// ─── computeSponsorStrength ───────────────────────────────────

describe('computeSponsorStrength', () => {
  it('returns 30 when no sponsors provided', () => {
    expect(computeSponsorStrength()).toBe(30);
    expect(computeSponsorStrength(undefined)).toBe(30);
  });

  it('returns 30 for empty sponsors array', () => {
    expect(computeSponsorStrength([])).toBe(30);
  });

  it('adds 30 for primary committee chair', () => {
    const sponsors: SponsorInfo[] = [
      { name: 'Sen. Chair', party: 'D', isCommitteeChair: true, isLeadership: false, isPrimary: true },
    ];
    expect(computeSponsorStrength(sponsors)).toBe(60); // 30 base + 30 chair
  });

  it('does not add chair bonus if chair is not primary', () => {
    const sponsors: SponsorInfo[] = [
      { name: 'Sen. Chair', party: 'D', isCommitteeChair: true, isLeadership: false, isPrimary: false },
    ];
    // 30 base + 0.5 cosponsor (non-primary) = 30.5
    expect(computeSponsorStrength(sponsors)).toBe(30.5);
  });

  it('adds 20 for leadership sponsor', () => {
    const sponsors: SponsorInfo[] = [
      { name: 'Leader', party: 'R', isCommitteeChair: false, isLeadership: true, isPrimary: false },
    ];
    expect(computeSponsorStrength(sponsors)).toBe(50.5); // 30 + 20 + 0.5 cosponsor
  });

  it('adds 15 for bipartisan sponsorship', () => {
    const sponsors: SponsorInfo[] = [
      { name: 'Sen. A', party: 'D', isCommitteeChair: false, isLeadership: false, isPrimary: true },
      { name: 'Sen. B', party: 'R', isCommitteeChair: false, isLeadership: false, isPrimary: false },
    ];
    // 30 base + 15 bipartisan + 0.5 cosponsor = 45.5 -> 45 (but score is number, not rounded)
    expect(computeSponsorStrength(sponsors)).toBe(45.5);
  });

  it('adds cosponsor bonus capped at 10', () => {
    const sponsors: SponsorInfo[] = [
      { name: 'Primary', party: 'D', isCommitteeChair: false, isLeadership: false, isPrimary: true },
      ...Array.from({ length: 25 }, (_, i) => ({
        name: `Cosponsor ${i}`,
        party: 'D',
        isCommitteeChair: false,
        isLeadership: false,
        isPrimary: false,
      })),
    ];
    // 30 base + 10 cosponsor cap = 40
    expect(computeSponsorStrength(sponsors)).toBe(40);
  });

  it('caps total at 100', () => {
    const sponsors: SponsorInfo[] = [
      { name: 'Sen. Chair', party: 'D', isCommitteeChair: true, isLeadership: true, isPrimary: true },
      ...Array.from({ length: 25 }, (_, i) => ({
        name: `Cosponsor ${i}`,
        party: 'R',
        isCommitteeChair: false,
        isLeadership: false,
        isPrimary: false,
      })),
    ];
    // 30 + 30 (chair) + 20 (leadership) + 15 (bipartisan) + 10 (cosponsor cap) = 105 -> capped at 100
    expect(computeSponsorStrength(sponsors)).toBe(100);
  });
});

// ─── computeSentiment ─────────────────────────────────────────

describe('computeSentiment', () => {
  it('returns 50 when no articles provided', () => {
    expect(computeSentiment()).toBe(50);
    expect(computeSentiment(undefined)).toBe(50);
  });

  it('returns 50 for empty articles array', () => {
    expect(computeSentiment([])).toBe(50);
  });

  it('returns 100 when all articles are supportive', () => {
    const articles: NewsArticle[] = [
      { sentiment: 'supportive' },
      { sentiment: 'supportive' },
      { sentiment: 'supportive' },
    ];
    expect(computeSentiment(articles)).toBe(100);
  });

  it('returns 0 when all articles are opposed', () => {
    const articles: NewsArticle[] = [
      { sentiment: 'opposed' },
      { sentiment: 'opposed' },
    ];
    expect(computeSentiment(articles)).toBe(0);
  });

  it('returns correct ratio for mixed coverage', () => {
    const articles: NewsArticle[] = [
      { sentiment: 'supportive' },
      { sentiment: 'opposed' },
      { sentiment: 'neutral' },
      { sentiment: 'supportive' },
    ];
    // 2 supportive / 4 total = 50
    expect(computeSentiment(articles)).toBe(50);
  });

  it('returns 0 when all articles are neutral', () => {
    const articles: NewsArticle[] = [
      { sentiment: 'neutral' },
      { sentiment: 'neutral' },
    ];
    expect(computeSentiment(articles)).toBe(0);
  });
});

// ─── computePolitical ─────────────────────────────────────────

describe('computePolitical', () => {
  it('always returns 50', () => {
    expect(computePolitical()).toBe(50);
  });
});

// ─── computeOpposition ────────────────────────────────────────

describe('computeOpposition', () => {
  it('returns 70 when no articles provided', () => {
    expect(computeOpposition()).toBe(70);
    expect(computeOpposition(undefined)).toBe(70);
  });

  it('returns 70 for empty articles array', () => {
    expect(computeOpposition([])).toBe(70);
  });

  it('returns 30 when more than 50% are opposed', () => {
    const articles: NewsArticle[] = [
      { sentiment: 'opposed' },
      { sentiment: 'opposed' },
      { sentiment: 'supportive' },
    ];
    // 2/3 = 66.7% > 50%
    expect(computeOpposition(articles)).toBe(30);
  });

  it('returns 50 when 30-50% are opposed', () => {
    const articles: NewsArticle[] = [
      { sentiment: 'opposed' },
      { sentiment: 'supportive' },
      { sentiment: 'neutral' },
    ];
    // 1/3 = 33.3% > 30%
    expect(computeOpposition(articles)).toBe(50);
  });

  it('returns 70 when less than 30% are opposed', () => {
    const articles: NewsArticle[] = [
      { sentiment: 'opposed' },
      { sentiment: 'supportive' },
      { sentiment: 'supportive' },
      { sentiment: 'supportive' },
    ];
    // 1/4 = 25% < 30%
    expect(computeOpposition(articles)).toBe(70);
  });

  it('returns 70 when no articles are opposed', () => {
    const articles: NewsArticle[] = [
      { sentiment: 'supportive' },
      { sentiment: 'neutral' },
    ];
    expect(computeOpposition(articles)).toBe(70);
  });
});

// ─── computeStalenessPenalty ──────────────────────────────────

describe('computeStalenessPenalty', () => {
  const now = '2026-04-05T00:00:00Z';

  it('returns 0 for action within 30 days', () => {
    expect(computeStalenessPenalty('2026-03-15', now)).toBe(0);
  });

  it('returns -10 for action 31-60 days ago', () => {
    expect(computeStalenessPenalty('2026-02-20', now)).toBe(-10);
  });

  it('returns -25 for action 61-90 days ago', () => {
    expect(computeStalenessPenalty('2026-01-20', now)).toBe(-25);
  });

  it('returns -40 for action more than 90 days ago', () => {
    expect(computeStalenessPenalty('2025-12-01', now)).toBe(-40);
  });

  it('returns 0 for same-day action', () => {
    expect(computeStalenessPenalty(now, now)).toBe(0);
  });
});

// ─── computePassageScore (composite) ──────────────────────────

describe('computePassageScore', () => {
  const now = '2026-04-05T00:00:00Z';

  it('returns 0 total for terminal stage "died"', () => {
    const context: BillContext = {
      currentStage: 'died',
      lastActionDate: '2026-04-01',
      jurisdiction: 'US',
    };
    const result = computePassageScore(context, now);
    expect(result.total).toBe(0);
    expect(result.components.momentum).toBe(0);
    expect(result.components.baseRate).toBe(0);
    expect(result.stalenessPenalty).toBe(0);
  });

  it('returns 0 total for terminal stage "stalled"', () => {
    const context: BillContext = {
      currentStage: 'stalled',
      lastActionDate: '2026-04-01',
      jurisdiction: 'US',
    };
    const result = computePassageScore(context, now);
    expect(result.total).toBe(0);
  });

  it('computes a realistic score for an active bill', () => {
    const context: BillContext = {
      currentStage: 'committee_passed',
      lastActionDate: '2026-04-01',
      jurisdiction: 'US',
      sponsors: [
        { name: 'Sen. Smith', party: 'D', isCommitteeChair: true, isLeadership: false, isPrimary: true },
        { name: 'Sen. Jones', party: 'R', isCommitteeChair: false, isLeadership: false, isPrimary: false },
      ],
      newsArticles: [
        { sentiment: 'supportive' },
        { sentiment: 'supportive' },
        { sentiment: 'neutral' },
      ],
    };

    const result = computePassageScore(context, now);

    // Verify components individually
    expect(result.components.momentum).toBe(95);       // 4 days ago -> <=7
    expect(result.components.baseRate).toBe(50);        // committee_passed
    expect(result.components.sponsorStrength).toBe(75.5); // 30+30(chair)+15(bipartisan)+0.5(cosponsor)
    expect(result.components.sentiment).toBe(67);       // 2/3 supportive = 66.67 -> round 67
    expect(result.components.political).toBe(50);       // always 50
    expect(result.components.opposition).toBe(70);      // 0 opposed / 3 = 0% < 30%
    expect(result.stalenessPenalty).toBe(0);             // 4 days, no penalty

    // Weighted: 95*0.30 + 50*0.25 + 75.5*0.15 + 67*0.10 + 50*0.10 + 70*0.10 =
    //   28.5 + 12.5 + 11.325 + 6.7 + 5.0 + 7.0 = 71.025 -> round 71
    expect(result.total).toBe(71);
  });

  it('applies staleness penalty correctly', () => {
    const context: BillContext = {
      currentStage: 'introduced',
      lastActionDate: '2025-12-01', // ~125 days ago
      jurisdiction: 'US',
    };

    const result = computePassageScore(context, now);

    expect(result.components.momentum).toBe(10);      // >90 days
    expect(result.stalenessPenalty).toBe(-40);          // >90 days
    // Weighted without penalty: 10*0.30 + 12*0.25 + 30*0.15 + 50*0.10 + 50*0.10 + 70*0.10 =
    //   3 + 3 + 4.5 + 5 + 5 + 7 = 27.5 -> 27.5 + (-40) = -12.5 -> clamped to 0
    expect(result.total).toBe(0);
  });

  it('clamps score to 0-100 range', () => {
    // Score cannot go below 0 even with heavy penalty
    const context: BillContext = {
      currentStage: 'rumor',
      lastActionDate: '2025-06-01',
      jurisdiction: 'US',
    };
    const result = computePassageScore(context, now);
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(100);
  });

  it('includes computedAt timestamp', () => {
    const context: BillContext = {
      currentStage: 'introduced',
      lastActionDate: '2026-04-01',
      jurisdiction: 'US',
    };
    const result = computePassageScore(context, now);
    expect(result.computedAt).toBe(now);
  });

  it('uses current time when now parameter is omitted', () => {
    const context: BillContext = {
      currentStage: 'introduced',
      lastActionDate: '2026-04-01',
      jurisdiction: 'US',
    };
    const before = new Date().toISOString();
    const result = computePassageScore(context);
    const after = new Date().toISOString();
    expect(result.computedAt >= before).toBe(true);
    expect(result.computedAt <= after).toBe(true);
  });

  it('handles missing optional fields gracefully', () => {
    const context: BillContext = {
      currentStage: 'introduced',
      lastActionDate: '2026-04-01',
      jurisdiction: 'US',
      // no sponsors, no newsArticles, no session, no introducedDate
    };
    const result = computePassageScore(context, now);
    expect(result.components.sponsorStrength).toBe(30);  // default
    expect(result.components.sentiment).toBe(50);         // default
    expect(result.components.opposition).toBe(70);        // default
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it('handles empty arrays for sponsors and articles', () => {
    const context: BillContext = {
      currentStage: 'floor_vote',
      lastActionDate: '2026-04-03',
      jurisdiction: 'US',
      sponsors: [],
      newsArticles: [],
    };
    const result = computePassageScore(context, now);
    expect(result.components.sponsorStrength).toBe(30);
    expect(result.components.sentiment).toBe(50);
    expect(result.components.opposition).toBe(70);
  });
});

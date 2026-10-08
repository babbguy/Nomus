/**
 * Per-source scrape frequency (G4, 2026-07-25).
 * Before this fix every active source scraped on every cron run and the
 * dashboard's "Every 168h" was decorative.
 */
import { describe, it, expect } from 'vitest';
import { isSourceDue } from './scheduler.js';

const NOW = Date.parse('2026-07-25T12:00:00Z');

function hoursAgo(h: number): string {
  return new Date(NOW - h * 60 * 60 * 1000).toISOString();
}

describe('isSourceDue', () => {
  it('never-scraped sources are always due', () => {
    expect(isSourceDue({ lastScrapedAt: null, scrapeFrequencyHours: 168 }, NOW)).toBe(true);
  });

  it('a daily source scraped 25h ago is due', () => {
    expect(isSourceDue({ lastScrapedAt: hoursAgo(25), scrapeFrequencyHours: 24 }, NOW)).toBe(true);
  });

  it('a weekly source scraped 24h ago is NOT due', () => {
    expect(isSourceDue({ lastScrapedAt: hoursAgo(24), scrapeFrequencyHours: 168 }, NOW)).toBe(false);
  });

  it('a weekly source scraped 168h ago is due', () => {
    expect(isSourceDue({ lastScrapedAt: hoursAgo(168), scrapeFrequencyHours: 168 }, NOW)).toBe(true);
  });

  it('grace window: a daily source scraped 23.5h ago is due (does not slip a full cycle)', () => {
    expect(isSourceDue({ lastScrapedAt: hoursAgo(23.5), scrapeFrequencyHours: 24 }, NOW)).toBe(true);
  });

  it('a daily source scraped 2h ago is NOT due', () => {
    expect(isSourceDue({ lastScrapedAt: hoursAgo(2), scrapeFrequencyHours: 24 }, NOW)).toBe(false);
  });

  it('null frequency defaults to 24h', () => {
    expect(isSourceDue({ lastScrapedAt: hoursAgo(25), scrapeFrequencyHours: null }, NOW)).toBe(true);
    expect(isSourceDue({ lastScrapedAt: hoursAgo(2), scrapeFrequencyHours: null }, NOW)).toBe(false);
  });
});

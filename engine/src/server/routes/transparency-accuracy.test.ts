/**
 * Scout Accuracy Ledger: public transparency route tests.
 *
 * Asserts the exact response contracts the dashboard builds against, for
 * both the empty state and a seeded state, plus pagination validation.
 * Uses the real engine DB client (:memory: per .env.test; vitest isolates
 * this file's process).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { accuracySnapshots, billOutcomes, trackedBills } from '../../db/schema.js';
import {
  emptyCalibrationBuckets,
  emptyHitRates,
  MIN_PUBLISH_N,
  METHODOLOGY_VERSION,
} from '../../scout/accuracy-calibration.js';
import { transparencyAccuracyRoutes } from './transparency-accuracy.js';

const app = new Hono();
app.route('/api/v1/transparency/accuracy', transparencyAccuracyRoutes);

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  const db = getDb();
  db.delete(accuracySnapshots).run();
  db.delete(billOutcomes).run();
  db.delete(trackedBills).run();
});

// ─── Seed helpers ──────────────────────────────────────────────

function seedSnapshot(overrides: Partial<typeof accuracySnapshots.$inferInsert> = {}): string {
  const id = randomUUID();
  getDb().insert(accuracySnapshots).values({
    generatedAt: '2026-07-24T04:30:00.000Z',
    methodologyVersion: METHODOLOGY_VERSION,
    sampleSize: 40,
    enactedCount: 15,
    failedCount: 25,
    withCalibrationScore: 36,
    brierScore: 0.181,
    calibrationBuckets: JSON.stringify(emptyCalibrationBuckets()),
    hitRates: JSON.stringify({
      at50: { predictedCount: 12, enactedCount: 9, rate: 0.75 },
      at70: { predictedCount: 6, enactedCount: 5, rate: 5 / 6 },
      at90: { predictedCount: 2, enactedCount: 2, rate: 1 },
    }),
    byJurisdiction: JSON.stringify([
      { jurisdiction: 'US-FED', outcomes: 30, enacted: 10, brierScore: 0.2 },
    ]),
    published: true,
    ...overrides,
    id,
  }).run();
  return id;
}

function seedOutcome(params: {
  billId?: string;
  outcomeAt: string;
  outcome?: 'enacted' | 'failed';
  title?: string;
  jurisdiction?: string;
}): string {
  const db = getDb();
  const billId = params.billId ?? randomUUID();
  const now = new Date().toISOString();

  if (params.title !== undefined) {
    db.insert(trackedBills).values({
      id: billId,
      title: params.title,
      jurisdiction: params.jurisdiction ?? 'US-FED',
      currentStage: 'signed',
      progressPercent: 95,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  const id = randomUUID();
  db.insert(billOutcomes).values({
    id,
    billId,
    finalStage: (params.outcome ?? 'enacted') === 'enacted' ? 'signed' : 'died',
    outcome: params.outcome ?? 'enacted',
    outcomeAt: params.outcomeAt,
    scoreAtOutcome: 88,
    scoreT30: 72,
    scoreT60: 60,
    scoreT90: 45,
    peakScore: 90,
    componentSnapshot: JSON.stringify({ componentsT30: null }),
    signature: 'test-signature',
    recordedAt: now,
    methodologyVersion: METHODOLOGY_VERSION,
  }).run();
  return id;
}

// ─── GET /api/v1/transparency/accuracy ─────────────────────────

describe('GET /api/v1/transparency/accuracy', () => {
  it('returns the exact contract shape with zeros when no snapshot exists', async () => {
    const res = await app.request('/api/v1/transparency/accuracy');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.methodologyVersion).toBe(METHODOLOGY_VERSION);
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
    expect(body.sample).toEqual({ outcomes: 0, enacted: 0, failed: 0, withCalibrationScore: 0 });
    expect(body.brierScore).toBeNull();
    expect(body.calibration).toEqual(emptyCalibrationBuckets());
    expect(body.hitRates).toEqual(emptyHitRates());
    expect(body.byJurisdiction).toEqual([]);
    expect(body.minPublishN).toBe(MIN_PUBLISH_N);
    expect(body.published).toBe(false);
    expect(body.methodology).toBeDefined();
    expect(body.methodology.primaryMetric).toContain('scoreT30');
    // the fixed political component is disclosed
    expect(JSON.stringify(body.methodology)).toContain('fixed at 50');
  });

  it('serves the LATEST snapshot with the exact contract shape', async () => {
    seedSnapshot({ generatedAt: '2026-07-20T04:30:00.000Z', sampleSize: 10, published: false });
    seedSnapshot({ generatedAt: '2026-07-24T04:30:00.000Z', sampleSize: 40, published: true });

    const res = await app.request('/api/v1/transparency/accuracy');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.generatedAt).toBe('2026-07-24T04:30:00.000Z');
    expect(body.sample).toEqual({ outcomes: 40, enacted: 15, failed: 25, withCalibrationScore: 36 });
    expect(body.brierScore).toBeCloseTo(0.181, 10);
    expect(body.calibration).toHaveLength(10);
    expect(body.calibration[0]).toEqual({ bucket: '0-10', predictedMidpoint: 5, observed: null, n: 0 });
    expect(body.hitRates.at50).toEqual({ predictedCount: 12, enactedCount: 9, rate: 0.75 });
    expect(body.hitRates.at90).toEqual({ predictedCount: 2, enactedCount: 2, rate: 1 });
    expect(body.byJurisdiction).toEqual([
      { jurisdiction: 'US-FED', outcomes: 30, enacted: 10, brierScore: 0.2 },
    ]);
    expect(body.minPublishN).toBe(MIN_PUBLISH_N);
    expect(body.published).toBe(true);
    expect(body.methodologyVersion).toBe(METHODOLOGY_VERSION);
  });
});

// ─── GET /api/v1/transparency/accuracy/outcomes ────────────────

describe('GET /api/v1/transparency/accuracy/outcomes', () => {
  it('returns { total, entries } with the exact entry shape, joined with tracked_bills', async () => {
    seedOutcome({
      outcomeAt: '2026-06-01T00:00:00.000Z',
      title: 'AI Safety Act',
      jurisdiction: 'US-CA',
    });

    const res = await app.request('/api/v1/transparency/accuracy/outcomes');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.total).toBe(1);
    expect(body.entries).toHaveLength(1);
    const entry = body.entries[0];
    expect(Object.keys(entry).sort()).toEqual([
      'billId', 'finalStage', 'id', 'jurisdiction', 'outcome', 'outcomeAt',
      'peakScore', 'recordedAt', 'scoreAtOutcome', 'scoreT30', 'scoreT60',
      'scoreT90', 'signature', 'title',
    ]);
    expect(entry.title).toBe('AI Safety Act');
    expect(entry.jurisdiction).toBe('US-CA');
    expect(entry.outcome).toBe('enacted');
    expect(entry.finalStage).toBe('signed');
    expect(entry.scoreT30).toBe(72);
    expect(entry.scoreT60).toBe(60);
    expect(entry.scoreT90).toBe(45);
    expect(entry.peakScore).toBe(90);
    expect(entry.scoreAtOutcome).toBe(88);
    expect(entry.signature).toBe('test-signature');
  });

  it('null title/jurisdiction when the operational bill row no longer exists', async () => {
    seedOutcome({ outcomeAt: '2026-06-01T00:00:00.000Z' }); // no tracked_bills row
    const res = await app.request('/api/v1/transparency/accuracy/outcomes');
    const body = await res.json();
    expect(body.entries[0].title).toBeNull();
    expect(body.entries[0].jurisdiction).toBeNull();
  });

  it('orders by outcomeAt descending and paginates', async () => {
    const oldest = seedOutcome({ outcomeAt: '2026-01-01T00:00:00.000Z' });
    const newest = seedOutcome({ outcomeAt: '2026-07-01T00:00:00.000Z' });
    const middle = seedOutcome({ outcomeAt: '2026-04-01T00:00:00.000Z' });

    const res = await app.request('/api/v1/transparency/accuracy/outcomes');
    const body = await res.json();
    expect(body.total).toBe(3);
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual([newest, middle, oldest]);

    const page2 = await app.request('/api/v1/transparency/accuracy/outcomes?limit=1&offset=1');
    const page2Body = await page2.json();
    expect(page2Body.total).toBe(3);
    expect(page2Body.entries.map((e: { id: string }) => e.id)).toEqual([middle]);
  });

  it('validates pagination bounds: limit clamped to [1,200], offset floored at 0', async () => {
    for (let i = 0; i < 3; i++) {
      seedOutcome({ outcomeAt: `2026-0${i + 1}-15T00:00:00.000Z` });
    }

    // limit=0 → clamped to 1
    const minRes = await app.request('/api/v1/transparency/accuracy/outcomes?limit=0');
    expect((await minRes.json()).entries).toHaveLength(1);

    // negative offset → treated as 0; garbage limit → default 50
    const junkRes = await app.request('/api/v1/transparency/accuracy/outcomes?limit=abc&offset=-5');
    const junkBody = await junkRes.json();
    expect(junkBody.entries).toHaveLength(3);
    expect(junkBody.total).toBe(3);

    // limit far above the cap still succeeds (clamped to 200 internally)
    const bigRes = await app.request('/api/v1/transparency/accuracy/outcomes?limit=99999');
    expect(bigRes.status).toBe(200);
    expect((await bigRes.json()).entries).toHaveLength(3);
  });
});

// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * Benchmark run list and result upload.
 *
 * End-to-end audit: GET /runs served resultsByPrinciple as the JSON string
 * "{}", which the Benchmarks page iterated character by character.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { apiKeys, organizations } from '../../db/schema.js';
import type { AppEnv } from '../app.js';
import { benchmarkRoutes } from './benchmarks.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/benchmarks', benchmarkRoutes);
const KEY = 'nk_test_benchmarks_key_00000000000';

beforeAll(() => {
  runMigrations();
  const db = getDb();
  const orgId = randomUUID();
  const now = new Date().toISOString();
  db.insert(organizations).values({ id: orgId, name: 'Bench Org', slug: `bench-${orgId.slice(0, 8)}`, jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId, keyHash: createHash('sha256').update(KEY).digest('hex'), keyPrefix: KEY.slice(0, 12),
    label: 'bench', scopes: JSON.stringify(['read:policies']), rateLimitRpm: 100000, isActive: true, createdAt: now,
  }).run();
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, {
    method, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
};

describe('benchmark runs', () => {
  it('lists runs with parsed JSON fields, before and after results are uploaded', async () => {
    const run = await call('POST', '/api/v1/benchmarks/run', { modelName: 'claude-sonnet-4-5', provider: 'anthropic' });
    expect(run.status).toBe(201);

    let list = await call('GET', '/api/v1/benchmarks/runs');
    expect(list.json.runs[0].resultsByPrinciple).toEqual({});
    expect(list.json.runs[0].rawResults).toEqual([]);

    expect((await call('PATCH', `/api/v1/benchmarks/runs/${run.json.id}/results`, { overallScore: 140 })).status).toBe(400);
    const up = await call('PATCH', `/api/v1/benchmarks/runs/${run.json.id}/results`, {
      overallScore: 86.5,
      resultsByPrinciple: { fairness: { score: 90, benchmarks_run: 3, passed: 3, failed: 0 } },
      benchmarksPassed: 3,
    });
    expect(up.status).toBe(200);

    list = await call('GET', '/api/v1/benchmarks/runs');
    expect(list.json.runs[0].status).toBe('completed');
    expect(list.json.runs[0].resultsByPrinciple.fairness.score).toBe(90);
  });
});

describe('benchmark summary', () => {
  it('serves the fields the Benchmarks page renders', async () => {
    const s = (await call('GET', '/api/v1/benchmarks/summary')).json;
    expect(s.modelsTested).toBe(1);
    expect(s.averageScore).toBe(86.5);
    expect(s.bestPrinciple).toEqual({ principle: 'fairness', avgScore: 90 });
    expect(s.worstPrinciple.principle).toBe('fairness');
  });
});

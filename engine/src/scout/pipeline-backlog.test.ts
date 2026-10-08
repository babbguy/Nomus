// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * Scout cycle: items whose LLM classification failed are retried.
 *
 * End-to-end audit: after one cycle's classifier failures, 873 items stayed
 * 'pending' with no LLM verdict; later cycles only classified newly fetched
 * items, so the backlog sat in the review queue unclassified for good.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

vi.mock('./feed-fetcher.js', () => ({ fetchFeed: vi.fn(async () => []) }));
vi.mock('./llm-classifier.js', () => ({
  classifyBatch: vi.fn(async (items: unknown[]) => ({
    items: items.map((_, index) => ({ index, relevant: false, confidence: 0.8, jurisdiction: null })),
    llmResponse: { content: '[]', tokensIn: 10, tokensOut: 10, model: 'm', provider: 'openai' },
  })),
}));
vi.mock('./signal-extractor.js', () => ({ extractSignal: vi.fn() }));
vi.mock('../services/notifications.js', () => ({
  notifyScoutSignal: vi.fn(async () => {}),
  notifyScoutReviewNeeded: vi.fn(async () => {}),
}));
vi.mock('../sse/manager.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { scoutFeeds, scoutItems } from '../db/schema.js';
import { classifyBatch } from './llm-classifier.js';
import { runScoutCycle } from './pipeline.js';

beforeAll(() => {
  runMigrations();
});

describe('runScoutCycle', () => {
  it('classifies pending items left unclassified by an earlier cycle', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const feedId = randomUUID();
    db.insert(scoutFeeds).values({
      id: feedId, name: 'Backlog feed', url: 'https://example.gov/feed', feedType: 'rss',
      jurisdiction: 'EU', createdAt: now, updatedAt: now,
    }).run();
    const itemId = randomUUID();
    db.insert(scoutItems).values({
      id: itemId, feedId, title: 'Commission consults on AI Act guidance', url: 'https://example.gov/item',
      publishedAt: now, rawSnippet: 'Consultation on the AI Act.', status: 'pending', keywordScore: 0.5, discoveredAt: now,
    }).run();

    const result = await runScoutCycle();

    expect(classifyBatch).toHaveBeenCalled();
    expect(result.itemsLlmClassified).toBeGreaterThanOrEqual(1);
    const item = db.select().from(scoutItems).where(eq(scoutItems.id, itemId)).get()!;
    expect(item.llmRelevant).toBe(false);
    expect(item.status).toBe('rejected');
  });
});

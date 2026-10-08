// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * Scout tier-2 classifier response handling.
 *
 * End-to-end audit: a model reply that was valid JSON but not an array
 * threw "parsed.map is not a function"; every batch failed and its items
 * stayed pending, to be re-sent (and re-billed) on every cycle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const generate = vi.fn();
vi.mock('../llm/provider.js', () => ({
  resolveProvider: vi.fn(async () => ({ provider: { generate }, providerName: 'openai', model: 'm' })),
}));
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { classifyBatch } from './llm-classifier.js';

const items = [
  { title: 'EU AI Act implementing act adopted', snippet: 'The Commission adopted...' },
  { title: 'New phone released', snippet: 'A phone.' },
];
const reply = (content: string) => ({ content, tokensIn: 1, tokensOut: 1, model: 'm', provider: 'openai' });

beforeEach(() => generate.mockReset());

describe('classifyBatch', () => {
  it('reads a plain JSON array', async () => {
    generate.mockResolvedValue(reply(JSON.stringify([
      { index: 0, relevant: true, confidence: 0.9, jurisdiction: 'EU' },
      { index: 1, relevant: false, confidence: 0.8, jurisdiction: null },
    ])));
    const r = await classifyBatch(items);
    expect(r.items.map((i) => i.relevant)).toEqual([true, false]);
  });

  it('reads an array wrapped in an object', async () => {
    generate.mockResolvedValue(reply(JSON.stringify({ items: [
      { index: 0, relevant: true, confidence: 0.9, jurisdiction: 'EU' },
      { index: 1, relevant: false, confidence: 0.8, jurisdiction: null },
    ] })));
    const r = await classifyBatch(items);
    expect(r.items[1].relevant).toBe(false);
  });

  it('treats a non-array reply like unparseable output (kept relevant), instead of throwing', async () => {
    generate.mockResolvedValue(reply('{}'));
    const r = await classifyBatch(items);
    expect(r.items).toHaveLength(2);
    expect(r.items.every((i) => i.relevant && i.confidence === 0.5)).toBe(true);
  });
});

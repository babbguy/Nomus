// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * GET /api/v1/stream reconnect replay (Last-Event-ID).
 *
 * End-to-end audit: live events honour ?jurisdictions=, but the replay of
 * missed events on reconnect did not, so a US-CA subscriber received EU rule
 * changes after every reconnect.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { apiKeys, organizations, policyEvents } from '../../db/schema.js';
import type { AppEnv } from '../app.js';
import { streamRoutes, eventJurisdiction } from './stream.js';
import { getClientCount } from '../../sse/manager.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/stream', streamRoutes);

const KEY = 'nk_test_stream_replay_key_0000000';
let base = 0;

beforeAll(() => {
  runMigrations();
  const db = getDb();
  const orgId = randomUUID();
  const now = new Date().toISOString();
  db.insert(organizations).values({
    id: orgId, name: 'Stream Org', slug: `stream-${orgId.slice(0, 8)}`,
    jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now,
  }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId,
    keyHash: createHash('sha256').update(KEY).digest('hex'),
    keyPrefix: KEY.slice(0, 12), label: 'stream test',
    scopes: JSON.stringify(['stream']), rateLimitRpm: 100000, isActive: true, createdAt: now,
  }).run();

  base = 1_000_000 + Math.floor(Math.random() * 1000) * 10;
  for (const [i, jurisdiction] of ['EU', 'US-CA', 'EU'].entries()) {
    db.insert(policyEvents).values({
      id: randomUUID(),
      eventType: 'policy.updated',
      ruleId: null,
      payload: JSON.stringify({ ruleKey: `replay.rule_${i}`, jurisdiction }),
      payloadSignature: 'test',
      sequence: base + i + 1,
      createdAt: now,
    }).run();
  }
});

/** Read the stream until the `connected` event, then disconnect. */
async function readUntilConnected(path: string, lastEventId: string = String(base)): Promise<string> {
  const controller = new AbortController();
  const res = await app.request(path, {
    headers: { Authorization: `Bearer ${KEY}`, 'Last-Event-ID': lastEventId },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('event: connected')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  controller.abort();
  await reader.cancel().catch(() => {});
  return text;
}

describe('GET /api/v1/stream replay', () => {
  it('replays only the subscribed jurisdictions', async () => {
    const text = await readUntilConnected('/api/v1/stream?jurisdictions=US-CA');
    expect(text).toContain('replay.rule_1');
    expect(text).not.toContain('replay.rule_0');
    expect(text).not.toContain('replay.rule_2');
  });

  it('replays everything without a jurisdiction filter', async () => {
    const text = await readUntilConnected('/api/v1/stream');
    for (const k of ['replay.rule_0', 'replay.rule_1', 'replay.rule_2']) expect(text).toContain(k);
  });

  it('does not replay for a Last-Event-ID that is not a sequence number', async () => {
    // parseInt('37a1f412-...') is 37, which replayed the wrong range; other
    // UUIDs parsed as NaN. Neither is a policy event sequence.
    for (const bad of ['37a1f412-0000-4000-8000-000000000000', 'a69d0000-0000-4000-8000-000000000000', '12abc', '-5']) {
      const text = await readUntilConnected('/api/v1/stream', bad);
      expect(text, bad).not.toContain('replay.rule_');
    }
  });

  it('eventJurisdiction tolerates bad payloads', () => {
    expect(eventJurisdiction('{"jurisdiction":"EU"}')).toBe('EU');
    expect(eventJurisdiction('not json')).toBe('');
  });
});

describe('GET /api/v1/stream disconnect', () => {
  it('deregisters the client when the subscriber disconnects', async () => {
    const before = getClientCount();
    await readUntilConnected('/api/v1/stream');
    // Closed connections stayed registered until a keepalive write threw,
    // which never happens: the client count only ever grew.
    for (let i = 0; i < 20 && getClientCount() > before; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(getClientCount()).toBe(before);
  });
});

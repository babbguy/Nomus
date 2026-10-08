// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * The SSE `id:` field becomes the client's Last-Event-ID, which the stream
 * route replays stored policy events from. Only stored policy events (id =
 * their sequence) may carry one; ephemeral events used to carry random UUIDs
 * that corrupted the replay cursor.
 */
import { describe, it, expect, afterEach } from 'vitest';

import { broadcastEvent, registerClient, removeClient } from './manager.js';

const decoder = new TextDecoder();
let clientId: string | null = null;

afterEach(() => {
  if (clientId) removeClient(clientId);
  clientId = null;
});

function subscribe(): string[] {
  const received: string[] = [];
  const controller = {
    enqueue: (chunk: Uint8Array) => { received.push(decoder.decode(chunk)); },
  } as unknown as ReadableStreamDefaultController;
  clientId = registerClient('org-sse-manager-test', [], controller);
  expect(clientId).not.toBeNull();
  return received;
}

describe('broadcastEvent', () => {
  it('writes no id line for an event without an id', () => {
    const received = subscribe();
    broadcastEvent({ type: 'pipeline.progress', data: { step: 2 }, jurisdiction: 'EU' });
    expect(received).toHaveLength(1);
    expect(received[0]).not.toMatch(/^id:/m);
    expect(received[0]).toBe('event: pipeline.progress\ndata: {"step":2}\n\n');
  });

  it('writes the sequence as the id of a stored policy event', () => {
    const received = subscribe();
    broadcastEvent({ id: '42', type: 'policy.created', data: { ruleKey: 'k' }, jurisdiction: 'EU' });
    expect(received[0]).toBe('id: 42\nevent: policy.created\ndata: {"ruleKey":"k"}\n\n');
  });
});

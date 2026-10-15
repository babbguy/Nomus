/**
 * The SSE org filter (design spec §1.6): an event that carries `orgId` is
 * private to that org's clients, whatever their jurisdiction subscription;
 * events without `orgId` (the regulatory corpus) keep the jurisdiction filter.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { broadcastEvent, registerClient, removeClient } from './manager.js';

const decoder = new TextDecoder();

function client(orgId: string, jurisdictions: string[]) {
  const received: string[] = [];
  const controller = { enqueue: (chunk: Uint8Array) => received.push(decoder.decode(chunk)) } as unknown as ReadableStreamDefaultController;
  const id = registerClient(orgId, jurisdictions, controller)!;
  return { id, received, events: () => received.map((r) => /event: (\S+)/.exec(r)?.[1]) };
}

const registered: string[] = [];
afterEach(() => {
  for (const id of registered.splice(0)) removeClient(id);
});

describe('broadcastEvent org filter', () => {
  it("another org's client never receives a CPG event; the org's clients do, whatever their jurisdictions", () => {
    const mine = client('org-a', []);
    const mineEu = client('org-a', ['EU']);
    const theirs = client('org-b', []);
    registered.push(mine.id, mineEu.id, theirs.id);
    broadcastEvent({ type: 'cpg.bundle.changed', data: { orgId: 'org-a', reason: 'policy_activated' }, jurisdiction: '', orgId: 'org-a' });
    expect(mine.events()).toEqual(['cpg.bundle.changed']);
    expect(mineEu.events()).toEqual(['cpg.bundle.changed']);
    expect(theirs.events()).toEqual([]);
  });

  it('existing events (no orgId) are unchanged: every org, filtered by jurisdiction only', () => {
    const a = client('org-a', ['EU']);
    const b = client('org-b', []);
    const c = client('org-c', ['US-CA']);
    registered.push(a.id, b.id, c.id);
    broadcastEvent({ id: '42', type: 'policy.created', data: { ruleKey: 'eu.x' }, jurisdiction: 'EU' });
    expect(a.events()).toEqual(['policy.created']);
    expect(b.events()).toEqual(['policy.created']);
    expect(c.events()).toEqual([]);
    expect(a.received[0]).toContain('id: 42\n');
  });

  it('a CPG event carries no SSE id, so it never moves a Last-Event-ID replay cursor', () => {
    const a = client('org-a', []);
    registered.push(a.id);
    broadcastEvent({ type: 'cpg.bundle.changed', data: {}, jurisdiction: '', orgId: 'org-a' });
    expect(a.received[0].startsWith('event: cpg.bundle.changed\n')).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac, timingSafeEqual } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  env: {
    NOMUS_MODUS_API_URL: 'http://localhost:8080',
    NOMUS_MODUS_API_KEY: 'test-modus-key',
    NOMUS_WEBHOOK_LEGACY_SIGNATURE: 'true',
  } as Record<string, unknown>,
  // When set, returned as the platform_settings row for 'webhook.subscribers'
  customSubscribersRow: null as { value: string } | null,
}));

vi.mock('../config/env.js', () => ({
  env: () => mocks.env,
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

vi.mock('../db/client.js', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => mocks.customSubscribersRow,
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          run: () => {},
        }),
        run: () => {},
      }),
    }),
  }),
}));

vi.mock('../db/schema.js', () => ({
  platformSettings: { key: 'key' },
}));

import {
  dispatchWebhook,
  notifyRulesUpdated,
  notifyRulesError,
  notifyScoutSignalPromoted,
} from './webhook-dispatcher.js';

const MODUS_SECRET = 'test-modus-key';
const V2_FRESHNESS_MS = 5 * 60 * 1000;

/**
 * Consumer-side V2 verification — mirrors EXACTLY what a consumer (Modus)
 * must do to verify a Nomus webhook.
 * This helper doubles as executable documentation of the consumer contract:
 *
 *   1. Read X-Nomus-Signature-V2 and X-Nomus-Timestamp headers.
 *   2. Parse the timestamp as ISO-8601 UTC; reject if unparseable.
 *   3. Reject if abs(now - timestamp) > 5 minutes (freshness window).
 *   4. Recompute "sha256=" + HMAC-SHA256(secret, `${timestamp}.${rawBody}`) hex.
 *   5. Compare against the header value in constant time.
 */
function consumerVerifyV2(
  headers: Record<string, string>,
  rawBody: string,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  const signature = headers['X-Nomus-Signature-V2'];
  const timestamp = headers['X-Nomus-Timestamp'];
  if (!signature || !timestamp) return false;

  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts)) return false;
  if (Math.abs(nowMs - ts) > V2_FRESHNESS_MS) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  const expectedBuf = Buffer.from(expected, 'utf-8');
  const actualBuf = Buffer.from(signature, 'utf-8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/** Extract headers + body of the nth fetch call. */
function capturedDelivery(callIndex = 0): { headers: Record<string, string>; body: string } {
  const call = vi.mocked(global.fetch).mock.calls[callIndex];
  return {
    headers: (call[1] as any).headers as Record<string, string>,
    body: (call[1] as any).body as string,
  };
}

describe('webhook-dispatcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.env.NOMUS_WEBHOOK_LEGACY_SIGNATURE = 'true';
    mocks.customSubscribersRow = null;
    // Mock global fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    }) as any;
  });

  describe('dispatchWebhook', () => {
    it('sends webhook to Modus subscriber', async () => {
      await dispatchWebhook('rules.updated', { test: true });

      // Give the async Promise.allSettled time to fire
      await new Promise((r) => setTimeout(r, 50));

      expect(global.fetch).toHaveBeenCalled();
      const call = vi.mocked(global.fetch).mock.calls[0];
      expect(call[0]).toContain('/api/v1/webhooks/nomus');
    });

    it('includes HMAC signature header', async () => {
      await dispatchWebhook('rules.updated', { sourceId: 'src-1' });
      await new Promise((r) => setTimeout(r, 50));

      const { headers } = capturedDelivery();
      expect(headers['X-Nomus-Signature']).toBeDefined();
      expect(typeof headers['X-Nomus-Signature']).toBe('string');
    });

    it('includes event type header', async () => {
      await dispatchWebhook('rules.error', { error: 'test' });
      await new Promise((r) => setTimeout(r, 50));

      const { headers } = capturedDelivery();
      expect(headers['X-Nomus-Event']).toBe('rules.error');
    });

    it('retries on failure', async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({ ok: false, status: 500 } as any)
        .mockResolvedValueOnce({ ok: false, status: 500 } as any)
        .mockResolvedValueOnce({ ok: true, status: 200 } as any);

      await dispatchWebhook('rules.updated', { test: true });
      // Wait for retries (exponential backoff: 1s, 2s)
      await new Promise((r) => setTimeout(r, 4000));

      expect(vi.mocked(global.fetch).mock.calls.length).toBe(3);
    }, 10000);

    it('does not dispatch when no subscribers match the event', async () => {
      // 'rules.approved' is a valid event but Modus only subscribes to rules.updated, rules.error, scout.signal_promoted
      await dispatchWebhook('rules.approved', { test: true });
      await new Promise((r) => setTimeout(r, 50));

      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('convenience helpers', () => {
    it('notifyRulesUpdated dispatches rules.updated event', async () => {
      await notifyRulesUpdated({
        sourceId: 'src-1',
        sourceName: 'Test',
        jurisdiction: 'EU',
        rulesCreated: 5,
        rulesUpdated: 2,
        stateHash: 'abc',
        generatedAt: new Date().toISOString(),
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(global.fetch).toHaveBeenCalled();
    });

    it('notifyRulesError dispatches rules.error event', async () => {
      await notifyRulesError({
        sourceId: 'src-1',
        sourceName: 'Test',
        error: 'Pipeline failed',
        stepReached: 2,
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(global.fetch).toHaveBeenCalled();
    });

    it('notifyScoutSignalPromoted dispatches scout.signal_promoted event', async () => {
      await notifyScoutSignalPromoted({
        signalId: 'sig-1',
        title: 'Test Signal',
        jurisdiction: 'EU',
        ruleKey: 'eu.test.rule',
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe('HMAC signing — legacy v1 (body only)', () => {
    it('produces valid HMAC-SHA256 signature over the body', async () => {
      await dispatchWebhook('rules.updated', { data: 'test' });
      await new Promise((r) => setTimeout(r, 50));

      const { headers, body } = capturedDelivery();
      const expected = createHmac('sha256', MODUS_SECRET).update(body).digest('hex');
      expect(headers['X-Nomus-Signature']).toBe(expected);
    });

    it('is emitted by default (NOMUS_WEBHOOK_LEGACY_SIGNATURE defaults to true)', async () => {
      await dispatchWebhook('rules.updated', { data: 'test' });
      await new Promise((r) => setTimeout(r, 50));

      const { headers } = capturedDelivery();
      expect(headers['X-Nomus-Signature']).toBeDefined();
      // Legacy format: bare lowercase hex, no "sha256=" prefix
      expect(headers['X-Nomus-Signature']).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is NOT emitted when NOMUS_WEBHOOK_LEGACY_SIGNATURE is false', async () => {
      mocks.env.NOMUS_WEBHOOK_LEGACY_SIGNATURE = 'false';

      await dispatchWebhook('rules.updated', { data: 'test' });
      await new Promise((r) => setTimeout(r, 50));

      const { headers } = capturedDelivery();
      expect(headers['X-Nomus-Signature']).toBeUndefined();
      // V2 must still be present — never send unsigned
      expect(headers['X-Nomus-Signature-V2']).toBeDefined();
    });
  });

  describe('HMAC signing — v2 (timestamp-bound)', () => {
    it('emits X-Nomus-Signature-V2 as "sha256=" + HMAC-SHA256(secret, `${timestamp}.${body}`) hex', async () => {
      await dispatchWebhook('rules.updated', { data: 'test' });
      await new Promise((r) => setTimeout(r, 50));

      const { headers, body } = capturedDelivery();
      const timestamp = headers['X-Nomus-Timestamp'];
      const expected = `sha256=${createHmac('sha256', MODUS_SECRET).update(`${timestamp}.${body}`).digest('hex')}`;
      expect(headers['X-Nomus-Signature-V2']).toBe(expected);
    });

    it('verifies with the consumer-side contract (freshness window + constant-time compare)', async () => {
      await dispatchWebhook('rules.updated', { sourceId: 'src-1' });
      await new Promise((r) => setTimeout(r, 50));

      const { headers, body } = capturedDelivery();
      expect(consumerVerifyV2(headers, body, MODUS_SECRET)).toBe(true);
    });

    it('fails consumer verification when the timestamp header is tampered', async () => {
      await dispatchWebhook('rules.updated', { sourceId: 'src-1' });
      await new Promise((r) => setTimeout(r, 50));

      const { headers, body } = capturedDelivery();
      // Attacker rewrites the timestamp to look fresh — signature no longer matches
      const tampered = { ...headers, 'X-Nomus-Timestamp': new Date(Date.now() + 1000).toISOString() };
      expect(consumerVerifyV2(tampered, body, MODUS_SECRET)).toBe(false);
    });

    it('fails consumer verification when the body is tampered', async () => {
      await dispatchWebhook('rules.updated', { sourceId: 'src-1' });
      await new Promise((r) => setTimeout(r, 50));

      const { headers, body } = capturedDelivery();
      const tamperedBody = body.replace('src-1', 'src-2');
      expect(consumerVerifyV2(headers, tamperedBody, MODUS_SECRET)).toBe(false);
    });

    it('fails consumer verification when replayed outside the 5-minute freshness window', async () => {
      await dispatchWebhook('rules.updated', { sourceId: 'src-1' });
      await new Promise((r) => setTimeout(r, 50));

      const { headers, body } = capturedDelivery();
      const ts = Date.parse(headers['X-Nomus-Timestamp']);
      // Same untampered delivery, replayed 6 minutes later — must be rejected
      expect(consumerVerifyV2(headers, body, MODUS_SECRET, ts + 6 * 60 * 1000)).toBe(false);
      // ...but inside the window it verifies
      expect(consumerVerifyV2(headers, body, MODUS_SECRET, ts + 4 * 60 * 1000)).toBe(true);
    });

    it('signs the SAME timestamp that is sent in the header and embedded in the body', async () => {
      await dispatchWebhook('rules.updated', { data: 'test' });
      await new Promise((r) => setTimeout(r, 50));

      const { headers, body } = capturedDelivery();
      const payload = JSON.parse(body) as { timestamp: string };
      // Regression guard for the time-of-check-vs-time-of-use bug (spec §9 note):
      // the header timestamp and the in-body timestamp must be the same string.
      expect(headers['X-Nomus-Timestamp']).toBe(payload.timestamp);
      // And it must be UTC ISO-8601
      expect(headers['X-Nomus-Timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('sends the exact expected header names', async () => {
      await dispatchWebhook('rules.updated', { data: 'test' });
      await new Promise((r) => setTimeout(r, 50));

      const { headers } = capturedDelivery();
      expect(Object.keys(headers).sort()).toEqual([
        'Content-Type',
        'User-Agent',
        'X-Nomus-Delivery-Id',
        'X-Nomus-Event',
        'X-Nomus-Signature',
        'X-Nomus-Signature-V2',
        'X-Nomus-Timestamp',
      ]);
    });

    it('includes a UUID X-Nomus-Delivery-Id', async () => {
      await dispatchWebhook('rules.updated', { data: 'test' });
      await new Promise((r) => setTimeout(r, 50));

      const { headers } = capturedDelivery();
      expect(headers['X-Nomus-Delivery-Id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  describe('retry semantics (spec §6.3 — no re-signing on retry)', () => {
    it('reuses the same timestamp, signatures, and delivery-id across retry attempts', async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({ ok: false, status: 500 } as any)
        .mockResolvedValueOnce({ ok: false, status: 500 } as any)
        .mockResolvedValueOnce({ ok: true, status: 200 } as any);

      await dispatchWebhook('rules.updated', { test: true });
      // Wait for retries (exponential backoff: 1s, 2s)
      await new Promise((r) => setTimeout(r, 4000));

      expect(vi.mocked(global.fetch).mock.calls.length).toBe(3);
      const first = capturedDelivery(0);
      const second = capturedDelivery(1);
      const third = capturedDelivery(2);

      // Spec §6.3: the timestamp is NOT refreshed on retry — re-signing would
      // mask transient network failures vs. an actual replay. All attempts of
      // one delivery carry identical signed material.
      for (const attempt of [second, third]) {
        expect(attempt.headers['X-Nomus-Timestamp']).toBe(first.headers['X-Nomus-Timestamp']);
        expect(attempt.headers['X-Nomus-Signature-V2']).toBe(first.headers['X-Nomus-Signature-V2']);
        expect(attempt.headers['X-Nomus-Signature']).toBe(first.headers['X-Nomus-Signature']);
        expect(attempt.headers['X-Nomus-Delivery-Id']).toBe(first.headers['X-Nomus-Delivery-Id']);
        expect(attempt.body).toBe(first.body);
      }

      // Each attempt still verifies under the consumer contract
      expect(consumerVerifyV2(third.headers, third.body, MODUS_SECRET)).toBe(true);
    }, 10000);

    it('separate dispatches each get a fresh timestamp and delivery-id', async () => {
      await dispatchWebhook('rules.updated', { seq: 1 });
      await new Promise((r) => setTimeout(r, 20));
      await dispatchWebhook('rules.updated', { seq: 2 });
      await new Promise((r) => setTimeout(r, 50));

      expect(vi.mocked(global.fetch).mock.calls.length).toBe(2);
      const first = capturedDelivery(0);
      const second = capturedDelivery(1);
      expect(second.headers['X-Nomus-Delivery-Id']).not.toBe(first.headers['X-Nomus-Delivery-Id']);
      expect(second.headers['X-Nomus-Signature-V2']).not.toBe(first.headers['X-Nomus-Signature-V2']);
    });
  });

  describe('signing failure — fail loudly, never send unsigned', () => {
    it('aborts delivery without any HTTP request when signing throws', async () => {
      // Custom subscriber with a malformed (null) secret — createHmac throws.
      // Only this subscriber listens to 'rules.approved', so the delivery
      // path under test is isolated from the Modus subscriber.
      mocks.customSubscribersRow = {
        value: JSON.stringify([{
          id: 'broken',
          name: 'Broken Subscriber',
          url: 'http://localhost:9999/hook',
          secret: null,
          events: ['rules.approved'],
          enabled: true,
        }]),
      };

      await dispatchWebhook('rules.approved', { test: true });
      await new Promise((r) => setTimeout(r, 100));

      // Signing failed before any network I/O — nothing was ever sent
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});

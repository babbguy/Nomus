/**
 * Public verify API contract tests.
 *
 * Asserts the EXACT frozen response contract the dashboard builds against,
 * for every lifecycle status, plus the signatureValid=false tampered-record
 * fixture, the org-display opt-in, and the subscribe endpoint's validation,
 * rate limiting, and email-unconfigured rejection.
 *
 * Real engine DB (:memory: per .env.test), real Ed25519 signing.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import {
  organizations, regulatorySources, policyRules,
  attestationReceipts, attestationSubscriptions, platformSettings,
} from '../../db/schema.js';
import { initSigningKeys, getPublicKey } from '../../core/signing.js';
import { evaluateCompliance } from '../../core/attestation.js';
import { invalidateNotificationCache } from '../../services/notifications.js';
import { verifyPublicRoutes, resetSubscribeRateLimiter } from './verify.js';

const app = new Hono();
app.route('/api/v1/verify', verifyPublicRoutes);

let orgId: string;

beforeAll(() => {
  runMigrations();
  initSigningKeys();

  const db = getDb();
  const now = new Date().toISOString();
  orgId = randomUUID();
  db.insert(organizations).values({
    id: orgId,
    name: 'Acme AI Corp',
    slug: 'acme-ai',
    jurisdictionAccess: '[]',
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }).run();

  // One active EU rule so the subject carries a rulesEvaluated entry
  const sourceId = randomUUID();
  db.insert(regulatorySources).values({
    id: sourceId,
    name: 'EU AI Act',
    jurisdiction: 'EU',
    url: 'https://example.eu/ai-act',
    parserType: 'html',
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(policyRules).values({
    id: randomUUID(),
    sourceId,
    ruleKey: 'eu.test.rule-1',
    version: 3,
    jurisdiction: 'EU',
    category: 'transparency',
    conditions: JSON.stringify({ action: 'deploy_model' }),
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary: 'Disclose AI system deployment',
    legalReference: 'EU AI Act Art. 52',
    effectiveDate: '2026-01-01',
    isActive: true,
    signature: 'rule-sig-fixture',
    createdAt: now,
    updatedAt: now,
  }).run();
});

beforeEach(() => {
  resetSubscribeRateLimiter();
  getDb().delete(attestationSubscriptions).run();
});

function createAttestation(expiresAt?: string): string {
  return evaluateCompliance(orgId, { action: 'deploy_model' }, 'EU', { expiresAt }).id;
}

async function getVerify(id: string) {
  return app.request(`/api/v1/verify/${id}`);
}

async function subscribe(id: string, body: unknown, ip = '203.0.113.10') {
  return app.request(`/api/v1/verify/${id}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

// ─── GET /api/v1/verify/:attestationId ─────────────────────────

describe('GET /api/v1/verify/:attestationId', () => {
  it('404 with a bare error body for unknown ids (no existence oracle)', async () => {
    const res = await getVerify(randomUUID());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['error']);
  });

  it('valid attestation — the exact frozen contract shape', async () => {
    const id = createAttestation();
    const res = await getVerify(id);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual([
      '_disclaimer', 'attestationId', 'attestedAt', 'checkedAt', 'expiresAt',
      'orgDisplayName', 'revocationReason', 'revokedAt', 'ruleContext',
      'schemaVersion', 'signatureValid', 'status', 'subject', 'supersededBy',
      'verification',
    ]);

    expect(body.attestationId).toBe(id);
    expect(body.status).toBe('valid');
    expect(body.signatureValid).toBe(true);
    expect(body.schemaVersion).toBe(1);
    expect(Number.isNaN(Date.parse(body.attestedAt))).toBe(false);
    expect(body.expiresAt).toBeNull();
    expect(body.revokedAt).toBeNull();
    expect(body.revocationReason).toBeNull();
    expect(body.supersededBy).toBeNull();
    // Private by default
    expect(body.orgDisplayName).toBeNull();

    // Subject: attested content summary — NO actionContext, NO orgId
    expect(Object.keys(body.subject).sort()).toEqual(['jurisdiction', 'result', 'rulesEvaluated']);
    expect(body.subject.jurisdiction).toBe('EU');
    expect(body.subject.result).toBe('requires_review');
    expect(body.subject.rulesEvaluated).toEqual([
      { ruleKey: 'eu.test.rule-1', version: 3, effect: 'require_disclosure', matched: true },
    ]);
    expect(JSON.stringify(body)).not.toContain(orgId);

    // Rule context
    expect(body.ruleContext).toEqual({
      stateHash: expect.any(String),
      computedAt: body.attestedAt,
    });

    // Verification block
    expect(body.verification.algorithm).toBe('ed25519');
    expect(body.verification.publicKey).toBe(getPublicKey());
    expect(typeof body.verification.signedPayloadDescription).toBe('string');
    expect(Array.isArray(body.verification.instructions)).toBe(true);
    expect(body.verification.instructions.length).toBeGreaterThanOrEqual(3);

    expect(typeof body._disclaimer).toBe('string');
  });

  it('revoked attestation NEVER reads as clean — status revoked, signature still valid', async () => {
    const id = createAttestation();
    const revokedAt = new Date().toISOString();
    getDb().update(attestationReceipts)
      .set({ revokedAt, revocationReason: 'Control gap discovered in Q3 audit' })
      .where(eq(attestationReceipts.id, id)).run();

    const body = await (await getVerify(id)).json();
    expect(body.status).toBe('revoked');
    expect(body.revokedAt).toBe(revokedAt);
    expect(body.revocationReason).toBe('Control gap discovered in Q3 audit');
    expect(body.signatureValid).toBe(true); // separate axes, both reported
  });

  it('superseded attestation reports superseded + the replacement id', async () => {
    const id = createAttestation();
    const newerId = createAttestation();
    getDb().update(attestationReceipts)
      .set({ supersededBy: newerId })
      .where(eq(attestationReceipts.id, id)).run();

    const body = await (await getVerify(id)).json();
    expect(body.status).toBe('superseded');
    expect(body.supersededBy).toBe(newerId);
    expect(body.signatureValid).toBe(true);
  });

  it('expired attestation reports expired', async () => {
    const id = createAttestation();
    getDb().update(attestationReceipts)
      .set({ expiresAt: '2026-01-01T00:00:00.000Z' })
      .where(eq(attestationReceipts.id, id)).run();

    const body = await (await getVerify(id)).json();
    expect(body.status).toBe('expired');
    expect(body.expiresAt).toBe('2026-01-01T00:00:00.000Z');
    expect(body.signatureValid).toBe(true);
  });

  it('revoked wins over superseded and expired (precedence)', async () => {
    const id = createAttestation();
    getDb().update(attestationReceipts)
      .set({
        revokedAt: '2026-07-01T00:00:00.000Z',
        revocationReason: 'r',
        supersededBy: 'some-other',
        expiresAt: '2026-01-01T00:00:00.000Z',
      })
      .where(eq(attestationReceipts.id, id)).run();
    const body = await (await getVerify(id)).json();
    expect(body.status).toBe('revoked');
  });

  it('tampered record fixture — signatureValid false, status still derived', async () => {
    const id = createAttestation();
    getDb().update(attestationReceipts)
      .set({ jurisdiction: 'US-CA' }) // flip a signed field
      .where(eq(attestationReceipts.id, id)).run();

    const body = await (await getVerify(id)).json();
    expect(body.signatureValid).toBe(false);
    expect(body.status).toBe('valid'); // lifecycle unchanged — axes independent
  });

  it('corrupted actionContext — signatureValid false, no 500', async () => {
    const id = createAttestation();
    getDb().update(attestationReceipts)
      .set({ actionContext: '{broken' })
      .where(eq(attestationReceipts.id, id)).run();

    const res = await getVerify(id);
    expect(res.status).toBe(200);
    expect((await res.json()).signatureValid).toBe(false);
  });

  it('orgDisplayName appears ONLY after the org opts in', async () => {
    const id = createAttestation();
    const db = getDb();

    db.update(organizations).set({ showOrgOnPublicVerify: true })
      .where(eq(organizations.id, orgId)).run();
    let body = await (await getVerify(id)).json();
    expect(body.orgDisplayName).toBe('Acme AI Corp');

    db.update(organizations).set({ showOrgOnPublicVerify: false })
      .where(eq(organizations.id, orgId)).run();
    body = await (await getVerify(id)).json();
    expect(body.orgDisplayName).toBeNull();
  });
});

// ─── POST /api/v1/verify/:attestationId/subscribe ──────────────

describe('POST /api/v1/verify/:attestationId/subscribe', () => {
  it('404 for unknown attestation', async () => {
    const res = await subscribe(randomUUID(), { channel: 'webhook', target: 'https://example.com/hook' });
    expect(res.status).toBe(404);
  });

  it('rejects an invalid channel', async () => {
    const id = createAttestation();
    const res = await subscribe(id, { channel: 'sms', target: '+15551234567' });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed email target', async () => {
    const id = createAttestation();
    const res = await subscribe(id, { channel: 'email', target: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed webhook target', async () => {
    const id = createAttestation();
    const res = await subscribe(id, { channel: 'webhook', target: 'not a url' });
    expect(res.status).toBe(400);
  });

  it('rejects non-http(s) and internal webhook targets', async () => {
    const id = createAttestation();
    expect((await subscribe(id, { channel: 'webhook', target: 'ftp://example.com/x' })).status).toBe(400);
    expect((await subscribe(id, { channel: 'webhook', target: 'https://localhost/hook' })).status).toBe(400);
    expect((await subscribe(id, { channel: 'webhook', target: 'https://127.0.0.1/hook' })).status).toBe(400);
    expect((await subscribe(id, { channel: 'webhook', target: 'https://192.168.1.5/hook' })).status).toBe(400);
  });

  it('rejects a missing/invalid JSON body', async () => {
    const id = createAttestation();
    const res = await app.request(`/api/v1/verify/${id}/subscribe`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    expect(res.status).toBe(400);
  });

  it('email channel is REJECTED with 503 when Resend is not configured — never a silent accept', async () => {
    const id = createAttestation();
    const res = await subscribe(id, { channel: 'email', target: 'auditor@example.com' });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('not configured');
    // Nothing was persisted
    expect(getDb().select().from(attestationSubscriptions).all()).toHaveLength(0);
  });

  it('email channel succeeds once a Resend key is configured', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.insert(platformSettings)
      .values({ key: 'notification.apiKeys.resend', value: 're_test_key', updatedAt: now })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: 're_test_key', updatedAt: now } })
      .run();
    invalidateNotificationCache();

    try {
      const id = createAttestation();
      const res = await subscribe(id, { channel: 'email', target: 'auditor@example.com' });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.subscriptionId).toBeDefined();
      expect(body.channel).toBe('email');
      expect(body.secret).toBeUndefined(); // secrets are webhook-only
    } finally {
      db.delete(platformSettings).where(eq(platformSettings.key, 'notification.apiKeys.resend')).run();
      invalidateNotificationCache();
    }
  });

  it('webhook channel returns a one-time HMAC secret and the event list', async () => {
    const id = createAttestation();
    const res = await subscribe(id, { channel: 'webhook', target: 'https://auditor.example.com/nomus-hook' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.subscriptionId).toBeDefined();
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.events).toEqual(['attestation.revoked', 'attestation.superseded', 'attestation.expired']);

    const row = getDb().select().from(attestationSubscriptions)
      .where(eq(attestationSubscriptions.id, body.subscriptionId)).get()!;
    expect(row.attestationId).toBe(id);
    expect(row.channel).toBe('webhook');
    expect(row.secret).toBe(body.secret);
    expect(row.active).toBe(true);
  });

  it('re-subscribing the same target is idempotent and does NOT re-reveal the secret', async () => {
    const id = createAttestation();
    const first = await (await subscribe(id, { channel: 'webhook', target: 'https://auditor.example.com/hook' })).json();
    const res = await subscribe(id, { channel: 'webhook', target: 'https://auditor.example.com/hook' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadySubscribed).toBe(true);
    expect(body.subscriptionId).toBe(first.subscriptionId);
    expect(body.secret).toBeUndefined();
    expect(getDb().select().from(attestationSubscriptions).all()).toHaveLength(1);
  });

  it('per-IP rate limiter returns 429 after the window budget, per IP', async () => {
    const id = createAttestation();
    // Budget is 10 per 10 minutes per IP
    for (let i = 0; i < 10; i++) {
      const res = await subscribe(id, { channel: 'webhook', target: `https://h${i}.example.com/hook` }, '198.51.100.7');
      expect(res.status).toBe(201);
    }
    const blocked = await subscribe(id, { channel: 'webhook', target: 'https://h11.example.com/hook' }, '198.51.100.7');
    expect(blocked.status).toBe(429);
    // A different IP still has its own budget
    const other = await subscribe(id, { channel: 'webhook', target: 'https://other.example.com/hook' }, '198.51.100.8');
    expect(other.status).toBe(201);
  });
});

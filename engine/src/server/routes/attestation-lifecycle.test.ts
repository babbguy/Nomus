/**
 * Lifecycle actions: revoke (idempotent, immutable, cross-org 403),
 * supersede flow, evidence export (json determinism + html), notification
 * dispatch on status change (mocked dispatcher), and the nightly
 * expiry-crossing sweep.
 *
 * The webhook dispatcher is mocked so no network I/O happens; everything
 * else (DB, signing, routes, notifier) is real.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  dispatchWebhookToTargets: vi.fn(),
}));

vi.mock('../../services/webhook-dispatcher.js', () => ({
  dispatchWebhook: vi.fn(),
  dispatchWebhookToTargets: mocks.dispatchWebhookToTargets,
  notifyRulesUpdated: vi.fn(),
  notifyRulesError: vi.fn(),
  notifyScoutSignalPromoted: vi.fn(),
}));

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import {
  organizations, apiKeys, attestationReceipts, attestationSubscriptions,
} from '../../db/schema.js';
import { initSigningKeys, getPublicKey } from '../../core/signing.js';
import { evaluateCompliance } from '../../core/attestation.js';
import { sweepExpiredAttestations } from '../../services/attestation-notifier.js';
import type { AppEnv } from '../app.js';
import { auditRoutes } from './audit.js';
import { evaluateRoutes } from './evaluate.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/attestations', auditRoutes);
app.route('/api/v1/evaluate', evaluateRoutes);

const KEY_A = 'nk_test_org_a_key';
const KEY_B = 'nk_test_org_b_key';
let orgA: string;
let orgB: string;

function seedOrgWithKey(name: string, slug: string, rawKey: string): string {
  const db = getDb();
  const now = new Date().toISOString();
  const orgId = randomUUID();
  db.insert(organizations).values({
    id: orgId,
    name,
    slug,
    jurisdictionAccess: '[]',
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(apiKeys).values({
    id: randomUUID(),
    orgId,
    keyHash: createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 12),
    label: 'test key',
    scopes: JSON.stringify(['read:policies', 'evaluate']),
    rateLimitRpm: 100000,
    isActive: true,
    createdAt: now,
  }).run();
  return orgId;
}

beforeAll(() => {
  runMigrations();
  initSigningKeys();
  orgA = seedOrgWithKey('Org A', 'org-a', KEY_A);
  orgB = seedOrgWithKey('Org B', 'org-b', KEY_B);
});

beforeEach(() => {
  mocks.dispatchWebhookToTargets.mockClear();
  getDb().delete(attestationSubscriptions).run();
});

function createAttestation(orgId: string, expiresAt?: string): string {
  return evaluateCompliance(orgId, { action: 'test' }, 'EU', { expiresAt }).id;
}

function addWebhookSubscription(attestationId: string, active = true): string {
  const id = randomUUID();
  getDb().insert(attestationSubscriptions).values({
    id,
    attestationId,
    channel: 'webhook',
    target: 'https://auditor.example.com/hook',
    secret: 'a'.repeat(64),
    active,
    createdAt: new Date().toISOString(),
  }).run();
  return id;
}

async function req(method: string, path: string, key: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

// ─── Revoke ────────────────────────────────────────────────────

describe('POST /api/v1/attestations/:id/revoke', () => {
  it('requires a reason', async () => {
    const id = createAttestation(orgA);
    expect((await req('POST', `/api/v1/attestations/${id}/revoke`, KEY_A, {})).status).toBe(400);
    expect((await req('POST', `/api/v1/attestations/${id}/revoke`, KEY_A)).status).toBe(400);
  });

  it('404 for unknown attestations', async () => {
    const res = await req('POST', `/api/v1/attestations/${randomUUID()}/revoke`, KEY_A, { reason: 'x'.repeat(10) });
    expect(res.status).toBe(404);
  });

  it("403 when revoking another org's attestation, which stays un-revoked", async () => {
    const id = createAttestation(orgB);
    const res = await req('POST', `/api/v1/attestations/${id}/revoke`, KEY_A, { reason: 'cross-org attempt' });
    expect(res.status).toBe(403);
    const row = getDb().select().from(attestationReceipts).where(eq(attestationReceipts.id, id)).get()!;
    expect(row.revokedAt).toBeNull();
  });

  it('revokes with a timestamped reason and fires the dispatcher for active subscriptions', async () => {
    const id = createAttestation(orgA);
    const subId = addWebhookSubscription(id);

    const res = await req('POST', `/api/v1/attestations/${id}/revoke`, KEY_A, { reason: 'Key rotation invalidated the control evidence' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('revoked');
    expect(body.alreadyRevoked).toBe(false);
    expect(body.revocationReason).toBe('Key rotation invalidated the control evidence');
    expect(Number.isNaN(Date.parse(body.revokedAt))).toBe(false);

    // Persisted
    const row = getDb().select().from(attestationReceipts).where(eq(attestationReceipts.id, id)).get()!;
    expect(row.revokedAt).toBe(body.revokedAt);

    // Notification fired through the (mocked) signed dispatcher
    expect(mocks.dispatchWebhookToTargets).toHaveBeenCalledTimes(1);
    const [targets, event, data] = mocks.dispatchWebhookToTargets.mock.calls[0];
    expect(event).toBe('attestation.revoked');
    expect(targets).toEqual([expect.objectContaining({
      id: subId,
      url: 'https://auditor.example.com/hook',
      secret: 'a'.repeat(64),
    })]);
    expect(data).toMatchObject({
      attestationId: id,
      status: 'revoked',
      revocationReason: 'Key rotation invalidated the control evidence',
    });
    // No org-private data leaves the building
    expect(JSON.stringify(data)).not.toContain(orgA);
  });

  it('is idempotent AND immutable: a second revoke keeps the original reason + timestamp and does not re-notify', async () => {
    const id = createAttestation(orgA);
    addWebhookSubscription(id);

    const first = await (await req('POST', `/api/v1/attestations/${id}/revoke`, KEY_A, { reason: 'original reason' })).json();
    mocks.dispatchWebhookToTargets.mockClear();

    const res = await req('POST', `/api/v1/attestations/${id}/revoke`, KEY_A, { reason: 'attempted rewrite' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyRevoked).toBe(true);
    expect(body.revocationReason).toBe('original reason');
    expect(body.revokedAt).toBe(first.revokedAt);
    expect(mocks.dispatchWebhookToTargets).not.toHaveBeenCalled();

    const row = getDb().select().from(attestationReceipts).where(eq(attestationReceipts.id, id)).get()!;
    expect(row.revocationReason).toBe('original reason');
    expect(row.revokedAt).toBe(first.revokedAt);
  });
});

// ─── Supersede ─────────────────────────────────────────────────

describe('POST /api/v1/evaluate with supersedes', () => {
  const evalBody = (extra: Record<string, unknown> = {}) => ({
    action: 'deploy_model',
    jurisdiction: 'EU',
    context: { model: 'test-model' }, // policyConditionsSchema requires ≥1 key
    ...extra,
  });

  it('sets supersededBy on the old attestation and notifies its subscribers', async () => {
    const oldId = createAttestation(orgA);
    addWebhookSubscription(oldId);

    const res = await req('POST', '/api/v1/evaluate', KEY_A, evalBody({ supersedes: oldId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.supersedes).toBe(oldId);
    expect(body.id).toBeDefined();

    const oldRow = getDb().select().from(attestationReceipts).where(eq(attestationReceipts.id, oldId)).get()!;
    expect(oldRow.supersededBy).toBe(body.id);

    expect(mocks.dispatchWebhookToTargets).toHaveBeenCalledTimes(1);
    const [, event, data] = mocks.dispatchWebhookToTargets.mock.calls[0];
    expect(event).toBe('attestation.superseded');
    expect(data).toMatchObject({ attestationId: oldId, status: 'superseded', supersededBy: body.id });
  });

  it('404 for an unknown supersede target — and creates nothing', async () => {
    const before = getDb().select().from(attestationReceipts).all().length;
    const res = await req('POST', '/api/v1/evaluate', KEY_A, evalBody({ supersedes: randomUUID() }));
    expect(res.status).toBe(404);
    expect(getDb().select().from(attestationReceipts).all().length).toBe(before);
  });

  it("403 when superseding another org's attestation", async () => {
    const otherOrgs = createAttestation(orgB);
    const res = await req('POST', '/api/v1/evaluate', KEY_A, evalBody({ supersedes: otherOrgs }));
    expect(res.status).toBe(403);
    const row = getDb().select().from(attestationReceipts).where(eq(attestationReceipts.id, otherOrgs)).get()!;
    expect(row.supersededBy).toBeNull();
  });

  it('409 when the target is already superseded', async () => {
    const oldId = createAttestation(orgA);
    const first = await req('POST', '/api/v1/evaluate', KEY_A, evalBody({ supersedes: oldId }));
    expect(first.status).toBe(200);
    const res = await req('POST', '/api/v1/evaluate', KEY_A, evalBody({ supersedes: oldId }));
    expect(res.status).toBe(409);
  });

  it('accepts a future UTC expiresAt and rejects past or offset-formatted values', async () => {
    const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const ok = await req('POST', '/api/v1/evaluate', KEY_A, evalBody({ expiresAt: future }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).expiresAt).toBe(future);

    const past = await req('POST', '/api/v1/evaluate', KEY_A, evalBody({ expiresAt: '2020-01-01T00:00:00.000Z' }));
    expect(past.status).toBe(400);

    const offset = await req('POST', '/api/v1/evaluate', KEY_A, evalBody({ expiresAt: '2027-01-01T00:00:00+02:00' }));
    expect(offset.status).toBe(400);
  });
});

// ─── Evidence export ───────────────────────────────────────────

describe('GET /api/v1/attestations/:id/export', () => {
  it('404 for another org (read endpoints do not leak existence to non-owners)', async () => {
    const id = createAttestation(orgB);
    const res = await req('GET', `/api/v1/attestations/${id}/export`, KEY_A);
    expect(res.status).toBe(404);
  });

  it('400 for an unknown format', async () => {
    const id = createAttestation(orgA);
    const res = await req('GET', `/api/v1/attestations/${id}/export?format=pdf`, KEY_A);
    expect(res.status).toBe(400);
  });

  it('json bundle is self-contained: record, signature, public key, signed payload, instructions, corpus hash', async () => {
    const id = createAttestation(orgA);
    const res = await req('GET', `/api/v1/attestations/${id}/export?format=json`, KEY_A);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const bundle = JSON.parse(await res.text());

    expect(bundle.bundleType).toBe('nomus-attestation-evidence');
    expect(bundle.attestation.id).toBe(id);
    expect(bundle.attestation.schemaVersion).toBe(1);
    expect(bundle.attestation.status).toBe('valid');
    expect(bundle.verification.algorithm).toBe('ed25519');
    expect(bundle.verification.publicKey).toBe(getPublicKey());
    expect(bundle.verification.signatureValid).toBe(true);
    expect(typeof bundle.verification.signedPayloadCanonicalJson).toBe('string');
    // The canonical payload contains the attested facts, keys sorted
    expect(bundle.verification.signedPayloadCanonicalJson).toContain(`"id":"${id}"`);
    expect(bundle.verification.instructions.length).toBeGreaterThanOrEqual(3);
    expect(bundle.corpus.policyStateHash).toBe(bundle.attestation.policyStateHash);
    expect(Array.isArray(bundle.citedRules)).toBe(true);
    expect(typeof bundle._disclaimer).toBe('string');
  });

  it('json export is deterministic — identical bytes except generatedAt', async () => {
    const id = createAttestation(orgA);
    const strip = (s: string) => s.replace(/"generatedAt": "[^"]+"/, '"generatedAt": "<stripped>"');

    const first = await (await req('GET', `/api/v1/attestations/${id}/export?format=json`, KEY_A)).text();
    await new Promise((r) => setTimeout(r, 5)); // ensure a different generatedAt
    const second = await (await req('GET', `/api/v1/attestations/${id}/export?format=json`, KEY_A)).text();

    expect(strip(first)).toBe(strip(second));
  });

  it('html export is a printable single file containing the signature and public key', async () => {
    const id = createAttestation(orgA);
    const row = getDb().select().from(attestationReceipts).where(eq(attestationReceipts.id, id)).get()!;

    const res = await req('GET', `/api/v1/attestations/${id}/export?format=html`, KEY_A);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain(row.signature);
    expect(html).toContain(getPublicKey());
    expect(html).toContain(id);
    // Self-contained: no external assets
    expect(html).not.toMatch(/<script\s+src=|<link\s/i);
  });

  it('html export of a revoked attestation shows REVOKED', async () => {
    const id = createAttestation(orgA);
    await req('POST', `/api/v1/attestations/${id}/revoke`, KEY_A, { reason: 'shown in binder' });
    const html = await (await req('GET', `/api/v1/attestations/${id}/export?format=html`, KEY_A)).text();
    expect(html).toContain('REVOKED');
    expect(html).toContain('shown in binder');
  });
});

// ─── Authed verify reflects lifecycle ──────────────────

describe('GET /api/v1/attestations/:id/verify', () => {
  it('reports status alongside signatureValid — revoked never reads clean', async () => {
    const id = createAttestation(orgA);
    await req('POST', `/api/v1/attestations/${id}/revoke`, KEY_A, { reason: 'audit finding' });

    const body = await (await req('GET', `/api/v1/attestations/${id}/verify`, KEY_A)).json();
    expect(body.signatureValid).toBe(true);
    expect(body.status).toBe('revoked');
    expect(body.revocationReason).toBe('audit finding');
  });
});

// ─── Expiry-crossing nightly sweep ─────────────────────────────

describe('sweepExpiredAttestations', () => {
  function expireNow(id: string, when = '2026-01-01T00:00:00.000Z') {
    getDb().update(attestationReceipts).set({ expiresAt: when })
      .where(eq(attestationReceipts.id, id)).run();
  }

  it('notifies active subscriptions of newly-expired attestations exactly once', async () => {
    const id = createAttestation(orgA);
    expireNow(id);
    addWebhookSubscription(id);

    const first = sweepExpiredAttestations();
    expect(first).toEqual({ newlyExpired: 1, notified: 1 });
    expect(mocks.dispatchWebhookToTargets).toHaveBeenCalledTimes(1);
    const [, event, data] = mocks.dispatchWebhookToTargets.mock.calls[0];
    expect(event).toBe('attestation.expired');
    expect(data).toMatchObject({ attestationId: id, status: 'expired' });

    // Exactly-once: the marker is set and the next sweep is a no-op
    const row = getDb().select().from(attestationReceipts).where(eq(attestationReceipts.id, id)).get()!;
    expect(row.expiryNotifiedAt).not.toBeNull();
    const second = sweepExpiredAttestations();
    expect(second).toEqual({ newlyExpired: 0, notified: 0 });
    expect(mocks.dispatchWebhookToTargets).toHaveBeenCalledTimes(1);
  });

  it('marks newly-expired attestations without active subscriptions but sends nothing', () => {
    const id = createAttestation(orgA);
    expireNow(id);
    addWebhookSubscription(id, false); // inactive

    const result = sweepExpiredAttestations();
    expect(result).toEqual({ newlyExpired: 1, notified: 0 });
    expect(mocks.dispatchWebhookToTargets).not.toHaveBeenCalled();
  });

  it('skips revoked and superseded attestations (higher-precedence status already notified)', async () => {
    const revoked = createAttestation(orgA);
    expireNow(revoked);
    addWebhookSubscription(revoked);
    await req('POST', `/api/v1/attestations/${revoked}/revoke`, KEY_A, { reason: 'revoked before expiry' });
    mocks.dispatchWebhookToTargets.mockClear();

    const superseded = createAttestation(orgA);
    expireNow(superseded);
    getDb().update(attestationReceipts).set({ supersededBy: randomUUID() })
      .where(eq(attestationReceipts.id, superseded)).run();

    const result = sweepExpiredAttestations();
    expect(result).toEqual({ newlyExpired: 0, notified: 0 });
    expect(mocks.dispatchWebhookToTargets).not.toHaveBeenCalled();
  });

  it('does not touch unexpired or never-expiring attestations', () => {
    createAttestation(orgA); // no expiry
    const future = createAttestation(orgA);
    expireNow(future, '2099-01-01T00:00:00.000Z');

    expect(sweepExpiredAttestations()).toEqual({ newlyExpired: 0, notified: 0 });
  });
});

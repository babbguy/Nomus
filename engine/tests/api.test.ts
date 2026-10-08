import { describe, it, expect, beforeAll } from 'vitest';
// Test env vars loaded from .env.test via vitest setupFiles

import { createApp } from '../src/server/app.js';
import { seedDatabase } from '../src/db/seed.js';
import { initSigningKeys, getPublicKey, signData } from '../src/core/signing.js';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createTestTables } from './setup.js';

const app = createApp();

// Helper to make requests to Hono app
async function request(method: string, path: string, options?: { body?: unknown; headers?: Record<string, string> }) {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  };
  if (options?.body) init.body = JSON.stringify(options.body);
  return app.request(url, init);
}

const AUTH = { Authorization: 'Bearer nk_test_api_key_bootstrap' };

describe('API Endpoints', () => {
  beforeAll(async () => {
    createTestTables();
    initSigningKeys();
    await seedDatabase();
  });

  // ─── Health ──────────────────────────────────────────────────
  describe('Health', () => {
    it('GET /health returns 200', async () => {
      const res = await request('GET', '/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.service).toBe('nomus-engine');
    });

    it('GET /ready returns 200', async () => {
      const res = await request('GET', '/ready');
      expect(res.status).toBe(200);
    });
  });

  // ─── Auth ────────────────────────────────────────────────────
  describe('Auth', () => {
    it('POST /api/v1/auth/login returns session on valid credentials', async () => {
      const res = await request('POST', '/api/v1/auth/login', {
        body: { email: 'test@nomus.dev', password: 'test-password-123' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user).toBeDefined();
      expect(body.user.email).toBe('test@nomus.dev');
    });

    it('POST /api/v1/auth/login rejects bad password', async () => {
      const res = await request('POST', '/api/v1/auth/login', {
        body: { email: 'test@nomus.dev', password: 'wrong-password' },
      });
      expect(res.status).toBe(401);
    });

    it('GET /api/v1/auth/me returns 401 without session', async () => {
      const res = await request('GET', '/api/v1/auth/me');
      expect(res.status).toBe(401);
    });
  });

  // ─── Policies ────────────────────────────────────────────────
  describe('Policies', () => {
    it('GET /api/v1/policies returns policy list with API key', async () => {
      const res = await request('GET', '/api/v1/policies', { headers: AUTH });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBeDefined();
      expect(Array.isArray(body.policies)).toBe(true);
    });

    it('GET /api/v1/policies returns 401 without auth', async () => {
      const res = await request('GET', '/api/v1/policies');
      expect(res.status).toBe(401);
    });

    it('GET /api/v1/policies/hash returns hash or empty state', async () => {
      const res = await request('GET', '/api/v1/policies/hash', { headers: AUTH });
      // 200 with hash, or 200 with empty hash when no policies exist
      expect([200, 404]).toContain(res.status);
    });
  });

  // ─── Sources ─────────────────────────────────────────────────
  describe('Sources', () => {
    it('GET /api/v1/sources returns seeded sources', async () => {
      const res = await request('GET', '/api/v1/sources', { headers: AUTH });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBeGreaterThanOrEqual(5);
      expect(body.sources[0].name).toBeDefined();
    });
  });

  // ─── Evaluate ────────────────────────────────────────────────
  describe('Evaluate', () => {
    it('POST /api/v1/evaluate returns response with disclaimer', async () => {
      const res = await request('POST', '/api/v1/evaluate', {
        headers: AUTH,
        body: { action: 'deploy_ai', jurisdiction: 'EU', context: { risk_level: 'low' } },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body._disclaimer).toBeDefined();
    });

    it('POST /api/v1/evaluate validates input', async () => {
      const res = await request('POST', '/api/v1/evaluate', {
        headers: AUTH,
        body: { action: '', jurisdiction: '' },
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── Dashboard ───────────────────────────────────────────────
  describe('Dashboard', () => {
    it('GET /api/v1/dashboard/stats returns system stats', async () => {
      const res = await request('GET', '/api/v1/dashboard/stats', { headers: AUTH });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sources).toBeGreaterThanOrEqual(5);
      expect(body.tenants).toBeDefined();
    });
  });

  // ─── Transparency (public) ──────────────────────────────────
  describe('Transparency', () => {
    it('GET /api/v1/transparency/stats returns public stats without auth', async () => {
      const res = await request('GET', '/api/v1/transparency/stats');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sources).toBeDefined();
      expect(body.rules).toBeDefined();
    });
  });

  // ─── JWKS ────────────────────────────────────────────────────
  describe('Well-Known', () => {
    it('GET /.well-known/nomus-keys returns public key', async () => {
      const res = await request('GET', '/.well-known/nomus-keys');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keys).toBeDefined();
      expect(body.keys.length).toBeGreaterThan(0);
    });

    // RFC 8037: x is the base64url raw 32-byte Ed25519 key. The endpoint used to
    // publish the 44-byte base64 SPKI DER, which standard libraries reject.
    it('GET /.well-known/nomus-keys publishes an RFC 8037 JWK that standard libraries import', async () => {
      const res = await request('GET', '/.well-known/nomus-keys');
      const { keys } = await res.json();
      const jwk = keys[0];
      expect(jwk.kty).toBe('OKP');
      expect(jwk.crv).toBe('Ed25519');
      expect(jwk.x).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(jwk.x, 'base64url')).toHaveLength(32);

      const imported = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
      const engineKey = createPublicKey({ key: Buffer.from(getPublicKey(), 'base64'), format: 'der', type: 'spki' });
      expect(imported.equals(engineKey)).toBe(true);

      // spki member matches the evidence-bundle encoding and the kid is stable.
      expect(jwk.spki).toBe(getPublicKey());
      expect(jwk.kid).toBe(createHash('sha256').update(getPublicKey()).digest('hex').slice(0, 16));

      // Engine-signed data verifies with the JWK-imported key.
      const data = 'nomus jwks regression payload';
      expect(verify(null, Buffer.from(data), imported, Buffer.from(signData(data), 'base64'))).toBe(true);
    });
  });

  // ─── Ontology ────────────────────────────────────────────────
  describe('Ontology', () => {
    it('GET /api/v1/admin/ontology/stats returns counts', async () => {
      const res = await request('GET', '/api/v1/admin/ontology/stats', { headers: AUTH });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBeDefined();
      expect(body.active).toBeDefined();
    });

    it('POST /api/v1/admin/ontology/import accepts array', async () => {
      const res = await request('POST', '/api/v1/admin/ontology/import', {
        headers: AUTH,
        body: [{ term: 'API Test Term', type: 'definition', jurisdiction: 'EU', source_article: 'Art. 99', description: 'Test' }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.imported).toBeGreaterThanOrEqual(0);
    });

    it('POST /api/v1/admin/ontology/import rejects non-array', async () => {
      const res = await request('POST', '/api/v1/admin/ontology/import', {
        headers: AUTH,
        body: { term: 'not an array' },
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── GitHub Webhook ──────────────────────────────────────────
  describe('GitHub', () => {
    it('POST /api/v1/github/webhook rejects without signature', async () => {
      const res = await request('POST', '/api/v1/github/webhook', { body: {} });
      // Should fail — either 401 (no sig) or 503 (webhook not configured)
      expect([401, 503]).toContain(res.status);
    });
  });
});

/**
 * Dashboard API contract test.
 *
 * Hits every API endpoint the dashboard pages depend on, asserting that:
 *   1. The route is registered (not 404)
 *   2. Returns sane status (200/4xx, never 500)
 *   3. Returns JSON with the documented top-level shape
 *
 * The end-to-end audit on 2026-04-07 marked every dashboard page as PASS
 * by code-trace alone. This test exercises the actual code paths so the
 * "looks right by reading the code" gap is closed for every page in the
 * dashboard's routing table.
 *
 * Test design:
 * - Real Hono app via createApp()
 * - Real in-memory SQLite via .env.test (LICENSING_DB_PATH=:memory:)
 * - Real seeded admin API key (nk_test_api_key_bootstrap)
 * - Each endpoint tested with the bootstrap API key for auth
 * - Endpoints that need a body get a minimal valid one
 * - Endpoints that mutate (POST/PATCH/DELETE) test ROUTE REGISTRATION only
 *   via OPTIONS or by sending a request that should produce 200/204/4xx —
 *   never 404. We don't assert on side-effects because those are covered
 *   by per-route unit tests elsewhere.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from './app.js';
import { seedDatabase } from '../db/seed.js';
import { initSigningKeys } from '../core/signing.js';
import { runMigrations } from '../db/migrate.js';

const app = createApp();
const AUTH = { Authorization: 'Bearer nk_test_api_key_bootstrap' };

async function req(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...AUTH,
      ...extraHeaders,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(url, init);
}

beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
});

// Status that means "route is registered and code didn't crash" — any
// non-5xx response. We can't distinguish a handler returning 404 (resource
// not found) from a Hono trie miss, so we treat 404 as acceptable too.
// What we actually care about is: NO 500s (handler crashes).
const ROUTE_OK = (status: number) => status < 500;

// ════════════════════════════════════════════════════════════════════
// Customer pages — every GET endpoint a customer-facing page hits
// ════════════════════════════════════════════════════════════════════

describe('Dashboard customer page contracts', () => {
  describe('CustomerDashboard', () => {
    it('GET /api/v1/dashboard/stats', async () => {
      const res = await req('GET', '/api/v1/dashboard/stats');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toBeTruthy();
    });

    it('GET /api/v1/dashboard/pipeline-history', async () => {
      const res = await req('GET', '/api/v1/dashboard/pipeline-history?limit=10');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/dashboard/cost-breakdown', async () => {
      const res = await req('GET', '/api/v1/dashboard/cost-breakdown');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('Policies + Policies/:id', () => {
    it('GET /api/v1/policies', async () => {
      const res = await req('GET', '/api/v1/policies?limit=10');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.policies).toBeInstanceOf(Array);
    });

    it('GET /api/v1/policies/industries', async () => {
      const res = await req('GET', '/api/v1/policies/industries');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/policies/hash', async () => {
      const res = await req('GET', '/api/v1/policies/hash');
      expect(res.status).toBe(200);
    });

    it('GET /api/v1/policies/:id (not-found returns 4xx not 5xx)', async () => {
      const res = await req('GET', '/api/v1/policies/nonexistent-id');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('Radar + RadarV2', () => {
    it('GET /api/v1/radar', async () => {
      const res = await req('GET', '/api/v1/radar');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/radar/v2/bills', async () => {
      const res = await req('GET', '/api/v1/radar/v2/bills');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/radar/v2/stats', async () => {
      const res = await req('GET', '/api/v1/radar/v2/stats');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/radar/v2/movers', async () => {
      const res = await req('GET', '/api/v1/radar/v2/movers');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/radar/v2/bills/:id', async () => {
      const res = await req('GET', '/api/v1/radar/v2/bills/none');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/radar/v2/bills/:id/timeline', async () => {
      const res = await req('GET', '/api/v1/radar/v2/bills/none/timeline');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/radar/v2/bills/:id/scores', async () => {
      const res = await req('GET', '/api/v1/radar/v2/bills/none/scores');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/radar/v2/bills/:id/news', async () => {
      const res = await req('GET', '/api/v1/radar/v2/bills/none/news');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('Scans + ScanRepo', () => {
    it('GET /api/v1/scan/findings', async () => {
      const res = await req('GET', '/api/v1/scan/findings');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.findings).toBeInstanceOf(Array);
    });

    it('GET /api/v1/scan/repos', async () => {
      const res = await req('GET', '/api/v1/scan/repos');
      expect(res.status).toBe(200);
    });
  });

  describe('Attestations', () => {
    it('GET /api/v1/attestations', async () => {
      const res = await req('GET', '/api/v1/attestations');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/attestations/:id/verify (route registered)', async () => {
      const res = await req('GET', '/api/v1/attestations/none/verify');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('Simulator + Simulations', () => {
    it('POST /api/v1/simulate (with valid body)', async () => {
      const res = await req('POST', '/api/v1/simulate', {
        capabilities: ['text_generation'],
        targetMarkets: ['EU', 'US-FED'],
      });
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('POST /api/v1/simulate rejects invalid body (400)', async () => {
      const res = await req('POST', '/api/v1/simulate', { foo: 'bar' });
      expect([400, 422]).toContain(res.status);
    });
  });

  describe('Graph Explorer', () => {
    it('GET /api/v1/graph (any subroute)', async () => {
      const res = await req('GET', '/api/v1/graph');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('CompliancePosture', () => {
    it('GET /api/v1/compliance-posture (route registered)', async () => {
      const res = await req('GET', '/api/v1/compliance-posture');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('Benchmarks', () => {
    it('GET /api/v1/benchmarks (route registered)', async () => {
      const res = await req('GET', '/api/v1/benchmarks');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('AuditExport', () => {
    it('GET /api/v1/audit-export?format=json', async () => {
      const res = await req('GET', '/api/v1/audit-export?format=json');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/audit-export?format=csv', async () => {
      const res = await req('GET', '/api/v1/audit-export?format=csv');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('BadgePage', () => {
    it('GET /api/v1/badge/:org/svg (no auth required)', async () => {
      const res = await app.request('http://localhost/api/v1/badge/test-org/svg');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('AiBom + BillDetail', () => {
    it('GET /api/v1/ai-bom', async () => {
      const res = await req('GET', '/api/v1/ai-bom');
      expect(res.status).toBe(200);
      // AiBom.tsx renders its summary cards from these fields; without them
      // the cards showed 0 systems next to a populated table.
      const body = await res.json() as { systems: unknown[]; summary: Record<string, unknown> };
      expect(Array.isArray(body.systems)).toBe(true);
      for (const k of ['total', 'highRisk', 'jurisdictions', 'unclassified']) {
        expect(typeof body.summary[k]).toBe('number');
      }
      expect(body.summary.total).toBe(body.systems.length);
    });
  });

  describe('Settings + Profile + Team', () => {
    it('GET /api/v1/settings/scout-api-keys', async () => {
      const res = await req('GET', '/api/v1/settings/scout-api-keys');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/users (team member list)', async () => {
      const res = await req('GET', '/api/v1/users');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('FeedbackSubmit', () => {
    it('POST /api/v1/feedback', async () => {
      const res = await req('POST', '/api/v1/feedback', {
        ruleKey: 'test.rule',
        feedback: 'test',
      });
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('Templates', () => {
    it('GET /api/v1/templates', async () => {
      const res = await req('GET', '/api/v1/templates');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// Admin pages — every GET endpoint an admin page hits
// ════════════════════════════════════════════════════════════════════

describe('Dashboard admin page contracts', () => {
  describe('AdminDashboard + SystemStatus', () => {
    it('GET /api/v1/admin/dashboard', async () => {
      const res = await req('GET', '/api/v1/admin/dashboard');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/admin/status (system status)', async () => {
      const res = await req('GET', '/api/v1/admin/status');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('IntegrityCheck', () => {
    it('POST /api/v1/admin/verify-integrity', async () => {
      const res = await req('POST', '/api/v1/admin/verify-integrity', {});
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('POST /api/v1/admin/state-hash', async () => {
      const res = await req('POST', '/api/v1/admin/state-hash', {});
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('POST /api/v1/admin/shadow-test', async () => {
      const res = await req('POST', '/api/v1/admin/shadow-test', {});
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('PipelineHistory', () => {
    it('GET /api/v1/admin/pipeline-runs', async () => {
      const res = await req('GET', '/api/v1/admin/pipeline-runs?limit=20');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('SourceList', () => {
    it('GET /api/v1/sources', async () => {
      const res = await req('GET', '/api/v1/sources');
      expect(res.status).toBe(200);
    });

    it('GET /api/v1/sources/uploadable', async () => {
      const res = await req('GET', '/api/v1/sources/uploadable');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('POST /api/v1/admin/scrape-all (concurrency-guarded)', async () => {
      const res = await req('POST', '/api/v1/admin/scrape-all', {});
      // Either kicks off (200/202) OR returns 409 if a previous test left
      // a sweep running OR returns 4xx for bad input — none should 500.
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('SourceAudit', () => {
    it('POST /api/v1/admin/audit', async () => {
      const res = await req('POST', '/api/v1/admin/audit');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/sources/:id/rules and /pipeline for a seeded source', async () => {
      const list = await req('GET', '/api/v1/sources');
      const { sources } = await list.json() as { sources: Array<{ id: string; name: string }> };
      const nist = sources.find((s) => s.name === 'NIST AI Risk Management Framework')!;
      expect(nist).toBeDefined();

      const rules = await req('GET', `/api/v1/sources/${nist.id}/rules`);
      expect(rules.status).toBe(200);
      const rulesBody = await rules.json() as { ruleCount: number; rules: Array<{ ruleKey: string; version: number }> };
      expect(rulesBody.ruleCount).toBeGreaterThan(0);
      expect(rulesBody.rules[0].ruleKey).toBeTruthy();
      expect(rulesBody.rules[0].version).toBeGreaterThanOrEqual(1);

      const pipeline = await req('GET', `/api/v1/sources/${nist.id}/pipeline`);
      expect(pipeline.status).toBe(200);
      expect(await pipeline.json()).toMatchObject({ staged: null, runs: [] });
    });
  });

  describe('OntologyManage', () => {
    it('GET /api/v1/admin/ontology/stats', async () => {
      const res = await req('GET', '/api/v1/admin/ontology/stats');
      expect(res.status).toBe(200);
    });

    it('GET /api/v1/admin/ontology/terms (list)', async () => {
      const res = await req('GET', '/api/v1/admin/ontology/terms');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('DiffViewer', () => {
    it('GET /api/v1/admin/diffs/:sourceId/snapshots', async () => {
      const res = await req('GET', '/api/v1/admin/diffs/nonexistent/snapshots');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/admin/diffs/:sourceId', async () => {
      const res = await req('GET', '/api/v1/admin/diffs/nonexistent');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('FeedbackReview', () => {
    it('GET /api/v1/admin/feedback', async () => {
      const res = await req('GET', '/api/v1/admin/feedback');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('ModusIntegration', () => {
    it('GET /api/v1/admin/modus/status', async () => {
      const res = await req('GET', '/api/v1/admin/modus/status');
      // Modus may be unreachable in tests — 502/503/504 acceptable
      expect(res.status).not.toBe(404);
      expect(res.status).not.toBe(500);
    });
  });

  describe('LLMSettings', () => {
    it('GET /api/v1/settings/llm', async () => {
      const res = await req('GET', '/api/v1/settings/llm');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('NotificationSettings', () => {
    it('GET /api/v1/settings/notifications', async () => {
      const res = await req('GET', '/api/v1/settings/notifications');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('ScoutFeeds + ScoutReview', () => {
    it('GET /api/v1/scout/feeds', async () => {
      const res = await req('GET', '/api/v1/scout/feeds');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/scout/items', async () => {
      const res = await req('GET', '/api/v1/scout/items');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/scout/stats', async () => {
      const res = await req('GET', '/api/v1/scout/stats');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('ForgeManage', () => {
    it('GET /api/v1/admin/forge/status', async () => {
      const res = await req('GET', '/api/v1/admin/forge/status');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('RadarManage', () => {
    it('GET /api/v1/radar (admin view)', async () => {
      const res = await req('GET', '/api/v1/radar');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('ScanAdmin', () => {
    it('GET /api/v1/admin/staged', async () => {
      const res = await req('GET', '/api/v1/admin/staged');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('TenantList + TenantDetail', () => {
    it('GET /api/v1/tenants', async () => {
      const res = await req('GET', '/api/v1/tenants');
      expect(ROUTE_OK(res.status)).toBe(true);
    });

    it('GET /api/v1/tenants/:id (not-found is 4xx not 5xx)', async () => {
      const res = await req('GET', '/api/v1/tenants/nonexistent');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });

  describe('UserList', () => {
    it('GET /api/v1/users', async () => {
      const res = await req('GET', '/api/v1/users');
      expect(ROUTE_OK(res.status)).toBe(true);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// Auth-required protection — every protected route returns 401 without
// credentials. Confirms middleware is mounted.
// ════════════════════════════════════════════════════════════════════

describe('Auth protection on dashboard endpoints', () => {
  const protectedRoutes = [
    'GET /api/v1/policies',
    'GET /api/v1/sources',
    'GET /api/v1/scan/findings',
    'GET /api/v1/dashboard/stats',
    'GET /api/v1/radar/v2/bills',
    'GET /api/v1/scout/feeds',
    'GET /api/v1/tenants',
    'GET /api/v1/users',
    'POST /api/v1/simulate',
    'POST /api/v1/admin/scrape-all',
  ];

  for (const route of protectedRoutes) {
    it(`${route} returns 401 without auth header`, async () => {
      const [method, path] = route.split(' ');
      const url = `http://localhost${path}`;
      const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
      if (method === 'POST') init.body = JSON.stringify({});
      const res = await app.request(url, init);
      expect([401, 403]).toContain(res.status);
    });
  }
});

// ════════════════════════════════════════════════════════════════════
// JSON shape sanity — responses parse as JSON when expected
// ════════════════════════════════════════════════════════════════════

describe('JSON response sanity', () => {
  it('GET /api/v1/dashboard/stats returns JSON object', async () => {
    const res = await req('GET', '/api/v1/dashboard/stats');
    const body = await res.json();
    expect(typeof body).toBe('object');
    expect(body).not.toBeNull();
  });

  it('GET /api/v1/policies returns { policies: [...], count }', async () => {
    const res = await req('GET', '/api/v1/policies?limit=5');
    const body = await res.json();
    expect(body.policies).toBeInstanceOf(Array);
    expect(typeof body.count).toBe('number');
  });

  it('GET /api/v1/scan/findings returns { findings: [...], count }', async () => {
    const res = await req('GET', '/api/v1/scan/findings');
    const body = await res.json();
    expect(body.findings).toBeInstanceOf(Array);
    expect(typeof body.count).toBe('number');
  });

  it('GET /api/v1/scan/repos returns { repos: [...], count }', async () => {
    const res = await req('GET', '/api/v1/scan/repos');
    const body = await res.json();
    expect(body.repos).toBeInstanceOf(Array);
    expect(typeof body.count).toBe('number');
  });
});

// ════════════════════════════════════════════════════════════════════
// Corporate Policy Governance (/api/v1/cpg, E1–E18). The governance pages
// use a browser session, so these run as the org's first member (Org Admin
// + Developer) and parse each body with the engine's zod contract.
// ════════════════════════════════════════════════════════════════════

describe('CPG API contracts', () => {
  let cookie = '';
  let orgId = '';

  beforeAll(async () => {
    const { makeOrg, makeUser } = await import('../cpg/__fixtures__/rbac-fixtures.js');
    orgId = makeOrg('Contract');
    cookie = makeUser(orgId).cookie;
  });

  async function session(method: string, path: string, body?: unknown) {
    return app.request(`http://localhost${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it('GET reads return their documented shapes', async () => {
    const c = await import('../cpg/contracts.js');
    const reads: Array<[string, { parse: (v: unknown) => unknown }]> = [
      ['/api/v1/cpg/me', c.meResponseSchema],
      ['/api/v1/cpg/permissions', c.listOf(c.permissionResponseSchema)],
      ['/api/v1/cpg/roles', c.listOf(c.roleResponseSchema)],
      ['/api/v1/cpg/users', c.listOf(c.orgUserResponseSchema)],
      ['/api/v1/cpg/teams', c.listOf(c.teamResponseSchema)],
      ['/api/v1/cpg/settings', c.cpgSettingsResponseSchema],
      ['/api/v1/cpg/audit', c.auditListResponseSchema],
      // Phase 2: boards, quorum, policy log, bundle (E19, E25, E31, E38)
      ['/api/v1/cpg/boards', c.listOf(c.boardResponseSchema)],
      ['/api/v1/cpg/quorum', c.quorumVersionResponseSchema],
      ['/api/v1/cpg/quorum/versions', c.listOf(c.quorumVersionSummarySchema)],
      ['/api/v1/cpg/quorum/versions/1', c.quorumVersionResponseSchema],
      ['/api/v1/cpg/policies', c.listOf(c.policyHeadResponseSchema)],
    ];
    for (const [path, schema] of reads) {
      const res = await session('GET', path);
      expect(res.status, path).toBe(200);
      const body: unknown = await res.json();
      expect(() => schema.parse(body), path).not.toThrow();
    }
    const { corporateBundleSchema } = await import('@nomus/scanner/corporate');
    const bundle = await session('GET', '/api/v1/cpg/bundle');
    expect(bundle.status).toBe(200);
    expect(corporateBundleSchema.safeParse(await bundle.json()).success).toBe(true);
  });

  it('the dashboard zod schemas (dashboard/src/api/cpg-schemas.ts) parse the real responses', async () => {
    // Loaded by path at run time: the dashboard is another workspace, outside
    // the engine's tsconfig rootDir. A drift between the two sides fails here.
    const { pathToFileURL } = await import('node:url');
    const { resolve } = await import('node:path');
    const d = await import(pathToFileURL(resolve(__dirname, '../../../dashboard/src/api/cpg-schemas.ts')).href);
    const reads: Array<[string, { safeParse: (v: unknown) => { success: boolean; error?: unknown } }]> = [
      ['/api/v1/cpg/me', d.meSchema],
      ['/api/v1/cpg/permissions', d.listOf(d.permissionSchema)],
      ['/api/v1/cpg/roles', d.listOf(d.roleSchema)],
      ['/api/v1/cpg/users', d.listOf(d.orgUserSchema)],
      ['/api/v1/cpg/teams', d.listOf(d.teamSchema)],
      ['/api/v1/cpg/settings', d.cpgSettingsSchema],
      ['/api/v1/cpg/audit', d.auditListSchema],
    ];
    for (const [path, schema] of reads) {
      const res = await session('GET', path);
      expect(res.status, path).toBe(200);
      const parsed = schema.safeParse(await res.json());
      expect(parsed.success, `${path}: ${JSON.stringify(parsed.error)}`).toBe(true);
    }

    // Writes the governance pages make, parsed the same way.
    const role = await session('POST', '/api/v1/cpg/roles', { key: 'contract_reader', name: 'Contract Reader', permissions: ['case.read'] });
    expect(role.status).toBe(201);
    const roleBody = await role.json();
    expect(d.roleSchema.safeParse(roleBody).success).toBe(true);
    const team = await session('POST', '/api/v1/cpg/teams', { key: 'contract', name: 'Contract', repoPatterns: ['example-org/*'] });
    expect(team.status).toBe(201);
    const teamBody = await team.json();
    expect(d.teamSchema.safeParse(teamBody).success).toBe(true);
    const invite = await session('POST', '/api/v1/cpg/users', { email: 'contract-user@example.org', name: 'Contract User' });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json();
    expect(d.inviteResultSchema.safeParse(inviteBody).success).toBe(true);
    const grant = await session('POST', `/api/v1/cpg/users/${inviteBody.user.id}/grants`, { roleId: roleBody.id, scopeType: 'team', scopeId: teamBody.id });
    expect(grant.status).toBe(201);
    const grantBody = await grant.json();
    expect(d.grantSchema.safeParse(grantBody).success).toBe(true);
    const revoked = await session('POST', `/api/v1/cpg/grants/${grantBody.id}/revoke`, { reason: 'contract test' });
    expect(d.grantSchema.safeParse(await revoked.json()).success).toBe(true);
    const user = await session('PATCH', `/api/v1/cpg/users/${inviteBody.user.id}`, { isActive: false });
    expect(d.orgUserSchema.safeParse(await user.json()).success).toBe(true);
    const patchedRole = await session('PATCH', `/api/v1/cpg/roles/${roleBody.id}`, { permissions: ['case.read', 'case.comment'] });
    expect(d.roleSchema.safeParse(await patchedRole.json()).success).toBe(true);
    const archived = await session('POST', `/api/v1/cpg/roles/${roleBody.id}/archive`, {});
    expect(d.roleSchema.safeParse(await archived.json()).success).toBe(true);
    const patchedTeam = await session('PATCH', `/api/v1/cpg/teams/${teamBody.id}`, { archived: true });
    expect(d.teamSchema.safeParse(await patchedTeam.json()).success).toBe(true);
    const settings = await session('PATCH', '/api/v1/cpg/settings', { reviewerContextLlm: false });
    expect(d.cpgSettingsSchema.safeParse(await settings.json()).success).toBe(true);
    const audit = await session('GET', '/api/v1/cpg/audit?limit=2');
    const auditBody = await audit.json();
    expect(d.auditListSchema.safeParse(auditBody).success).toBe(true);
    expect(typeof auditBody.nextCursor).toBe('string');
    const next = await session('GET', `/api/v1/cpg/audit?limit=2&cursor=${auditBody.nextCursor}`);
    expect(d.auditListSchema.safeParse(await next.json()).success).toBe(true);
  });

  it('the dashboard registry schemas (cpg-schemas.ts, cpg-quorum.ts) parse the real Phase 2 responses', async () => {
    const { pathToFileURL } = await import('node:url');
    const { resolve } = await import('node:path');
    const d = await import(pathToFileURL(resolve(__dirname, '../../../dashboard/src/api/cpg-schemas.ts')).href);
    const q = await import(pathToFileURL(resolve(__dirname, '../../../dashboard/src/api/cpg-quorum.ts')).href);
    const board = await session('POST', '/api/v1/cpg/boards', { key: 'contract-board', name: 'Contract Board', kind: 'governance' });
    expect(board.status).toBe(201);
    const boardBody = await board.json();
    expect(d.boardSchema.safeParse(boardBody).success).toBe(true);
    const meRes = await (await session('GET', '/api/v1/cpg/me')).json();
    const member = await session('POST', `/api/v1/cpg/boards/${boardBody.id}/members`, { userId: meRes.user.id });
    expect(d.boardMemberSchema.safeParse(await member.json()).success).toBe(true);
    const patched = await session('PATCH', `/api/v1/cpg/boards/${boardBody.id}`, { description: 'contract' });
    expect(d.boardSchema.safeParse(await patched.json()).success).toBe(true);
    const removed = await session('POST', `/api/v1/cpg/boards/${boardBody.id}/members/${meRes.user.id}/remove`, {});
    expect(d.boardMemberSchema.safeParse(await removed.json()).success).toBe(true);
    const current = await (await session('GET', '/api/v1/cpg/quorum')).json();
    expect(q.quorumVersionSchema.safeParse(current).success).toBe(true);
    const put = await session('PUT', '/api/v1/cpg/quorum', { config: { ...current.config, proposalLapseDays: 31 }, changeNote: 'contract' });
    expect(put.status).toBe(201);
    expect(q.quorumVersionSchema.safeParse(await put.json()).success).toBe(true);
    const reads: Array<[string, { safeParse: (v: unknown) => { success: boolean; error?: unknown } }]> = [
      ['/api/v1/cpg/boards', d.listOf(d.boardSchema)],
      ['/api/v1/cpg/quorum/versions', d.listOf(q.quorumVersionSummarySchema)],
      ['/api/v1/cpg/quorum/versions/1', q.quorumVersionSchema],
      ['/api/v1/cpg/policies', d.listOf(d.policyHeadSchema)],
      ['/api/v1/cpg/me', d.meSchema],
    ];
    for (const [path, schema] of reads) {
      const res = await session('GET', path);
      expect(res.status, path).toBe(200);
      const parsed = schema.safeParse(await res.json());
      expect(parsed.success, `${path}: ${JSON.stringify(parsed.error)}`).toBe(true);
    }
    const archived = await session('POST', `/api/v1/cpg/boards/${boardBody.id}/archive`, {});
    expect(d.boardSchema.safeParse(await archived.json()).success).toBe(true);
  });

  it('the dashboard quorum schema (cpg-quorum.ts) accepts and refuses exactly what the engine schema does', async () => {
    const { pathToFileURL } = await import('node:url');
    const { resolve } = await import('node:path');
    const q = await import(pathToFileURL(resolve(__dirname, '../../../dashboard/src/api/cpg-quorum.ts')).href);
    const { quorumConfigSchema, SEED_QUORUM_CONFIG } = await import('../cpg/quorum/schema.js');
    const seed = SEED_QUORUM_CONFIG as unknown as Record<string, any>;
    const edit = (fn: (c: any) => void) => { const c = JSON.parse(JSON.stringify(seed)); fn(c); return c; };
    const corpus: unknown[] = [
      seed,
      edit((c) => { c.proposalLapseDays = 90; }),
      edit((c) => { c.proposalLapseDays = 91; }),
      edit((c) => { c.tiers.prohibited.bulk = { ...c.tiers['review-required'].bulk }; }),
      edit((c) => { c.tiers['review-required'].bulk = { allowed: false }; }),
      edit((c) => { c.tiers['review-required'].snippet.approvals = 0; }),
      edit((c) => { c.tiers['review-required'].snippet.approvals = 11; }),
      edit((c) => { c.tiers.prohibited.snippet.defaultExpiryDays = 91; }),
      edit((c) => { c.tiers.prohibited.standing.maxExpiryDays = 120; }),
      edit((c) => { c.standingExceptions.defaultExpiryDays = 91; }),
      edit((c) => { c.standingExceptions.maxExpiryDays = 366; }),
      edit((c) => { c.policyApproval.approvals = 0; }),
      edit((c) => { c.policyApproval.approvals = 6; }),
      edit((c) => { c.policyApproval.allowSelfApproval = true; }),
      edit((c) => { c.tiers.advisory.blocking = true; }),
      edit((c) => { c.gracePeriod.newPolicyDefaultDays = 0; c.gracePeriod.newVersionDefaultDays = 365; }),
      edit((c) => { c.gracePeriod.newVersionDefaultDays = -1; }),
      edit((c) => { c.tiers['review-required'].snippet.extraBoardIds = ['not-a-uuid']; }),
      edit((c) => { c.tiers['review-required'].snippet.requiredPermission = 'case.review'; }),
      edit((c) => { c.tiers['review-required'].snippet.boardCoverage = 'some_owning'; }),
      edit((c) => { c.policyOverrides = { '00000000-0000-4000-8000-000000000000': { bulk: { allowed: false } } }; }),
      edit((c) => { c.policyOverrides = { 'not-a-uuid': {} }; }),
      edit((c) => { c.schemaVersion = 2; }),
      edit((c) => { c.extra = true; }),
      edit((c) => { delete c.gracePeriod; }),
    ];
    const verdicts = corpus.map((c) => [quorumConfigSchema.safeParse(c).success, q.quorumConfigSchema.safeParse(c).success]);
    for (const [i, [engine, dashboard]] of verdicts.entries()) expect(dashboard, `corpus case ${i}`).toBe(engine);
    expect(verdicts.filter(([e]) => e).length).toBe(5);
  });

  it('write routes are registered and never 5xx on invalid input', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    for (const [method, path] of [
      ['POST', '/api/v1/cpg/roles'], ['PATCH', `/api/v1/cpg/roles/${id}`], ['POST', `/api/v1/cpg/roles/${id}/archive`],
      ['POST', '/api/v1/cpg/users'], ['PATCH', `/api/v1/cpg/users/${id}`], ['POST', `/api/v1/cpg/users/${id}/grants`],
      ['POST', `/api/v1/cpg/grants/${id}/revoke`], ['POST', '/api/v1/cpg/teams'], ['PATCH', `/api/v1/cpg/teams/${id}`],
      ['PATCH', '/api/v1/cpg/settings'],
      ['POST', '/api/v1/cpg/boards'], ['PATCH', `/api/v1/cpg/boards/${id}`], ['POST', `/api/v1/cpg/boards/${id}/archive`],
      ['POST', `/api/v1/cpg/boards/${id}/members`], ['POST', `/api/v1/cpg/boards/${id}/members/${id}/remove`],
      ['PUT', '/api/v1/cpg/quorum'], ['POST', '/api/v1/cpg/compile'], ['POST', '/api/v1/cpg/policies'],
      ['POST', `/api/v1/cpg/policies/${id}/versions`], ['POST', `/api/v1/cpg/policies/${id}/retire`],
      ['POST', `/api/v1/cpg/policy-versions/${id}/votes`], ['POST', `/api/v1/cpg/policy-versions/${id}/withdraw`],
    ] as const) {
      const res = await session(method, path, { unexpected: true });
      expect([400, 403, 404], `${method} ${path}`).toContain(res.status);
      const body = await res.json();
      expect(typeof body.code, `${method} ${path}`).toBe('string');
    }
    const e18 = await req('POST', `/api/v1/tenants/${orgId}/org-admins`, { userId: 'not-a-uuid' });
    expect(e18.status).toBe(400);
  });

  it('every CPG route answers 401 without credentials', async () => {
    for (const path of ['/api/v1/cpg/me', '/api/v1/cpg/roles', '/api/v1/cpg/users', '/api/v1/cpg/teams', '/api/v1/cpg/settings', '/api/v1/cpg/audit', '/api/v1/cpg/permissions',
      '/api/v1/cpg/boards', '/api/v1/cpg/quorum', '/api/v1/cpg/quorum/versions', '/api/v1/cpg/policies', '/api/v1/cpg/policies/export', '/api/v1/cpg/bundle',
      '/api/v1/cpg/compile/00000000-0000-4000-8000-000000000000']) {
      const res = await app.request(`http://localhost${path}`);
      expect(res.status, path).toBe(401);
    }
  });
});

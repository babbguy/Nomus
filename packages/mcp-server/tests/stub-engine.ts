/**
 * In-process stub of the Nomus engine API for tests.
 *
 * A real node:http server on a loopback ephemeral port, so BOTH HTTP stacks
 * used by the MCP server hit it: the server's own fetch client and the
 * @nomus/scanner axios call inside runScanFromContents. No live network.
 */

import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | undefined;
}

export interface RouteOverride {
  status: number;
  body: unknown;
  /** Extra response headers, e.g. { 'retry-after': '1' }. */
  headers?: Record<string, string>;
  /** Apply this override only for the first N matching requests. */
  times?: number;
}

export interface StubEngine {
  url: string;
  requests: RecordedRequest[];
  /** Replace the canned response for a route ("METHOD /path", exact path, no query). */
  override(route: string, override: RouteOverride): void;
  close(): Promise<void>;
}

export const STUB_API_KEY = 'nk_test_stub_key_0123456789abcdef';

export const STUB_STATE_HASH = 'f'.repeat(64);

export function makeRuleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    sourceId: 'src-eu-ai-act',
    ruleKey: 'eu_ai_act.art52.transparency',
    version: 1,
    jurisdiction: 'EU',
    category: 'transparency',
    conditions: { action: 'text_generation' },
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary: 'AI systems that interact with natural persons must disclose that the user is interacting with an AI system.',
    legalReference: 'EU AI Act, Article 52(1)',
    effectiveDate: '2025-08-01T00:00:00.000Z',
    expiresAt: null,
    industries: ['all'],
    industryScope: 'global',
    industryNotes: '',
    isActive: true,
    signature: '3c4f9a2b1e8d7c6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

export function makeSimulateResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const rule = makeRuleRow();
  return {
    input: {},
    markets: {
      EU: {
        jurisdiction: 'EU',
        totalRules: 12,
        triggered: 1,
        riskLevel: 'high',
        rules: [
          {
            ruleKey: rule.ruleKey,
            effect: rule.effect,
            severity: rule.severity,
            humanSummary: rule.humanSummary,
            legalReference: rule.legalReference,
            matchedOn: ['capability: text_generation'],
          },
        ],
      },
    },
    conflicts: [],
    gapAnalysis: { allJurisdictionsCovered: true, uncoveredMarkets: [] },
    overallRisk: 'high',
    totalRulesTriggered: 1,
    _disclaimer: 'stub-disclaimer',
    ...overrides,
  };
}

interface StubFixtures {
  policies?: Array<Record<string, unknown>>;
  simulate?: Record<string, unknown>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function startStubEngine(fixtures: StubFixtures = {}): Promise<StubEngine> {
  const policies = fixtures.policies ?? [makeRuleRow()];
  const simulate = fixtures.simulate ?? makeSimulateResponse();
  const requests: RecordedRequest[] = [];
  const overrides = new Map<string, RouteOverride>();

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams.entries());
    const rawBody = await readBody(req);
    let body: unknown;
    try { body = rawBody ? JSON.parse(rawBody) : undefined; } catch { body = rawBody; }

    requests.push({
      method: req.method ?? 'GET',
      path,
      query,
      body,
      authorization: req.headers.authorization,
    });

    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };

    const routeKey = `${req.method} ${path}`;
    const override = overrides.get(routeKey);
    if (override) {
      if (override.times !== undefined) {
        override.times -= 1;
        if (override.times <= 0) overrides.delete(routeKey);
      }
      send(override.status, override.body, override.headers ?? {});
      return;
    }

    // Auth — mirrors the engine's bearer-key middleware.
    if (req.headers.authorization !== `Bearer ${STUB_API_KEY}`) {
      send(401, { error: 'Invalid or expired API key' });
      return;
    }

    if (req.method === 'POST' && path === '/api/v1/simulate') {
      send(200, simulate);
      return;
    }

    if (req.method === 'GET' && path === '/api/v1/policies/hash') {
      send(200, { stateHash: STUB_STATE_HASH, ruleCount: policies.length, computedAt: '2026-07-20T00:00:00.000Z' });
      return;
    }

    if (req.method === 'GET' && path === '/api/v1/policies/impact-map') {
      send(200, {
        matrix: [
          { industry: 'all', jurisdiction: 'EU', ruleCount: 12, maxSeverity: 'high', severityScore: 3, topRules: [] },
          { industry: 'all', jurisdiction: 'US-CA', ruleCount: 4, maxSeverity: 'medium', severityScore: 2, topRules: [] },
        ],
        industries: ['all'],
        jurisdictions: ['EU', 'US-CA'],
      });
      return;
    }

    if (req.method === 'GET' && path === '/api/v1/policies') {
      let rows = policies;
      if (query.jurisdiction) rows = rows.filter((r) => r.jurisdiction === query.jurisdiction);
      if (query.since) rows = rows.filter((r) => String(r.updatedAt) >= query.since);
      const limit = query.limit ? Number.parseInt(query.limit, 10) : 500;
      rows = rows.slice(0, limit);
      send(200, { count: rows.length, policies: rows, _disclaimer: 'stub-disclaimer' });
      return;
    }

    if (req.method === 'GET' && path.startsWith('/api/v1/policies/')) {
      const id = decodeURIComponent(path.slice('/api/v1/policies/'.length));
      const row = policies.find((r) => r.id === id);
      if (!row) {
        send(404, { error: 'Policy not found' });
        return;
      }
      send(200, { ...row, _disclaimer: 'stub-disclaimer' });
      return;
    }

    if (req.method === 'GET' && path === '/api/v1/templates') {
      send(200, {
        templates: [
          {
            id: 'eu-ai-act-full',
            name: 'EU AI Act — Full Coverage',
            description: 'Comprehensive EU AI Act compliance.',
            useCase: 'eu-compliance',
            jurisdictions: ['EU'],
            icon: 'Globe',
            ruleCount: 12,
          },
          {
            id: 'nist-rmf',
            name: 'NIST AI Risk Management',
            description: 'NIST AI RMF alignment.',
            useCase: 'nist-compliance',
            jurisdictions: ['NIST'],
            icon: 'BookOpen',
            ruleCount: 7,
          },
        ],
        _disclaimer: 'stub-disclaimer',
      });
      return;
    }

    if (req.method === 'GET' && path === '/api/v1/radar/v2/bills') {
      let bills = [
        { id: 'bill-1', jurisdiction: 'US-CA', billNumber: 'SB 1047', title: 'AI Safety Act', passageScore: 72, currentStage: 'committee' },
        { id: 'bill-2', jurisdiction: 'US-FED', billNumber: 'HR 2026', title: 'Federal AI Accountability Act', passageScore: 38, currentStage: 'introduced' },
      ];
      if (query.jurisdiction) bills = bills.filter((b) => b.jurisdiction === query.jurisdiction);
      if (query.minScore) bills = bills.filter((b) => b.passageScore >= Number.parseInt(query.minScore, 10));
      send(200, { bills, total: bills.length, page: 1, limit: 100, _disclaimer: 'stub-disclaimer' });
      return;
    }

    send(404, { error: `Stub engine has no route for ${routeKey}` });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    override(route, ov) {
      overrides.set(route, { ...ov });
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Reserve an ephemeral port and release it — yields a URL that is almost
 * certainly connection-refused, for fail-closed tests.
 */
export async function deadEngineUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return `http://127.0.0.1:${port}`;
}

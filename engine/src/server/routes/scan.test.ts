// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /api/v1/scan/findings as the GitHub Action and scanners use it.
 *
 * End-to-end audit regressions: every CI run re-uploaded the whole scan as
 * new rows (duplicates on the Scans page, a falling exposure score), a null
 * optional field (prNumber on a push build) rejected the entire upload, and
 * the exposure score kept serving a cached value that predated the upload.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { apiKeys, organizations, scanFindings } from '../../db/schema.js';
import type { AppEnv } from '../app.js';
import { scanRoutes } from './scan.js';
import { compliancePostureRoutes } from './compliance-posture.js';

const app = new Hono<AppEnv>();
app.route('/api/v1/scan', scanRoutes);
app.route('/api/v1/compliance', compliancePostureRoutes);

const KEY = 'nk_test_scan_upload_key_0000000000';
let orgId = '';

beforeAll(() => {
  runMigrations();
  orgId = randomUUID();
  const now = new Date().toISOString();
  const db = getDb();
  db.insert(organizations).values({
    id: orgId, name: 'Scan Upload Org', slug: `scan-${orgId.slice(0, 8)}`,
    jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now,
  }).run();
  db.insert(apiKeys).values({
    id: randomUUID(), orgId,
    keyHash: createHash('sha256').update(KEY).digest('hex'),
    keyPrefix: KEY.slice(0, 12), label: 'scan test',
    scopes: JSON.stringify(['evaluate', 'read:policies']), rateLimitRpm: 100000, isActive: true, createdAt: now,
  }).run();
});

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}

const finding = (over: Record<string, unknown> = {}) => ({
  file: 'app/chatbot.py', line: 16, ruleKey: 'eu_ai_act.art50.1.chatbot_disclosure',
  severity: 'high', effect: 'require_disclosure', sdk: 'openai', summary: 'Disclose AI interaction',
  ...over,
});

describe('POST /api/v1/scan/findings', () => {
  it('accepts null optional fields (push builds have no PR number)', async () => {
    const res = await call('POST', '/api/v1/scan/findings', {
      repo: 'acme/null-fields', commitSha: 'c1', prNumber: null,
      findings: [finding({ suggestion: null, detectorSource: null, legalReference: null, prNumber: null })],
    });
    expect(res.status).toBe(201);
    expect(res.json.created).toBe(1);
  });

  it('a rescan refreshes findings instead of duplicating them', async () => {
    const repo = 'acme/rescan';
    const first = await call('POST', '/api/v1/scan/findings', { repo, commitSha: 'aaa', findings: [finding(), finding({ ruleKey: 'hipaa.164_502.phi_in_ai_pipeline', severity: 'critical' })] });
    expect(first.json).toMatchObject({ created: 2, updated: 0 });

    const second = await call('POST', '/api/v1/scan/findings', { repo, commitSha: 'bbb', findings: [finding({ line: 18 }), finding({ ruleKey: 'hipaa.164_502.phi_in_ai_pipeline', severity: 'critical' })] });
    expect(second.json).toMatchObject({ created: 0, updated: 2 });

    const list = await call('GET', `/api/v1/scan/findings?repo=${encodeURIComponent(repo)}`);
    expect(list.json.count).toBe(2);
    const moved = list.json.findings.find((f: any) => f.ruleKey === 'eu_ai_act.art50.1.chatbot_disclosure');
    expect(moved.lineNumber).toBe(18);
    expect(moved.commitSha).toBe('bbb');
  });

  it('keeps a dismissed finding dismissed and reopens a resolved one', async () => {
    const repo = 'acme/status';
    await call('POST', '/api/v1/scan/findings', { repo, findings: [finding(), finding({ ruleKey: 'r.resolved' })] });
    const rows = getDb().select().from(scanFindings).where(eq(scanFindings.repo, repo)).all();
    const dismissed = rows.find((r) => r.ruleKey === 'eu_ai_act.art50.1.chatbot_disclosure')!;
    const resolved = rows.find((r) => r.ruleKey === 'r.resolved')!;
    expect((await call('PATCH', `/api/v1/scan/findings/${dismissed.id}`, { status: 'dismissed' })).status).toBe(200);
    expect((await call('PATCH', `/api/v1/scan/findings/${resolved.id}`, { status: 'resolved' })).status).toBe(200);

    await call('POST', '/api/v1/scan/findings', { repo, findings: [finding(), finding({ ruleKey: 'r.resolved' })] });
    const after = getDb().select().from(scanFindings).where(eq(scanFindings.repo, repo)).all();
    expect(after).toHaveLength(2);
    expect(after.find((r) => r.id === dismissed.id)!.status).toBe('dismissed');
    expect(after.find((r) => r.id === resolved.id)!.status).toBe('open');
  });

  it('the exposure score reflects an upload immediately (no stale cache)', async () => {
    const before = (await call('GET', '/api/v1/compliance/score')).json.overallScore as number;
    await call('POST', '/api/v1/scan/findings', { repo: 'acme/score', findings: [finding({ ruleKey: 'fresh.critical', severity: 'critical' })] });
    const after = (await call('GET', '/api/v1/compliance/score')).json.overallScore as number;
    expect(after).toBe(Math.max(0, before - 5));
  });
});

describe('GET /api/v1/admin/scans/summary', () => {
  it('counts every organization\'s findings, with the organization named', async () => {
    const { adminRoutes } = await import('./admin.js');
    const adminApp = new Hono<AppEnv>();
    adminApp.route('/api/v1/admin', adminRoutes);
    const ADMIN = 'nk_test_scan_admin_key_000000000000';
    const db = getDb();
    db.insert(apiKeys).values({
      id: randomUUID(), orgId: randomUUIDOrg(), keyHash: createHash('sha256').update(ADMIN).digest('hex'),
      keyPrefix: ADMIN.slice(0, 12), label: 'admin', scopes: JSON.stringify(['admin']), rateLimitRpm: 100000,
      isActive: true, createdAt: new Date().toISOString(),
    }).run();

    const res = await adminApp.request('/api/v1/admin/scans/summary', { headers: { Authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const own = db.select().from(scanFindings).all();
    expect(body.totals.totalFindings).toBe(own.length);
    expect(body.totals.openFindings).toBe(own.filter((f) => f.status === 'open').length);
    expect(body.totals.criticalOpen).toBe(own.filter((f) => f.status === 'open' && f.severity === 'critical').length);
    expect(body.repos.find((r: any) => r.repo === 'acme/rescan').orgName).toBe('Scan Upload Org');
  });
});

/** An organization for the admin key (any org: admin scope is platform-wide). */
function randomUUIDOrg(): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().insert(organizations).values({
    id, name: 'Admin Org', slug: `admin-${id.slice(0, 8)}`, jurisdictionAccess: '[]', isActive: true, createdAt: now, updatedAt: now,
  }).run();
  return id;
}

describe('GET /api/v1/scan/findings?status=all', () => {
  it('lists every status, while the default stays open-only', async () => {
    const all = await call('GET', `/api/v1/scan/findings?repo=${encodeURIComponent('acme/status')}&status=all`);
    const open = await call('GET', `/api/v1/scan/findings?repo=${encodeURIComponent('acme/status')}`);
    expect(all.json.findings.map((f: any) => f.status).sort()).toEqual(['dismissed', 'open']);
    expect(open.json.findings.every((f: any) => f.status === 'open')).toBe(true);
  });
});

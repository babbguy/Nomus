/**
 * CPG integrations (design spec §12, §16.7) on the real app and a real
 * database, with outbound HTTP captured by a stubbed fetch: configuration and
 * secret handling, the no-source-code sentinel across every event and
 * channel, Jira dedupe, retries, permanent failure and the outbox's atomicity.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { fingerprintOf, requestReviewResponseSchema } from '@nomus/scanner/corporate';
import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { rawSqlite } from '../../db/migrations/runner.js';
import { platformSettings } from '../../db/schema.js';
import { cpgNotificationDeliveries } from '../../db/schema-cpg.js';
import { seedDatabase } from '../../db/seed.js';
import { initSigningKeys } from '../../core/signing.js';
import { encryptForStorage } from '../../core/crypto.js';
import { createApp } from '../../server/app.js';
import { invalidateNotificationCache } from '../../services/notifications.js';
import { signPayloadV2 } from '../../services/webhook-dispatcher.js';
import { listAuditEventsByAction } from '../audit/log.js';
import { getCase } from '../cases/service.js';
import { sweepDecisions } from '../decisions/sweep.js';
import { caseFixtures } from '../__fixtures__/case-fixtures.js';
import { call, makeOrg, makeUser, type TestUser } from '../__fixtures__/rbac-fixtures.js';
import { notifyCase } from './outbox.js';
import { CPG_EVENTS } from './summary.js';
import { attemptDelivery, classify, nextAttemptAt, runDueDeliveries } from './worker.js';

const app = createApp();
const SENTINEL = `NOMUS-SENTINEL-${randomUUID()}`;
const REPO = 'gate.example.org/team/notify';
const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();
let orgId: string;
let owner: TestUser, dev: TestUser, ai: TestUser, legal: TestUser;
let aiBoard: string, legalBoard: string;

interface Sent { url: string; method: string; headers: Record<string, string>; body: string }
let sent: Sent[] = [];
let respond: (req: Sent) => { status: number; body?: unknown; headers?: Record<string, string> };
let jiraKeys = 0;
const defaultResponder = (req: Sent) => {
  if (req.url.includes('/search/jql')) return { status: 200, body: { issues: [] } };
  if (req.url.endsWith('/rest/api/3/issue')) return { status: 201, body: { id: '1', key: `GOV-${++jiraKeys}` } };
  return { status: 200, body: { id: randomUUID() } };
};

beforeEach(() => {
  sent = [];
  respond = defaultResponder;
  vi.stubGlobal('fetch', async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const req = { url, method: init.method, headers: init.headers, body: init.body ?? '' };
    sent.push(req);
    const r = respond(req);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  });
});

const post = (user: TestUser, path: string, body: unknown = {}) => call(app, 'POST', `/api/v1/cpg${path}`, { cookie: user.cookie, body });
const deliveries = () => getDb().select().from(cpgNotificationDeliveries).where(eq(cpgNotificationDeliveries.orgId, orgId)).all();
const finding = (key: string, filePath: string) => {
  const code = `client.call("${SENTINEL}"); // ${key}`;
  return { fingerprint: fingerprintOf(code, key, 1), policyKey: key, policyVersion: 1, filePath, startLine: 3, endLine: 3, language: 'typescript' as const, snippet: code };
};
const OPENAI = finding('corp.no-openai', `src/${SENTINEL}/a.ts`);
const PII = finding('corp.no-pii', 'src/pii.ts');

async function openCase(branch: string, findings = [OPENAI, PII]) {
  const res = await post(dev, '/cases/request-review', {
    repo: REPO, branch, headSha: null, bundleHash: 'b'.repeat(64), findings,
    justifications: findings.map((f) => ({ fingerprint: f.fingerprint, body: `Kept for now: ${SENTINEL}` })),
  });
  expect(res.status).toBe(201);
  return requestReviewResponseSchema.parse(res.json).case;
}

async function integration(body: Record<string, unknown>) {
  const res = await post(owner, '/integrations', { events: [...CPG_EVENTS], ...body });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json as { integration: { id: string; secretLast4: string | null }; secret?: string };
}

let webhookSecret: string;
beforeAll(async () => {
  runMigrations();
  initSigningKeys();
  await seedDatabase();
  orgId = makeOrg('Notify');
  [owner, dev, ai, legal] = [makeUser(orgId), makeUser(orgId), makeUser(orgId), makeUser(orgId)];
  const roles = (await call(app, 'GET', '/api/v1/cpg/roles', { cookie: owner.cookie })).json.items as Array<{ id: string; key: string }>;
  for (const u of [ai, legal]) expect((await post(owner, `/users/${u.id}/grants`, { roleId: roles.find((r) => r.key === 'case_reviewer')!.id, scopeType: 'org' })).status).toBe(201);
  const { insertBoard, insertPolicy } = caseFixtures(rawSqlite(getDb()));
  aiBoard = insertBoard(orgId, 'ai');
  legalBoard = insertBoard(orgId, 'legal');
  for (const [b, u] of [[aiBoard, ai], [legalBoard, legal]] as const) expect((await post(owner, `/boards/${b}/members`, { userId: u.id })).status).toBe(201);
  insertPolicy(orgId, 'corp.no-openai', 'prohibited', [aiBoard, legalBoard], { plainText: `Never call OpenAI directly. ${SENTINEL}` });
  insertPolicy(orgId, 'corp.no-pii', 'review-required', [legalBoard], { plainText: `No personal data in prompts. ${SENTINEL}` });
  expect((await call(app, 'PATCH', '/api/v1/cpg/settings', { cookie: owner.cookie, body: { enabled: true } })).status).toBe(200);
  getDb().insert(platformSettings).values({ key: 'notification.apiKeys.resend', value: encryptForStorage('re_test_key'), updatedAt: new Date().toISOString() })
    .onConflictDoNothing().run();
  invalidateNotificationCache();
});

describe('integration configuration', () => {
  it('secrets are encrypted, returned once (webhook) and never listed or audited; private targets are refused', async () => {
    await integration({ kind: 'email', name: 'Email', config: { extraRecipients: ['governance@gate.example.org'] } });
    const jira = await integration({ kind: 'jira', name: 'Jira', apiToken: 'jira-token-secret-1234', config: { baseUrl: 'https://jira.gate.example.org/', accountEmail: 'bot@gate.example.org', projectKey: 'GOV' } });
    const hook = await integration({ kind: 'webhook', name: 'Hook', config: { url: 'https://hooks.gate.example.org/nomus' } });
    webhookSecret = hook.secret!;
    expect(webhookSecret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect([jira.secret, jira.integration.secretLast4, hook.integration.secretLast4]).toEqual([undefined, '1234', webhookSecret.slice(-4)]);

    const list = await call(app, 'GET', '/api/v1/cpg/integrations', { cookie: owner.cookie });
    const audit = JSON.stringify(listAuditEventsByAction(getDb(), orgId, 'integration.created'));
    for (const text of [list.text, audit]) expect(text.includes('jira-token-secret') || text.includes(webhookSecret)).toBe(false);
    expect(list.json.items.map((i: { kind: string }) => i.kind)).toEqual(['email', 'jira', 'webhook']);
    expect(list.json.items[1].config.baseUrl).toBe('https://jira.gate.example.org');

    const local = await post(owner, '/integrations', { kind: 'webhook', name: 'Local', events: ['case.closed'], config: { url: 'https://127.0.0.1/hook' } });
    expect([local.status, local.json.code]).toEqual([400, 'invalid_input']);
    expect((await call(app, 'GET', '/api/v1/cpg/integrations', { cookie: dev.cookie })).status).toBe(403);

    const rotated = await post(owner, `/integrations/${hook.integration.id}/rotate-secret`);
    expect(rotated.json.secret).not.toBe(webhookSecret);
    webhookSecret = rotated.json.secret;
    expect(JSON.stringify(listAuditEventsByAction(getDb(), orgId, 'integration.secret_rotated'))).not.toContain(webhookSecret);
  });
});

describe('no source code in any notification (constraint 2)', () => {
  it(`every event on every channel: the sentinel is in no email, Jira body, webhook or stored payload`, async () => {
    const kase = await openCase('feat/sentinel');
    const aiLaneFp = [OPENAI.fingerprint];
    const asked = await post(ai, `/cases/${kase.id}/request-changes`, { boardId: aiBoard, body: `Use the gateway. ${SENTINEL}`, fingerprints: aiLaneFp });
    expect(asked.status).toBe(201);
    expect((await post(dev, `/cases/${kase.id}/comments`, { kind: 'reply', threadId: asked.json.id, resolves: true, body: `Done. ${SENTINEL}` })).status).toBe(201);
    expect((await post(dev, `/cases/${kase.id}/resubmit`)).status).toBe(200);
    const p = await post(legal, '/proposals', { caseId: kase.id, scope: 'snippet', outcome: 'approve', fingerprints: [PII.fingerprint], expiresAt: inDays(3), rationale: `Reviewed. ${SENTINEL}` });
    expect(p.json.status).toBe('finalized');
    sweepDecisions(getDb());
    sweepDecisions(getDb(), new Date(Date.now() + 4 * DAY));
    expect((await post(ai, `/cases/${kase.id}/close`, { reason: `Closing. ${SENTINEL}` })).status).toBe(200);
    for (const i of (await call(app, 'GET', '/api/v1/cpg/integrations', { cookie: owner.cookie })).json.items) {
      expect((await post(owner, `/integrations/${i.id}/test`)).json.status).toBe('delivered');
    }
    await runDueDeliveries();

    const rows = deliveries();
    expect(new Set(rows.map((r) => r.event))).toEqual(new Set(CPG_EVENTS));
    expect(rows.filter((r) => r.status !== 'delivered')).toEqual([]);
    // A mixed case splits per owning board: the AI lane and the Legal lane each get their own notification.
    expect(rows.filter((r) => r.event === 'case.review_requested' && r.channel === 'webhook').map((r) => r.boardId).sort()).toEqual([aiBoard, legalBoard, aiBoard, legalBoard].sort());
    expect(rows.find((r) => r.event === 'case.changes_requested' && r.channel === 'email')!.payload).toContain(dev.email);

    const log = await call(app, 'GET', '/api/v1/cpg/deliveries?limit=200', { cookie: owner.cookie });
    expect(log.json.items.length).toBe(rows.length);
    expect(log.json.items.find((d: { event: string }) => d.event === 'integration.test').payload.summary.link).toMatch(/\/governance\/integrations$/);
    const everything = [...sent.map((s) => `${s.url}\n${JSON.stringify(s.headers)}\n${s.body}`), ...rows.map((r) => r.payload), log.text];
    expect(sent.length).toBeGreaterThan(rows.length - 1);
    expect(everything.filter((t) => t.includes(SENTINEL))).toEqual([]);
    expect(everything.filter((t) => t.includes('src/'))).toEqual([]);

    // Jira: one issue per (case, board) plus the test issue; every later lane event is a comment.
    const creates = sent.filter((s) => s.method === 'POST' && s.url.endsWith('/rest/api/3/issue'));
    expect(creates.length).toBe(3);
    expect(sent.filter((s) => s.url.endsWith('/comment')).length).toBe(rows.filter((r) => r.channel === 'jira' && r.caseId).length - 2);
    expect(sent.find((s) => s.url.includes('jira'))!.headers.Authorization).toBe(`Basic ${Buffer.from('bot@gate.example.org:jira-token-secret-1234').toString('base64')}`);

    // Webhooks verify with the current secret over `timestamp.body`.
    const hooks = sent.filter((s) => s.url.startsWith('https://hooks.'));
    for (const h of hooks) expect(h.headers['X-Nomus-Signature']).toBe(`sha256=${signPayloadV2(h.headers['X-Nomus-Timestamp'], h.body, webhookSecret)}`);
    expect(hooks.every((h) => JSON.parse(h.body).deliveryId === h.headers['X-Nomus-Delivery-Id'])).toBe(true);
  });
});

describe('delivery, retries and failure', () => {
  it('a 503 is retried 10 s later with a fresh signature; a 400 fails at once, is audited and can be retried as a new delivery', async () => {
    const kase = await openCase('feat/retry', [PII]);
    const hook = () => deliveries().find((r) => r.caseId === kase.id && r.channel === 'webhook')!;
    respond = (req) => (req.url.startsWith('https://hooks.') ? { status: 503 } : defaultResponder(req));
    await runDueDeliveries();
    const first = hook();
    expect([first.status, first.attempts]).toEqual(['pending', 1]);
    expect(Date.parse(first.nextAttemptAt!) - Date.parse(first.updatedAt)).toBeGreaterThanOrEqual(9_900);

    respond = defaultResponder;
    await new Promise((r) => setTimeout(r, 5));
    expect((await attemptDelivery(getDb(), first)).status).toBe('delivered');
    const [a, b] = sent.filter((s) => s.url.startsWith('https://hooks.'));
    expect(a.headers['X-Nomus-Delivery-Id']).toBe(b.headers['X-Nomus-Delivery-Id']);
    expect(a.headers['X-Nomus-Timestamp']).not.toBe(b.headers['X-Nomus-Timestamp']);
    const log = (await call(app, 'GET', `/api/v1/cpg/deliveries?caseId=${kase.id}&status=delivered`, { cookie: owner.cookie })).json.items;
    expect(log.find((d: { channel: string }) => d.channel === 'webhook').attemptHistory.map((x: { httpStatus: number }) => x.httpStatus)).toEqual([503, 200]);

    respond = (req) => (req.url.startsWith('https://hooks.') ? { status: 400, body: { error: 'bad' } } : defaultResponder(req));
    await post(dev, `/cases/${kase.id}/comments`, { kind: 'reply', threadId: randomUUID(), body: 'x' }); // 404: no event
    await post(ai, `/cases/${kase.id}/close`, { reason: 'Done.' });
    await runDueDeliveries();
    const failed = deliveries().find((r) => r.caseId === kase.id && r.event === 'case.closed' && r.channel === 'webhook')!;
    expect([failed.status, failed.attempts]).toEqual(['failed', 1]);
    expect(listAuditEventsByAction(getDb(), orgId, 'delivery.failed').map((e) => e.targetId)).toContain(failed.id);
    respond = defaultResponder;
    const retry = await post(owner, `/deliveries/${failed.id}/retry`);
    expect([retry.status, retry.json.retryOf, (await post(owner, `/deliveries/${failed.id}/retry`)).status]).toEqual([201, failed.id, 201]);
    await runDueDeliveries();
    expect(deliveries().find((r) => r.id === retry.json.id)!.status).toBe('delivered');
    expect((await post(owner, `/deliveries/${retry.json.id}/retry`)).json.code).toBe('delivery_not_failed');
  });

  it('Jira: an issue created before a crash is found by its label and commented on, never created twice', async () => {
    const kase = await openCase('feat/jira-crash', [PII]);
    respond = (req) => (req.url.includes('/search/jql') ? { status: 200, body: { issues: [{ key: 'GOV-77' }] } } : defaultResponder(req));
    await runDueDeliveries();
    const jira = sent.filter((s) => s.url.includes('jira.'));
    expect(jira.map((s) => `${s.method} ${s.url.replace(/\?.*/, '')}`)).toEqual(['GET https://jira.gate.example.org/rest/api/3/search/jql', 'POST https://jira.gate.example.org/rest/api/3/issue/GOV-77/comment']);
    expect(decodeURIComponent(jira[0].url)).toContain(`labels = "nomus-${kase.ref.toLowerCase()}-${legalBoard.slice(0, 8)}"`);
  });

  it('the outbox is transactional: a rolled-back action leaves no delivery', () => {
    const before = deliveries().length;
    const c = getCase(getDb(), orgId, deliveries()[0].caseId!);
    expect(() => rawSqlite(getDb()).transaction(() => {
      notifyCase(getDb(), { ...c, state: 'in_review' }, 'case.review_requested');
      expect(deliveries().length).toBeGreaterThan(before);
      throw new Error('rolled back');
    })()).toThrow('rolled back');
    expect(deliveries().length).toBe(before);
  });

  it('classification and schedule', () => {
    const o = (httpStatus: number | null, error: string | null = 'x') => classify({ httpStatus, error, excerpt: null });
    expect([o(200, null), o(null), o(500), o(503), o(408), o(429), o(400), o(401), o(404), o(302)])
      .toEqual(['delivered', 'retry', 'retry', 'retry', 'retry', 'retry', 'failed', 'failed', 'failed', 'failed']);
    expect(classify({ httpStatus: null, error: 'no key', excerpt: null, permanent: true })).toBe('failed');
    const t = Date.UTC(2026, 9, 8);
    expect([1, 2, 7].map((n) => Date.parse(nextAttemptAt(n, t)) - t)).toEqual([10_000, 60_000, 43_200_000]);
    expect(Date.parse(nextAttemptAt(1, t, 7_200_000)) - t).toBe(3_600_000);
    // §12.3 test vector.
    expect(signPayloadV2('2026-10-08T12:00:00.000Z', '{"event":"case.opened"}', 'whsec_test_0123456789abcdef'))
      .toBe('ec3cfbb8f700616d43cc5930536aa63d8864e4de224a88f97519144da18911d1');
  });
});

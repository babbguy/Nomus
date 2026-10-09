// CPG Phase 7a: integrations, design spec §16.7 release-gate checks 1 to 6.
//
// Email (through the fake Resend API), Jira (the fake Jira) and a signed
// webhook (the notify sink) are configured for gate-policy; dev@ requests
// review on a new branch whose violating line and justification carry a
// unique sentinel. The gate then asserts what each fake received: the board
// members' emails, one Jira issue per lane, a webhook signature that
// verifies, a retry after a 503, a Jira comment (not a new issue) after a
// change request, and the sentinel nowhere at all. Nothing leaves 127.0.0.1.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/procs.mjs';
import { waitFor } from '../lib/http.mjs';
import { preparePolicyRepo } from './cpg-scanner.mjs';
import { uploads } from './cpg-cases.mjs';

const REPO = 'gate-org/policy-repo-notify';
const BRANCH = 'feat/notify';
const EVENTS = ['case.review_requested', 'case.changes_requested', 'case.replied', 'decision.recorded', 'case.closed', 'integration.test'];
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

export async function cpgIntegrationsChecks(ctx) {
  const { gate, repoRoot, outDir, notifySink, jira } = ctx;
  const { owner, users } = ctx.data.cpg;
  const sentinel = `NOMUS-SENTINEL-${crypto.randomUUID()}`;
  const work = path.join(outDir, 'work', 'cpg-integrations');
  fs.mkdirSync(work, { recursive: true });

  const enable = await owner.client.patch('/api/v1/cpg/settings', { enabled: true });
  const keyRes = await owner.client.post('/api/v1/org/api-keys', { label: 'cpg integrations gate', scopes: ['read:policies', 'evaluate'] });
  if (!gate.check('governance switched on for gate-policy and an org API key minted for the CLI', enable.status === 200 && typeof keyRes.json?.key === 'string',
    '200 and a key', `${enable.status} ${keyRes.status}`)) return;

  try {
    // ── 1. the Resend key, then email, Jira and webhook integrations ─────
    const resend = await ctx.data.admin.put('/api/v1/settings/notifications', { email: { enabled: 'false', recipients: [], resendApiKey: `re_gate_${crypto.randomBytes(8).toString('hex')}` } });
    const create = (body) => owner.client.post('/api/v1/cpg/integrations', { events: EVENTS, ...body });
    const email = await create({ kind: 'email', name: 'Governance email', config: {} });
    const issues = await create({ kind: 'jira', name: 'Jira GOV', apiToken: jira.token, config: { baseUrl: jira.url, accountEmail: jira.email, projectKey: 'GOV' } });
    const hook = await create({ kind: 'webhook', name: 'Governance webhook', config: { url: `${notifySink.url}/hooks/cpg` } });
    const secret = hook.json?.secret;
    const listed = await owner.client.get('/api/v1/cpg/integrations');
    const listedText = JSON.stringify(listed.json);
    gate.check('platform admin sets the Resend key; Org Admin creates email, Jira and webhook integrations; the webhook secret is returned once',
      resend.status === 200 && email.status === 201 && issues.status === 201 && hook.status === 201 && /^whsec_/.test(secret ?? '') && issues.json?.secret === undefined,
      '200, 201 × 3, whsec_ secret on the webhook only', `${resend.status} ${email.status} ${issues.status} ${hook.status} ${String(secret).slice(0, 6)}`);
    gate.check('GET /cpg/integrations shows only secretLast4: never the Jira token or the webhook secret',
      listed.status === 200 && JSON.stringify((listed.json?.items ?? []).map((i) => i.secretLast4)) === JSON.stringify([null, jira.token.slice(-4), secret?.slice(-4)])
        && !listedText.includes(jira.token) && !listedText.includes(secret),
      '[null, last4, last4], no secret', `${listed.status} ${JSON.stringify((listed.json?.items ?? []).map((i) => i.secretLast4))}`);

    // ── 2. request review with the sentinel in the code and the justification ──
    const repo = preparePolicyRepo(ctx, path.join(work, 'policy-repo'));
    fs.appendFileSync(path.join(repo, 'src', 'models.ts'), `export const NOTIFY_MODEL = 'gpt-4-32k'; // ${sentinel}\n`);
    const cli = path.join(repoRoot, 'packages', 'scanner', 'dist', 'index.js');
    const scanned = parse((await run(process.execPath, [cli, '.', '--json'], { cwd: repo, env: { NOMUS_API_KEY: keyRes.json.key }, timeout: 120_000 })).stdout);
    const findings = scanned?.corporateFindings ?? [];
    const findingsUp = uploads(repo, findings);
    notifySink.failFirst(1, 503, '/hooks/');
    const t0 = Date.now();
    const requested = await users.dev.client.post('/api/v1/cpg/cases/request-review', {
      repo: REPO, branch: BRANCH, headSha: null, bundleHash: scanned?.corporate?.bundleHash, findings: findingsUp,
      justifications: findings.filter((f) => f.blocking).map((f) => ({ fingerprint: f.fingerprint, body: `Needed until the gateway ships (${sentinel}).` })),
    });
    const kase = requested.json?.case;
    gate.check('dev@ requests review on a new branch; the snippet sent and the justification carry the sentinel',
      requested.status === 201 && findingsUp.some((f) => f.snippet.includes(sentinel)) && (kase?.lanes ?? []).length === 2,
      '201, 2 lanes, sentinel in a snippet', `${requested.status} lanes ${(kase?.lanes ?? []).length} sentinel ${findingsUp.some((f) => f.snippet.includes(sentinel))}`);

    const emails = () => notifySink.received.filter((r) => r.path === '/resend/emails').map((r) => parse(r.body));
    const hooks = () => notifySink.received.filter((r) => r.path === '/hooks/cpg');
    const reviewers = [users['ai-reviewer'].email, users['legal-reviewer'].email];
    const arrived = await waitFor(() => jira.issues.length >= 2 && reviewers.every((e) => emails().some((m) => m?.to?.includes(e)))
      && hooks().some((h) => h.answered === 200), { timeout: 30_000 });
    gate.check('within 30 s: fake Resend received the review emails for the AI and Legal board members',
      !!arrived && reviewers.every((e) => emails().some((m) => m.to.includes(e) && m.subject.includes(kase.ref))), reviewers, emails().map((m) => m?.to));
    gate.check('fake Jira received exactly 2 issues (one per lane), with Basic auth, summary and link only',
      jira.issues.length === 2 && jira.requests.every((r) => r.authorized) && jira.issues.every((i) => JSON.stringify(i.fields.description).includes(`/governance/cases/${kase?.id}`)),
      '2 issues, all authorized', `${jira.issues.length} issues ${jira.requests.filter((r) => !r.authorized).length} unauthorized`);
    const delivered = hooks().find((h) => h.answered === 200);
    const ts = delivered?.headers['x-nomus-timestamp'];
    const expectedSig = delivered && `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${delivered.body}`).digest('hex')}`;
    gate.check('the webhook X-Nomus-Signature verifies with the returned secret over timestamp.body, the timestamp is within 300 s',
      !!delivered && delivered.headers['x-nomus-signature'] === expectedSig && Math.abs(Date.now() - Date.parse(ts)) < 300_000
        && delivered.headers['x-nomus-delivery-id'] === parse(delivered.body)?.deliveryId && delivered.headers['x-nomus-event'] === 'case.review_requested',
      'signature, fresh timestamp, delivery id, event', delivered ? { sig: delivered.headers['x-nomus-signature']?.slice(0, 20), ts } : 'no webhook delivered');

    // ── 3. the 503 is retried and delivered on attempt 2 ─────────────────
    const deliveriesOf = async (q) => (await owner.client.get(`/api/v1/cpg/deliveries?caseId=${kase?.id}${q}`)).json?.items ?? [];
    const retried = await waitFor(async () => (await deliveriesOf('&status=delivered')).find((d) => d.channel === 'webhook' && d.attempts === 2), { timeout: 45_000 });
    gate.check('the sink failed the first webhook with 503: GET /cpg/deliveries shows it delivered on attempt 2 (503, then 200)',
      JSON.stringify(retried?.attemptHistory?.map((a) => a.httpStatus)) === '[503,200]' && hooks()[0]?.answered === 503,
      '[503, 200], delivered', `${JSON.stringify(retried?.attemptHistory?.map((a) => a.httpStatus))} after ${Math.round((Date.now() - t0) / 1000)} s`);

    // ── 4. request changes → a comment on the AI lane issue, an email to dev@ ──
    const aiLane = kase?.lanes?.find((l) => l.boardName === 'AI Review Board');
    const aiFingerprint = findings.find((f) => f.policyKey === 'corp.no-direct-openai')?.fingerprint;
    const asked = await users['ai-reviewer'].client.post(`/api/v1/cpg/cases/${kase?.id}/request-changes`, { boardId: aiLane?.boardId, body: `Use the gateway (${sentinel}).`, fingerprints: [aiFingerprint] });
    const aiIssue = jira.issues.find((i) => i.fields.labels.some((l) => l.endsWith(aiLane?.boardId?.slice(0, 8))));
    const commented = await waitFor(() => aiIssue?.comments.length >= 1 && emails().some((m) => m.to.includes(users.dev.email)), { timeout: 30_000 });
    gate.check('ai-reviewer@ requests changes: a Jira comment on the AI lane issue (still 2 issues) and an email to dev@',
      asked.status === 201 && !!commented && jira.issues.length === 2 && jira.issues.filter((i) => i !== aiIssue).every((i) => i.comments.length === 0),
      '201, 1 comment on the AI issue, 2 issues, dev@ emailed', `${asked.status} comments ${aiIssue?.comments.length} issues ${jira.issues.length}`);

    // ── 6. a test delivery is delivered synchronously ───────────────────
    const test = await owner.client.post(`/api/v1/cpg/integrations/${hook.json?.integration?.id}/test`, {});
    gate.check('POST /cpg/integrations/:id/test (webhook): 201 delivered, and the sink received the integration.test event',
      test.status === 201 && test.json?.status === 'delivered' && hooks().some((h) => h.headers['x-nomus-event'] === 'integration.test'),
      '201 delivered', `${test.status} ${test.json?.status}`);

    // ── 5. the sentinel is nowhere ───────────────────────────────────────
    const log = await owner.client.get('/api/v1/cpg/deliveries?limit=200');
    const captured = [
      ...notifySink.received.map((r) => `${JSON.stringify(r.headers)}\n${r.body}`),
      ...jira.requests.map((r) => `${r.query}\n${r.body}`),
      JSON.stringify(log.json),
    ];
    const leaks = captured.filter((t) => t.includes(sentinel)).length;
    gate.check('the sentinel is absent from every body fake Resend, fake Jira and the sink received, and from GET /cpg/deliveries',
      leaks === 0 && emails().length >= 3 && jira.requests.length >= 4 && hooks().length >= 3 && (log.json?.items ?? []).length >= 6,
      '0 of all captured bodies', `${leaks} leaks in ${captured.length} bodies (${emails().length} emails, ${jira.requests.length} Jira, ${hooks().length} webhooks, ${(log.json?.items ?? []).length} deliveries)`);
  } finally {
    const restore = await owner.client.patch('/api/v1/cpg/settings', { enabled: false });
    gate.check('governance switched off again', restore.status === 200 && restore.json?.enabled === false, '200 enabled false', `${restore.status} ${restore.json?.enabled}`);
    if (keyRes.json?.id) await owner.client.del(`/api/v1/org/api-keys/${keyRes.json.id}`);
  }
}

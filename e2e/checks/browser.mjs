// 9. Browser sweep (Playwright + Chromium) over every member and admin
// route of the production dashboard build. A page fails on a console error,
// an uncaught page error, a failed API call that is not on the allow-list,
// broken values on screen (NaN, undefined, [object Object], Invalid Date,
// negative relative times) or an empty table/tile where the gate's data
// means there must be content. The same number shown on different pages
// must agree. A full-page screenshot of every page is saved.

import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/browser.mjs';
import { crossChecks } from './browser-crosschecks.mjs';

/**
 * Failed requests that are expected. Each entry: [method, path regex, status
 * (number, or 'aborted' for a cancelled request), reason].
 */
const ALLOWED_FAILURES = [
  // The dashboard asks who is signed in before login; 401 is the answer.
  ['GET', /^\/api\/v1\/auth\/me$/, 401, 'session probe before sign-in'],
  // Leaving a page closes its live-update stream; Chromium reports the
  // cancelled long-lived request as aborted.
  ['GET', /^\/api\/v1\/stream/, 'aborted', 'SSE stream closed on navigation'],
];

const BROKEN_TEXT = [
  [/\bNaN\b/, 'NaN'],
  [/\bundefined\b/, 'undefined'],
  [/\[object Object\]/, '[object Object]'],
  [/Invalid Date/, 'Invalid Date'],
  [/(^|[\s(])-\d+\s*(s|sec|secs|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\s+ago\b/i, 'negative relative time'],
  [/\bin -\d+\s*(s|m|h|d|seconds?|minutes?|hours?|days?)\b/i, 'negative relative time'],
];

export async function browserChecks(ctx) {
  const { gate, webUrl, shotsDir, outDir } = ctx;
  const pagesDir = path.join(outDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });
  const d = ctx.data;
  const repoParam = encodeURIComponent(d.action?.repo ?? 'gate-org/sample-repo');
  const ilSource = (d.sources ?? []).find((s) => /820 ILCS 42/.test(s.name));
  const firstAttestation = (await d.orgKey.get('/api/v1/attestations?limit=1')).json?.attestations?.[0]?.id;

  // route -> expectations. `must`: text that has to be on the page (the gate
  // created that data); `notEmpty`: phrases that mean an empty state.
  const memberRoutes = [
    ['/dashboard', { must: ['Active Policies', 'Attestations'] }],
    ['/policies', { must: ['eu_ai_act.art50.1.chatbot_disclosure'] }],
    ['/attestations', { must: ['ai_user_interaction'] }],
    ['/simulator', {}],
    ['/radar', { must: ['general-purpose AI'] }],
    ['/radar/v2', {}],
    ['/graph', {}],
    ['/ai-bom', { must: ['OpenAI', 'Anthropic'] }],
    ['/compliance', {}],
    ['/templates', {}],
    ['/simulations', { must: ['general-purpose AI'] }],
    ['/scans', { must: ['gate-org/sample-repo'] }],
    [`/scans/${repoParam}`, { must: ['app/chatbot.py'] }],
    ['/clause-map', {}],
    ['/benchmarks', { must: ['gpt-4o-mini'] }],
    ['/feedback', {}],
    ['/audit-log', {}],
    ['/badge', {}],
    ['/settings', { must: ['release gate'] }],
    ['/profile', { must: [d.memberEmail] }],
    ['/team', { must: [d.memberEmail] }],
  ];
  const adminRoutes = [
    ['/admin/dashboard', {}],
    ['/admin/users', { must: [d.memberEmail] }],
    ['/admin/tenants', { must: [ctx.expected.org.name] }],
    [`/admin/tenants/${d.orgId}`, { must: [ctx.expected.org.name, 'release gate'] }],
    ['/admin/sources', { must: ['820 ILCS 42'] }],
    ...(ilSource ? [[`/admin/sources/${ilSource.id}`, { must: ['820 ILCS 42'] }], [`/admin/sources/${ilSource.id}/rules`, { must: ['us_il.'] }], [`/admin/diffs/${ilSource.id}`, {}]] : []),
    ['/admin/rules', { must: ['eu_ai_act.'] }],
    ['/admin/pipeline', { must: ['820 ILCS 42'] }],
    ['/admin/integrity', {}],
    ['/admin/feedback', {}],
    ['/admin/radar', { must: ['general-purpose AI'] }],
    ['/admin/ontology', {}],
    ['/admin/scans', { must: ['gate-org/sample-repo'] }],
    ['/admin/scout/feeds', {}],
    ['/admin/scout/review', {}],
    ['/admin/llm', {}],
    ['/admin/notifications', {}],
    ['/admin/system', {}],
    ['/admin/modus', {}],
  ];
  const publicRoutes = [
    ['/transparency', {}],
    ['/ledger', {}],
    ...(firstAttestation ? [[`/verify/${firstAttestation}`, { must: [firstAttestation.slice(0, 8)] }]] : []),
  ];

  const browser = await launchBrowser();
  const texts = {};
  const browser5xx = [];
  try {
    for (const [who, email, password, routes] of [
      ['member', d.memberEmail, d.memberPassword, memberRoutes],
      ['admin', ctx.secrets.adminEmail, ctx.secrets.adminPassword, adminRoutes],
      ['public', null, null, publicRoutes],
    ]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      let current = '(login)';
      const issues = [];
      // In-flight API requests, not counting the long-lived SSE stream
      // (Playwright's "networkidle" never fires while a stream is open).
      const inflight = new Set();
      const track = (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/') && !u.pathname.startsWith('/api/v1/stream')) inflight.add(r); };
      const untrack = (r) => inflight.delete(r);
      page.on('request', track);
      page.on('requestfinished', untrack);
      page.on('requestfailed', untrack);
      page.inflight = inflight;
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const t = m.text();
        // Chromium also logs every failed request as a console error; those
        // are judged by the request rules below (allow-list included).
        if (/^Failed to load resource: the server responded with a status of \d+/.test(t)) return;
        issues.push([current, `console error: ${t.slice(0, 200)}`]);
      });
      page.on('pageerror', (e) => issues.push([current, `page error: ${e.message.slice(0, 200)}`]));
      page.on('response', (r) => {
        const u = new URL(r.url());
        if (!u.pathname.startsWith('/api/') || r.status() < 400) return;
        if (r.status() >= 500) browser5xx.push(`${current}: ${r.request().method()} ${u.pathname} ${r.status()}`);
        if (allowed(r.request().method(), u.pathname, r.status(), current)) return;
        issues.push([current, `HTTP ${r.status()} ${r.request().method()} ${u.pathname}${u.search}`]);
      });
      page.on('requestfailed', (r) => {
        const u = new URL(r.url());
        if (!u.pathname.startsWith('/api/')) return;
        if (allowed(r.method(), u.pathname, 'aborted', current)) return;
        issues.push([current, `request failed: ${r.method()} ${u.pathname} ${r.failure()?.errorText}`]);
      });

      if (email) {
        await page.goto(`${webUrl}/login`);
        await page.fill('input[type="email"]', email);
        await page.fill('input[type="password"]', password);
        await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 }).catch(() => {}), page.click('button[type="submit"]')]);
        const landed = new URL(page.url()).pathname;
        gate.check(`${who} signs in through the login page`, landed === (who === 'admin' ? '/admin/dashboard' : '/dashboard'), who === 'admin' ? '/admin/dashboard' : '/dashboard', landed);
        const loginIssues = issues.filter(([r]) => r === '(login)');
        gate.check(`${who} sign-in: no console errors or failed calls`, loginIssues.length === 0, 'none', loginIssues.map(([, m]) => m).slice(0, 3));
      }

      for (const [route, exp] of routes) {
        current = route;
        const before = issues.length;
        await page.goto(`${webUrl}${route}`);
        await settle(page);
        // Visible text plus the values of form fields (an email shown in an input is not innerText).
        const text = await page.evaluate(() => {
          const fields = [...document.querySelectorAll('input:not([type=password]):not([type=hidden]), textarea')]
            .map((el) => el.value).filter(Boolean);
          return [document.body.innerText, ...fields].join('\n');
        }).catch(() => '');
        texts[`${who}:${route}`] = text;
        const file = `${who}${route.replace(/[^a-zA-Z0-9]+/g, '_')}`.replace(/_+$/, '');
        fs.writeFileSync(path.join(pagesDir, `${file}.txt`), text);
        await page.screenshot({ path: path.join(shotsDir, `${file}.png`), fullPage: true }).catch(() => {});
        const problems = issues.slice(before).map(([, m]) => m);
        const landed = new URL(page.url()).pathname;
        if (decodeURIComponent(landed) !== decodeURIComponent(route)) problems.push(`redirected to ${landed}`);
        if (/something went wrong|unexpected application error|page not found|404 not found/i.test(text)) problems.push('error or not-found screen');
        for (const [re, what] of BROKEN_TEXT) {
          const m = re.exec(text);
          if (m) problems.push(`shows "${what}": …${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}…`);
        }
        for (const must of exp.must ?? []) if (must && !text.includes(must)) problems.push(`missing "${must}" (the gate created it)`);
        gate.check(`${who} ${route}`, problems.length === 0, 'renders cleanly with its data', problems.slice(0, 4));
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  d.browser5xx = browser5xx;
  fs.writeFileSync(path.join(outDir, 'page-texts.json'), JSON.stringify(texts, null, 1));

  await crossChecks(ctx, texts);

  // Every page that streamed live updates has been closed.
  const count = (await d.adminKey.get('/api/v1/dashboard/connected-clients')).json?.count;
  gate.equal('after the sweep no SSE connection is left open', count, 0);
}

function allowed(method, pathname, status, route) {
  return ALLOWED_FAILURES.some(([m, re, s]) => m === method && re.test(pathname) && s === status
    && (pathname !== '/api/v1/auth/me' || route === '(login)' || route.startsWith('/transparency') || route.startsWith('/ledger') || route.startsWith('/verify')));
}

async function settle(page) {
  await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
  // Quiet: no API request in flight for 500 ms (max 15 s).
  const until = Date.now() + 15_000;
  let quietSince = Date.now();
  while (Date.now() < until) {
    if (page.inflight.size > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= 500) break;
    await page.waitForTimeout(50);
  }
  // Loading spinners/skeletons gone (best effort), then a short pause for charts.
  await page.waitForFunction(() => !document.querySelector('.animate-spin, .animate-pulse'), null, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

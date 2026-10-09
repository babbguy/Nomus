// CPG Phase 1b: the governance dashboard pages in a real browser (design spec
// §16.1 check 10), against the production dashboard build and the gate-policy
// org that cpg-setup.mjs and cpg-rbac.mjs prepared.
//
// Each user's existing session (from cpg-setup) is put into a fresh browser
// context, so this area adds no sign-ins (the engine allows 10 per minute per
// address). A page fails on a console error, an uncaught page error, any 4xx
// or 5xx API answer, broken values on screen (NaN, undefined, [object Object],
// Invalid Date) or missing text the gate's data guarantees. A full-page
// screenshot of every page is saved as cpg-<user>_<route>.png.
//
// It runs after cpg-rbac and cpg-policy (area order) and reads what they
// created; to debug it alone use --only=cpg-rbac,cpg-policy,cpg-browser.
//
// The Org Admin also drives the Access page's write workflows through the UI
// (custom role, team, team- and repository-scoped grants), and the API then
// confirms what the UI did.
//
// Phase 2b (design spec §16.2 check 11) adds the policy registry pages: the
// policy log, a policy's detail and authoring (a rejected compile, a compiled
// rule, a proposal its author cannot approve, an approval by the approver),
// all through the UI, and the sidebar's governance role label.

import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/browser.mjs';

const BROKEN_TEXT = [
  [/\bNaN\b/, 'NaN'],
  [/\bundefined\b/, 'undefined'],
  [/\[object Object\]/, '[object Object]'],
  [/Invalid Date/, 'Invalid Date'],
];

// Failed requests that are expected: a page that is left closes its live-update stream.
const allowedFailure = (method, pathname, status) => method === 'GET' && /^\/api\/v1\/stream/.test(pathname) && status === 'aborted';

/** A browser page signed in with an existing session cookie, recording every problem per route. */
async function openAs(browser, ctx, client) {
  const { webUrl } = ctx;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const [name, ...rest] = (client.cookie ?? '').split('=');
  await context.addCookies([{ name, value: rest.join('='), url: webUrl }]);
  const page = await context.newPage();
  const state = { current: '(start)', issues: [], inflight: new Set() };
  const track = (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/') && !u.pathname.startsWith('/api/v1/stream')) state.inflight.add(r); };
  const untrack = (r) => state.inflight.delete(r);
  page.on('request', track);
  page.on('requestfinished', untrack);
  page.on('requestfailed', untrack);
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Failed requests are judged by the response rule below.
    if (/^Failed to load resource: the server responded with a status of \d+/.test(t)) return;
    state.issues.push([state.current, `console error: ${t.slice(0, 200)}`]);
  });
  page.on('pageerror', (e) => state.issues.push([state.current, `page error: ${e.message.slice(0, 200)}`]));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/') || r.status() < 400) return;
    state.issues.push([state.current, `HTTP ${r.status()} ${r.request().method()} ${u.pathname}${u.search}`]);
  });
  page.on('requestfailed', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/') || allowedFailure(r.method(), u.pathname, 'aborted')) return;
    state.issues.push([state.current, `request failed: ${r.method()} ${u.pathname} ${r.failure()?.errorText}`]);
  });
  return { context, page, state };
}

async function settle(page, state) {
  await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
  const until = Date.now() + 15_000;
  let quietSince = Date.now();
  while (Date.now() < until) {
    if (state.inflight.size > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= 500) break;
    await page.waitForTimeout(50);
  }
  await page.waitForFunction(() => !document.querySelector('.animate-spin, .animate-pulse'), null, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function pageText(page) {
  return page.evaluate(() => {
    const fields = [...document.querySelectorAll('input:not([type=password]):not([type=hidden]), textarea')].map((el) => el.value).filter(Boolean);
    return [document.body.innerText, ...fields].join('\n');
  }).catch(() => '');
}

/**
 * Visit a route and judge it. `expectLanding` is where the browser must end up
 * (default: the route itself); `must` / `mustNot` are texts that must (not) be shown.
 */
async function visit(ctx, s, who, route, { must = [], mustNot = [], expectLanding = route } = {}) {
  const { webUrl, shotsDir } = ctx;
  s.state.current = route;
  const before = s.state.issues.length;
  await s.page.goto(`${webUrl}${route}`);
  await settle(s.page, s.state);
  const text = await pageText(s.page);
  const file = `cpg-${who}${route.replace(/[^a-zA-Z0-9]+/g, '_')}`.replace(/_+$/, '');
  fs.writeFileSync(path.join(ctx.outDir, 'pages', `${file}.txt`), text);
  await s.page.screenshot({ path: path.join(shotsDir, `${file}.png`), fullPage: true }).catch(() => {});
  const problems = s.state.issues.slice(before).map(([, m]) => m);
  const landed = new URL(s.page.url()).pathname;
  if (landed !== expectLanding) problems.push(`landed on ${landed}`);
  if (/something went wrong|unexpected application error|page not found|404 not found|Unexpected response from/i.test(text)) problems.push('error or not-found screen');
  for (const [re, what] of BROKEN_TEXT) {
    const m = re.exec(text);
    if (m) problems.push(`shows "${what}": …${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}…`);
  }
  for (const t of must) if (!text.includes(t)) problems.push(`missing "${t}"`);
  for (const t of mustNot) if (text.includes(t)) problems.push(`shows "${t}"`);
  return { problems, text };
}

/** Run a UI step; record failures (with the page's errors) instead of throwing. */
async function uiStep(s, label, fn) {
  const before = s.state.issues.length;
  try {
    await fn();
    await settle(s.page, s.state);
  } catch (err) {
    s.state.issues.push([label, `step failed: ${String(err?.message ?? err).split('\n')[0].slice(0, 200)}`]);
  }
  return s.state.issues.slice(before).map(([, m]) => m);
}

export async function cpgBrowserChecks(ctx) {
  const { gate, expected } = ctx;
  const { owner, users } = ctx.data.cpg;
  fs.mkdirSync(path.join(ctx.outDir, 'pages'), { recursive: true });
  const emails = Object.values(expected.cpg.users).map((u) => u.email);
  const browser = await launchBrowser();
  try {
    // ── Org Admin: the four pages ───────────────────────────────────────
    const admin = await openAs(browser, ctx, owner.client);
    const overview = await visit(ctx, admin, 'owner', '/governance', { must: ['Corporate policy governance is off', owner.email, 'rbac.users.manage'] });
    gate.check('Org Admin /governance renders cleanly (status, own permissions)', overview.problems.length === 0, 'no 4xx, no console errors, data shown', overview.problems.slice(0, 4));
    const nav = await admin.page.$$eval('nav a', (as) => as.map((a) => a.getAttribute('href')));
    gate.equal('Org Admin sidebar lists the four governance pages', ['/governance', '/governance/access', '/governance/audit', '/governance/settings'].filter((h) => nav.includes(h)).length, 4);

    const access = await visit(ctx, admin, 'owner', '/governance/access', { must: [expected.cpg.users.dev.email, ...emails, 'Policy Author', 'Auditor'] });
    gate.check(`Org Admin /governance/access renders cleanly and lists ${expected.cpg.users.dev.email} and the other governance users`, access.problems.length === 0,
      'no 4xx, no console errors, every gate-policy user shown', access.problems.slice(0, 4));
    const roles = await visit(ctx, admin, 'owner', '/governance/access?tab=roles', { must: ['org.api_keys.manage', 'Exception Approver'], expectLanding: '/governance/access' });
    gate.check('Org Admin Access > Roles shows the permission matrix', roles.problems.length === 0, 'matrix with every system role', roles.problems.slice(0, 4));

    const settings = await visit(ctx, admin, 'owner', '/governance/settings', {
      must: ['snippets of flagged code are sent to the LLM provider', 'An LLM provider is configured on this instance', 'Turn on'],
    });
    gate.check('Org Admin /governance/settings renders cleanly with the reviewer-context disclosure (D1)', settings.problems.length === 0,
      'no 4xx, disclosure and provider status shown', settings.problems.slice(0, 4));
    const llmSwitch = await admin.page.getAttribute('[role="switch"]', 'aria-checked').catch(() => null);
    const apiSettings = await owner.client.get('/api/v1/cpg/settings');
    gate.equal('the reviewer-context switch shows the stored setting (on by default with a provider configured)',
      [llmSwitch, apiSettings.json?.reviewerContextLlm, apiSettings.json?.llmProviderConfigured], ['true', true, true]);

    const audit = await visit(ctx, admin, 'owner', '/governance/audit', { must: ['Chain verified', 'grant.created', 'role.permissions_changed', expected.cpg.users.dev.email] });
    gate.check('Org Admin /governance/audit renders cleanly: events, chain verified, actors resolved', audit.problems.length === 0, 'no 4xx, chain verified', audit.problems.slice(0, 4));

    // ── Org Admin: Access write workflows through the UI ────────────────
    const p = admin.page;
    const ui = { roleName: 'Gate Repo Reviewer', roleKey: 'gate_repo_reviewer', teamName: 'Gate UI Team', teamKey: 'gate-ui', pattern: 'gate-org/ui-*', repo: 'gate-org/ui-repo' };
    const steps = [];
    await visit(ctx, admin, 'owner', '/governance/access?tab=roles', { expectLanding: '/governance/access' });
    steps.push(...await uiStep(admin, 'create role', async () => {
      await p.click('button:has-text("New role")');
      await p.fill('#role-key', ui.roleKey);
      await p.fill('#role-name', ui.roleName);
      await p.check('label:has(span.font-mono:text-is("case.read")) input[type=checkbox]');
      await p.check('label:has(span.font-mono:text-is("case.comment")) input[type=checkbox]');
      await p.click('button[type=submit]:has-text("Create role")');
      await p.waitForSelector(`text=Role ${ui.roleName} created.`, { timeout: 10_000 });
    }));
    await visit(ctx, admin, 'owner', '/governance/access?tab=teams', { expectLanding: '/governance/access' });
    steps.push(...await uiStep(admin, 'create team', async () => {
      await p.click('button:has-text("New team")');
      await p.fill('#team-key', ui.teamKey);
      await p.fill('#team-name', ui.teamName);
      await p.fill('#team-patterns', ui.pattern);
      await p.click('button[type=submit]:has-text("Create team")');
      await p.waitForSelector(`text=Team ${ui.teamName} created.`, { timeout: 10_000 });
    }));
    await visit(ctx, admin, 'owner', '/governance/access', {});
    const grantVia = async (scope) => {
      const row = p.locator('tr', { hasText: expected.cpg.users.dev.email });
      await row.locator('button:has-text("Grant role")').click();
      await p.selectOption('#grant-role', { label: ui.roleName });
      await p.check(`label:has-text("${scope === 'team' ? 'One team' : 'One repository'}") input[type=radio]`);
      if (scope === 'team') await p.selectOption('#grant-team', { label: `${ui.teamName} (${ui.pattern})` });
      else await p.fill('#grant-repo', ui.repo);
      await p.click('button[type=submit]:has-text("Grant role")');
      await p.waitForSelector(`text=Granted ${ui.roleName}`, { timeout: 10_000 });
    };
    steps.push(...await uiStep(admin, 'grant team-scoped role', () => grantVia('team')));
    steps.push(...await uiStep(admin, 'grant repo-scoped role', () => grantVia('repo')));
    const afterGrants = await visit(ctx, admin, 'owner', '/governance/access', { must: [`Team ${ui.teamName}`, `Repository ${ui.repo}`] });
    steps.push(...afterGrants.problems);
    gate.check('Org Admin creates a custom role and a team, then grants the role to dev@ per team and per repository, through the Access page',
      steps.length === 0, 'every step succeeds with no 4xx; the grants show their scope', steps.slice(0, 4));

    const apiUsers = await owner.client.get('/api/v1/cpg/users');
    const apiTeams = await owner.client.get('/api/v1/cpg/teams');
    const team = (apiTeams.json?.items ?? []).find((t) => t.key === ui.teamKey);
    const devGrants = ((apiUsers.json?.items ?? []).find((u) => u.email === expected.cpg.users.dev.email)?.grants ?? [])
      .filter((g) => g.roleKey === ui.roleKey).map((g) => [g.scopeType, g.scopeType === 'team' ? (g.scopeId === team?.id ? 'team-id-ok' : g.scopeId) : g.scopeId]).sort();
    gate.equal('the API holds exactly what the UI did (team id and canonical repo as scope ids; team patterns)',
      { devGrants, patterns: team?.repoPatterns ?? null }, { devGrants: [['repo', ui.repo], ['team', 'team-id-ok']], patterns: [ui.pattern] });
    await admin.context.close();

    // ── Developer: no governance management, no 4xx ────────────────────
    const dev = await openAs(browser, ctx, users.dev.client);
    const devAccess = await visit(ctx, dev, 'dev', '/governance/access', { expectLanding: '/governance', must: ["You don't have access to Access", 'rbac.users.manage'] });
    gate.check('Developer /governance/access redirects to /governance with an explanation, no 4xx', devAccess.problems.length === 0,
      'landed on /governance, no 4xx', devAccess.problems.slice(0, 4));
    const devAudit = await visit(ctx, dev, 'dev', '/governance/audit', { expectLanding: '/governance', must: ['audit.read'] });
    gate.check('Developer /governance/audit redirects too (no audit.read), no 4xx', devAudit.problems.length === 0, 'landed on /governance', devAudit.problems.slice(0, 4));
    const devNav = await dev.page.$$eval('nav a', (as) => as.map((a) => a.getAttribute('href')));
    gate.check('Developer sidebar has no Governance group while governance is off', !devNav.some((h) => h?.startsWith('/governance')), 'no /governance links', JSON.stringify(devNav.filter((h) => h?.startsWith('/governance'))));
    await dev.context.close();

    // ── Auditor: the audit log ──────────────────────────────────────────
    const auditor = await openAs(browser, ctx, users.auditor.client);
    const auditorAudit = await visit(ctx, auditor, 'auditor', '/governance/audit', { must: ['Chain verified', 'grant.created'] });
    gate.check('Auditor /governance/audit renders cleanly with the chain verified', auditorAudit.problems.length === 0, 'no 4xx', auditorAudit.problems.slice(0, 4));
    await auditor.context.close();

    // ── Settings without org.api_keys.manage (spec §14.2) ───────────────
    // Every member holds Developer, which carries the legacy key permission;
    // take it off the role for this check and put it back afterwards.
    const rolesRes = await owner.client.get('/api/v1/cpg/roles');
    const developer = (rolesRes.json?.items ?? []).find((r) => r.key === 'developer');
    const cut = await owner.client.patch(`/api/v1/cpg/roles/${developer?.id}`, { permissions: (developer?.permissions ?? []).filter((x) => x !== 'org.api_keys.manage') });
    const devNoKeys = await openAs(browser, ctx, users.dev.client);
    const devSettings = await visit(ctx, devNoKeys, 'dev-no-key-permission', '/settings', { must: ["You don't have permission to manage this organization's API keys"], mustNot: ['Generate'] });
    await devNoKeys.context.close();
    const restore = await owner.client.patch(`/api/v1/cpg/roles/${developer?.id}`, { permissions: developer?.permissions ?? [] });
    gate.check('without org.api_keys.manage, /settings hides API-key management and makes no 403 call (permission restored afterwards)',
      cut.status === 200 && restore.status === 200 && devSettings.problems.length === 0,
      'no Generate button, no 4xx; role edits 200', [`cut ${cut.status}, restore ${restore.status}`, ...devSettings.problems].slice(0, 4));

    // ── Phase 2b: the policy registry pages (design spec §16.2 check 11) ──
    await policyRegistryChecks(ctx, browser);
  } finally {
    await browser.close();
  }
}

/** The text of the sidebar user card's role label. */
async function sidebarRole(page) {
  return (await page.textContent('[data-testid="sidebar-role"]').catch(() => null))?.trim() ?? null;
}

// Example code for the UI compile: it goes to the engine only, never to the LLM.
const UI_MARKER = 'gate-ui-example-marker-6d1f';
const UI_VIOLATING = `// ${UI_MARKER}\nexport const model = 'gpt-4-32k';\n`;
const UI_COMPLIANT = `// ${UI_MARKER}\nexport const model = 'gpt-4o';\n`;

/**
 * CPG Phase 2b: the policy log, a policy's detail and authoring in the
 * browser, against the gate-policy org as cpg-policy left it (three active
 * policies, two boards, quorum v2; governance off). Authoring runs end to end
 * through the UI: a rejected compile, a compiled rule, a proposal its author
 * cannot approve (four-eyes), and the approver's approval.
 */
async function policyRegistryChecks(ctx, browser) {
  const { gate } = ctx;
  const { owner, users } = ctx.data.cpg;
  const heads = (await owner.client.get('/api/v1/cpg/policies')).json?.items ?? [];
  const openaiPolicy = heads.find((h) => h.policyKey === 'corp.no-direct-openai');

  // ── Org Admin: list and detail ──────────────────────────────────────
  const admin = await openAs(browser, ctx, owner.client);
  const list = await visit(ctx, admin, 'owner', '/governance/policies', {
    must: ['corp.no-direct-openai', 'corp.no-gpt-4-32k', 'corp.no-pii-to-ai', 'Prohibited', 'Grace period', 'AI Review Board', 'Governance is off'],
  });
  gate.check('Org Admin /governance/policies renders the policy log cleanly (state, tier, owning boards, version, grace period)', list.problems.length === 0,
    'no 4xx, the three gate policies shown', list.problems.slice(0, 4));
  gate.equal('sidebar user card names the governance role, Org Admin (+1 for Developer), instead of the legacy "Member" (brief §9)', await sidebarRole(admin.page), 'Org Admin +1');
  const detail = await visit(ctx, admin, 'owner', `/governance/policies/${openaiPolicy?.policyId}`, {
    must: ['corp.no-direct-openai', 'Signed', 'Activated and signed', 'Approved by Gate approver', 'Release gate approval', 'Enforced since', 'Compare versions'],
  });
  gate.check('Org Admin policy detail renders cleanly: versions, signature, approval vote, enforcement, history', !!openaiPolicy && detail.problems.length === 0,
    'no 4xx, signed v1 with its vote', detail.problems.slice(0, 4));
  await admin.context.close();

  // ── Author: compile (rejected, then compiled), propose; four-eyes ───
  const llmBefore = ctx.llm.calls.filter((c) => c.kind === 'cpg-compile').length;
  const author = await openAs(browser, ctx, users.author.client);
  const newPage = await visit(ctx, author, 'author', '/governance/policies/new', { must: ['Describe the policy', 'never becomes active until someone other than you approves it'] });
  gate.check('Author /governance/policies/new renders cleanly and says nothing is active until someone else approves it', newPage.problems.length === 0, 'no 4xx', newPage.problems.slice(0, 4));
  const a = author.page;
  const rejectSteps = await uiStep(author, 'rejected compile', async () => {
    await a.fill('#policy-text', 'Every AI integration must be well designed and show good taste.');
    await a.fill('[aria-label="violating example 1 path"]', 'src/models.js');
    await a.fill('[aria-label="violating example 1 code"]', UI_VIOLATING);
    await a.click('button:has-text("Compile")');
    await a.waitForSelector('text=Cannot be expressed as a deterministic rule', { timeout: 15_000 });
  });
  const rejectText = await pageText(a);
  gate.check('a policy that cannot be decided deterministically is rejected in the UI with the reason shown verbatim, no 4xx',
    rejectSteps.length === 0 && rejectText.includes('Requires a judgement about design quality, which a deterministic rule cannot make.') && !rejectText.includes('Propose for approval'),
    'rejected_unexpressible reason shown, no proposal form', rejectSteps.slice(0, 4));

  const proposeSteps = await uiStep(author, 'compile and propose', async () => {
    await a.fill('#policy-text', 'No new code may reference the retired gpt-4-32k model (release gate UI).');
    await a.locator('div.mt-4', { hasText: 'Compliant examples' }).locator('button:has-text("Add")').click();
    await a.fill('[aria-label="compliant example 1 path"]', 'src/ok.js');
    await a.fill('[aria-label="compliant example 1 code"]', UI_COMPLIANT);
    await a.click('button:has-text("Compile again")');
    await a.waitForSelector('[data-testid="generated-notice"]', { timeout: 15_000 });
    await a.fill('#policy-key', 'corp.gate-ui-model');
    await a.check('label:has-text("AI Review Board") input[type=checkbox]');
    await a.click('button:has-text("Propose for approval")');
    await a.waitForURL(/\/governance\/policies\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    await a.waitForSelector('[data-testid="proposed-notice"]', { timeout: 10_000 });
  });
  const proposedText = await pageText(a);
  const approveButtons = await a.locator('button:text-is("Approve")').count();
  gate.check('Author compiles through the UI (labelled as generated), proposes corp.gate-ui-model, and is told it is not active',
    proposeSteps.length === 0 && proposedText.includes('is not active') && proposedText.includes('corp.gate-ui-model'),
    'proposed, not active', proposeSteps.slice(0, 4));
  gate.check('four-eyes in the UI: the author (who also holds policy.approve) gets no Approve button and is told why',
    approveButtons === 0 && proposedText.includes('You proposed this version, so you cannot approve or reject it.'),
    'no Approve button, explanation shown', JSON.stringify({ approveButtons }));
  const uiPrompts = ctx.llm.calls.filter((c) => c.kind === 'cpg-compile').slice(llmBefore);
  gate.check('the UI compiles sent the policy text but none of the example code to the LLM',
    uiPrompts.length === 2 && uiPrompts.every((c) => !c.requestBody.includes(UI_MARKER)) && uiPrompts.some((c) => c.requestBody.includes('release gate UI')),
    '2 prompts, no example code', `${uiPrompts.length} prompts`);
  gate.equal('Author sidebar role label: the most privileged role plus the others', await sidebarRole(a), 'Policy Approver +2');
  const proposedId = new URL(a.url()).pathname.split('/').pop();
  await author.context.close();

  // ── Approver: approves through the UI ───────────────────────────────
  const approver = await openAs(browser, ctx, users.approver.client);
  const before = await visit(ctx, approver, 'approver', `/governance/policies/${proposedId}`, { must: ['corp.gate-ui-model', 'Version 1 awaits approval', '0 of 1 approval'] });
  const approveSteps = await uiStep(approver, 'approve', async () => {
    await approver.page.fill('#vote-comment', 'Release gate UI approval');
    await approver.page.click('button:text-is("Approve")');
    await approver.page.waitForSelector('text=Approved. Version 1 is now active and signed.', { timeout: 10_000 });
  });
  const afterText = await pageText(approver.page);
  const apiPolicy = (await owner.client.get(`/api/v1/cpg/policies/${proposedId}`)).json;
  gate.check("Approver approves through the policy page: active and signed; the API records the approver's vote",
    before.problems.length === 0 && approveSteps.length === 0 && afterText.includes('Activated and signed') && apiPolicy?.policy?.state === 'active'
      && apiPolicy?.votes?.length === 1 && apiPolicy.votes[0].voterUserId === users.approver.id && typeof apiPolicy?.versions?.[0]?.signature === 'string',
    'no 4xx; active, 1 vote by approver, signed', [...before.problems, ...approveSteps, `${apiPolicy?.policy?.state} votes=${apiPolicy?.votes?.length}`].slice(0, 4));
  await approver.context.close();

  // ── Developer: read-only log and quorum, no authoring ───────────────
  const dev = await openAs(browser, ctx, users.dev.client);
  const devNew = await visit(ctx, dev, 'dev', '/governance/policies/new', { expectLanding: '/governance', must: ["You don't have access to New policy", 'policy.author'] });
  gate.check('Developer /governance/policies/new redirects with an explanation (no policy.author), no 4xx', devNew.problems.length === 0, 'landed on /governance', devNew.problems.slice(0, 4));
  const devList = await visit(ctx, dev, 'dev', '/governance/policies', { must: ['corp.no-direct-openai', 'corp.gate-ui-model'], mustNot: ['New policy'] });
  gate.check('Developer reads the policy log without authoring controls, no 4xx', devList.problems.length === 0,
    'no New policy', devList.problems.slice(0, 4));
  // dev@ holds Developer plus the custom role this area granted per team and repository; system roles rank first.
  const devRoleTitle = await dev.page.getAttribute('[data-testid="sidebar-role"]', 'title').catch(() => null);
  gate.equal('Developer sidebar role label: Developer, +1 for the custom role granted above (full list on hover)',
    [await sidebarRole(dev.page), devRoleTitle], ['Developer +1', 'Developer, Gate Repo Reviewer']);
  await dev.context.close();
}

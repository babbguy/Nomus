// 5. VS Code extension: the real dist/extension.js is loaded into a stub
// extension host. Sign-in runs end to end (authorize -> dashboard login in
// Chromium -> vscode:// callback -> token exchange in the extension), then
// the views, commands and scan-on-save run against the engine and every
// response must render as the extension reads it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createHost, loadExtension, renderTree } from '../lib/vscode-host.mjs';
import { launchBrowser } from '../lib/browser.mjs';
import { waitFor, sleep } from '../lib/http.mjs';
import { prepareRepo, rulesByFile } from './scanner.mjs';

const BAD_TEXT = /\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b|Invalid Date/;

export async function vscodeChecks(ctx) {
  const { gate, repoRoot, outDir, webUrl } = ctx;
  const workspace = prepareRepo(ctx, path.join(outDir, 'work', 'vscode-workspace'));
  const cfg = fs.readFileSync(path.join(workspace, '.nomus.yml'), 'utf8');
  const jurisdictions = [...cfg.matchAll(/^\s+- ([A-Z][A-Z-]+)\s*$/gm)].map((m) => m[1]);
  const settings = { 'nomus.apiUrl': webUrl, 'nomus.jurisdictions': jurisdictions, 'nomus.scanOnSave': true, 'nomus.scanOnOpen': false };
  const host = createHost({ settings, workspaceRoot: workspace });
  const { state, vscode } = host;

  // A regulatory signal for the Radar view and impact simulation
  const signal = await ctx.data.adminKey.post('/api/v1/radar', {
    title: 'EU AI Act: proposed amendment to general-purpose AI obligations',
    jurisdiction: 'EU', stage: 'committee', likelihoodPercent: 60,
    summary: 'A proposed amendment would extend transparency obligations for general-purpose AI models.',
  });
  gate.equal('admin records a regulatory signal', signal.status, 201);

  const ext = loadExtension(path.join(repoRoot, 'packages', 'vscode-extension', 'dist', 'extension.js'), vscode);
  gate.check('the extension bundle loads and exports activate()', typeof ext.activate === 'function', 'activate()', typeof ext.activate);
  ext.activate(host.context);
  await waitFor(() => state.webviewHandlers.length > 0, { timeout: 5000 });
  gate.check('first activation (signed out) opens the welcome panel', state.webviewHandlers.length > 0, 'welcome webview', `${state.webviewHandlers.length} webview(s)`);

  // ── Sign in: the welcome panel's "Sign in" button ──
  state.webviewHandlers[0]?.({ command: 'signIn' });
  const authorizeUrl = await waitFor(() => state.opened.find((u) => u.includes('/api/v1/auth/device/authorize')), { timeout: 5000 });
  gate.check('Sign in opens the engine authorize URL in the browser', !!authorizeUrl && authorizeUrl.startsWith(`${webUrl}/api/v1/auth/device/authorize?state=`), `${webUrl}/api/v1/auth/device/authorize?state=…`, authorizeUrl ?? state.opened);
  if (!authorizeUrl) return;
  const sentState = new URL(authorizeUrl).searchParams.get('state');

  const browser = await launchBrowser();
  let callback = null;
  try {
    const page = await browser.newPage();
    await page.route('**/api/v1/auth/device/callback*', async (route) => {
      const resp = await route.fetch({ maxRedirects: 0 });
      callback = resp.headers().location ?? `(status ${resp.status()}: ${(await resp.text()).slice(0, 120)})`;
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Returning to VS Code…</p>' });
    });
    await page.goto(authorizeUrl);
    await page.waitForURL(/\/login\?device_state=/, { timeout: 15_000 }).catch(() => {});
    gate.check('authorize redirects to the dashboard login with the device state', page.url().startsWith(`${webUrl}/login?device_state=`), `${webUrl}/login?device_state=…`, page.url());
    await page.fill('input[type="email"]', ctx.data.memberEmail);
    await page.fill('input[type="password"]', ctx.data.memberPassword);
    await page.click('button[type="submit"]');
    await waitFor(() => callback, { timeout: 15_000 });
    await page.screenshot({ path: path.join(ctx.shotsDir, 'vscode-signin.png') }).catch(() => {});
  } finally {
    await browser.close();
  }
  const cbOk = typeof callback === 'string' && callback.startsWith('vscode://nomus.nomus/auth-callback?');
  gate.check('dashboard login hands a one-time code back to vscode://nomus.nomus/auth-callback', cbOk, 'vscode://nomus.nomus/auth-callback?code=…&state=…', callback);
  if (!cbOk) return;
  const cb = new URL(callback.replace('vscode://', 'http://'));
  gate.equal('the callback carries the state the extension sent', cb.searchParams.get('state'), sentState);

  await state.uriHandler.handleUri(vscode.Uri.parse(callback));
  const signedIn = state.messages.find((m) => /Signed in as/.test(m.text));
  gate.check('the extension exchanges the code and signs in', !!signedIn && signedIn.text.includes(ctx.data.memberEmail) && /^nk_live_/.test([...state.secrets.values()].find((v) => /^nk_live_/.test(String(v))) ?? ''),
    `"Signed in as ${ctx.data.memberEmail} (…)", key in SecretStorage`, state.messages.map((m) => `${m.level}: ${m.text}`).slice(-3));
  const replay = await fetch(`${webUrl}/api/v1/auth/device/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cb.searchParams.get('code') }) });
  gate.equal('the one-time code cannot be exchanged twice', replay.status, 400);
  const forged = await fetch(`${webUrl}/api/v1/auth/device/callback?device_state=${crypto.randomUUID()}`, { redirect: 'manual' });
  gate.equal('an unknown device state is refused', forged.status, 400);

  // ── Views (before any local scan, so they show engine numbers only) ──
  await vscode.commands.executeCommand('nomus.refreshViews');
  const score = (await ctx.data.orgKey.get('/api/v1/compliance/score')).json;
  const status = await renderTree(state.trees.get('nomus.complianceStatus'));
  const text = (rows) => rows.map((r) => `${'  '.repeat(r.depth)}${r.label}${r.description ? ` — ${r.description}` : ''}`);
  fs.writeFileSync(path.join(outDir, 'vscode-views.txt'), `Compliance Status\n${text(status).join('\n')}\n`);
  const bad = (rows) => rows.filter((r) => BAD_TEXT.test(`${r.label} ${r.description} ${r.tooltip}`)).map((r) => `${r.label} ${r.description}`);
  gate.check('Compliance Status view renders no undefined/NaN/null', status.length > 1 && bad(status).length === 0, 'clean labels', bad(status).length ? bad(status) : text(status));
  const label = (re) => status.find((r) => re.test(r.label))?.label ?? '';
  gate.equal('view score equals GET /compliance/score', label(/^Score:/), `Score: ${score.overallScore.toFixed(0)}%`);
  gate.equal('view active rules equals the API', label(/^Active Rules:/), `Active Rules: ${score.rulesActive}`);
  gate.equal('view open findings equals the API (findings uploaded by the Action)', label(/^Open Findings:/), score.openFindings > 0 ? `Open Findings: ${score.openFindings}` : '');

  // ── Commands ──
  const before = state.messages.length;
  const newMessages = () => state.messages.slice(before);
  state.quickPick.push((items) => items[0]);
  await vscode.commands.executeCommand('nomus.simulateImpact');
  const sim0 = state.messages.at(-1)?.text ?? '';
  gate.check('Simulate Impact with no AI systems yet reports a risk level', /Simulation complete\. 0\/0 systems impacted\. Risk: (none|low|medium|high|critical)\./.test(sim0), '"0/0 systems impacted. Risk: none."', sim0);

  await vscode.commands.executeCommand('nomus.generateAiBom');
  const gen = state.messages.at(-1)?.text ?? '';
  const created = Number(/(\d+) systems detected/.exec(gen)?.[1]);
  gate.check('Generate AI-BOM reports the systems created from the uploaded findings', created > 0, 'N > 0 systems detected', gen);
  await vscode.commands.executeCommand('nomus.refreshViews');
  const bom = await renderTree(state.trees.get('nomus.aiBom'));
  const radar = await renderTree(state.trees.get('nomus.radar'));
  fs.appendFileSync(path.join(outDir, 'vscode-views.txt'), `\nAI-BOM\n${text(bom).join('\n')}\n\nRadar\n${text(radar).join('\n')}\n`);
  gate.check('AI-BOM view lists systems without undefined/NaN/null', bom.length > 0 && bad(bom).length === 0, 'systems with provider and risk', bad(bom).length ? bad(bom) : text(bom).slice(0, 4));
  gate.check('Radar view lists the signal without undefined/NaN/null', radar.some((r) => r.label.includes('general-purpose AI')) && bad(radar).length === 0, 'the recorded signal', bad(radar).length ? bad(radar) : text(radar).slice(0, 3));
  const apiSystems = (await ctx.data.orgKey.get('/api/v1/ai-bom')).json;
  ctx.data.aiBomSystems = apiSystems?.count;

  state.quickPick.push((items) => items[0]);
  await vscode.commands.executeCommand('nomus.simulateImpact');
  const sim1 = state.messages.at(-1)?.text ?? '';
  gate.check('Simulate Impact analyses every AI system', new RegExp(`(\\d+)/${apiSystems?.count} systems impacted\\. Risk: (none|low|medium|high|critical)\\.`).test(sim1), `k/${apiSystems?.count} systems impacted. Risk: <level>.`, sim1);

  state.inputBox.push('gpt-4o-mini');
  state.quickPick.push((items) => items.find((i) => i === 'openai'));
  await vscode.commands.executeCommand('nomus.runBenchmarks');
  gate.check('Run Benchmarks records a run', /Benchmark run recorded for gpt-4o-mini/.test(state.messages.at(-1)?.text ?? ''), 'Benchmark run recorded…', state.messages.at(-1)?.text);
  for (const fmt of ['json', 'pdf']) {
    state.quickPick.push(() => fmt);
    const n = state.messages.length;
    await vscode.commands.executeCommand('nomus.exportReport');
    const m = state.messages.slice(n).map((x) => x.text).join(' | ');
    gate.check(`Export Report (${fmt}) completes`, new RegExp(`Report exported as ${fmt.toUpperCase()}`).test(m), `Report exported as ${fmt.toUpperCase()}`, m || '(no message: the response was not usable)');
  }
  const problems = newMessages().filter((m) => m.level !== 'info' || BAD_TEXT.test(m.text));
  gate.check('commands show no errors, warnings or undefined values', problems.length === 0, 'none', problems.map((m) => `${m.level}: ${m.text}`).slice(0, 4));

  // ── Scan on save, and Scan Workspace, agree with the CLI ──
  const cli = ctx.data.scan ? rulesByFile(ctx.data.scan.findings) : null;
  const viaSave = {};
  for (const rel of ['app/chatbot.py', 'app/triage.py', 'src/api/chat.ts']) {
    const file = path.join(workspace, rel);
    const doc = host.document(file, fs.readFileSync(file, 'utf8'), rel.endsWith('.py') ? 'python' : 'typescript');
    for (const h of state.saveHandlers) h(doc);
    const diags = await waitFor(() => state.diagnostics.get(doc.uri.toString()), { timeout: 60_000 });
    viaSave[rel] = [...new Set((diags ?? []).map((d) => d.code?.value))].sort();
    const badDiag = (diags ?? []).filter((d) => BAD_TEXT.test(d.message));
    if (badDiag.length) gate.check(`diagnostics for ${rel} have no undefined/NaN`, false, 'clean messages', badDiag.map((d) => d.message).slice(0, 2));
  }
  if (cli) {
    gate.check('scan on save reports the same rule ids per file as the scanner CLI (workspace .nomus.yml)', JSON.stringify(viaSave) === JSON.stringify(cli),
      Object.fromEntries(Object.entries(cli).map(([k, v]) => [k, v.length])), Object.fromEntries(Object.entries(viaSave).map(([k, v]) => [k, v.length])));
  }
  const nWs = state.messages.length;
  await vscode.commands.executeCommand('nomus.scanWorkspace');
  const ws = state.messages.slice(nWs).map((m) => m.text).join(' | ');
  gate.check('Scan Workspace reports the same total as the scanner CLI', new RegExp(`Scanned \\d+ files — ${ctx.data.scan?.total} finding\\(s\\)`).test(ws), `… ${ctx.data.scan?.total} finding(s)`, ws);
  await sleep(100);
}

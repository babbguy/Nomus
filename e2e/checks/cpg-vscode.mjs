// CPG Phase 3: corporate findings in the real VS Code extension bundle
// (packages/vscode-extension/dist/extension.js) in the gate's stub
// extension host, design spec §16.3, release-gate checks 8 to 11, plus the
// ETag, expiry and CPG-off rows.
//
// A fresh host signs in as dev@ through the device flow. The extension talks
// to the engine through a pass-through proxy (lib/pass-proxy.mjs), so the
// gate can read the requests it made (If-None-Match, 304) and close the
// proxy to make the server unreachable without touching the extension's
// settings. The bundle cache key includes the API URL (§10.1), so changing
// nomus.apiUrl would also change the cache; closing the proxy keeps the
// same URL and tests the cache the user actually has.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHost, loadExtension, renderTree } from '../lib/vscode-host.mjs';
import { launchBrowser } from '../lib/browser.mjs';
import { waitFor, sleep } from '../lib/http.mjs';
import { run } from '../lib/procs.mjs';
import { startPassProxy } from '../lib/pass-proxy.mjs';
import { rulesByFile } from './scanner.mjs';
import { preparePolicyRepo, corporateByFile } from './cpg-scanner.mjs';

const BAD_TEXT = /\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b|Invalid Date/;
const SEV = { 0: 'Error', 1: 'Warning', 2: 'Information', 3: 'Hint' };
const HEAD_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A minimal .git directory (no git binary): branch feat/policy-check, origin on github.com. */
function writeGitDir(root) {
  const g = path.join(root, '.git');
  fs.mkdirSync(path.join(g, 'refs', 'heads', 'feat'), { recursive: true });
  fs.writeFileSync(path.join(g, 'HEAD'), 'ref: refs/heads/feat/policy-check\n');
  fs.writeFileSync(path.join(g, 'config'), '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/Gate-Example/Policy-Repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  fs.writeFileSync(path.join(g, 'refs', 'heads', 'feat', 'policy-check'), `${HEAD_SHA}\n`);
}

const describe = (d) => ({
  source: d.source, code: d.code?.value ?? null, severity: SEV[d.severity] ?? d.severity,
  range: [d.range?.start?.line, d.range?.end?.line], message: d.message,
  related: (d.relatedInformation ?? []).map((r) => r.message),
});

export async function cpgVscodeChecks(ctx) {
  const { gate, repoRoot, outDir, webUrl, expected } = ctx;
  const { owner, users } = ctx.data.cpg;
  if (!ctx.data.cpg.policy) {
    gate.blocked('cpg-vscode checks', 'the cpg-policy area did not activate the policies this area shows');
    return;
  }
  const exp = expected.cpg.scanner;
  const extensionJs = path.join(repoRoot, 'packages', 'vscode-extension', 'dist', 'extension.js');
  const workspace = preparePolicyRepo(ctx, path.join(outDir, 'work', 'cpg-vscode-workspace'));
  writeGitDir(workspace);
  const cfg = fs.readFileSync(path.join(workspace, '.nomus.yml'), 'utf8');
  const jurisdictions = [...cfg.matchAll(/^\s+- ([A-Z][A-Z-]+)\s*$/gm)].map((m) => m[1]);

  const enable = await owner.client.patch('/api/v1/cpg/settings', { enabled: true });
  const keyRes = await owner.client.post('/api/v1/org/api-keys', { label: 'cpg vscode gate (CLI cross-check)', scopes: ['read:policies', 'evaluate'] });
  const cliKey = keyRes.json?.key;
  if (!gate.check('governance switched on for gate-policy and an org key minted for the CLI cross-check', enable.status === 200 && typeof cliKey === 'string', '200 and a key', `${enable.status} ${keyRes.status}`)) return;

  let proxy = await startPassProxy({ target: webUrl });
  const proxyPort = proxy.port;
  const evidence = { diagnostics: {}, views: {}, messages: [] };
  try {
    const settings = { 'nomus.apiUrl': proxy.url, 'nomus.jurisdictions': jurisdictions, 'nomus.scanOnSave': true, 'nomus.scanOnOpen': false };
    const host = createHost({ settings, workspaceRoot: workspace });
    const { state, vscode } = host;

    // A second extension instance in this process: load the bundle afresh against this host.
    delete createRequire(import.meta.url).cache[extensionJs];
    const ext = loadExtension(extensionJs, vscode);
    ext.activate(host.context);
    await waitFor(() => state.webviewHandlers.length > 0, { timeout: 5000 });
    gate.check('the extension registers the Corporate Policies view (nomus.corporate) and the nomus.cpg.refresh command',
      state.trees.has('nomus.corporate') && state.commands.has('nomus.cpg.refresh'), 'view and command', `${state.trees.has('nomus.corporate')} ${state.commands.has('nomus.cpg.refresh')}`);
    const signedOut = await renderTree(state.trees.get('nomus.corporate'));
    gate.check('signed out, the view asks the user to sign in (no findings, no error)', signedOut.length === 1 && /Sign in/.test(signedOut[0].label), 'Sign in…', signedOut.map((r) => r.label));

    // ── sign in as dev@ (device flow) ──────────────────────────────────
    state.webviewHandlers[0]?.({ command: 'signIn' });
    const authorizeUrl = await waitFor(() => state.opened.find((u) => u.includes('/api/v1/auth/device/authorize')), { timeout: 5000 });
    let callback = null;
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.route('**/api/v1/auth/device/callback*', async (route) => {
        const resp = await route.fetch({ maxRedirects: 0 });
        callback = resp.headers().location ?? `(status ${resp.status()})`;
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Returning to VS Code…</p>' });
      });
      await page.goto(authorizeUrl);
      await page.waitForURL(/\/login\?device_state=/, { timeout: 15_000 }).catch(() => {});
      await page.fill('input[type="email"]', users.dev.email);
      await page.fill('input[type="password"]', users.dev.password);
      await page.click('button[type="submit"]');
      await waitFor(() => callback, { timeout: 15_000 });
    } finally {
      await browser.close();
    }
    if (!gate.check('dev@ signs in to the extension with the device flow', typeof callback === 'string' && callback.startsWith('vscode://nomus.nomus/auth-callback?'), 'vscode://… callback', callback)) return;
    await state.uriHandler.handleUri(vscode.Uri.parse(callback));
    gate.check('the extension holds a user-bound key for dev@', state.messages.some((m) => m.text.includes(`Signed in as ${users.dev.email}`)), `Signed in as ${users.dev.email}`, state.messages.map((m) => m.text).slice(-2));
    await waitFor(async () => (await renderTree(state.trees.get('nomus.corporate'))).some((r) => /verified/.test(r.label)), { timeout: 15_000 }).catch(() => {});

    const save = async (rel, languageId) => {
      const file = path.join(workspace, rel);
      const doc = host.document(file, fs.readFileSync(file, 'utf8'), languageId);
      const before = state.diagnostics.get(doc.uri.toString());
      state.diagnostics.delete(doc.uri.toString());
      for (const h of state.saveHandlers) h(doc);
      const diags = await waitFor(() => state.diagnostics.get(doc.uri.toString()), { timeout: 60_000 }).catch(() => undefined);
      await sleep(200);
      const final = state.diagnostics.get(doc.uri.toString()) ?? diags ?? before ?? [];
      evidence.diagnostics[`${rel} #${Object.keys(evidence.diagnostics).length + 1}`] = final.map(describe);
      return final;
    };
    const corp = (diags) => diags.filter((d) => d.source === 'Nomus Policy');
    const reg = (diags) => diags.filter((d) => d.source === 'Nomus');

    // ── 8. scan on save: corporate diagnostics are distinct ───────────
    const chatDiags = await save('src/chat.ts', 'typescript');
    const c = corp(chatDiags);
    const d0 = c[0];
    gate.check('save src/chat.ts: a corporate diagnostic with source "Nomus Policy", code corp.no-direct-openai, Error, the multi-line range',
      c.length === 1 && d0.code?.value === 'corp.no-direct-openai' && d0.severity === vscode.DiagnosticSeverity.Error
        && d0.range.start.line === exp.chatRange[0] - 1 && d0.range.end.line === exp.chatRange[1] - 1,
      `1 × Nomus Policy / corp.no-direct-openai / Error / lines ${exp.chatRange.join('-')}`, c.map(describe));
    gate.check('its message, policy link and owners follow §10.2',
      /^\[Policy · PROHIBITED\] corp\.no-direct-openai v1: Call OpenAI only through the approved LLM gateway\. Status: needs review\.$/.test(d0?.message ?? '')
        && String(d0?.code?.target ?? '').includes(`/governance/policies/`) && (d0?.relatedInformation ?? []).some((r) => /^Owned by: /.test(r.message) && r.message.slice(10).split(', ').sort().join('|') === 'AI Review Board|Legal Board'),
      '[Policy · PROHIBITED] … Status: needs review.; policy URL; Owned by: AI Review Board, Legal Board', d0 ? describe(d0) : 'none');

    const cli = await run(process.execPath, [path.join(repoRoot, 'packages', 'scanner', 'dist', 'index.js'), '.', '--json', '--no-corporate'], { cwd: workspace, env: { NOMUS_API_KEY: cliKey }, timeout: 120_000 });
    const cliRegulatory = rulesByFile(JSON.parse(cli.stdout || '{"findings":[]}').findings);
    const codes = (diags) => [...new Set(reg(diags).map((d) => d.code?.value))].sort();
    gate.equal('the regulatory diagnostics of src/chat.ts (source "Nomus") equal a CLI regulatory scan', codes(chatDiags), cliRegulatory['src/chat.ts'] ?? []);

    const models = corp(await save('src/models.ts', 'typescript'));
    gate.check('save src/models.ts: corp.no-gpt-4-32k in its grace period is Information, "advisory; enforced from <date>"',
      models.length === 1 && models[0].severity === vscode.DiagnosticSeverity.Information && /Status: advisory; enforced from \d{4}-\d{2}-\d{2}\.$/.test(models[0].message),
      'Information, advisory; enforced from YYYY-MM-DD', models.map(describe));
    const py = corp(await save('app/summarize.py', 'python'));
    gate.check('save app/summarize.py: corp.no-pii-to-ai (review-required, enforced) is a Warning that needs review',
      py.length === 1 && py[0].code?.value === 'corp.no-pii-to-ai' && py[0].severity === vscode.DiagnosticSeverity.Warning && /Status: needs review\.$/.test(py[0].message),
      'Warning, needs review', py.map(describe));
    const gw = corp(await save('src/llm/gateway/client.ts', 'typescript'));
    gate.equal('save src/llm/gateway/client.ts (the approved gateway): no corporate diagnostic', gw.length, 0);

    // ── 9. the Corporate Policies view after Scan Workspace ───────────
    await vscode.commands.executeCommand('nomus.scanWorkspace');
    const corpEntries = [];
    for (const [uri, diags] of state.diagnostics) {
      const keys = corp(diags).map((d) => d.code?.value);
      if (keys.length) corpEntries.push([path.relative(workspace, vscode.Uri.parse(uri).fsPath).split(path.sep).join('/'), [...new Set(keys)].sort()]);
    }
    const corpByUri = Object.fromEntries(corpEntries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    gate.equal('Scan Workspace: corporate diagnostics per file equal expectations.cpg.scanner (and the CLI)', corpByUri, exp.byFile);
    const view = await renderTree(state.trees.get('nomus.corporate'));
    evidence.views.verified = view;
    const viewText = view.map((r) => `${'  '.repeat(r.depth)}${r.label}${r.description ? ` — ${r.description}` : ''}`);
    const badRows = view.filter((r) => BAD_TEXT.test(`${r.label} ${r.description} ${r.tooltip}`));
    gate.check('the Corporate Policies view shows the groups, each finding, the repository and a "verified" status row, with no undefined/NaN/null',
      badRows.length === 0 && view.some((r) => r.label === 'Blocking: needs review (3)') && view.some((r) => r.label === 'Advisory / grace period (1)')
        && view.some((r) => /^corp\.no-direct-openai · src\/chat\.ts:\d+-\d+$/.test(r.label)) && view.some((r) => r.label === 'Repository: gate-example/policy-repo @ feat/policy-check')
        && /^Policy bundle: 3 policies · verified \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/.test(view.at(-1)?.label ?? ''),
      'groups 3 + 1, repository row, verified status row', badRows.length ? badRows.map((r) => r.label) : viewText);

    // ── ETag revalidation ──────────────────────────────────────────────
    const bundleGets = () => proxy.log.filter((e) => e.method === 'GET' && e.path.startsWith('/api/v1/cpg/bundle'));
    const firstGet = bundleGets()[0];
    const nBefore = bundleGets().length;
    await vscode.commands.executeCommand('nomus.cpg.refresh');
    const reval = bundleGets().slice(nBefore);
    gate.check('Refresh revalidates with If-None-Match and the server answers 304; the view stays verified',
      firstGet?.status === 200 && reval.length === 1 && !!reval[0].ifNoneMatch && reval[0].status === 304
        && /verified/.test((await renderTree(state.trees.get('nomus.corporate'))).at(-1)?.label ?? ''),
      'first GET 200, refresh GET with If-None-Match → 304', JSON.stringify({ first: firstGet?.status, reval }));

    // ── 10. offline: the cached, re-verified bundle keeps the findings ─
    await proxy.close();
    const msgBefore = state.messages.length;
    await vscode.commands.executeCommand('nomus.cpg.refresh');
    const offlineDiags = corp(await save('src/chat.ts', 'typescript'));
    const offlineView = await renderTree(state.trees.get('nomus.corporate'));
    evidence.views.offline = offlineView;
    gate.check('offline (server unreachable): the corporate diagnostics persist and the status row says "offline (cached …)"',
      offlineDiags.length === 1 && offlineDiags[0].code?.value === 'corp.no-direct-openai' && /^Policy bundle: offline \(cached \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)$/.test(offlineView.at(-1)?.label ?? ''),
      '1 corporate diagnostic; offline (cached …)', `${offlineDiags.length} diag(s); ${offlineView.at(-1)?.label}`);
    const cacheKey = `nomus.cpg.bundle:${proxy.url}`;

    // ── expired: an offline cache older than the allowed age is not used ─
    const record = state.globalState.get(cacheKey);
    const fetchedAt = record?.fetchedAt;
    state.globalState.set(cacheKey, { ...record, fetchedAt: new Date(Date.now() - 100 * 3_600_000).toISOString() });
    const nExp = state.messages.length;
    const expiredDiags = corp(await save('src/chat.ts', 'typescript'));
    const expiredView = await renderTree(state.trees.get('nomus.corporate'));
    evidence.views.expired = expiredView;
    gate.check('expired (offline, cached 100 hours ago, limit 72): corporate diagnostics cleared, an error says so, the status row says expired',
      expiredDiags.length === 0 && state.messages.slice(nExp).some((m) => m.level === 'error' && /too old to use offline/.test(m.text)) && /^Policy bundle expired/.test(expiredView.at(-1)?.label ?? ''),
      'no corporate diagnostic, error, expired row', `${expiredDiags.length} diag(s); ${state.messages.slice(nExp).map((m) => m.text).join(' | ')}; ${expiredView.at(-1)?.label}`);
    state.globalState.set(cacheKey, { ...record, fetchedAt });
    const restored = corp(await save('src/chat.ts', 'typescript'));
    gate.equal('with a fresh cache again the corporate diagnostic is back (offline)', restored.map((d) => d.code?.value), ['corp.no-direct-openai']);

    // ── 11. a tampered cached bundle is discarded, never used ─────────
    const good = state.globalState.get(cacheKey);
    const tampered = JSON.parse(JSON.stringify(good));
    for (const p of tampered.bundle.policies) if (p.policyKey === 'corp.no-direct-openai') p.tier = 'advisory';
    state.globalState.set(cacheKey, tampered);
    const nT = state.messages.length;
    const tamperedDiags = corp(await save('src/chat.ts', 'typescript'));
    const tamperedView = await renderTree(state.trees.get('nomus.corporate'));
    evidence.views.tampered = tamperedView;
    const tMsgs = state.messages.slice(nT);
    gate.check('a tampered cached bundle: corporate diagnostics cleared, an error message shown, the cache deleted, no "no violations" state',
      tamperedDiags.length === 0 && tMsgs.some((m) => m.level === 'error' && /failed verification and was discarded/.test(m.text)) && state.globalState.get(cacheKey) === undefined
        && tamperedView.some((r) => /cannot be shown/.test(r.label)) && /^Policy bundle unavailable$/.test(tamperedView.at(-1)?.label ?? ''),
      'cleared, error, cache gone, unavailable row', `${tamperedDiags.length} diag(s); ${tMsgs.map((m) => `${m.level}: ${m.text}`).join(' | ')}; ${tamperedView.map((r) => r.label).join(' / ')}`);
    evidence.messages.push(...state.messages.slice(msgBefore).map((m) => `${m.level}: ${m.text}`));

    // ── CPG off: back online, governance switched off → exactly the regulatory view ─
    proxy = await startPassProxy({ target: webUrl, port: proxyPort });
    const disable = await owner.client.patch('/api/v1/cpg/settings', { enabled: false });
    const nOff = state.messages.length;
    await vscode.commands.executeCommand('nomus.cpg.refresh');
    const offDiags = await save('src/chat.ts', 'typescript');
    const offView = await renderTree(state.trees.get('nomus.corporate'));
    evidence.views.cpgOff = offView;
    gate.check('governance off: no corporate diagnostics, the regulatory diagnostics equal the CLI, the view says not enabled, no error',
      disable.status === 200 && corp(offDiags).length === 0 && JSON.stringify(codes(offDiags)) === JSON.stringify(cliRegulatory['src/chat.ts'] ?? [])
        && offView.some((r) => r.label === 'Corporate policies are not enabled for this organization') && state.messages.slice(nOff).every((m) => m.level === 'info'),
      'regulatory only; "not enabled"', `${corp(offDiags).length} corporate; ${offView.map((r) => r.label).join(' / ')}; ${state.messages.slice(nOff).map((m) => m.text).join(' | ')}`);

    const allText = state.messages.map((m) => m.text).filter((t) => BAD_TEXT.test(t));
    gate.check('no extension message contains undefined/NaN/null', allText.length === 0, 'clean', allText.slice(0, 3));
    gate.check('every corporate finding the CLI reports appears in the editor (same files and policies)', JSON.stringify(corpByUri) === JSON.stringify(corporateByFile(ctx.data.cpg.scanner?.findings ?? [])) || !ctx.data.cpg.scanner,
      'same as cpg-scanner', JSON.stringify(corporateByFile(ctx.data.cpg.scanner?.findings ?? [])));
  } finally {
    fs.writeFileSync(path.join(outDir, 'cpg-vscode-evidence.json'), JSON.stringify(evidence, null, 2));
    await proxy.close().catch(() => {});
    const off = await owner.client.patch('/api/v1/cpg/settings', { enabled: false });
    gate.check('governance is off at the end of the area', off.status === 200 && off.json?.enabled === false, '200 enabled false', `${off.status} ${off.json?.enabled}`);
    if (keyRes.json?.id) await owner.client.del(`/api/v1/org/api-keys/${keyRes.json.id}`);
  }
}

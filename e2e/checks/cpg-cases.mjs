// CPG Phase 4a: review cases, design spec §16.4: release-gate checks 2 to 9
// over HTTP, then check 1 and the extension half of check 6 through the real
// VS Code extension bundle in the gate's stub host (request review, the case
// in the Corporate Policies view, a change request, reply and resubmit).
//
// dev@ requests review for the corporate findings the cpg-scanner area got
// from the real CLI on the policy-repo fixture; the snippets are cut from the
// fixture files by the gate itself (lib/fingerprint.mjs). Governance is
// switched on for this area and off again at the end, and the reviewer-context
// setting is put back as it was.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { run } from '../lib/procs.mjs';
import { Client, waitFor } from '../lib/http.mjs';
import { lineRange, normalize } from '../lib/fingerprint.mjs';
import { createHost, loadExtension, renderTree } from '../lib/vscode-host.mjs';
import { preparePolicyRepo } from './cpg-scanner.mjs';
import { writeGitDir } from './cpg-vscode.mjs';

// The HTTP checks use their own repository (given with the github.com host): the VS Code checks
// open the case of gate-org/policy-repo @ feat/policy-demo, and both forms name one repository.
const REPO = 'github.com/gate-org/policy-repo-api';
const JUSTIFICATION = 'Needed for the support chat until the gateway client supports streaming responses.';
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** Findings in the request-review shape, each with its snippet cut from the file on disk. */
export function uploads(repoDir, findings) {
  return findings.map((f) => ({
    fingerprint: f.fingerprint, policyKey: f.policyKey, policyVersion: f.policyVersion, filePath: f.file,
    startLine: f.startLine, endLine: f.endLine, language: f.language ?? 'other',
    snippet: normalize(lineRange(fs.readFileSync(path.join(repoDir, f.file), 'utf8'), f.startLine, f.endLine)),
  }));
}

/**
 * §16.4 check 1 and the extension half of check 6: dev@ requests review from
 * VS Code (the real dist/extension.js), with the QuickPick and InputBox
 * answers queued; the case appears in the view; ai-reviewer@ requests
 * changes and the extension shows the request and a warning; dev@ replies
 * (resolving it) and resubmits from the extension.
 */
async function extensionChecks(ctx, work, expectedBlocking) {
  const { gate, repoRoot, webUrl } = ctx;
  const { users } = ctx.data.cpg;
  const SENTINEL = 'gate-sentinel-4a3';
  const JUSTIFY = `Kept until the gateway client supports streaming; tracked as ${SENTINEL}.`;
  const workspace = preparePolicyRepo(ctx, path.join(work, 'vscode-workspace'));
  writeGitDir(workspace, 'feat/policy-demo', 'https://github.com/gate-org/policy-repo.git');
  const host = createHost({ settings: { 'nomus.apiUrl': webUrl, 'nomus.scanOnSave': false, 'nomus.scanOnOpen': false }, workspaceRoot: workspace });
  const { state, vscode } = host;
  const extensionJs = path.join(repoRoot, 'packages', 'vscode-extension', 'dist', 'extension.js');
  delete createRequire(import.meta.url).cache[extensionJs];
  loadExtension(extensionJs, vscode).activate(host.context);

  // Sign in as dev@ with the device flow the extension starts (HTTP; dev@'s session approves it).
  await waitFor(() => state.webviewHandlers.length > 0, { timeout: 5000 });
  state.webviewHandlers[0]({ command: 'signIn' });
  const authorize = new URL(await waitFor(() => state.opened.find((u) => u.includes('/api/v1/auth/device/authorize')), { timeout: 5000 }));
  await new Client(webUrl).get(authorize.pathname + authorize.search, { redirect: 'manual' });
  const callback = await users.dev.client.get(`/api/v1/auth/device/callback?device_state=${authorize.searchParams.get('state')}`, { redirect: 'manual' });
  await state.uriHandler.handleUri(vscode.Uri.parse(callback.headers.get('location') ?? ''));
  const viewText = async () => (await renderTree(state.trees.get('nomus.corporate'))).map((r) => `${'  '.repeat(r.depth)}${r.label}${r.description ? ` — ${r.description}` : ''}`);
  const since = (n) => state.messages.slice(n).map((m) => `${m.level}: ${m.text}`);
  const byBranch = async () => (await users.dev.client.get('/api/v1/cpg/cases/by-branch?repo=gate-org/policy-repo&branch=feat/policy-demo')).json?.case;

  // ── 1. request review from VS Code: all preselected, the same justification for all ──
  let n = state.messages.length;
  state.quickPick.push((items) => items, (items) => items.find((i) => /^Use this justification for the remaining \d+ findings?$/.test(i)));
  state.inputBox.push(JUSTIFY);
  await vscode.commands.executeCommand('nomus.cpg.requestReview');
  const opened = state.messages.slice(n).find((m) => m.level === 'info' && /Review case CPG-/.test(m.text));
  gate.check('VS Code (dev@, branch feat/policy-demo): "Nomus: Request Policy Review" shows "Review case CPG-… opened (revision 1). Sent to: AI Review Board, Legal Board."',
    /^Nomus: Review case CPG-[0-9A-F]{8} opened \(revision 1\)\. Sent to: AI Review Board, Legal Board\.$/.test(opened?.text ?? '') && state.quickPick.length === 0 && state.inputBox.length === 0,
    'Review case CPG-… opened (revision 1)', since(n));
  const kase = await byBranch();
  const detail = kase ? (await users.dev.client.get(`/api/v1/cpg/cases/${kase.id}`)).json : null;
  gate.check('the server has the case in_review: every blocking finding justified with the one queued text, revision 1 from vscode',
    kase?.state === 'in_review' && !!opened?.text.includes(kase.ref) && detail?.revisions?.[0]?.source === 'vscode'
      && detail.justifications?.length === expectedBlocking && detail.justifications.every((j) => j.body === JUSTIFY),
    `in_review, ${expectedBlocking} × the sentinel justification, source vscode`, `${kase?.state} ${detail?.revisions?.[0]?.source} ${detail?.justifications?.map((j) => j.body.includes(SENTINEL)).join(',')}`);
  const tree = await viewText();
  const laneRows = (kase?.lanes ?? []).map((l) => `  ${l.boardName}: needs review (${l.blocking} blocking)`);
  gate.check('the Corporate Policies view shows the case, one row per lane with the blocking count from the server, and "Open in dashboard"',
    tree[0] === `Case ${kase?.ref} · in review (revision 1)` && laneRows.length === 2 && JSON.stringify(tree.slice(1, 4)) === JSON.stringify([...laneRows, '  Open in dashboard']),
    ['Case … · in review (revision 1)', ...laneRows, '  Open in dashboard'], tree.slice(0, 6));

  // ── 6 (extension half). a change request reaches the tree and warns ──
  const asked = await users['ai-reviewer'].client.post(`/api/v1/cpg/cases/${kase?.id}/request-changes`, {
    boardId: kase?.lanes?.find((l) => l.boardName === 'AI Review Board')?.boardId, body: 'Route this call through the approved gateway client.',
    fingerprints: kase?.resolutions?.filter((r) => r.tier === 'prohibited').map((r) => r.fingerprint),
  });
  n = state.messages.length;
  await vscode.commands.executeCommand('nomus.cpg.refresh');
  const changed = await viewText();
  const row = changed.find((l) => /^ {2}Changes requested by .+ \(AI Review Board\): "Route this call through the approved gateway client\."/.test(l));
  const warnings = state.messages.slice(n).filter((m) => m.level === 'warning');
  gate.check('after ai-reviewer@ requests changes, Refresh shows the request in the tree and one warning notification with Reply / Open case',
    asked.status === 201 && changed[0] === `Case ${kase?.ref} · changes requested (revision 1)` && !!row && warnings.length === 1
      && /^Nomus: CPG-[0-9A-F]{8}: Changes requested by .+ \(AI Review Board\): "Route this call through the approved gateway client\."$/.test(warnings[0].text)
      && JSON.stringify(warnings[0].items) === '["Reply","Open case"]',
    'tree row + 1 warning [Reply, Open case]', { tree: changed.slice(0, 5), messages: since(n) });

  // dev@ replies from the extension (resolving the request) and resubmits.
  n = state.messages.length;
  state.inputBox.push('Moved the call behind the gateway client.');
  state.quickPick.push((items) => items.find((i) => i === 'This resolves the request'));
  await vscode.commands.executeCommand('nomus.cpg.replyToChangeRequest', asked.json?.id);
  const answered = await viewText();
  await vscode.commands.executeCommand('nomus.cpg.resubmit');
  const after = await byBranch();
  const finalTree = await viewText();
  gate.check('dev@ replies from VS Code (resolving it), is offered Resubmit, resubmits: the case is in_review again and the view says so',
    answered.includes('  Every change request is resolved: resubmit for review') && after?.state === 'in_review' && after.openChangeRequests.length === 0
      && since(n).join('\n') === `info: Nomus: Reply sent. Every change request on ${kase?.ref} is resolved: resubmit the case for review.\ninfo: Nomus: Review case ${kase?.ref} resubmitted: in review.`
      && finalTree[0] === `Case ${kase?.ref} · in review (revision 1)`,
    'resolved row, 2 info messages, in_review', { answered: answered.slice(0, 5), messages: since(n), state: after?.state });
}

export async function cpgCasesChecks(ctx) {
  const { gate, repoRoot, outDir } = ctx;
  const { owner, users } = ctx.data.cpg;
  if (!ctx.data.cpg.scanner || !ctx.data.cpg.policy) {
    gate.blocked('cpg-cases checks', 'the cpg-scanner area did not record the corporate findings this area submits');
    return;
  }
  const dev = users.dev.client;
  const reviewer = users['ai-reviewer'].client;
  const { bundleHash } = ctx.data.cpg.scanner;
  const work = path.join(outDir, 'work', 'cpg-cases');
  fs.mkdirSync(work, { recursive: true });

  const before = await owner.client.get('/api/v1/cpg/settings');
  const enable = await owner.client.patch('/api/v1/cpg/settings', { enabled: true });
  const keyRes = await owner.client.post('/api/v1/org/api-keys', { label: 'cpg cases gate', scopes: ['read:policies', 'evaluate'] });
  const orgKey = keyRes.json?.key;
  if (!gate.check('governance switched on for gate-policy and an org API key minted for the CLI', enable.status === 200 && typeof orgKey === 'string',
    '200 and a key', `${enable.status} ${keyRes.status}`)) return;

  const cli = path.join(repoRoot, 'packages', 'scanner', 'dist', 'index.js');
  const scan = async (dir) => parse((await run(process.execPath, [cli, '.', '--json'], { cwd: dir, env: { NOMUS_API_KEY: orgKey }, timeout: 120_000 })).stdout)?.corporateFindings ?? [];
  const request = (client, branch, findings, dir) => client.post('/api/v1/cpg/cases/request-review', {
    repo: REPO, branch, headSha: null, bundleHash, findings: uploads(dir, findings),
    justifications: findings.filter((f) => f.blocking).map((f) => ({ fingerprint: f.fingerprint, body: JUSTIFICATION })),
  });
  const byBranch = async (branch) => (await dev.get(`/api/v1/cpg/cases/by-branch?repo=${REPO}&branch=${encodeURIComponent(branch)}`)).json?.case;

  try {
    // ── 2. request review → in_review, lanes AI and Legal ────────────────
    const repo = preparePolicyRepo(ctx, path.join(work, 'policy-repo'));
    const findings = await scan(repo);
    const blocking = findings.filter((f) => f.blocking);
    const first = await request(dev, 'feat/policy-demo', findings, repo);
    const opened = first.json?.case;
    gate.check('dev@ requests review (POST /cpg/cases/request-review): 201, a new case with revision 1',
      first.status === 201 && first.json?.created === true && first.json?.revisionCreated === true && opened?.latestRevision === 1 && /^CPG-[0-9A-F]{8}$/.test(opened?.ref ?? ''),
      '201 created, revision 1, CPG- ref', `${first.status} ${JSON.stringify(first.json)?.slice(0, 200)}`);
    const status = await byBranch('feat/policy-demo');
    const lanes = (status?.lanes ?? []).map((l) => l.boardName).sort();
    const blockingResolutions = (status?.resolutions ?? []).filter((r) => r.blocking && r.status === 'needs_review').length;
    gate.check('GET /cpg/cases/by-branch: in_review, lanes AI Review Board and Legal Board, every blocking finding needs review',
      status?.id === opened?.id && status?.state === 'in_review' && JSON.stringify(lanes) === JSON.stringify(['AI Review Board', 'Legal Board'])
        && blockingResolutions === blocking.length && blocking.length > 0,
      `in_review, 2 lanes, ${blocking.length} blocking`, `${status?.state} ${JSON.stringify(lanes)} ${blockingResolutions}`);
    const rev1 = (await dev.get(`/api/v1/cpg/cases/${opened?.id}/revisions/1`)).json;
    gate.check('revision 1 holds every corporate finding, each with its snippet and the blocking ones justified',
      rev1?.findings?.length === findings.length && rev1.findings.filter((f) => f.blocking && f.justification).length === blocking.length,
      `${findings.length} findings, ${blocking.length} justified`, `${rev1?.findings?.length} ${rev1?.findings?.filter((f) => f.justification).length}`);

    // ── 3. re-request without a code change → no new revision, same case ──
    const again = await request(dev, 'feat/policy-demo', findings, repo);
    gate.check('re-requesting with no code change: 200, revisionCreated false, the same case (no duplicate)',
      again.status === 200 && again.json?.revisionCreated === false && again.json?.case?.id === opened?.id && again.json?.case?.latestRevision === 1,
      '200, false, same id', `${again.status} ${again.json?.revisionCreated} ${again.json?.case?.id === opened?.id}`);

    // ── 4. a new violating line → revision 2, added 1, carried n ─────────
    fs.appendFileSync(path.join(repo, 'src', 'models.ts'), "export const BACKUP_MODEL = 'gpt-4-32k';\n");
    const changed = await scan(repo);
    const second = await request(dev, 'feat/policy-demo', changed, repo);
    const rev2 = (await dev.get(`/api/v1/cpg/cases/${opened?.id}`)).json?.revisions?.find((r) => r.revision === 2);
    gate.check('after adding a violating line and re-requesting: revision 2 with added 1 and carried equal to the previous findings',
      second.json?.revisionCreated === true && second.json?.case?.latestRevision === 2 && rev2?.addedCount === 1 && rev2?.carriedCount === findings.length,
      `revision 2, added 1, carried ${findings.length}`, `${second.status} rev ${second.json?.case?.latestRevision} added ${rev2?.addedCount} carried ${rev2?.carriedCount}`);

    // ── 5. two parallel requests on a new branch → one case ──────────────
    const [p1, p2] = await Promise.all([request(dev, 'feat/policy-parallel', findings, repo), request(dev, 'feat/policy-parallel', findings, repo)]);
    gate.check('two parallel request-review calls on a new branch converge on the same case (one created, one not)',
      p1.json?.case?.id && p1.json.case.id === p2.json?.case?.id && [p1.json.created, p2.json?.created].sort().join() === 'false,true',
      'same id', `${p1.status}/${p2.status} ${p1.json?.case?.id} ${p2.json?.case?.id}`);

    // ── 6. request changes → reply resolving → resubmit ──────────────────
    const aiLane = status?.lanes?.find((l) => l.boardName === 'AI Review Board');
    const aiFingerprint = findings.find((f) => f.policyKey === 'corp.no-direct-openai')?.fingerprint;
    const asked = await reviewer.post(`/api/v1/cpg/cases/${opened?.id}/request-changes`, { boardId: aiLane?.boardId, body: 'Call OpenAI through the approved gateway client.', fingerprints: [aiFingerprint] });
    const afterAsk = await byBranch('feat/policy-demo');
    gate.check('ai-reviewer@ requests changes on the AI lane: 201, case changes_requested with the open request listed',
      asked.status === 201 && afterAsk?.state === 'changes_requested' && afterAsk.openChangeRequests?.[0]?.commentId === asked.json?.id,
      '201, changes_requested', `${asked.status} ${afterAsk?.state} ${afterAsk?.openChangeRequests?.length}`);
    const reply = await dev.post(`/api/v1/cpg/cases/${opened?.id}/comments`, { kind: 'reply', threadId: asked.json?.id, resolves: true, body: 'Moved the call behind the gateway client.' });
    const resubmitted = await dev.post(`/api/v1/cpg/cases/${opened?.id}/resubmit`, {});
    gate.check('dev@ replies with resolves: true and resubmits: the case is back in_review with no open change request',
      reply.status === 201 && resubmitted.status === 200 && resubmitted.json?.state === 'in_review' && resubmitted.json?.openChangeRequests?.length === 0,
      '201, 200 in_review', `${reply.status} ${resubmitted.status} ${resubmitted.json?.state}`);

    // ── 7. reviewer context: disabled when off, generated and labelled when on ──
    const finding = (await reviewer.get(`/api/v1/cpg/cases/${opened?.id}/revisions/2`)).json?.findings?.find((f) => f.policyKey === 'corp.no-direct-openai');
    const contextPath = `/api/v1/cpg/cases/${opened?.id}/findings/${finding?.id}/context`;
    await owner.client.patch('/api/v1/cpg/settings', { reviewerContextLlm: false });
    const llmBefore = ctx.llm.calls.length;
    const off = await reviewer.get(contextPath);
    gate.check('reviewer context with the org setting off: status disabled and no LLM call',
      off.status === 200 && off.json?.status === 'disabled' && ctx.llm.calls.length === llmBefore, 'disabled, 0 calls', `${off.status} ${off.json?.status} ${ctx.llm.calls.length - llmBefore}`);
    await owner.client.patch('/api/v1/cpg/settings', { reviewerContextLlm: true });
    const on = await reviewer.get(contextPath);
    const contextCalls = ctx.llm.calls.slice(llmBefore).filter((c) => c.kind === 'cpg-reviewer-context');
    gate.check('with it on: generated, labelled with provider and model; the fake LLM received the reviewer-context prompt',
      on.json?.status === 'generated' && on.json.provider === 'openai' && typeof on.json.model === 'string' && on.json.label === `Generated by openai ${on.json.model}`
        && /gate fake/.test(on.json.whatItDoes ?? '') && contextCalls.length === 1,
      'generated, Generated by openai <model>, 1 prompt', `${on.status} ${on.json?.status} ${on.json?.label} calls ${contextCalls.length}`);

    // ── 8. an org key cannot request review ──────────────────────────────
    const viaKey = await ctx.data.api.withKey(orgKey).post('/api/v1/cpg/cases/request-review', {
      repo: REPO, branch: 'feat/policy-key', headSha: null, bundleHash, findings: uploads(repo, findings), justifications: [],
    });
    gate.check('an organization API key calling request-review: 403 user_identity_required',
      viaKey.status === 403 && viaKey.json?.code === 'user_identity_required', '403 user_identity_required', `${viaKey.status} ${viaKey.json?.code}`);

    // ── 9. another org cannot see the case ───────────────────────────────
    const foreign = await ctx.data.member.get(`/api/v1/cpg/cases/${opened?.id}`);
    gate.check('the gate-health member reading the gate-policy case: 404 (never 403)', foreign.status === 404, '404', `${foreign.status} ${foreign.json?.code}`);

    // ── 1 and 6 through the VS Code extension ────────────────────────────
    await extensionChecks(ctx, work, blocking.length);
  } finally {
    const restore = await owner.client.patch('/api/v1/cpg/settings', { enabled: false, reviewerContextLlm: before.json?.reviewerContextLlm ?? false });
    gate.check('governance switched off again and the reviewer-context setting restored', restore.status === 200 && restore.json?.enabled === false,
      '200 enabled false', `${restore.status} ${restore.json?.enabled}`);
    if (keyRes.json?.id) await owner.client.del(`/api/v1/org/api-keys/${keyRes.json.id}`);
  }
}

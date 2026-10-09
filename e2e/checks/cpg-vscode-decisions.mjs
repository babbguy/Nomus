// CPG Phase 5a.2 in the editor: decision statuses in the real VS Code
// extension bundle (packages/vscode-extension/dist/extension.js), after the
// decisions of cpg-approvals exist (§10.4: approved and excepted findings are
// hints, rejected ones errors).
//
// dev@ requests review on a new branch of the policy-repo fixture. Its
// findings already carry the decisions cpg-approvals made for the repository
// (chat.ts approved, the PII finding rejected); a standing exception limited
// to this branch excepts the legacy finding. A fresh extension host, given an
// org key with read:policies (the by-branch status accepts it), polls the
// branch's case and rebuilds the diagnostics. Afterwards the exception is
// revoked, the case withdrawn, the Exception Approver grant revoked and
// governance switched off, so later areas see what cpg-approvals left.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHost, loadExtension } from '../lib/vscode-host.mjs';
import { waitFor, sleep } from '../lib/http.mjs';
import { run } from '../lib/procs.mjs';
import { preparePolicyRepo } from './cpg-scanner.mjs';
import { uploads } from './cpg-cases.mjs';
import { writeGitDir } from './cpg-vscode.mjs';

const REPO = 'gate-org/policy-repo';
const BRANCH = 'feat/policy-decisions';
const SEV = { 0: 'Error', 1: 'Warning', 2: 'Information', 3: 'Hint' };
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString();
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

export async function cpgVscodeDecisionsChecks(ctx) {
  const { gate, repoRoot, outDir, webUrl, data } = ctx;
  const { owner, users } = data.cpg;
  if (!data.cpg.closedCaseId) {
    gate.blocked('cpg-vscode-decisions checks', 'the cpg-approvals area did not record its decisions');
    return;
  }
  const work = path.join(outDir, 'work', 'cpg-vscode-decisions');
  const workspace = preparePolicyRepo(ctx, path.join(work, 'policy-repo'));
  writeGitDir(workspace, BRANCH, 'https://github.com/Gate-Org/Policy-Repo.git');

  const enable = await owner.client.patch('/api/v1/cpg/settings', { enabled: true });
  const keyRes = await owner.client.post('/api/v1/org/api-keys', { label: 'cpg vscode decisions gate', scopes: ['read:policies', 'evaluate'] });
  const exceptionRole = (await owner.client.get('/api/v1/cpg/roles')).json?.items?.find((r) => r.key === 'exception_approver')?.id;
  const legalGrant = await owner.client.post(`/api/v1/cpg/users/${users['legal-reviewer'].id}/grants`, { roleId: exceptionRole, scopeType: 'org' });
  let caseId = null;
  let exceptionId = null;
  try {
    if (!gate.check('governance on, an org key for the extension, and legal-reviewer@ granted Exception Approver',
      enable.status === 200 && typeof keyRes.json?.key === 'string' && legalGrant.status === 201, '200, key, 201', `${enable.status} ${keyRes.status} ${legalGrant.status}`)) return;

    // ── the case on a new branch, and a standing exception for this branch only ──
    const scan = parse((await run(process.execPath, [path.join(repoRoot, 'packages', 'scanner', 'dist', 'index.js'), '.', '--json'],
      { cwd: workspace, env: { NOMUS_API_KEY: keyRes.json.key }, timeout: 120_000 })).stdout);
    const findings = scan?.corporateFindings ?? [];
    const blocking = findings.filter((f) => f.blocking);
    const legacy = blocking.find((f) => f.policyKey === 'corp.no-direct-openai' && f.file === 'src/legacy/old_chat.ts');
    const opened = await users.dev.client.post('/api/v1/cpg/cases/request-review', {
      repo: REPO, branch: BRANCH, headSha: null, bundleHash: scan?.corporate?.bundleHash, findings: uploads(workspace, findings),
      justifications: blocking.map((f) => ({ fingerprint: f.fingerprint, body: 'Needed for the support chat until the gateway client supports streaming.' })),
    });
    caseId = opened.json?.case?.id ?? null;
    const proposed = await users.exceptions.client.post('/api/v1/cpg/proposals', {
      scope: 'standing', expiresAt: inDays(30), rationale: 'Gate: the legacy client stays on this branch until the gateway release.',
      pattern: { repos: [REPO], paths: ['src/legacy/**'], policyKey: 'corp.no-direct-openai', policyVersion: legacy?.policyVersion, conditions: { branches: [BRANCH] } },
    });
    await users['ai-reviewer'].client.post(`/api/v1/cpg/proposals/${proposed.json?.id}/votes`, { vote: 'approve' });
    const finalVote = await users['legal-reviewer'].client.post(`/api/v1/cpg/proposals/${proposed.json?.id}/votes`, { vote: 'approve' });
    exceptionId = finalVote.json?.decisionIds?.[0] ?? null;
    const byStatus = Object.fromEntries((opened.json?.case?.resolutions ?? []).map((r) => [r.fingerprint, r.status]));
    if (!gate.check(`dev@ requests review on ${BRANCH}: the repository's decisions already apply (chat.ts approved, the PII finding rejected); a branch-only standing exception excepts the legacy finding`,
      opened.status === 201 && Object.values(byStatus).includes('approved') && Object.values(byStatus).includes('rejected') && finalVote.json?.proposalStatus === 'finalized' && !!exceptionId,
      '201 with approved and rejected; exception finalized', `${opened.status} ${JSON.stringify(byStatus)} ${finalVote.status} ${finalVote.json?.proposalStatus}`)) return;

    // ── the extension: a fresh host on the same branch ──
    const jurisdictions = [...fs.readFileSync(path.join(workspace, '.nomus.yml'), 'utf8').matchAll(/^\s+- ([A-Z][A-Z-]+)\s*$/gm)].map((m) => m[1]);
    const settings = { 'nomus.apiUrl': webUrl, 'nomus.apiKey': keyRes.json.key, 'nomus.jurisdictions': jurisdictions, 'nomus.scanOnSave': true, 'nomus.scanOnOpen': false };
    const host = createHost({ settings, workspaceRoot: workspace });
    const { state, vscode } = host;
    const extensionJs = path.join(repoRoot, 'packages', 'vscode-extension', 'dist', 'extension.js');
    delete createRequire(import.meta.url).cache[extensionJs];
    loadExtension(extensionJs, vscode).activate(host.context);
    await vscode.commands.executeCommand('nomus.cpg.refresh');

    const corporate = async (rel, languageId) => {
      const doc = host.document(path.join(workspace, rel), fs.readFileSync(path.join(workspace, rel), 'utf8'), languageId);
      state.diagnostics.delete(doc.uri.toString());
      for (const h of state.saveHandlers) h(doc);
      await waitFor(() => state.diagnostics.get(doc.uri.toString()), { timeout: 60_000 }).catch(() => undefined);
      await sleep(200);
      return (state.diagnostics.get(doc.uri.toString()) ?? []).filter((d) => d.source === 'Nomus Policy')
        .map((d) => ({ code: d.code?.value, severity: SEV[d.severity] ?? d.severity, message: d.message }));
    };
    const shown = {
      chat: await corporate('src/chat.ts', 'typescript'),
      legacy: await corporate('src/legacy/old_chat.ts', 'typescript'),
      pii: await corporate('app/summarize.py', 'python'),
    };
    fs.writeFileSync(path.join(outDir, 'cpg-vscode-decisions-evidence.json'), JSON.stringify(shown, null, 2));
    const one = (list, code, severity, status) => list.length === 1 && list[0].code === code && list[0].severity === severity && status.test(list[0].message);
    gate.check('VS Code after decisions: the approved and excepted findings are hints with their expiry, the rejected review-required finding is an error',
      one(shown.chat, 'corp.no-direct-openai', 'Hint', /Status: approved until \d{4}-\d{2}-\d{2}\.$/)
        && one(shown.legacy, 'corp.no-direct-openai', 'Hint', /Status: excepted \(standing exception\) until \d{4}-\d{2}-\d{2}\.$/)
        && one(shown.pii, 'corp.no-pii-to-ai', 'Error', /Status: rejected\.$/),
      'chat Hint approved, legacy Hint excepted, PII Error rejected', JSON.stringify(shown));
  } finally {
    const revoked = exceptionId ? await users.exceptions.client.post(`/api/v1/cpg/decisions/${exceptionId}/revoke`, { reason: 'Gate: the branch check is done.' }) : null;
    const withdrawn = caseId ? await users.dev.client.post(`/api/v1/cpg/cases/${caseId}/withdraw`, { reason: 'Gate: the branch check is done.' }) : null;
    const revokeLegal = legalGrant.json?.id ? await owner.client.post(`/api/v1/cpg/grants/${legalGrant.json.id}/revoke`, { reason: 'Gate: standing exception check done' }) : null;
    const off = await owner.client.patch('/api/v1/cpg/settings', { enabled: false });
    if (keyRes.json?.id) await owner.client.del(`/api/v1/org/api-keys/${keyRes.json.id}`);
    gate.check('cleanup: the exception revoked, the case withdrawn, the grant revoked, governance off',
      (!exceptionId || revoked?.status === 201) && (!caseId || withdrawn?.status === 200) && revokeLegal?.status === 200 && off.json?.enabled === false,
      '201, 200, 200, enabled false', `${revoked?.status} ${withdrawn?.status} ${revokeLegal?.status} ${off.json?.enabled}`);
  }
}

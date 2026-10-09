// CPG Phase 6: the GitHub Action enforces corporate policies (design spec
// §16.6 release-gate checks 1 to 10). The committed dist/index.js runs on
// pull_request events for the policy-repo fixture against the built engine
// and a second fake GitHub API, after the cpg-approvals area's decisions
// (the chat and legacy findings approved, the PII finding rejected).
// Check 11, the v1.1.0 `action` area, is unchanged and runs on the
// gate-health org, whose corporate policies are off.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, run } from '../lib/procs.mjs';
import { startFakeGithub } from '../lib/fake-github.mjs';
import { startFaultProxy } from '../lib/fault-proxy.mjs';
import { validateSarif } from '../lib/sarif.mjs';
import { preparePolicyRepo } from './cpg-scanner.mjs';
import { parseOutputs } from './action.mjs';

const OWNER = 'gate-org';
const NAME = 'policy-repo';
const PR = 12;
const BRANCH = 'feat/policy-ci';
const HEAD_SHA = '3333333333333333333333333333333333333333';
const MERGE_SHA = '4444444444444444444444444444444444444444';
const CHECK = 'Nomus Corporate Policy Gate';
const MARKER = '<!-- nomus-cpg -->';
const EVALUATE = { method: 'POST', path: '/api/v1/cpg/ci/evaluate' };
// Code from the fixture's flagged lines: never in a comment, check run or SARIF (§12).
const SENTINELS = ['jane.roe@example.org', 'chat.completions.create', 'client.messages.create'];

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}
function verifies(spki, text, signature) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
const corporateLine = (stdout) => /Corporate policies: (\d+), files checked: (\d+), findings: (\d+)/.exec(stdout)?.slice(1).map(Number) ?? null;
const errors = (stdout) => stdout.split('\n').filter((l) => l.startsWith('::error::'));

export async function cpgActionChecks(ctx) {
  const { gate, repoRoot, outDir, webUrl, data } = ctx;
  const { owner } = data.cpg;
  if (!data.cpg.decisions) {
    gate.blocked('cpg-action checks', 'the cpg-approvals area did not record its decisions');
    return;
  }
  const bundle = path.join(repoRoot, 'packages', 'github-action', 'dist', 'index.js');
  const work = path.join(outDir, 'work', 'cpg-action');
  fs.mkdirSync(work, { recursive: true });
  const workspace = preparePolicyRepo(ctx, path.join(work, 'policy-repo'));
  // The regulatory scan's configuration for the working-directory: app run (check 9), present in every run.
  fs.copyFileSync(path.join(workspace, '.nomus.yml'), path.join(workspace, 'app', '.nomus.yml'));
  const gh = await startFakeGithub({ logFile: path.join(outDir, 'fake-github-cpg.log'), prFiles: [] });
  const proxy = await startFaultProxy({ target: webUrl });
  (ctx.closers ??= []).push(gh.close, proxy.close);

  const enable = await owner.client.patch('/api/v1/cpg/settings', { enabled: true });
  const keyRes = await owner.client.post('/api/v1/org/api-keys', { label: 'cpg action gate', scopes: ['read:policies', 'evaluate'] });
  if (!gate.check('governance on and an org key for the Action', enable.status === 200 && typeof keyRes.json?.key === 'string', '200, key', `${enable.status} ${keyRes.status}`)) return;
  const spki = (await data.api.get('/.well-known/nomus-keys')).json?.keys?.[0]?.spki;

  let n = 0;
  const runAction = async ({ apiUrl = webUrl, inputs = {}, action = 'synchronize', pr = {} } = {}) => {
    const i = ++n;
    // Each run starts from a fresh checkout, as on a runner: no report of an earlier run.
    for (const f of ['nomus-results.sarif', 'nomus-corporate.sarif']) fs.rmSync(path.join(workspace, f), { force: true });
    const eventPath = path.join(work, `event-${i}.json`);
    const repository = { name: NAME, owner: { login: OWNER }, full_name: `${OWNER}/${NAME}` };
    fs.writeFileSync(eventPath, JSON.stringify({
      action, number: PR, repository,
      pull_request: { number: PR, head: { sha: HEAD_SHA, ref: BRANCH, repo: { full_name: `${OWNER}/${NAME}` } }, base: { sha: '0'.repeat(40), ref: 'main', repo: { full_name: `${OWNER}/${NAME}` } }, ...pr },
    }));
    const outFile = path.join(work, `github-output-${i}.txt`);
    fs.writeFileSync(outFile, '');
    const input = { 'api-key': keyRes.json.key, 'api-url': apiUrl, 'github-token': 'ghs_gate_fake_token', 'fail-on': 'critical', 'working-directory': '.', 'upload-sarif': 'true', 'post-pr-comment': 'true', 'badge-embed': 'false', ...inputs };
    const r = await run(process.execPath, [bundle], {
      cwd: workspace,
      timeout: 180_000,
      env: {
        ...Object.fromEntries(Object.entries(input).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
        GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: `${OWNER}/${NAME}`, GITHUB_REPOSITORY_OWNER: OWNER, GITHUB_SHA: MERGE_SHA,
        GITHUB_REF: `refs/pull/${PR}/merge`, GITHUB_REF_NAME: `${PR}/merge`, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath,
        GITHUB_API_URL: gh.url, GITHUB_SERVER_URL: 'https://github.com', GITHUB_WORKSPACE: workspace, GITHUB_OUTPUT: outFile, RUNNER_TEMP: work,
      },
    });
    fs.writeFileSync(path.join(outDir, `cpg-action-run-${i}.log`), `exit ${r.code}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
    return { ...r, outputs: parseOutputs(fs.readFileSync(outFile, 'utf8')) };
  };
  const corporateRuns = () => gh.state.checkRuns.filter((c) => c.name === CHECK);
  const corporateSarifs = () => gh.state.sarifs.filter((s) => s.sarif?.runs?.[0]?.automationDetails?.id === 'nomus-corporate/');
  const marked = () => gh.state.issueComments.filter((c) => c.body.includes(MARKER));
  const caseDetail = async (id) => (await owner.client.get(`/api/v1/cpg/cases/${id}`)).json;

  try {
    // ── 1. the PR run after the decisions: the rejected PII finding fails the job ──
    const r1 = await runAction();
    const pii = /Blocking: corp\.no-pii-to-ai @ app\/summarize\.py:\d+: rejected/.test(r1.stdout);
    gate.check('1. the Action on the PR (PII finding rejected): exit 1, ::error::Corporate policy gate failed, corporate-status=fail, the PII reason logged',
      r1.code === 1 && errors(r1.stdout).some((l) => l.startsWith('::error::Corporate policy gate failed')) && r1.outputs['corporate-status'] === 'fail' && Number(r1.outputs['corporate-blocking']) >= 1 && pii,
      'exit 1, error, fail, PII rejected', `exit ${r1.code}, ${r1.outputs['corporate-status']}, blocking ${r1.outputs['corporate-blocking']}, PII ${pii}, ${errors(r1.stdout).join(' | ').slice(0, 300)}`);

    // ── 2. the corporate check run ──
    const cr1 = corporateRuns()[0];
    gate.check(`2. check run "${CHECK}" on the PR head: failure, with annotations`,
      corporateRuns().length === 1 && cr1.head_sha === HEAD_SHA && cr1.conclusion === 'failure' && (cr1.output?.annotations?.length ?? 0) > 0
        && cr1.output.annotations.some((a) => a.path === 'app/summarize.py' && a.annotation_level === 'failure'),
      '1 run, failure, the PII annotation', `${corporateRuns().length} ${cr1?.head_sha === HEAD_SHA} ${cr1?.conclusion} ${cr1?.output?.annotations?.length}`);

    // ── 3. two SARIF uploads: the regulatory one and the corporate one ──
    const corp = corporateSarifs();
    const problems = corp[0] ? validateSarif(corp[0].sarif) : ['no corporate upload'];
    const regulatory = gh.state.sarifs.filter((s) => s.sarif?.runs?.[0]?.tool?.driver?.name === 'Nomus');
    gate.check('3. two SARIF uploads; the corporate one is valid 2.1.0 with category nomus-corporate/ and errors for blocking findings',
      gh.state.sarifs.length === 2 && regulatory.length === 1 && corp.length === 1 && problems.length === 0
        && corp[0].sarif.runs[0].results.some((x) => x.level === 'error') && corp[0].commit_sha === MERGE_SHA,
      '2 uploads (1 regulatory, 1 corporate), valid', `${gh.state.sarifs.length} uploads, ${regulatory.length} regulatory, ${corp.length} corporate, ${problems.slice(0, 3)}`);

    // ── 4. one marked comment with the case, and no code ──
    const caseUrl = r1.outputs['corporate-case-url'] ?? '';
    const caseId = /\/governance\/cases\/([0-9a-f-]{36})$/.exec(caseUrl)?.[1];
    const posted = [marked()[0]?.body ?? '', JSON.stringify(corporateRuns()), JSON.stringify(corp.map((s) => s.sarif))].join('\n');
    const leaked = SENTINELS.filter((s) => posted.includes(s));
    gate.check(`4. one ${MARKER} comment with the review case link and the counts; no code in the comment, the check run or the corporate SARIF`,
      marked().length === 1 && !!caseId && marked()[0].body.includes(caseUrl) && /\| Blocking \|/.test(marked()[0].body) && leaked.length === 0,
      '1 comment, case link, no sentinel', `${marked().length} comment(s), case ${caseId}, leaked ${leaked}`);

    // ── 5. the case gains the PR number; the CI run is recorded with a valid signature ──
    const before = await caseDetail(caseId);
    const runs1 = (await owner.client.get(`/api/v1/cpg/ci/runs?caseId=${caseId}`)).json?.items ?? [];
    const run1 = runs1[0];
    gate.check('5. the case is attached to the PR, and its CI run is recorded with a signature that verifies offline',
      before?.case?.prNumber === PR && before.case.branch === BRANCH && runs1.length === 1 && run1.verdict === 'fail' && run1.headSha === HEAD_SHA
        && run1.signatureValid === true && verifies(spki, run1.signedPayload, run1.signature) && JSON.stringify(sortDeep(JSON.parse(run1.signedPayload))) === run1.signedPayload,
      `PR ${PR}, 1 fail run, verifies`, `PR ${before?.case?.prNumber}, ${runs1.length} run(s) ${run1?.verdict} ${run1?.signatureValid}`);

    // ── 6. the developer removes the PII line: pass, comment edited, revision n+1 resolving it ──
    const file = path.join(workspace, 'app', 'summarize.py');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.includes('jane.roe@example.org')).join('\n'));
    const r2 = await runAction();
    const after = await caseDetail(caseId);
    const revs = (d) => (d?.revisions ?? []).map((x) => x.revision);
    const latest = after?.revisions?.find((x) => x.revision === Math.max(...revs(after)));
    const regulatoryFailed = r2.outputs.status === 'fail';
    gate.check('6. without the PII line: corporate-status=pass and no corporate error (the exit code is the regulatory scan\'s), the check run succeeds, the comment is edited, and the case gains revision n+1 with resolved=1',
      r2.outputs['corporate-status'] === 'pass' && !errors(r2.stdout).some((l) => /Corporate policy|failing closed/.test(l)) && r2.code === (regulatoryFailed ? 1 : 0)
        && corporateRuns()[1]?.conclusion === 'success' && marked().length === 1 && marked()[0].updates === 1
        && Math.max(...revs(after)) === Math.max(...revs(before)) + 1 && latest?.resolvedCount === 1 && latest.source === 'ci',
      'pass, success, edited once, revision +1 resolved 1',
      `${r2.outputs['corporate-status']} exit ${r2.code} (regulatory ${r2.outputs.status}), ${corporateRuns()[1]?.conclusion}, ${marked().length} comment(s) updated ${marked()[0]?.updates}, revisions ${revs(before)} -> ${revs(after)} resolved ${latest?.resolvedCount}; legacy ${data.cpg.decisions.legacyStatus}`);
    const corporate = corporateLine(r2.stdout);

    // ── 7. fail closed: no answer, a 500, a tampered verdict ──
    const closedPort = await freePort();
    const down = await runAction({ apiUrl: `http://127.0.0.1:${closedPort}` });
    gate.check('7a. api-url at a closed port: exit 1, ::error::…failing closed, corporate-status=unknown',
      down.code === 1 && errors(down.stdout).some((l) => /failing closed/.test(l)) && down.outputs['corporate-status'] === 'unknown',
      'exit 1, failing closed, unknown', `exit ${down.code}, ${down.outputs['corporate-status']}, ${errors(down.stdout).join(' | ').slice(0, 200)}`);
    proxy.fault = { ...EVALUATE, kind: 500 };
    const failed = await runAction({ apiUrl: proxy.url });
    gate.check('7b. the proxy answers 500 on /cpg/ci/evaluate: exit 1, Nomus unreachable…failing closed, corporate-status=unknown, no success check run',
      failed.code === 1 && errors(failed.stdout).some((l) => /^::error::Nomus unreachable: .*failing closed.*answered 500/.test(l)) && failed.outputs['corporate-status'] === 'unknown' && proxy.hits === 1
        && corporateRuns().at(-1)?.conclusion === 'failure',
      'exit 1, unreachable, unknown, failure check run', `exit ${failed.code}, ${failed.outputs['corporate-status']}, hits ${proxy.hits}, ${corporateRuns().at(-1)?.conclusion}`);
    proxy.hits = 0;
    proxy.fault = { ...EVALUATE, kind: 'rewrite', rewrite: (v) => ({ ...v, signature: Buffer.from(v.signature, 'base64').map((b) => b ^ 1).toString('base64') }) };
    const tampered = await runAction({ apiUrl: proxy.url });
    proxy.fault = null;
    gate.check('7c. the proxy corrupts the (pass) verdict signature: exit 1, response could not be verified…failing closed, corporate-status=unknown',
      tampered.code === 1 && errors(tampered.stdout).some((l) => /^::error::Nomus response could not be verified: .*failing closed.*signature does not verify/.test(l))
        && tampered.outputs['corporate-status'] === 'unknown' && proxy.hits === 1,
      'exit 1, not verified, unknown', `exit ${tampered.code}, ${tampered.outputs['corporate-status']}, hits ${proxy.hits}`);

    // ── 8. a workflow cannot switch the gate off ──
    const off = await runAction({ inputs: { 'corporate-gate': 'false' } });
    gate.check('8. corporate-gate: false while the org enforces corporate policies: exit 1, refused, corporate-status=unknown',
      off.code === 1 && errors(off.stdout).some((l) => /cannot be disabled from the workflow/.test(l)) && off.outputs['corporate-status'] === 'unknown',
      'exit 1, refused', `exit ${off.code}, ${off.outputs['corporate-status']}, ${errors(off.stdout).join(' | ').slice(0, 200)}`);

    // ── 9. working-directory does not narrow the corporate scan ──
    const sub = await runAction({ inputs: { 'working-directory': 'app' } });
    gate.check('9. working-directory: app leaves the corporate policies, files checked and finding count unchanged',
      !!corporate && JSON.stringify(corporateLine(sub.stdout)) === JSON.stringify(corporate) && sub.outputs['corporate-status'] === 'pass',
      `policies, files, findings ${corporate}`, `${corporateLine(sub.stdout)} ${sub.outputs['corporate-status']}`);

    // ── 10. the merged PR closes the case; the closure verifies offline; the case is immutable ──
    const merged = await runAction({ action: 'closed', pr: { merged: true, merge_commit_sha: MERGE_SHA } });
    const closed = await caseDetail(caseId);
    const closure = closed?.closure;
    const comment = await owner.client.post(`/api/v1/cpg/cases/${caseId}/comments`, { kind: 'comment', body: 'Gate: a comment after the merge.' });
    gate.check('10. pull_request closed (merged): corporate-status=closed, the case is closed as merged, its closure record verifies offline, and a new comment is 409 case_closed',
      merged.outputs['corporate-status'] === 'closed' && closed?.case?.state === 'closed' && closure?.reason === 'merged'
        && verifies(spki, JSON.stringify(sortDeep(closure.record)), closure.signature) && comment.status === 409 && comment.json?.code === 'case_closed',
      'closed, merged, verifies, 409', `${merged.outputs['corporate-status']} ${closed?.case?.state} ${closure?.reason} ${closure ? verifies(spki, JSON.stringify(sortDeep(closure.record)), closure.signature) : null} ${comment.status} ${comment.json?.code}`);
  } finally {
    proxy.fault = null;
    const restore = await owner.client.patch('/api/v1/cpg/settings', { enabled: false });
    const removed = await owner.client.del(`/api/v1/org/api-keys/${keyRes.json.id}`);
    gate.check('governance switched off again and the Action key deleted', restore.status === 200 && restore.json?.enabled === false && removed.status < 300,
      '200 enabled false, key deleted', `${restore.status} ${restore.json?.enabled} ${removed.status}`);
  }
}

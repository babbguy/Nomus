// 3. GitHub Action: the committed dist/index.js bundle loads and runs on a
// pull_request event against a fake GitHub API. It must upload SARIF, post
// the review and summary comment, create a check run and store findings in
// Nomus; a second run must update instead of duplicating.

import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/procs.mjs';
import { startFakeGithub, rightSideLines } from '../lib/fake-github.mjs';
import { validateSarif } from '../lib/sarif.mjs';
import { prepareRepo } from './scanner.mjs';

const OWNER = 'gate-org';
const REPO = 'sample-repo';
const PR = 7;
const HEAD_SHA = '1111111111111111111111111111111111111111';
const MERGE_SHA = '2222222222222222222222222222222222222222';

export async function actionChecks(ctx) {
  const { gate, repoRoot, outDir, webUrl } = ctx;
  const bundle = path.join(repoRoot, 'packages', 'github-action', 'dist', 'index.js');
  const workspace = prepareRepo(ctx, path.join(outDir, 'work', 'action-workspace'));
  const lineCount = (f) => fs.readFileSync(path.join(workspace, f), 'utf8').split('\n').filter((l, i, a) => i < a.length - 1 || l !== '').length;

  // The pull request: app/chatbot.py is a new file; src/api/chat.ts changes
  // lines 9-14; app/triage.py is not part of the PR.
  const added = (f) => `@@ -0,0 +1,${lineCount(f)} @@\n${fs.readFileSync(path.join(workspace, f), 'utf8').split('\n').slice(0, lineCount(f)).map((l) => `+${l}`).join('\n')}`;
  const chatLines = fs.readFileSync(path.join(workspace, 'src/api/chat.ts'), 'utf8').split('\n');
  const chatPatch = ['@@ -7,4 +7,10 @@', ` ${chatLines[6]}`, ` ${chatLines[7]}`, ...chatLines.slice(8, 14).map((l) => `+${l}`), ` ${chatLines[14]}`, ` ${chatLines[15]}`].join('\n');
  const prFiles = [
    { filename: 'app/chatbot.py', status: 'added', patch: added('app/chatbot.py') },
    { filename: 'src/api/chat.ts', status: 'modified', patch: chatPatch },
  ];
  const gh = await startFakeGithub({ logFile: path.join(outDir, 'fake-github.log'), prFiles });
  (ctx.closers ??= []).push(gh.close);

  const eventPath = path.join(outDir, 'work', 'github-event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ action: 'synchronize', number: PR, pull_request: { number: PR, head: { sha: HEAD_SHA }, base: { sha: '0'.repeat(40) } }, repository: { name: REPO, owner: { login: OWNER } } }));

  const runAction = async (n) => {
    const outFile = path.join(outDir, 'work', `github-output-${n}.txt`);
    fs.writeFileSync(outFile, '');
    const r = await run(process.execPath, [bundle], {
      cwd: workspace,
      timeout: 180_000,
      env: {
        'INPUT_API-KEY': ctx.data.orgApiKey,
        'INPUT_API-URL': webUrl,
        'INPUT_GITHUB-TOKEN': 'ghs_gate_fake_token',
        'INPUT_FAIL-ON': 'critical',
        'INPUT_WORKING-DIRECTORY': '.',
        'INPUT_UPLOAD-SARIF': 'true',
        'INPUT_POST-PR-COMMENT': 'true',
        'INPUT_BADGE-EMBED': 'true',
        'INPUT_BADGE-ORG': ctx.data.orgSlug,
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
        GITHUB_REPOSITORY_OWNER: OWNER,
        GITHUB_SHA: MERGE_SHA,
        GITHUB_REF: `refs/pull/${PR}/merge`,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_API_URL: gh.url,
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_WORKSPACE: workspace,
        GITHUB_OUTPUT: outFile,
        RUNNER_TEMP: path.join(outDir, 'work'),
      },
    });
    fs.writeFileSync(path.join(outDir, `action-run-${n}.log`), `exit ${r.code}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
    return { ...r, outputs: parseOutputs(fs.readFileSync(outFile, 'utf8')) };
  };

  // ── Run 1 ──
  const r1 = await runAction(1);
  const crashed = /__filename is not defined|Cannot find module|SyntaxError|ReferenceError/.test(r1.stderr + r1.stdout);
  gate.check('the committed dist bundle loads and runs', !crashed && /Nomus Regulatory Scan/.test(r1.stdout), 'starts and prints the scan banner', `exit ${r1.code}: ${(r1.stderr || r1.stdout).split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300)}`);
  const scanTotal = ctx.data.scan?.total;
  gate.check('outputs: total-findings and status', r1.outputs['total-findings'] !== undefined && (scanTotal === undefined || Number(r1.outputs['total-findings']) === scanTotal) && r1.outputs.status === 'fail',
    `total-findings ${scanTotal ?? '(scanner total)'}, status fail`, `total-findings ${r1.outputs['total-findings']}, status ${r1.outputs.status}`);
  const score = Number(r1.outputs['compliance-score']);
  gate.check('outputs: compliance-score 0-100 with a label', Number.isFinite(score) && score >= 0 && score <= 100 && !!r1.outputs['compliance-label'], 'number 0-100 + label', `${r1.outputs['compliance-score']} ${r1.outputs['compliance-label']}`);
  gate.check('fails the job on critical findings (exit 1, ::error::)', r1.code === 1 && /::error::/.test(r1.stdout), 'exit 1 with ::error::', `exit ${r1.code}`);
  const warn1 = r1.stdout.split('\n').filter((l) => l.startsWith('::warning::'));
  gate.check('no warnings (every GitHub and Nomus call succeeded)', warn1.length === 0, 'none', warn1.slice(0, 3));
  gate.check('GitHub rejected nothing the Action sent', gh.state.rejected.length === 0, 'no 4xx from the fake GitHub API', gh.state.rejected.map((x) => `${x.method} ${x.path} ${x.status} ${x.message}`).slice(0, 3));

  // SARIF
  const sarif = gh.state.sarifs[0]?.sarif;
  gate.equal('SARIF uploaded once', gh.state.sarifs.length, 1);
  if (sarif) {
    const probs = validateSarif(sarif);
    gate.check('uploaded SARIF is valid 2.1.0', probs.length === 0, 'no violations', probs.slice(0, 4));
    const uris = sarif.runs[0].results.flatMap((r) => r.locations.map((l) => l.physicalLocation.artifactLocation.uri));
    gate.check('uploaded SARIF uses repository-relative paths', uris.every((u) => /^(app|src)\//.test(u)), 'app/... or src/...', [...new Set(uris)].filter((u) => !/^(app|src)\//.test(u)).slice(0, 3));
    gate.equal('uploaded SARIF has one result per finding', sarif.runs[0].results.length, Number(r1.outputs['total-findings']));
    gate.equal('SARIF is uploaded for the workflow commit and ref', [gh.state.sarifs[0].commit_sha, gh.state.sarifs[0].ref], [MERGE_SHA, `refs/pull/${PR}/merge`]);
  }

  // Review comments: exactly the finding locations inside the PR's hunks
  const findings = ctx.data.scan?.findings ?? [];
  const hunks = new Map(prFiles.map((f) => [f.filename, rightSideLines(f.patch)]));
  const want = [...new Set(findings.filter((f) => hunks.get(f.file)?.has(f.line)).map((f) => `${f.file}:${f.line}`))].sort();
  const got1 = gh.state.reviewComments.map((c) => `${c.path}:${c.line}`).sort();
  gate.equal('one review posted on the PR head commit', gh.state.reviews.map((r) => r.commit_id), [HEAD_SHA]);
  gate.check('review comments cover every finding location inside the diff, and only those', JSON.stringify(got1) === JSON.stringify(want), want, got1);
  gate.equal('summary comment posted once', gh.state.issueComments.length, 1);
  const summary = gh.state.issueComments[0]?.body ?? '';
  gate.check('summary comment states the findings total', summary.includes('<!-- nomus-scan -->') && new RegExp(`\\b${r1.outputs['total-findings']}\\b`).test(summary), `marker + ${r1.outputs['total-findings']}`, summary.slice(0, 160));

  // Check run
  const cr = gh.state.checkRuns[0];
  gate.equal('check run created on the PR head commit', gh.state.checkRuns.map((c) => c.head_sha), [HEAD_SHA]);
  if (cr) {
    gate.check('check run concludes failure with annotations', cr.conclusion === 'failure' && cr.status === 'completed' && (cr.output?.annotations?.length ?? 0) > 0,
      'completed / failure / annotations', `${cr.status} / ${cr.conclusion} / ${cr.output?.annotations?.length}`);
    const annPaths = (cr.output?.annotations ?? []).map((a) => a.path);
    gate.check('check run annotations use repository-relative paths', annPaths.every((p) => /^(app|src)\//.test(p)), 'relative', annPaths.filter((p) => !/^(app|src)\//.test(p)).slice(0, 3));
  }

  // Findings stored in Nomus
  const repoName = `${OWNER}/${REPO}`;
  const stored1 = await ctx.data.member.get(`/api/v1/scan/findings?repo=${encodeURIComponent(repoName)}&status=all&limit=500`);
  const stored1Count = stored1.json?.count;
  gate.equal('findings stored in Nomus for the repository', stored1Count, Number(r1.outputs['total-findings']));
  gate.check('run 1 reports its findings as new', /Obligations stored in Nomus: (\d+) new, 0 updated/.test(r1.stdout) && Number(/stored in Nomus: (\d+) new/.exec(r1.stdout)?.[1]) === Number(r1.outputs['total-findings']),
    `${r1.outputs['total-findings']} new, 0 updated`, (/Obligations stored in Nomus: .*/.exec(r1.stdout) ?? ['(no upload line)'])[0]);

  // ── Run 2: same commit re-run (e.g. "Re-run jobs") ──
  const before = { reviewComments: gh.state.reviewComments.length, issueComments: gh.state.issueComments.length };
  const r2 = await runAction(2);
  gate.check('run 2 updates every finding instead of creating new ones', new RegExp(`stored in Nomus: 0 new, ${r1.outputs['total-findings']} updated`).test(r2.stdout),
    `0 new, ${r1.outputs['total-findings']} updated`, (/Obligations stored in Nomus: .*/.exec(r2.stdout) ?? ['(no upload line)'])[0]);
  const stored2 = await ctx.data.member.get(`/api/v1/scan/findings?repo=${encodeURIComponent(repoName)}&status=all&limit=500`);
  gate.equal('run 2 leaves the stored finding count unchanged', stored2.json?.count, stored1Count);
  gate.check('run 2 edits the summary comment instead of posting another', gh.state.issueComments.length === before.issueComments && gh.state.issueComments[0]?.updates === 1,
    '1 comment, updated once', `${gh.state.issueComments.length} comment(s), updates ${gh.state.issueComments[0]?.updates}`);
  gate.check('run 2 does not repeat review comments already on the PR', gh.state.reviewComments.length === before.reviewComments,
    `${before.reviewComments} review comments`, `${gh.state.reviewComments.length} review comments after run 2`);
  gate.equal('run 2 exit code and outputs match run 1', [r2.code, r2.outputs['total-findings'], r2.outputs['compliance-score']], [r1.code, r1.outputs['total-findings'], r1.outputs['compliance-score']]);

  ctx.data.action = { repo: repoName, total: Number(r1.outputs['total-findings']), score };
}

function parseOutputs(text) {
  // GITHUB_OUTPUT uses name<<DELIM\nvalue\nDELIM blocks (or name=value lines)
  const out = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^=<]+)<<(.+)$/.exec(lines[i]);
    if (m) {
      const vals = [];
      i++;
      while (i < lines.length && lines[i] !== m[2]) vals.push(lines[i++]);
      out[m[1]] = vals.join('\n');
    } else {
      const e = /^([^=]+)=(.*)$/.exec(lines[i]);
      if (e) out[e[1]] = e[2];
    }
  }
  return out;
}

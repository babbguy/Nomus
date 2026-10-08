// 2. Scanner CLI (packages/scanner/dist/index.js) on the fixture repository:
// exact findings (count, severities, rule ids per file) from
// e2e/expectations.json, documented exit codes, --help/--version, SARIF
// 2.1.0 validity, and results that do not depend on where the repository
// is checked out.

import fs from 'node:fs';
import path from 'node:path';
import { run, freePort } from '../lib/procs.mjs';
import { validateSarif } from '../lib/sarif.mjs';

export async function scannerChecks(ctx) {
  const { gate, repoRoot, outDir, webUrl, expected } = ctx;
  const cli = path.join(repoRoot, 'packages', 'scanner', 'dist', 'index.js');
  const exp = expected.scanner;
  const repo = prepareRepo(ctx, path.join(outDir, 'work', 'repo'));
  const env = { NOMUS_API_KEY: ctx.data.orgApiKey };
  const scan = (args, opts = {}) => run(process.execPath, [cli, ...args], { cwd: opts.cwd ?? repo, env: { ...env, ...opts.env }, timeout: 120_000 });

  // --help / --version / usage errors
  const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', 'scanner', 'package.json'), 'utf8')).version;
  const help = await scan(['--help']);
  gate.check('--help prints usage and exits 0', help.code === 0 && /^Usage: nomus-scan/m.test(help.stdout), 'exit 0, Usage: nomus-scan', `exit ${help.code}: ${help.stdout.slice(0, 80)}`);
  const ver = await scan(['--version']);
  gate.check('--version prints the package version and exits 0', ver.code === 0 && ver.stdout.trim() === version, `exit 0, ${version}`, `exit ${ver.code}: ${ver.stdout.trim()}`);
  const bad = await scan(['.', '--jsno']);
  gate.check('an unknown flag exits 2 with a usage error', bad.code === 2 && /Unknown option "--jsno"/.test(bad.stderr + bad.stdout), 'exit 2, Unknown option "--jsno"', `exit ${bad.code}: ${(bad.stderr + bad.stdout).slice(0, 100)}`);
  const badLevel = await scan(['.', '--fail-on=severe']);
  gate.equal('an invalid --fail-on level exits 2', badLevel.code, 2);
  const noCfgDir = path.join(outDir, 'work', 'no-config');
  fs.mkdirSync(noCfgDir, { recursive: true });
  fs.writeFileSync(path.join(noCfgDir, 'app.py'), 'from openai import OpenAI\n');
  const noCfg = await scan(['.'], { cwd: noCfgDir });
  gate.check('a directory without .nomus.yml exits 2', noCfg.code === 2 && /\.nomus\.yml/.test(noCfg.stderr + noCfg.stdout), 'exit 2 naming .nomus.yml', `exit ${noCfg.code}: ${(noCfg.stderr + noCfg.stdout).slice(-120)}`);

  // Exit 0: a repository with no AI SDK usage passes (without the engine)
  const cleanDir = path.join(outDir, 'work', 'clean-repo');
  fs.mkdirSync(cleanDir, { recursive: true });
  fs.copyFileSync(path.join(repo, '.nomus.yml'), path.join(cleanDir, '.nomus.yml'));
  fs.writeFileSync(path.join(cleanDir, 'util.py'), 'def add(a, b):\n    return a + b\n');
  const clean = await scan(['.', '--json'], { cwd: cleanDir });
  const cleanJson = parse(clean.stdout);
  gate.check('a repository with no AI usage passes with exit 0', clean.code === 0 && cleanJson?.status === 'pass' && cleanJson?.total === 0, 'exit 0, status pass, 0 findings', `exit ${clean.code}, ${cleanJson?.status}, ${cleanJson?.total}`);

  // Exit 3: engine unreachable fails closed
  const closed = await freePort();
  const downDir = prepareRepo(ctx, path.join(outDir, 'work', 'repo-engine-down'));
  fs.writeFileSync(path.join(downDir, '.nomus.yml'), fs.readFileSync(path.join(downDir, '.nomus.yml'), 'utf8').replace(webUrl, `http://127.0.0.1:${closed}`));
  const down = await scan(['.', '--json'], { cwd: downDir });
  gate.check('an unreachable engine fails closed with exit 3', down.code === 3, 'exit 3', `exit ${down.code}: ${(down.stderr + down.stdout).slice(-120)}`);
  const rejected = await scan(['.', '--json'], { env: { NOMUS_API_KEY: 'nk_live_revoked-or-wrong-key-000000000000' } });
  gate.check('a rejected API key exits 3 and names the cause', rejected.code === 3 && /401/.test(rejected.stderr + rejected.stdout), 'exit 3, mentions 401', `exit ${rejected.code}: ${(rejected.stderr + rejected.stdout).slice(-160)}`);

  // The fixture scan: JSON
  const js = await scan(['.', '--json']);
  fs.writeFileSync(path.join(outDir, 'scan.json'), js.stdout);
  const j = parse(js.stdout);
  if (!gate.check('JSON scan of the fixture produces a report', j && Array.isArray(j.findings), 'JSON with findings[]', `exit ${js.code}: ${(js.stderr || js.stdout).slice(0, 200)}`)) return;
  gate.equal('exit code 1: findings at or above --fail-on (default critical)', js.code, 1);
  gate.equal('JSON status agrees with the exit code', j.status, 'fail');
  gate.equal('exact finding count', j.total, exp.total);
  gate.equal('findings by severity', { critical: j.critical, high: j.high, medium: j.medium, low: j.low }, exp.bySeverity);
  gate.equal('finding count equals the findings listed', j.findings.length, j.total);
  const byFile = rulesByFile(j.findings);
  for (const file of Object.keys({ ...exp.rulesByFile, ...byFile }).sort()) {
    const want = exp.rulesByFile[file] ?? [];
    const got = byFile[file] ?? [];
    const extra = got.filter((r) => !want.includes(r));
    const lost = want.filter((r) => !got.includes(r));
    gate.check(`rule ids for ${file}`, extra.length === 0 && lost.length === 0, `${want.length} expected rule ids`,
      `${extra.length ? `unexpected: ${extra.join(', ')}` : ''}${extra.length && lost.length ? '; ' : ''}${lost.length ? `missing: ${lost.join(', ')}` : ''}`);
  }
  const forbidden = j.findings.filter((f) => exp.neverRulePrefixes.some((p) => f.ruleKey.startsWith(p)));
  gate.check('no rules for undeclared sectors or markets (FERPA, GLBA, PCI, CCPA, Annex III)', forbidden.length === 0, 'none', forbidden.map((f) => `${f.file}:${f.ruleKey}`).slice(0, 8));
  const absolute = j.findings.filter((f) => path.isAbsolute(f.file) || f.file.includes('\\'));
  gate.check('finding paths are relative to the scanned directory', absolute.length === 0, 'relative POSIX paths', absolute.map((f) => f.file).slice(0, 3));
  const dupes = duplicates(j.findings.map((f) => `${f.file}|${f.ruleKey}`));
  gate.check('each (rule, file) is reported once', dupes.length === 0, 'no duplicates', dupes.slice(0, 5));
  gate.check('the SDK named by a finding is the SDK called on its line', sdkMismatches(j.findings).length === 0, 'every finding on an SDK call line names that call\'s SDK', sdkMismatches(j.findings).slice(0, 4));

  // Console output agrees with JSON
  const con = await scan(['.']);
  gate.check('console report shows the same total and exits 1', con.code === 1 && new RegExp(`\\b${j.total}\\b`).test(con.stdout), `exit 1, mentions ${j.total}`, `exit ${con.code}: ${con.stdout.split('\n').filter((l) => /finding|obligation/i.test(l)).slice(0, 2).join(' | ')}`);

  // --fail-on is honoured both ways
  const low = await scan(['.', '--json', '--fail-on', 'low']);
  gate.equal('--fail-on low also exits 1 (space-separated value accepted)', low.code, 1);

  // SARIF
  const sa = await scan(['.', '--sarif']);
  fs.writeFileSync(path.join(outDir, 'scan.sarif'), sa.stdout);
  const sarif = parse(sa.stdout);
  const problems = validateSarif(sarif);
  gate.check('SARIF output is valid SARIF 2.1.0', sarif && problems.length === 0, 'no schema violations', problems.slice(0, 5));
  const results = sarif?.runs?.[0]?.results ?? [];
  gate.equal('SARIF lists every finding', results.length, j.total);
  const uris = results.flatMap((r) => (r.locations ?? []).map((l) => l.physicalLocation?.artifactLocation?.uri));
  const badUris = uris.filter((u) => !u || /^[a-zA-Z]:|^\/|^file:|\\/.test(u));
  gate.check('SARIF artifact URIs are relative to the repository', badUris.length === 0, 'relative URIs', badUris.slice(0, 3));
  gate.equal('SARIF exit code matches the JSON run', sa.code, js.code);

  // Same repository, checked out under a directory named "tests/fixtures":
  // the result must not change with the checkout location.
  const nested = prepareRepo(ctx, path.join(outDir, 'work', 'tests', 'fixtures', 'repo'));
  const js2 = await scan(['.', '--json'], { cwd: nested });
  const j2 = parse(js2.stdout);
  gate.check('findings do not depend on the checkout path (repo under tests/fixtures/)', j2?.total === j.total && JSON.stringify(rulesByFile(j2?.findings ?? [])) === JSON.stringify(byFile),
    `${j.total} findings, same rule ids`, `${j2?.total} findings${j2 ? `; missing ${j.total - j2.total}` : ''}`);

  ctx.data.scan = { total: j.total, findings: j.findings, repo };
}

/** Copy the fixture repository to `dest` (a fresh checkout for this run). */
export function prepareRepo(ctx, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(path.join(ctx.gateRoot, 'e2e', 'fixtures', 'sample-repo'), dest, { recursive: true });
  // Point the repository's .nomus.yml at the engine under test.
  const cfg = path.join(dest, '.nomus.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('http://localhost:3100', ctx.webUrl));
  return dest;
}

export function rulesByFile(findings) {
  const by = {};
  // CLI JSON flattens the rule (f.ruleKey); the programmatic shape nests it (f.rule.ruleKey).
  for (const f of findings) (by[f.file] ??= new Set()).add(f.ruleKey ?? f.rule?.ruleKey);
  return Object.fromEntries(Object.keys(by).sort().map((k) => [k, [...by[k]].sort()]));
}

function sdkMismatches(findings) {
  const callSdk = new Map();
  for (const f of findings) if (f.detectorSource === 'sdk-usage-detector') callSdk.set(`${f.file}:${f.line}`, f.sdk);
  return findings
    .filter((f) => callSdk.has(`${f.file}:${f.line}`) && family(callSdk.get(`${f.file}:${f.line}`)) !== family(f.sdk))
    .map((f) => `${f.file}:${f.line} ${f.ruleKey} says ${f.sdk}, the call is ${callSdk.get(`${f.file}:${f.line}`)}`);
}

const family = (sdk) => (/anthropic/.test(sdk) ? 'anthropic' : /openai/.test(sdk) ? 'openai' : sdk);

function duplicates(keys) {
  const seen = new Set();
  return keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
}

function parse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

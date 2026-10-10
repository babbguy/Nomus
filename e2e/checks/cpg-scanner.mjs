// CPG Phase 3: corporate policy findings from the real built scanner CLI
// (packages/scanner/dist/index.js), design spec §16.3, release-gate checks
// 1 to 7, plus the tamper, opt-out and backward-compatibility rows.
//
// Runs against the gate-policy org and the three policies the cpg-policy
// area activated (corp.no-direct-openai prohibited, corp.no-gpt-4-32k
// review-required in its 14-day grace period, corp.no-pii-to-ai
// review-required). Governance is switched on for this area and off again
// at the end, so the areas after it see the org as cpg-policy left it.
// Fingerprints are recomputed by e2e/lib/fingerprint.mjs, which shares no
// code with the scanner.

import fs from 'node:fs';
import path from 'node:path';
import { run } from '../lib/procs.mjs';
import { validateSarif } from '../lib/sarif.mjs';
import { fingerprintOfFile } from '../lib/fingerprint.mjs';
import { startTamperProxy } from '../lib/pass-proxy.mjs';
import { prepareRepo } from './scanner.mjs';

/** Copy the corporate-policy fixture to `dest` and point it at the engine under test. */
export function preparePolicyRepo(ctx, dest, { apiUrl = ctx.webUrl } = {}) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(path.join(ctx.gateRoot, 'e2e', 'fixtures', 'policy-repo'), dest, { recursive: true });
  const cfg = path.join(dest, '.nomus.yml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('http://localhost:3100', apiUrl));
  return dest;
}

/** Every regular file under `dir`, repo-relative with '/' separators. */
function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

export function corporateByFile(findings) {
  const by = {};
  for (const f of findings ?? []) (by[f.file] ??= new Set()).add(f.policyKey);
  return Object.fromEntries(Object.keys(by).sort().map((k) => [k, [...by[k]].sort()]));
}

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const withoutCorporate = (j) => { if (!j) return j; const { corporate: _c, corporateFindings: _f, ...rest } = j; return rest; };

export async function cpgScannerChecks(ctx) {
  const { gate, repoRoot, outDir, expected } = ctx;
  const exp = expected.cpg.scanner;
  const { owner } = ctx.data.cpg;
  if (!ctx.data.cpg.policy) {
    gate.blocked('cpg-scanner checks', 'the cpg-policy area did not activate the policies this area scans for');
    return;
  }
  const cli = path.join(repoRoot, 'packages', 'scanner', 'dist', 'index.js');
  const work = path.join(outDir, 'work', 'cpg-scanner');
  fs.mkdirSync(work, { recursive: true });

  const enable = await owner.client.patch('/api/v1/cpg/settings', { enabled: true });
  const keyRes = await owner.client.post('/api/v1/org/api-keys', { label: 'cpg scanner gate', scopes: ['read:policies', 'evaluate'] });
  const policyKey = keyRes.json?.key;
  if (!gate.check('governance switched on for gate-policy and an org API key minted for the CLI', enable.status === 200 && typeof policyKey === 'string',
    '200 and a key', `${enable.status} ${keyRes.status}`)) return;

  const llmBefore = ctx.llm.calls.length;
  const scan = (cwd, args, env = {}) => run(process.execPath, [cli, ...args], { cwd, env: { NOMUS_API_KEY: policyKey, ...env }, timeout: 120_000 });

  try {
    // ── 1. corporate findings per file ─────────────────────────────────
    const repo = preparePolicyRepo(ctx, path.join(work, 'policy-repo'));
    const first = await scan(repo, ['.', '--json']);
    fs.writeFileSync(path.join(outDir, 'cpg-scan.json'), first.stdout);
    const j = parse(first.stdout);
    const cf = j?.corporateFindings ?? [];
    if (!gate.check('CLI --json on policy-repo reports a corporate section (enabled, 3 policies, bundle hash)',
      j?.corporate?.enabled === true && j.corporate.policyCount === 3 && /^[0-9a-f]{64}$/.test(j.corporate.bundleHash ?? '') && Array.isArray(j.corporateFindings),
      'corporate.enabled, 3 policies', `exit ${first.code}: ${JSON.stringify(j?.corporate ?? (first.stderr || first.stdout).slice(0, 200))}`)) return;
    const byFile = corporateByFile(cf);
    gate.equal('corporate findings per file equal expectations.cpg.scanner (the gateway client has none)', byFile, exp.byFile);
    const status = Object.fromEntries(cf.map((f) => [`${f.policyKey}@${f.file}`, `${f.status}/${f.blocking ? 'blocking' : 'non-blocking'}`]));
    gate.equal('statuses: prohibited and enforced policies need review (blocking); corp.no-gpt-4-32k is advisory in its grace period', status, exp.statuses);
    const chat = cf.find((f) => f.file === 'src/chat.ts');
    gate.check('the multi-line OpenAI call in src/chat.ts is reported as its full line range', chat && chat.startLine === exp.chatRange[0] && chat.endLine === exp.chatRange[1],
      `lines ${exp.chatRange.join('-')}`, chat ? `lines ${chat.startLine}-${chat.endLine}` : 'no finding');

    // ── 2. fingerprints equal the independent computation ─────────────
    const mismatch = cf.filter((f) => fingerprintOfFile(path.join(repo, f.file), f.startLine, f.endLine, f.policyKey, f.policyVersion) !== f.fingerprint);
    gate.check('every fingerprint equals the gate\'s independent sha256(normalize(lines)):key:version', cf.length > 0 && mismatch.length === 0,
      `${cf.length} matching`, mismatch.map((f) => `${f.file}:${f.startLine} ${f.fingerprint.slice(0, 16)}…`));

    // ── 3. deterministic ───────────────────────────────────────────────
    const second = await scan(repo, ['.', '--json']);
    gate.check('two CLI runs give byte-identical JSON', second.stdout === first.stdout && second.code === first.code, 'identical stdout and exit code',
      second.stdout === first.stdout ? `exit ${first.code}/${second.code}` : 'stdout differs');

    // ── 4. CRLF (and a BOM) do not change fingerprints ────────────────
    const crlf = preparePolicyRepo(ctx, path.join(work, 'policy-repo-crlf'));
    for (const rel of listFiles(crlf)) {
      const p = path.join(crlf, rel);
      const text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
      fs.writeFileSync(p, rel === 'src/chat.ts' ? `﻿${text}` : text);
    }
    const jc = parse((await scan(crlf, ['.', '--json'])).stdout);
    const fps = (list) => (list ?? []).map((f) => `${f.file}|${f.startLine}-${f.endLine}|${f.fingerprint}`).sort();
    gate.equal('a CRLF copy (with a BOM on src/chat.ts) gives identical ranges and fingerprints', fps(jc?.corporateFindings), fps(cf));

    // ── 5. .nomus.yml ignore and detector toggles do not hide corporate findings
    const ign = preparePolicyRepo(ctx, path.join(work, 'policy-repo-ignore'));
    fs.appendFileSync(path.join(ign, '.nomus.yml'), '  ignore:\n    - "src/**"\n    - "app/**"\n  detectors:\n    sdk_usage: false\n    phi_pattern: false\n');
    const ji = parse((await scan(ign, ['.', '--json'])).stdout);
    gate.check('adding ignore: ["src/**", "app/**"] and turning detectors off in .nomus.yml leaves corporate findings unchanged',
      ji && JSON.stringify(fps(ji.corporateFindings)) === JSON.stringify(fps(cf)) && ji.total !== j.total,
      'same corporate findings; the regulatory scan honoured the ignore list', `corporate ${fps(ji?.corporateFindings).length}/${cf.length}, regulatory ${ji?.total} vs ${j.total}`);

    // ── 6. gate-health (governance never enabled): exactly the v1.1.0 output ──
    const health = prepareRepo(ctx, path.join(work, 'health-repo'));
    const hj = await scan(health, ['.', '--json'], { NOMUS_API_KEY: ctx.data.orgApiKey });
    const h = parse(hj.stdout);
    gate.check('CLI on the gate-health fixture: no corporate keys in the JSON and regulatory totals as expected (63)',
      h && !('corporate' in h) && !('corporateFindings' in h) && h.total === expected.scanner.total && hj.code === 1,
      `no corporate keys, total ${expected.scanner.total}, exit 1`, `exit ${hj.code}, keys ${h ? Object.keys(h).join(',') : 'none'}, total ${h?.total}`);
    if (ctx.data.scan?.repo) {
      const prior = parse(fs.readFileSync(path.join(outDir, 'scan.json'), 'utf8'));
      gate.check('gate-health JSON equals the scanner area\'s v1.1.0-shaped report byte for byte', prior && JSON.stringify(prior) === JSON.stringify(h), 'identical', prior ? 'differs' : 'no scanner-area report');
    }

    // ── 7. SARIF: a separate, valid corporate run ─────────────────────
    const sa = await scan(repo, ['.', '--sarif']);
    fs.writeFileSync(path.join(outDir, 'cpg-scan.sarif'), sa.stdout);
    const sarif = parse(sa.stdout);
    const problems = validateSarif(sarif);
    const corpRun = sarif?.runs?.[1];
    const sarifFps = (corpRun?.results ?? []).map((r) => r.partialFingerprints?.['nomusCorporate/v1']).sort();
    gate.check('--sarif: valid SARIF 2.1.0; run 2 is the corporate run (automationDetails.id nomus-corporate/) with one result per corporate finding',
      problems.length === 0 && sarif?.runs?.length === 2 && corpRun?.automationDetails?.id === 'nomus-corporate/' && corpRun?.tool?.driver?.name === 'Nomus Corporate Policy'
        && JSON.stringify(sarifFps) === JSON.stringify(cf.map((f) => f.fingerprint).sort()) && sarif.runs[0].results.length === j.total,
      'valid, 2 runs, fingerprints match', `${problems.slice(0, 3).join('; ')} runs=${sarif?.runs?.length} id=${corpRun?.automationDetails?.id} results=${corpRun?.results?.length}`);
    // The corporate parts carry ranges and fingerprints, never the code (the regulatory part is the v1.1.0 report).
    const corporateText = [JSON.stringify(cf), JSON.stringify(j.corporate), JSON.stringify(corpRun ?? {})].join(' ');
    const leaked = ['client.chat.completions.create', "LEGACY_MODEL = 'gpt-4-32k'", 'jane.roe@example.org', 'legacyClient'].filter((t) => corporateText.includes(t));
    gate.check('the corporate JSON and SARIF carry ranges and fingerprints, never the code', leaked.length === 0 && cf.every((f) => !('snippet' in f)), 'no snippet text', leaked);

    // ── exit codes and the regulatory report are unchanged by corporate findings ──
    const off = await scan(repo, ['.', '--json', '--no-corporate']);
    const jo = parse(off.stdout);
    gate.check('--no-corporate: no corporate keys; the regulatory report and the exit code equal the default run',
      jo && !('corporate' in jo) && JSON.stringify(jo) === JSON.stringify(withoutCorporate(j)) && off.code === first.code,
      'identical regulatory report and exit code', `exit ${off.code} vs ${first.code}, keys ${jo ? Object.keys(jo).length : 0}`);
    const con = await scan(repo, ['.']);
    gate.check('the console report has a separate corporate section naming each finding with its fingerprint',
      /Corporate policies/.test(con.stdout) && cf.every((f) => con.stdout.includes(f.fingerprint)) && con.code === first.code,
      'section with every fingerprint, same exit code', `exit ${con.code}; section ${/Corporate policies/.test(con.stdout)}`);
    // Each count says what it counts; --no-corporate keeps the v1.1.0 wording.
    const conOff = await scan(repo, ['.', '--no-corporate']);
    const filesLine = `${j.corporate.scannedFileCount} files checked for corporate policies (every repository file in a policy's scope, of any type)`;
    gate.check('the console names each count: source files for the regulatory scan, files checked for corporate policies; --no-corporate keeps "Found N source files"',
      /^ {3}Found \d+ source files for the regulatory scan\r?$/m.test(con.stdout) && con.stdout.split(/\r?\n/).includes(filesLine)
        && /^ {3}Found \d+ source files\r?$/m.test(conOff.stdout) && !/regulatory scan|corporate polic/i.test(conOff.stdout),
      `"Found N source files for the regulatory scan" and "${filesLine}"`,
      [con.stdout, conOff.stdout].map((s) => s.split(/\r?\n/).filter((l) => /Found|checked/.test(l)).join(' / ')).join(' || '));

    // ── a tampered bundle fails closed and its rules never run ────────
    const tamperProxy = await startTamperProxy({
      target: ctx.webUrl,
      // An attacker in the middle downgrades the prohibited policy to advisory.
      rewrite: (b) => ({ ...b, policies: (b.policies ?? []).map((p) => (p.policyKey === 'corp.no-direct-openai' ? { ...p, tier: 'advisory' } : p)) }),
    });
    try {
      const tRepo = preparePolicyRepo(ctx, path.join(work, 'policy-repo-tampered'), { apiUrl: tamperProxy.url });
      const t = await scan(tRepo, ['.', '--json']);
      gate.check('a tampered bundle (tier downgraded in transit): exit 3, a visible verification error, no report and no corporate result',
        t.code === 3 && /bundle/i.test(t.stderr) && /hash|signature/i.test(t.stderr) && t.stdout.trim() === '' && tamperProxy.tampered >= 1,
        'exit 3, error names the bundle verification, empty stdout', `exit ${t.code}, tampered ${tamperProxy.tampered}: ${t.stderr.trim().slice(0, 200)}`);
      const tOff = await scan(tRepo, ['.', '--json', '--no-corporate']);
      gate.check('with --no-corporate the same repository scans (the bundle is not fetched)', tOff.code === first.code && parse(tOff.stdout)?.total === j.total,
        `exit ${first.code}, total ${j.total}`, `exit ${tOff.code}, total ${parse(tOff.stdout)?.total}`);
    } finally {
      await tamperProxy.close();
    }

    gate.check('no LLM call during any corporate scan (deterministic, local evaluation)', ctx.llm.calls.length === llmBefore, '0 calls', `${ctx.llm.calls.length - llmBefore} calls`);
    ctx.data.cpg.scanner = { findings: cf, bundleHash: j.corporate.bundleHash };
  } finally {
    const disable = await owner.client.patch('/api/v1/cpg/settings', { enabled: false });
    gate.check('governance switched off again for the areas after this one', disable.status === 200 && disable.json?.enabled === false, '200 enabled false', `${disable.status} ${disable.json?.enabled}`);
    if (keyRes.json?.id) await owner.client.del(`/api/v1/org/api-keys/${keyRes.json.id}`);
  }
}

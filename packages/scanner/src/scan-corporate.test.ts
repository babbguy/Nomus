import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runScan, runScanFromContents, runCorporateScan, corporateStatusOf, dashboardUrlFromApiUrl, isNomusApiError } from './scan.js';
import { formatJsonReport } from './output/reporter.js';
import { formatSarifReport } from './output/sarif.js';
import {
  bundleHashOf, bundleSignedText, policyActivationPayload, ruleHashOf, type BundlePolicy, type CorporateBundle,
} from './corporate/contracts.js';
import { canonicalJson } from './corporate/canonical.js';
import { corporateRuleSchema } from './corporate/rule-schema.js';
import { FINGERPRINT_RE, fingerprintOf } from './corporate/fingerprint.js';

// ── a signed org bundle, as the engine builds it ─────────────────────────
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const signText = (t: string) => sign(null, Buffer.from(t, 'utf8'), privateKey).toString('base64');
const ORG = '6f1c2a4e-9b7d-4c3e-8a21-0d5e6f7a8b9c';
const BOARD = { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'AI Review Board' };
const ACTIVATED = '2026-10-01T09:00:00.000Z';
const NOW = new Date('2026-10-09T12:00:00.000Z');

function policy(policyKey: string, policyId: string, ruleInput: unknown, over: Partial<BundlePolicy> = {}): BundlePolicy {
  const rule = corporateRuleSchema.parse(ruleInput);
  const p = {
    policyId, policyKey, version: 1, title: `Policy ${policyKey}`, tier: 'prohibited' as const, owningBoards: [BOARD],
    enforceFrom: ACTIVATED, activatedAt: ACTIVATED, rule, ruleHash: ruleHashOf(rule), ...over,
  };
  return { ...p, activationSignature: signText(canonicalJson(policyActivationPayload(ORG, p))) };
}
function signedBundle(policies: BundlePolicy[], enabled = true): CorporateBundle {
  const b = { kind: 'nomus.cpg-bundle.v1' as const, enabled, orgId: ORG, generatedAt: '2026-10-09T10:00:00.000Z', bundleHash: bundleHashOf(policies), policies: enabled ? policies : [], minScannerVersion: '1.2.0' as const };
  return { ...b, signature: signText(bundleSignedText(b)) };
}
const POLICIES = [
  policy('corp.no-direct-openai', '0b8f5d2c-3e4a-4f6b-9c1d-2e3f4a5b6c7d', {
    schemaVersion: 1, match: { all: [{ kind: 'sdk_call', sdks: ['openai'] }] },
    files: { include: ['**/*'], exclude: ['src/llm/gateway/**'] }, message: 'Call OpenAI only through the approved LLM gateway.',
  }),
  policy('corp.no-gpt-4-32k', '9c8b7a6f-5e4d-4c3b-8a29-1f0e9d8c7b6a', {
    schemaVersion: 1, match: { all: [{ kind: 'line_regex', pattern: { source: 'gpt-4-32k', flags: '' } }] },
    files: { include: ['**/*'] }, message: 'The gpt-4-32k model is retired for new code.',
  }, { tier: 'review-required', enforceFrom: '2026-10-15T09:00:00.000Z' }),
];

// ── the fixture repository ───────────────────────────────────────────────
const CHAT = `import OpenAI from 'openai';

const client = new OpenAI();

export async function ask(question: string): Promise<string> {
  const reply = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: question }],
  });
  return reply.choices[0]?.message?.content ?? '';
}
`;
const FILES: Record<string, string> = {
  'src/chat.ts': CHAT,
  'src/llm/gateway/client.ts': CHAT.replace('ask', 'complete'),
  'src/models.ts': "export const LEGACY_MODEL = 'gpt-4-32k';\n",
  'docs/notes.md': 'We are migrating away from gpt-4-32k.\n',
};

// ── a stub engine: /simulate, the bundle and the signing key ─────────────
let server: Server;
let apiUrl = '';
let requests: string[] = [];
let bundleBody: () => unknown = () => signedBundle(POLICIES);
let bundleStatus = 200;
const RULES = { markets: { EU: { rules: [{ ruleKey: 'eu.test.ai_use', effect: 'flag', severity: 'high', humanSummary: 'Uses an AI model.', legalReference: 'Test Art. 1', matchedOn: ['capability: text_generation'], confidence: 1 }] } } };

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json', etag: '"e1"' }); res.end(JSON.stringify(json)); };
      if (req.url === '/api/v1/simulate') return send(200, RULES);
      if (req.url === '/.well-known/nomus-keys') return send(200, { keys: [{ spki }] });
      if (req.url === '/api/v1/cpg/bundle') return bundleStatus === 200 ? send(200, bundleBody()) : send(bundleStatus, { error: 'x' });
      return send(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  apiUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  requests = [];
  bundleBody = () => signedBundle(POLICIES);
  bundleStatus = 200;
});

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function makeRepo(files: Record<string, string> = FILES, yml = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'nomus-cpg-scan-'));
  dirs.push(root);
  writeFileSync(join(root, '.nomus.yml'), `nomus:\n  api_url: ${apiUrl}\n  api_key: nk_test_key\n  jurisdictions:\n    - EU\n${yml}`);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const corp = (mode: 'auto' | 'off') => ({ mode, now: NOW });
const summary = (fs: Array<{ filePath: string; startLine: number; endLine: number; policyKey: string; fingerprint: string }>) =>
  fs.map((f) => `${f.policyKey}@${f.filePath}:${f.startLine}-${f.endLine}|${f.fingerprint}`);

describe('runScan with corporate policies', () => {
  it('reports corporate findings in new fields with fingerprints; regulatory findings, counts, status, JSON and SARIF are byte-identical to mode off', async () => {
    const root = makeRepo();
    const off = await runScan({ rootDir: root, corporate: corp('off') });
    const auto = await runScan({ rootDir: root, corporate: corp('auto') });
    const none = await runScan({ rootDir: root });

    for (const r of [off, none]) {
      expect(JSON.stringify(auto.findings)).toBe(JSON.stringify(r.findings));
      expect(auto.counts).toEqual(r.counts);
      expect(auto.status).toBe(r.status);
      expect(JSON.stringify(formatJsonReport(auto.findings, { rootDir: root }))).toBe(JSON.stringify(formatJsonReport(r.findings, { rootDir: root })));
      expect(JSON.stringify(formatSarifReport(auto.findings, root))).toBe(JSON.stringify(formatSarifReport(r.findings, root)));
    }
    expect(off.corporateFindings).toEqual([]);
    expect(off.corporate).toMatchObject({ available: false, enabled: false });
    expect(none.corporate).toEqual(off.corporate);
    expect(auto.findings.every((f) => !('source' in f))).toBe(true);

    expect(auto.corporate).toMatchObject({ available: true, enabled: true, orgId: ORG, policyCount: 2 });
    expect(summary(auto.corporateFindings).map((s) => s.split('|')[0])).toEqual([
      'corp.no-gpt-4-32k@docs/notes.md:1-1',
      'corp.no-direct-openai@src/chat.ts:6-9',
      'corp.no-gpt-4-32k@src/models.ts:1-1',
    ]);
    for (const f of auto.corporateFindings) {
      expect(f.source).toBe('corporate');
      expect(f.fingerprint).toMatch(FINGERPRINT_RE);
      expect(f.fingerprint).toBe(fingerprintOf(f.snippet, f.policyKey, f.policyVersion));
      expect(f.file).toBe(join(root, f.filePath));
      expect(f.rule.policyReference).toBe(`Corporate policy ${f.policyKey} v1: Policy ${f.policyKey}`);
    }
    const chat = auto.corporateFindings.find((f) => f.filePath === 'src/chat.ts')!;
    expect(chat.snippet).toBe(CHAT.split('\n').slice(5, 9).join('\n'));
  });

  it('grace-period policies are advisory (not blocking) until enforceFrom; enforced ones need review', async () => {
    const root = makeRepo();
    const before = await runScan({ rootDir: root, corporate: corp('auto') });
    const byKey = (r: typeof before, k: string) => r.corporateFindings.find((f) => f.policyKey === k)!;
    expect(byKey(before, 'corp.no-direct-openai')).toMatchObject({ status: 'needs_review', blocking: true, tier: 'prohibited' });
    expect(byKey(before, 'corp.no-gpt-4-32k')).toMatchObject({ status: 'grace', blocking: false, tier: 'review-required', enforceFrom: '2026-10-15T09:00:00.000Z' });
    const after = await runScan({ rootDir: root, corporate: { mode: 'auto', now: new Date('2026-10-16T00:00:00.000Z') } });
    expect(byKey(after, 'corp.no-gpt-4-32k')).toMatchObject({ status: 'needs_review', blocking: true });
    expect(corporateStatusOf({ tier: 'advisory', enforceFrom: ACTIVATED }, NOW)).toEqual({ status: 'advisory', blocking: false });
  });

  it('is deterministic: the same repository gives the same findings and fingerprints', async () => {
    const root = makeRepo();
    const a = await runScan({ rootDir: root, corporate: corp('auto') });
    const b = await runScan({ rootDir: root, corporate: corp('auto') });
    expect(JSON.stringify(b.corporateFindings)).toBe(JSON.stringify(a.corporateFindings));
    expect(b.corporate).toEqual(a.corporate);
  });

  it('nothing at scan time calls an LLM: the only requests are the bundle, the signing key and /simulate', async () => {
    const root = makeRepo();
    await runScan({ rootDir: root, corporate: corp('auto') });
    expect([...new Set(requests)].sort()).toEqual(['GET /.well-known/nomus-keys', 'GET /api/v1/cpg/bundle', 'POST /api/v1/simulate']);
    // The corporate scan path imports no LLM or HTTP client code of its own.
    const src = readFileSync(join(import.meta.dirname, 'scan-corporate.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+['"][^'"]*(?:llm|openai|anthropic|axios|node:http)[^'"]*['"]/i);
  });

  it('evaluates corporate rules on a repository with no AI signals (regex rules need none)', async () => {
    const root = makeRepo({ 'src/models.ts': "export const LEGACY_MODEL = 'gpt-4-32k';\n", 'src/util.ts': 'export const add = (a: number, b: number) => a + b;\n' });
    const r = await runScan({ rootDir: root, corporate: corp('auto') });
    expect(r.status).toBe('pass');
    expect(r.findings).toEqual([]);
    expect(requests).not.toContain('POST /api/v1/simulate');
    expect(summary(r.corporateFindings).map((s) => s.split('|')[0])).toEqual(['corp.no-gpt-4-32k@src/models.ts:1-1']);
  });

  it('.nomus.yml ignore and detector toggles do not affect corporate findings (D14)', async () => {
    const plain = await runScan({ rootDir: makeRepo(), corporate: corp('auto') });
    const hidden = await runScan({
      rootDir: makeRepo(FILES, '  ignore:\n    - "src/**"\n    - "docs/**"\n  detectors:\n    sdk_usage: false\n    import: false\n'),
      corporate: corp('auto'),
    });
    expect(summary(hidden.corporateFindings)).toEqual(summary(plain.corporateFindings));
    expect(hidden.findings).toEqual([]);
  });

  it('CRLF line endings and a BOM give the same ranges and fingerprints', async () => {
    const crlf = Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, (k === 'src/chat.ts' ? '﻿' : '') + v.replace(/\n/g, '\r\n')]));
    const a = await runScan({ rootDir: makeRepo(), corporate: corp('auto') });
    const b = await runScan({ rootDir: makeRepo(crlf), corporate: corp('auto') });
    expect(summary(b.corporateFindings)).toEqual(summary(a.corporateFindings));
  });

  it('never reads .git or node_modules, and skips files over 2 MB without reading them', async () => {
    const root = makeRepo({ ...FILES, 'node_modules/pkg/index.js': "export const m = 'gpt-4-32k';\n" });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), 'gpt-4-32k\n');
    writeFileSync(join(root, 'big.txt'), `gpt-4-32k\n${'x'.repeat(2 * 1024 * 1024)}`);
    const r = await runScan({ rootDir: root, corporate: corp('auto') });
    expect(r.corporateFindings.map((f) => f.filePath)).not.toContain('node_modules/pkg/index.js');
    expect(r.corporateFindings.map((f) => f.filePath)).not.toContain('.git/config');
    expect(r.corporateFindings.map((f) => f.filePath)).not.toContain('big.txt');
    expect(r.corporate.skippedFileCount).toBe(1);
  });

  it('a tampered bundle fails closed BEFORE any rule runs: NomusApiError, no result, no regulatory call', async () => {
    const root = makeRepo();
    const tampers: Array<[string, () => unknown]> = [
      ['tier downgraded', () => { const b = signedBundle(POLICIES); return { ...b, policies: b.policies.map((p) => ({ ...p, tier: 'advisory' })) }; }],
      ['policy removed', () => { const b = signedBundle(POLICIES); return { ...b, policies: b.policies.slice(1) }; }],
      ['re-hashed without the key', () => { const b = signedBundle(POLICIES); const policies = b.policies.slice(1); return { ...b, policies, bundleHash: bundleHashOf(policies) }; }],
      ['enabled flipped', () => ({ ...signedBundle(POLICIES), enabled: false, policies: [] })],
      ['signed by another key', () => { const other = generateKeyPairSync('ed25519').privateKey; const b = signedBundle(POLICIES); return { ...b, signature: sign(null, Buffer.from(bundleSignedText(b)), other).toString('base64') }; }],
    ];
    for (const [name, body] of tampers) {
      requests = [];
      bundleBody = body;
      let caught: unknown;
      let result: unknown;
      try { result = await runScan({ rootDir: root, corporate: corp('auto') }); } catch (err) { caught = err; }
      expect(result, name).toBeUndefined();
      expect(isNomusApiError(caught), name).toBe(true);
      expect((caught as { failure?: { kind: string } }).failure, name).toEqual({ kind: 'invalid' });
      expect(requests, name).not.toContain('POST /api/v1/simulate');
    }
  });

  it('an unreachable bundle endpoint or a 5xx fails closed; a 401 names the cause', async () => {
    const root = makeRepo();
    bundleStatus = 503;
    await expect(runScan({ rootDir: root, corporate: corp('auto') })).rejects.toMatchObject({ name: 'NomusApiError', failure: { kind: 'http', status: 503 } });
    bundleStatus = 401;
    await expect(runScan({ rootDir: root, corporate: corp('auto') })).rejects.toThrow(/401/);
  });

  it('an engine without CPG (404) and a disabled org give exactly the v1.1.0 scan', async () => {
    const root = makeRepo();
    const off = await runScan({ rootDir: root, corporate: corp('off') });
    bundleStatus = 404;
    const old = await runScan({ rootDir: root, corporate: corp('auto') });
    expect(old.corporate).toMatchObject({ available: false, enabled: false });
    expect(JSON.stringify(old.findings)).toBe(JSON.stringify(off.findings));
    bundleStatus = 200;
    bundleBody = () => signedBundle([], false);
    const disabled = await runScan({ rootDir: root, corporate: corp('auto') });
    expect(disabled.corporate).toMatchObject({ available: true, enabled: false, policyCount: 0 });
    expect(disabled.corporateFindings).toEqual([]);
    expect(JSON.stringify(disabled.findings)).toBe(JSON.stringify(off.findings));
  });

  it('without an API key no bundle is requested', async () => {
    const root = makeRepo({ 'src/util.ts': 'export const x = 1;\n' });
    writeFileSync(join(root, '.nomus.yml'), `nomus:\n  api_url: ${apiUrl}\n  jurisdictions:\n    - EU\n`);
    const prev = process.env.NOMUS_API_KEY;
    delete process.env.NOMUS_API_KEY;
    try {
      const r = await runScan({ rootDir: root, corporate: corp('auto') });
      expect(r.corporate).toMatchObject({ available: false });
      expect(requests).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.NOMUS_API_KEY = prev;
    }
  });
});

describe('in-memory corporate scans (the VS Code extension path)', () => {
  it('runScanFromContents evaluates a given, already verified bundle without fetching it', async () => {
    const root = makeRepo({});
    const files = new Map([[join(root, 'src', 'chat.ts'), CHAT]]);
    const r = await runScanFromContents(files, {
      rootDir: root, config: { jurisdictions: ['EU'], api_key: 'k', api_url: apiUrl },
      corporate: { mode: 'auto', bundle: signedBundle(POLICIES), now: NOW },
    });
    expect(requests).not.toContain('GET /api/v1/cpg/bundle');
    expect(r.corporateFindings.map((f) => [f.file, f.filePath, f.startLine, f.endLine])).toEqual([[join(root, 'src', 'chat.ts'), 'src/chat.ts', 6, 9]]);
  });

  it('runCorporateScan: absolute keys are made repository-relative; files outside the root are skipped', async () => {
    const root = makeRepo({});
    const r = await runCorporateScan([
      [join(root, 'src', 'models.ts'), "const m = 'gpt-4-32k';\n"],
      ['src/other.ts', "const m = 'gpt-4-32k';\n"],
      [join(root, '..', 'elsewhere.ts'), "const m = 'gpt-4-32k';\n"],
    ], root, signedBundle(POLICIES), { now: NOW });
    expect(r.findings.map((f) => [f.file, f.filePath])).toEqual([[join(root, 'src', 'models.ts'), 'src/models.ts'], ['src/other.ts', 'src/other.ts']]);
    expect(r.summary.skippedFileCount).toBe(1);
  });

  it('the editor (in-memory) and the CLI (disk) compute the same fingerprints', async () => {
    const root = makeRepo();
    const disk = await runScan({ rootDir: root, corporate: corp('auto') });
    const mem = await runCorporateScan(Object.entries(FILES), root, signedBundle(POLICIES), { now: NOW });
    expect(summary(mem.findings)).toEqual(summary(disk.corporateFindings));
  });
});

describe('dashboardUrlFromApiUrl', () => {
  it('derives the dashboard origin like the extension does', () => {
    expect(dashboardUrlFromApiUrl('http://localhost:3100')).toBe('http://localhost:5173');
    expect(dashboardUrlFromApiUrl('https://api.nomus.example.org/')).toBe('https://nomus.example.org');
    expect(dashboardUrlFromApiUrl('https://nomus.example.org')).toBe('https://nomus.example.org');
    expect(dashboardUrlFromApiUrl('not a url')).toBeUndefined();
  });
});

// ── the built CLI (packages/scanner/dist/index.js), as users run it ──────
const CLI = join(import.meta.dirname, '..', 'dist', 'index.js');
function cli(cwd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    // Asynchronous: the stub engine runs in this process.
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, timeout: 60_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', rej);
    child.on('close', (code) => res({ code, stdout, stderr }));
  });
}

describe.skipIf(!existsSync(CLI))('nomus-scan CLI with corporate policies (built dist)', () => {
  it('governance on: corporate JSON fields and a second SARIF run; --no-corporate gives the v1.1.0 report and the same exit code', async () => {
    const root = makeRepo();
    const on = await cli(root, ['.', '--json']);
    const off = await cli(root, ['.', '--json', '--no-corporate']);
    const j = JSON.parse(on.stdout);
    const { corporate, corporateFindings, ...regulatory } = j;
    expect(corporate).toMatchObject({ enabled: true, policyCount: 2 });
    expect(corporateFindings.map((f: { policyKey: string; file: string }) => `${f.policyKey}@${f.file}`)).toContain('corp.no-direct-openai@src/chat.ts');
    expect(JSON.stringify(regulatory)).toBe(JSON.stringify(JSON.parse(off.stdout)));
    expect(on.code).toBe(off.code);
    const sarif = JSON.parse((await cli(root, ['.', '--sarif'])).stdout);
    expect(sarif.runs.map((r: { tool: { driver: { name: string } } }) => r.tool.driver.name)).toEqual(['Nomus', 'Nomus Corporate Policy']);
  }, 120_000);

  it('a tampered bundle: exit 3, the verification error on stderr, nothing on stdout', async () => {
    bundleBody = () => { const b = signedBundle(POLICIES); return { ...b, policies: b.policies.map((p) => ({ ...p, tier: 'advisory' })) }; };
    const r = await cli(makeRepo(), ['.', '--json']);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/bundle failed verification — compliance status UNKNOWN; failing closed/);
    expect(r.stdout).toBe('');
    expect(requests).not.toContain('POST /api/v1/simulate');
  }, 120_000);

  it('engine unreachable, no AI usage: still exit 0 as in v1.1.0, with a visible "NOT checked" warning', async () => {
    const root = makeRepo({ 'src/util.ts': 'export const add = (a: number, b: number) => a + b;\n' });
    writeFileSync(join(root, '.nomus.yml'), 'nomus:\n  api_key: nk_test_key\n  api_url: http://127.0.0.1:1\n  jurisdictions:\n    - EU\n');
    const r = await cli(root, ['.', '--json']);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/corporate policies were NOT checked .* Corporate policy status UNKNOWN/);
    expect(JSON.parse(r.stdout)).not.toHaveProperty('corporate');
  }, 120_000);
});

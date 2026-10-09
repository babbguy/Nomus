// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * A fake Nomus engine for the corporate gate tests: a real HTTP server that
 * signs its bundle and CI verdicts with its own Ed25519 key, decides each
 * finding from `statusOf`, and records what the Action sent. `fault` makes
 * one path drop the connection, answer 500, or corrupt the verdict.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  bundleHashOf, bundleSignedText, canonicalJson, corporateRuleSchema, policyActivationPayload, ruleHashOf,
  type BundlePolicy, type CiEvaluateRequest,
} from '@nomus/scanner/corporate';

export const ORG = '6f1c2a4e-9b7d-4c3e-8a21-0d5e6f7a8b9c';
export const CASE = '3d6c0b9a-8f7e-4d5c-9b4a-3c2d1e0f9a8b';
export const POLICY_KEY = 'corp.no-direct-openai';

type Status = 'approved' | 'excepted' | 'rejected' | 'needs_review' | 'pending' | 'advisory';
export type Fault = 'drop' | 500 | 'corrupt' | 'schema' | 'stale' | 'stale-once';

const rule = corporateRuleSchema.parse({
  schemaVersion: 1,
  match: { all: [{ kind: 'line_regex', pattern: { source: 'openai\\.chat\\.completions', flags: '' } }] },
  files: { include: ['**/*.ts'] },
  message: 'Call OpenAI only through the approved LLM gateway.',
});

/** A checkout with one finding in src/ and one under app/. */
export function makeCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nomus-cpg-'));
  const write = (rel: string, text: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  write('src/chat.ts', "import OpenAI from 'openai';\nconst client = new OpenAI();\nexport const ask = (q: string) => client.openai.chat.completions.create({ q });\n");
  write('app/helper.ts', "export const run = (c: any) => c.openai.chat.completions.create({});\n");
  return dir;
}

export interface FakeEngine {
  url: string;
  requests: Array<{ method: string; path: string; body: any }>;
  /** Decides each uploaded finding; blocking unless approved, excepted or advisory. */
  statusOf: (f: CiEvaluateRequest['findings'][number]) => Status;
  enabled: boolean;
  fault: { path: string; kind: Fault } | null;
  /** Bump to change the bundle (the Action then holds a stale one). */
  version: number;
  close: () => Promise<void>;
}

export async function startFakeEngine(): Promise<FakeEngine> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const signText = (t: string) => sign(null, Buffer.from(t, 'utf8'), privateKey).toString('base64');

  const policy = (version: number): BundlePolicy => {
    const p = {
      policyId: '0b8f5d2c-3e4a-4f6b-9c1d-2e3f4a5b6c7d', policyKey: POLICY_KEY, version, title: 'No direct OpenAI calls',
      tier: 'prohibited' as const, owningBoards: [{ id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'AI Review Board' }],
      enforceFrom: '2026-01-01T00:00:00.000Z', activatedAt: '2026-01-01T00:00:00.000Z', rule, ruleHash: ruleHashOf(rule),
    };
    return { ...p, activationSignature: signText(canonicalJson(policyActivationPayload(ORG, p))) };
  };
  const bundle = () => {
    const policies = engine.enabled ? [policy(engine.version)] : [];
    const b = { kind: 'nomus.cpg-bundle.v1' as const, enabled: engine.enabled, orgId: ORG, generatedAt: '2026-10-09T10:00:00.000Z', bundleHash: bundleHashOf(policies), policies, minScannerVersion: '1.2.0' as const };
    return { ...b, signature: signText(bundleSignedText(b)) };
  };

  function verdict(req: CiEvaluateRequest) {
    const findings = req.findings.map((f) => {
      const status = engine.statusOf(f);
      const blocking = !['approved', 'excepted', 'advisory'].includes(status);
      return {
        fingerprint: f.fingerprint, status, blocking, tier: 'prohibited' as const, enforceFrom: '2026-01-01T00:00:00.000Z',
        decisionId: status === 'approved' ? randomUUID() : null, exceptionDecisionId: status === 'excepted' ? randomUUID() : null,
        expiresAt: status === 'approved' || status === 'excepted' ? '2026-11-08T00:00:00.000Z' : null,
        filePath: f.filePath, startLine: f.startLine, endLine: f.endLine,
      };
    });
    const n = (s: Status) => findings.filter((f) => f.status === s).length;
    const counts = {
      blocking: findings.filter((f) => f.blocking).length, pending: n('pending') + n('needs_review'), rejected: n('rejected'),
      approved: n('approved'), excepted: n('excepted'), advisory: n('advisory'),
    };
    const v = counts.blocking > 0 ? 'fail' as const : 'pass' as const;
    const runId = randomUUID();
    const evaluatedAt = new Date().toISOString();
    const findingsDigest = createHash('sha256').update(req.findings.map((f) => f.fingerprint).sort().join('\n')).digest('hex');
    const signedPayload = canonicalJson({
      kind: 'nomus.cpg-ci-run.v1', runId, orgId: ORG, repo: req.repo, branch: req.branch, prNumber: req.prNumber, headSha: req.headSha,
      bundleHash: req.bundleHash, verdict: v, counts, findingsDigest, evaluatedAt,
    });
    const hasCase = findings.length > 0;
    return {
      runId, verdict: v, reasons: findings.filter((f) => f.blocking).map((f) => `${POLICY_KEY} @ ${f.filePath}:${f.startLine}: ${f.status}`),
      caseId: hasCase ? CASE : null, caseUrl: hasCase ? `https://gate.example.org/governance/cases/${CASE}` : null,
      findings, counts, evaluatedAt, signedPayload, signature: signText(signedPayload),
    };
  }

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const path = (req.url ?? '').split('?')[0];
    const body = raw ? JSON.parse(raw) : null;
    engine.requests.push({ method: req.method ?? '', path, body });
    const send = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const fault = engine.fault?.path === path ? engine.fault.kind : null;
    if (fault === 'drop') { req.socket.destroy(); return; }
    if (fault === 500) return send(500, { error: 'internal error', code: 'internal' });
    if (fault === 'stale' || (fault === 'stale-once' && engine.requests.filter((r) => r.path === path).length === 1)) {
      return send(409, { error: 'stale', code: 'bundle_stale' });
    }
    if (path === '/.well-known/nomus-keys') return send(200, { keys: [{ spki }] });
    if (path === '/api/v1/cpg/bundle') return send(200, bundle());
    if (path === '/api/v1/cpg/ci/evaluate') {
      if (body.bundleHash !== bundle().bundleHash) return send(409, { error: 'stale', code: 'bundle_stale' });
      const v = verdict(body);
      if (fault === 'corrupt') return send(200, { ...v, signature: Buffer.from('x'.repeat(64)).toString('base64') });
      if (fault === 'schema') return send(200, { ...v, verdict: 'green' });
      return send(200, v);
    }
    if (path === '/api/v1/cpg/ci/pr-closed') return send(200, { caseId: CASE, closed: true });
    return send(404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const engine: FakeEngine = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: [],
    statusOf: () => 'needs_review',
    enabled: true,
    fault: null,
    version: 1,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
  return engine;
}

/** An Octokit stand-in that keeps issue comments, check runs and SARIF uploads like GitHub does. */
export function statefulOctokit() {
  const state = { comments: [] as Array<{ id: number; body: string }>, checkRuns: [] as any[], sarifs: [] as any[] };
  let next = 1;
  const octokit = {
    paginate: async (fn: (p: any) => Promise<{ data: any[] }>, params: any) => (await fn(params)).data,
    rest: {
      checks: { create: async (p: any) => { state.checkRuns.push(p); return { data: { id: next++ } }; } },
      issues: {
        listComments: async () => ({ data: state.comments.map((c) => ({ ...c })) }),
        createComment: async (p: any) => { const c = { id: next++, body: p.body }; state.comments.push(c); return { data: c }; },
        updateComment: async (p: any) => { const c = state.comments.find((x) => x.id === p.comment_id)!; c.body = p.body; return { data: c }; },
      },
      codeScanning: { uploadSarif: async (p: any) => { state.sarifs.push(p); return { data: { id: 'sarif' } }; } },
    },
  };
  return { octokit, state };
}

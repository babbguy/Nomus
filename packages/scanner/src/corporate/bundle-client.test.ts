import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchCorporateBundle, verifyCorporateBundle } from './bundle-client.js';
import {
  bundleHashOf, bundleSignedText, policyActivationPayload, ruleHashOf, type BundlePolicy, type CorporateBundle,
} from './contracts.js';
import { canonicalJson } from './canonical.js';
import { corporateRuleSchema } from './rule-schema.js';
import { isNomusApiError } from '../errors.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const signText = (t: string) => sign(null, Buffer.from(t, 'utf8'), privateKey).toString('base64');

const ORG = '6f1c2a4e-9b7d-4c3e-8a21-0d5e6f7a8b9c';
const rule = corporateRuleSchema.parse({
  schemaVersion: 1,
  match: { all: [{ kind: 'sdk_call', sdks: ['openai'] }] },
  files: { include: ['**/*'], exclude: ['src/llm/gateway/**'] },
  message: 'Call OpenAI only through the approved LLM gateway.',
});

function policy(key: string, over: Partial<BundlePolicy> = {}): BundlePolicy {
  const p = {
    policyId: '0b8f5d2c-3e4a-4f6b-9c1d-2e3f4a5b6c7d',
    policyKey: key,
    version: 2,
    title: 'No direct OpenAI calls',
    tier: 'prohibited' as const,
    owningBoards: [{ id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'AI Review Board' }],
    enforceFrom: '2026-10-22T09:00:00.000Z',
    activatedAt: '2026-10-08T09:00:00.000Z',
    rule,
    ruleHash: ruleHashOf(rule),
    ...over,
  };
  return { ...p, activationSignature: signText(canonicalJson(policyActivationPayload(ORG, p))) };
}

function bundle(policies: BundlePolicy[], enabled = true): CorporateBundle {
  const b = { kind: 'nomus.cpg-bundle.v1' as const, enabled, orgId: ORG, generatedAt: '2026-10-08T10:00:00.000Z', bundleHash: bundleHashOf(policies), policies, minScannerVersion: '1.2.0' as const };
  return { ...b, signature: signText(bundleSignedText(b)) };
}

function expectApiError(fn: () => unknown, message: RegExp) {
  let caught: unknown;
  try { fn(); } catch (err) { caught = err; }
  expect(isNomusApiError(caught), String(caught)).toBe(true);
  expect((caught as Error).message).toMatch(message);
}

describe('verifyCorporateBundle (offline)', () => {
  it('accepts a correctly signed bundle and an empty enabled or disabled bundle', () => {
    const b = bundle([policy('corp.no-direct-openai'), policy('corp.a-first', { policyId: '9c8b7a6f-5e4d-4c3b-8a29-1f0e9d8c7b6a' })]);
    expect(verifyCorporateBundle(b, spki).policies).toHaveLength(2);
    expect(verifyCorporateBundle(bundle([]), spki).enabled).toBe(true);
    expect(verifyCorporateBundle(bundle([], false), spki).enabled).toBe(false);
  });

  it('the bundle hash is order-independent and ignores activation signatures', () => {
    const a = policy('corp.a');
    const z = policy('corp.z');
    expect(bundleHashOf([a, z])).toBe(bundleHashOf([z, a]));
    expect(bundleHashOf([{ ...a, activationSignature: 'x' }])).toBe(bundleHashOf([a]));
  });

  it('rejects a bundle signed by another key', () => {
    expectApiError(() => verifyCorporateBundle(bundle([policy('corp.a')]), other), /signature does not verify/);
  });

  it('rejects any tampering: enabled flag, policy content, rule, activation signature, hash', () => {
    const good = bundle([policy('corp.no-direct-openai')]);
    const cases: Array<[string, CorporateBundle, RegExp]> = [
      ['enabled flipped', { ...good, enabled: false }, /bundle signature/],
      ['tier lowered', { ...good, policies: [{ ...good.policies[0], tier: 'advisory' }] }, /bundle hash/],
      ['rule changed, hashes recomputed', (() => {
        const changed = corporateRuleSchema.parse({ ...rule, files: { include: ['web/**'], exclude: [] } });
        const p = { ...good.policies[0], rule: changed, ruleHash: ruleHashOf(changed) };
        const b = { ...good, policies: [p], bundleHash: bundleHashOf([p]) };
        return { ...b, signature: signText(bundleSignedText(b)) };
      })(), /activation signature/],
      ['rule changed, rule hash kept', (() => {
        const p = { ...good.policies[0], rule: corporateRuleSchema.parse({ ...rule, message: 'A different developer-facing message.' }) };
        const b = { ...good, policies: [p], bundleHash: bundleHashOf([p]) };
        return { ...b, signature: signText(bundleSignedText(b)) };
      })(), /does not match its hash/],
      ['activation signature swapped', { ...good, policies: [{ ...good.policies[0], activationSignature: policy('corp.other').activationSignature }] }, /activation signature/],
      ['disabled with policies', (() => {
        const b = { ...good, enabled: false };
        return { ...b, signature: signText(bundleSignedText(b)) };
      })(), /disabled/],
    ];
    for (const [name, b, msg] of cases) expectApiError(() => verifyCorporateBundle(b, spki), msg);
  });

  it('rejects responses that do not match the contract', () => {
    expectApiError(() => verifyCorporateBundle({ ...bundle([]), extra: 1 }, spki), /contract/);
    expectApiError(() => verifyCorporateBundle(null, spki), /contract/);
  });
});

function fakeFetch(routes: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const handler = routes[path];
    if (!handler) return new Response('not found', { status: 404 });
    (fakeFetch as unknown as { last?: RequestInit }).last = init;
    return handler();
  }) as typeof fetch;
}
const keys = () => Response.json({ keys: [{ spki }] });

describe('fetchCorporateBundle (fail closed)', () => {
  const apiUrl = 'http://nomus.local.example.org';

  it('returns the verified bundle with its ETag', async () => {
    const b = bundle([policy('corp.no-direct-openai')]);
    const res = await fetchCorporateBundle({ apiUrl, apiKey: 'k', fetchImpl: fakeFetch({ '/api/v1/cpg/bundle': () => Response.json(b, { headers: { etag: '"abc"' } }), '/.well-known/nomus-keys': keys }) });
    expect(res).toMatchObject({ available: true, etag: '"abc"', notModified: false });
  });

  it('a 404 means an engine without CPG: not available, not an error', async () => {
    const res = await fetchCorporateBundle({ apiUrl, apiKey: 'k', fetchImpl: fakeFetch({}) });
    expect(res).toEqual({ available: false });
  });

  it('a 304 returns the cached bundle after re-verifying it', async () => {
    const b = bundle([policy('corp.a')]);
    const res = await fetchCorporateBundle({ apiUrl, apiKey: 'k', cached: { bundle: b, etag: '"e"' }, fetchImpl: fakeFetch({ '/api/v1/cpg/bundle': () => new Response(null, { status: 304 }), '/.well-known/nomus-keys': keys }) });
    expect(res).toMatchObject({ available: true, notModified: true, etag: '"e"' });
  });

  it('throws NomusApiError on a network error, a 5xx, a 401, invalid JSON, a missing key or a bad signature', async () => {
    const cases: Array<[string, typeof fetch]> = [
      ['network', (async () => { throw new TypeError('fetch failed'); }) as typeof fetch],
      ['500', fakeFetch({ '/api/v1/cpg/bundle': () => Response.json({ error: 'x' }, { status: 500 }), '/.well-known/nomus-keys': keys })],
      ['401', fakeFetch({ '/api/v1/cpg/bundle': () => Response.json({ error: 'x' }, { status: 401 }), '/.well-known/nomus-keys': keys })],
      ['invalid json', fakeFetch({ '/api/v1/cpg/bundle': () => new Response('{', { status: 200 }), '/.well-known/nomus-keys': keys })],
      ['no key', fakeFetch({ '/api/v1/cpg/bundle': () => Response.json(bundle([])), '/.well-known/nomus-keys': () => Response.json({ keys: [] }) })],
      ['keys 503', fakeFetch({ '/api/v1/cpg/bundle': () => Response.json(bundle([])), '/.well-known/nomus-keys': () => Response.json({}, { status: 503 }) })],
      ['wrong key', fakeFetch({ '/api/v1/cpg/bundle': () => Response.json(bundle([])), '/.well-known/nomus-keys': () => Response.json({ keys: [{ spki: other }] }) })],
    ];
    for (const [name, f] of cases) {
      let caught: unknown;
      try { await fetchCorporateBundle({ apiUrl, apiKey: 'k', fetchImpl: f }); } catch (err) { caught = err; }
      expect(isNomusApiError(caught), name).toBe(true);
    }
  });
});

describe('scan-time purity (spec §8.3)', () => {
  const dir = import.meta.dirname;
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const NETWORK = /\bfetch\s*\(|from\s+['"](?:axios|node:http|node:https|http|https|node:net|undici)['"]|\brequire\(\s*['"](?:axios|http|https)['"]\s*\)/;

  it('only contracts.ts and bundle-client.ts may touch the network', () => {
    const offenders = sources.filter((f) => !['contracts.ts', 'bundle-client.ts'].includes(f) && NETWORK.test(readFileSync(join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the matcher imports none of the network modules, directly or through corporate/ imports, and no LLM code', () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(join(dir, file), 'utf8');
      for (const m of text.matchAll(/from\s+['"]\.\/([\w-]+)\.js['"]/g)) visit(`${m[1]}.ts`);
    };
    visit('matcher.ts');
    expect([...seen].sort()).not.toContain('bundle-client.ts');
    expect([...seen].sort()).not.toContain('contracts.ts');
    for (const f of seen) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(NETWORK.test(text), f).toBe(false);
      expect(/from\s+['"][^'"]*(?:llm|openai|anthropic|generative-ai)[^'"]*['"]/i.test(text), f).toBe(false);
    }
    // The detectors the matcher runs import no HTTP client either.
    const detectDir = join(dir, '..', 'detect');
    for (const f of readdirSync(detectDir).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
      expect(NETWORK.test(readFileSync(join(detectDir, f), 'utf8')), f).toBe(false);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalSdkFamily, EMITTED_CAPABILITIES, KNOWN_SDKS, SDK_ALIASES } from './vocab.js';
import { __test__ as sdkUsage } from '../detect/sdk-usage-detector.js';
import { __test__ as risk } from '../detect/risk-classifier.js';
import { __test__ as transparency } from '../detect/transparency-detector.js';
import { __test__ as dataFlow } from '../detect/data-flow-detector.js';
import { PhiPatternDetector } from '../detect/phi-pattern-detector.js';
import { DataFlowDetector } from '../detect/data-flow-detector.js';
import { SdkUsageDetector } from '../detect/sdk-usage-detector.js';
import { languageOf } from './languages.js';
import { canonicalRepo, isCanonicalRepo } from './repo.js';

/**
 * Vocabulary drift (design spec §8.4.1): every capability a behavioural
 * detector can emit, and every SDK name any detector reports, must be in the
 * closed vocabulary. A detector change that adds one fails here until vocab.ts
 * (and so the compile prompt and the rule schema) knows it.
 */

const emitted = new Set<string>(EMITTED_CAPABILITIES);

describe('vocabulary drift', () => {
  it('sdk-usage-detector: every method and default capability', () => {
    const caps = new Set<string>(['processes_user_input']);
    for (const spec of sdkUsage.SDK_SPECS) {
      for (const c of spec.defaultCapabilities) caps.add(c);
      for (const list of Object.values(spec.methods)) for (const c of list) caps.add(c);
      for (const list of Object.values(spec.commands ?? {})) for (const c of list) caps.add(c);
    }
    expect([...caps].filter((c) => !emitted.has(c))).toEqual([]);
  });

  it('risk-classifier and transparency-detector: every category capability', () => {
    const caps = new Set<string>(['handles_biometric']);
    for (const c of risk.CATEGORIES) caps.add(c.capability);
    for (const c of transparency.CATEGORIES) caps.add(c.capability);
    expect([...caps].filter((c) => !emitted.has(c))).toEqual([]);
  });

  it('data-flow-detector: every sink capability, and processes_user_input', async () => {
    const sinkKinds = [...new Set(dataFlow.SINK_PATTERNS.map(([k]) => k))];
    const code = [
      'async function a(req, res) {',
      '  const q = req.body.q;',
      '  const out = await openai.chat.completions.create({ messages: q });',
      '  res.json(out); console.log(out); db.insert(out); await fetch("https://x.example.org", { body: out });',
      '}',
    ].join('\n');
    const caps = new Set<string>();
    // One AI call per sink kind, each followed by only that sink.
    const sinkLines: Record<string, string> = {
      returns_to_user: 'res.json(out);', logs_output: 'console.log(out);', stores_output: 'db.insert(out);', third_party: 'fetch("https://x.example.org");',
    };
    expect(Object.keys(sinkLines).sort()).toEqual([...sinkKinds].sort());
    for (const sink of sinkKinds) {
      const file = `const out = await openai.chat.completions.create({ messages: m });\n${sinkLines[sink]}\n`;
      for (const s of await new DataFlowDetector().detect({ rootDir: '', files: ['f.js'], fileContents: new Map([['f.js', file]]), config: { jurisdictions: [] } })) {
        for (const c of s.capabilities) caps.add(c);
      }
    }
    for (const s of await new DataFlowDetector().detect({ rootDir: '', files: ['g.js'], fileContents: new Map([['g.js', code]]), config: { jurisdictions: [] } })) {
      for (const c of s.capabilities) caps.add(c);
    }
    expect(caps.size).toBeGreaterThanOrEqual(5);
    expect([...caps].filter((c) => !emitted.has(c))).toEqual([]);
  });

  it('phi-pattern-detector: every category, AI-proximity and log-proximity capability', async () => {
    const code = [
      'const patient_id = rec.id;', 'const ssn = rec.ssn;', 'const card_number = rec.card;',
      'openai.chat.completions.create({ messages: [patient_id, ssn, card_number] });',
      'console.log(patient_id, ssn);',
    ].join('\n');
    const caps = new Set<string>();
    for (const s of await new PhiPatternDetector().detect({ rootDir: '', files: ['p.ts'], fileContents: new Map([['p.ts', code]]), config: { jurisdictions: [] } })) {
      for (const c of s.capabilities) caps.add(c);
    }
    for (const c of ['contains_phi', 'contains_pii', 'contains_financial', 'phi_in_ai_call', 'pii_in_ai_call', 'logs_phi', 'logs_pii']) expect(caps.has(c), c).toBe(true);
    expect([...caps].filter((c) => !emitted.has(c))).toEqual([]);
    // The detector source names no other capability literal.
    const src = readFileSync(join(import.meta.dirname, '..', 'detect', 'phi-pattern-detector.ts'), 'utf8');
    const literals = [...src.matchAll(/baseCaps\.push\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    expect(literals.length).toBeGreaterThan(0);
    expect(literals.filter((c) => !emitted.has(c))).toEqual([]);
  });

  it('every SDK name a detector reports maps to a known SDK family', async () => {
    const names = new Set<string>(sdkUsage.SDK_SPECS.map((s) => s.sdk));
    for (const m of ['openai', 'anthropic', 'cohere', 'bedrock', 'genai', 'generativeai']) names.add(m); // DYNAMIC_RE alternatives
    // Import-detector targets are the keys of the SDK capability map and the import pattern tables.
    const importsSrc = readFileSync(join(import.meta.dirname, '..', 'detect', 'imports.ts'), 'utf8');
    for (const m of importsSrc.matchAll(/\{ sdk: '([^']+)'/g)) names.add(m[1]);
    expect(names.size).toBeGreaterThan(15);
    expect([...names].filter((n) => canonicalSdkFamily(n) === null)).toEqual([]);
    for (const family of Object.values(SDK_ALIASES)) expect(KNOWN_SDKS).toContain(family);
    // And the dynamic-call regex really emits those raw names.
    const dyn = await new SdkUsageDetector().detect({ rootDir: '', files: ['d.py'], fileContents: new Map([['d.py', 'genai[name](x)\n']]), config: { jurisdictions: [] } });
    expect(dyn.map((s) => (s.metadata as { sdk: string }).sdk)).toEqual(['genai']);
  });

  it('every detector file is covered by this test', () => {
    const detectors = readdirSync(join(import.meta.dirname, '..', 'detect')).filter((f) => /-(detector|classifier)\.ts$/.test(f) && !f.endsWith('.test.ts')).sort();
    expect(detectors).toEqual(['data-flow-detector.ts', 'import-detector.ts', 'phi-pattern-detector.ts', 'risk-classifier.ts', 'sdk-usage-detector.ts', 'transparency-detector.ts']);
  });
});

describe('language and repository helpers', () => {
  it('languageOf maps by extension', () => {
    expect(['a.ts', 'b.tsx', 'c.js', 'd.mjs', 'e.py', 'f.java', 'g.go', 'h.rb', 'Makefile'].map(languageOf))
      .toEqual(['typescript', 'typescript', 'javascript', 'javascript', 'python', 'java', 'go', 'other', 'other']);
  });

  it('canonicalRepo: owner/name for github.com, host/owner/name elsewhere, lowercase', () => {
    const cases: Array<[string, string | null]> = [
      ['Example-Org/Payments', 'example-org/payments'],
      ['https://github.com/Example-Org/Payments.git', 'example-org/payments'],
      ['git@github.com:Example-Org/Payments.git', 'example-org/payments'],
      ['ssh://git@github.com/example-org/payments', 'example-org/payments'],
      ['github.com/example-org/payments', 'example-org/payments'],
      ['https://git.example.org/team/svc', 'git.example.org/team/svc'],
      ['git@git.example.org:team/svc.git', 'git.example.org/team/svc'],
      ['payments', null],
      ['a/b/c/d', null],
      ['https://git.example.org/a/b/c', null],
      ['ftp://example.org/a/b', null],
      ['owner/../name', null],
      ['', null],
    ];
    for (const [input, expected] of cases) expect(canonicalRepo(input), input).toBe(expected);
    expect(isCanonicalRepo('example-org/payments')).toBe(true);
    expect(isCanonicalRepo('Example-Org/payments')).toBe(false);
  });
});

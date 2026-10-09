import { describe, it, expect } from 'vitest';
import { evaluateCorporateRules, evaluateRuleOnText, MAX_CORPORATE_FILE_BYTES, toRepoRelative, type CorporatePolicyInput } from './matcher.js';
import { corporateRuleSchema, type CorporateRuleInput } from './rule-schema.js';
import { fingerprintOf } from './fingerprint.js';
import { MAX_REGEX_LINE_LENGTH } from './regex-safety.js';

const rule = (r: Partial<CorporateRuleInput> & Pick<CorporateRuleInput, 'match'>) => corporateRuleSchema.parse({
  schemaVersion: 1,
  files: {},
  message: 'Corporate policy test message.',
  ...r,
});

const OPENAI_CHAT = [
  "import OpenAI from 'openai';",
  'const client = new OpenAI();',
  'export async function ask(q: string) {',
  '  return client.chat.completions.create({',
  "    model: 'gpt-4o',",
  "    messages: [{ role: 'user', content: q }],",
  '  });',
  '}',
].join('\n');

describe('matcher primitives', () => {
  it('sdk_call: an AST-traced call, its range covering the whole call expression (endLine)', async () => {
    const r = await evaluateRuleOnText(rule({ match: { all: [{ kind: 'sdk_call', sdks: ['openai'] }] } }), 'src/chat.ts', OPENAI_CHAT);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect([f.startLine, f.endLine, f.anchorLine, f.matchedBy, f.language]).toEqual([4, 7, 4, 'sdk_call', 'typescript']);
    expect(f.snippet).toBe(OPENAI_CHAT.split('\n').slice(3, 7).join('\n'));
    expect(f.fingerprint).toBe(fingerprintOf(f.snippet, 'corp.example', 1));
  });

  it('sdk_call: methods narrow the match; other SDKs never match', async () => {
    const moderation = rule({ match: { all: [{ kind: 'sdk_call', sdks: ['openai'], methods: ['moderations.create'] }] } });
    expect((await evaluateRuleOnText(moderation, 'src/chat.ts', OPENAI_CHAT)).findings).toHaveLength(0);
    const anthropic = rule({ match: { all: [{ kind: 'sdk_call', sdks: ['anthropic'] }] } });
    expect((await evaluateRuleOnText(anthropic, 'src/chat.ts', OPENAI_CHAT)).findings).toHaveLength(0);
  });

  it('sdk_call: Python uses the regex engine and canonical SDK families', async () => {
    const py = 'import anthropic\nclient = anthropic.Anthropic()\nmsg = client.messages.create(model="x", messages=[])\n';
    const r = await evaluateRuleOnText(rule({ match: { all: [{ kind: 'sdk_call', sdks: ['anthropic'], methods: ['messages.create'] }] } }), 'app/bot.py', py);
    expect(r.findings.map((f) => [f.startLine, f.language])).toEqual([[3, 'python']]);
  });

  it('sdk_import: imports in JS and Python, mapped to the SDK family', async () => {
    const r = await evaluateCorporateRules([
      ['web/a.ts', "import Anthropic from '@anthropic-ai/sdk';\n"],
      ['svc/b.py', 'from anthropic import Anthropic\n'],
      ['web/c.ts', "import OpenAI from 'openai';\n"],
    ], [{ policyKey: 'corp.no-anthropic', version: 2, rule: rule({ match: { all: [{ kind: 'sdk_import', sdks: ['anthropic'] }] } }) }]);
    expect(r.findings.map((f) => `${f.filePath}:${f.startLine}:${f.policyVersion}`)).toEqual(['svc/b.py:1:2', 'web/a.ts:1:2']);
  });

  it('capability: behavioural detector signals (pii_in_ai_call)', async () => {
    const code = [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      'export async function summarize(user: { ssn: string }) {',
      '  const ssn = user.ssn;',
      "  return openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: ssn }] });",
      '}',
    ].join('\n');
    const r = await evaluateRuleOnText(rule({ match: { all: [{ kind: 'capability', capabilities: ['pii_in_ai_call'] }] } }), 'src/summarize.ts', code);
    // Line 3 declares an `ssn` field and line 4 an `ssn` variable, both within 5 lines of the AI call.
    expect(r.findings.map((f) => f.anchorLine)).toEqual([3, 4]);
  });

  it('capability: an SDK import alone does not imply its potential capabilities', async () => {
    const r = await evaluateRuleOnText(rule({ match: { all: [{ kind: 'capability', capabilities: ['image_generation'] }] } }), 'src/x.ts', "import OpenAI from 'openai';\nconst c = new OpenAI();\n");
    expect(r.findings).toHaveLength(0);
  });

  it('data_pattern: category and label', async () => {
    const code = "const record = { ssn: '219-09-9999' };\nconst card_number = input.card;\n";
    const ssn = await evaluateRuleOnText(rule({ match: { all: [{ kind: 'data_pattern', categories: ['pii'], labels: ['ssn'] }] } }), 'src/r.ts', code);
    expect(ssn.findings.map((f) => f.anchorLine)).toEqual([1]);
    const fin = await evaluateRuleOnText(rule({ match: { all: [{ kind: 'data_pattern', categories: ['financial'] }] } }), 'src/r.ts', code);
    expect(fin.findings.map((f) => f.anchorLine)).toEqual([2]);
  });

  it('data_flow: AI output reaching a log sink', async () => {
    const code = [
      'async function run(prompt) {',
      '  const out = await openai.chat.completions.create({ messages: prompt });',
      '  console.log(out);',
      '}',
    ].join('\n');
    const logs = await evaluateRuleOnText(rule({ match: { all: [{ kind: 'data_flow', sinks: ['logs_output'] }] } }), 'src/run.js', code);
    expect(logs.findings.map((f) => f.anchorLine)).toEqual([2]);
    const stores = await evaluateRuleOnText(rule({ match: { all: [{ kind: 'data_flow', sinks: ['stores_output'] }] } }), 'src/run.js', code);
    expect(stores.findings).toHaveLength(0);
  });

  it('line_regex: per line, comments ignored by default, case flag honoured', async () => {
    const code = "const a = 'gpt-4-32k';\n// const b = 'gpt-4-32k';\nconst c = 'GPT-4-32K';\n";
    const exact = await evaluateRuleOnText(rule({ match: { all: [{ kind: 'line_regex', pattern: { source: 'gpt-4-32k', flags: '' } }] } }), 'src/m.ts', code);
    expect(exact.findings.map((f) => f.anchorLine)).toEqual([1]);
    const insensitive = await evaluateRuleOnText(rule({ match: { all: [{ kind: 'line_regex', pattern: { source: 'gpt-4-32k', flags: 'i', ignoreComments: false } }] } }), 'src/m.ts', code);
    expect(insensitive.findings.map((f) => f.anchorLine)).toEqual([1, 2, 3]);
  });

  it(`line_regex: lines over ${MAX_REGEX_LINE_LENGTH} characters are skipped and counted`, async () => {
    const code = `x = 'gpt-4-32k'\n${'a'.repeat(MAX_REGEX_LINE_LENGTH + 1)}gpt-4-32k\n`;
    const r = await evaluateRuleOnText(rule({ match: { all: [{ kind: 'line_regex', pattern: { source: 'gpt-4-32k', flags: '' } }] } }), 'app/m.py', code);
    expect(r.findings.map((f) => f.anchorLine)).toEqual([1]);
    expect(r.skippedLongLines).toBe(1);
  });
});

describe('combining matchers', () => {
  const chatThenModeration = (gap: number) => [
    'async function handle(q) {',
    '  const res = await openai.chat.completions.create({ messages: [q] });',
    ...Array.from({ length: gap }, (_, i) => `  const pad${i} = ${i};`),
    '  await openai.moderations.create({ input: res });',
    '}',
  ].join('\n');
  const moderated = rule({
    match: {
      all: [{ kind: 'sdk_call', sdks: ['openai'], methods: ['chat.completions.create'] }],
      withinLines: 20,
      unless: [{ kind: 'sdk_call', sdks: ['openai'], methods: ['moderations.create'] }],
      unlessScope: 'window',
    },
  });

  it('unless (window): a moderation call within 20 lines suppresses the anchor', async () => {
    expect((await evaluateRuleOnText(moderated, 'src/h.js', chatThenModeration(5))).findings).toHaveLength(0);
  });

  it('unless (window): a moderation call further away does not', async () => {
    expect((await evaluateRuleOnText(moderated, 'src/h.js', chatThenModeration(30))).findings.map((f) => f.anchorLine)).toEqual([2]);
  });

  it('unless (file): anywhere in the file suppresses', async () => {
    const fileWide = rule({ match: { ...moderated.match, unlessScope: 'file', withinLines: null } });
    expect((await evaluateRuleOnText(fileWide, 'src/h.js', chatThenModeration(30))).findings).toHaveLength(0);
  });

  it('all + withinLines: the companion must be near the anchor; the range is their union', async () => {
    const both = rule({
      match: {
        all: [
          { kind: 'sdk_call', sdks: ['openai'], methods: ['chat.completions.create'] },
          { kind: 'line_regex', pattern: { source: 'temperature:\\s*1', flags: '' } },
        ],
        withinLines: 3,
      },
    });
    const near = 'async function f(m) {\n  const t = { temperature: 1 };\n  return openai.chat.completions.create({ messages: m, ...t });\n}\n';
    const r = await evaluateRuleOnText(both, 'src/f.js', near);
    expect(r.findings.map((f) => [f.startLine, f.endLine, f.anchorLine])).toEqual([[2, 3, 3]]);
    const far = `async function f(m) {\n  const t = { temperature: 1 };\n${'  // pad\n'.repeat(10)}  return openai.chat.completions.create({ messages: m, ...t });\n}\n`;
    expect((await evaluateRuleOnText(both, 'src/f.js', far)).findings).toHaveLength(0);
  });
});

describe('file scoping and fixed exclusions', () => {
  const regex = rule({ match: { all: [{ kind: 'line_regex', pattern: { source: 'forbidden-model', flags: '' } }] }, files: { include: ['src/**'], exclude: ['src/vendor/**'], languages: ['typescript'] } });
  const line = "const m = 'forbidden-model';\n";

  it('honours include, exclude and languages', async () => {
    const r = await evaluateCorporateRules([
      ['src/a.ts', line], ['src/vendor/b.ts', line], ['lib/c.ts', line], ['src/d.py', line], ['src\\win\\e.ts', line],
    ], [{ policyKey: 'corp.no-forbidden-model', version: 1, rule: regex }]);
    expect(r.findings.map((f) => f.filePath)).toEqual(['src/a.ts', 'src/win/e.ts']);
    expect(r.scannedFileCount).toBe(2);
  });

  it('ignores the repository ignore list (there is none to pass) but always skips .git, node_modules, large and binary files', async () => {
    const r = await evaluateCorporateRules([
      ['src/node_modules/x.ts', line], ['src/.git/y.ts', line], ['src/big.ts', line + 'x'.repeat(MAX_CORPORATE_FILE_BYTES)],
      ['src/bin.ts', `\u0000${line}`], ['../escape.ts', line], ['src/ok.ts', line],
    ], [{ policyKey: 'corp.no-forbidden-model', version: 1, rule: regex }]);
    expect(r.findings.map((f) => f.filePath)).toEqual(['src/ok.ts']);
    expect(r.skippedFiles.map((s) => [s.filePath, s.reason])).toEqual([
      ['src/node_modules/x.ts', 'excluded_directory'], ['src/.git/y.ts', 'excluded_directory'], ['src/big.ts', 'too_large'],
      ['src/bin.ts', 'binary'], ['../escape.ts', 'invalid_path'],
    ]);
  });

  it('toRepoRelative rejects absolute and escaping paths', () => {
    expect(toRepoRelative('./src/a.ts')).toBe('src/a.ts');
    for (const bad of ['/etc/passwd', 'C:\\x\\y.ts', 'a/../../b', '']) expect(toRepoRelative(bad), bad).toBeNull();
  });
});

describe('BOM and line endings', () => {
  const r = rule({ match: { all: [{ kind: 'line_regex', pattern: { source: 'forbidden-model', flags: '' } }] } });
  it('the same code with a BOM, CRLF or CR line endings gives the same finding and fingerprint', async () => {
    const lf = "const a = 1;\nconst m = 'forbidden-model';\n";
    const variants = [lf, `\uFEFF${lf}`, lf.replace(/\n/g, '\r\n'), lf.replace(/\n/g, '\r')];
    const results = await Promise.all(variants.map((v) => evaluateRuleOnText(r, 'src/a.ts', v)));
    const summary = results.map((x) => x.findings.map((f) => `${f.startLine}:${f.fingerprint}`));
    expect(summary[0]).toHaveLength(1);
    for (const s of summary) expect(s).toEqual(summary[0]);
  });
});

describe('determinism and output contract', () => {
  const policies: CorporatePolicyInput[] = [
    { policyKey: 'corp.b-regex', version: 1, rule: rule({ match: { all: [{ kind: 'line_regex', pattern: { source: 'create', flags: '' } }] } }) },
    { policyKey: 'corp.a-openai', version: 3, rule: rule({ match: { all: [{ kind: 'sdk_call', sdks: ['openai'] }] }, snippet: { contextBefore: 1, contextAfter: 1 } }) },
  ];
  const files: Array<[string, string]> = [['src/z.ts', OPENAI_CHAT], ['src/a.ts', OPENAI_CHAT]];

  it('repeated runs give byte-identical findings, sorted by (file, startLine, policyKey)', async () => {
    const runs = await Promise.all(Array.from({ length: 5 }, () => evaluateCorporateRules(files, policies)));
    const json = runs.map((x) => JSON.stringify(x));
    expect(new Set(json).size).toBe(1);
    const order = runs[0].findings.map((f) => `${f.filePath}:${f.startLine}:${f.policyKey}`);
    expect(order).toEqual(['src/a.ts:3:corp.a-openai', 'src/a.ts:4:corp.b-regex', 'src/z.ts:3:corp.a-openai', 'src/z.ts:4:corp.b-regex']);
  });

  it('one finding per (policy, file, range) even when several anchors widen to the same range', async () => {
    const twoHits = "x = 'forbidden-model'; y = 'forbidden-model'\n";
    const r = await evaluateRuleOnText(rule({ match: { all: [{ kind: 'line_regex', pattern: { source: 'forbidden-model', flags: '' } }] } }), 'a.py', twoHits);
    expect(r.findings).toHaveLength(1);
  });
});

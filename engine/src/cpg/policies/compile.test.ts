/**
 * The policy compile pipeline (design spec §8.1), with a stubbed provider:
 * every status branch, the stored record, and proof that the author's
 * example code never reaches the provider.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { cpgCompileRecords } from '../../db/schema-cpg.js';
import type { LLMResponse } from '../../llm/provider.js';
import { CPG_COMPILE_PROMPT_PREFIX, CPG_COMPILE_PROMPT_VERSION, buildCompileSystemPrompt } from '../../llm/prompts/cpg-compile.js';
import { compilePolicy, compileRequestSchema, extractJson, MAX_RAW_OUTPUT, type CompileRequest } from './compile.js';
import { serializeCompileRecord } from './serialize.js';
import { makeOrg } from '../__fixtures__/rbac-fixtures.js';

let orgId: string;
const ACTOR = 'user:4b8c2d1e-6f3a-4e5b-9c7d-8a1b2c3d4e5f';

const VIOLATING = "import OpenAI from 'openai';\nconst client = new OpenAI();\nexport const ask = (q: string) => client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: q }] });\n";
const COMPLIANT = "import OpenAI from 'openai';\nconst gateway = new OpenAI();\nexport const ask = (q: string) => gateway.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: q }] });\n";

const request = (over: Partial<CompileRequest> = {}): CompileRequest => compileRequestSchema.parse({
  plainText: 'Do not call OpenAI directly; every call must go through the approved LLM gateway.',
  examples: {
    violating: [{ path: 'src/app/chat.ts', code: VIOLATING }],
    compliant: [{ path: 'src/llm/gateway/client.ts', code: COMPLIANT }],
  },
  ...over,
});

const OPENAI_RULE = {
  schemaVersion: 1,
  match: { all: [{ kind: 'sdk_call', sdks: ['openai'] }] },
  files: { include: ['**/*'], exclude: ['src/llm/gateway/**'] },
  message: 'Call OpenAI only through the approved LLM gateway.',
};

const expressible = (rule: unknown = OPENAI_RULE) => JSON.stringify({
  expressible: true, suggestedKey: 'corp.no-direct-openai', title: 'No direct OpenAI calls', suggestedTier: 'prohibited',
  rule, rationale: 'The SDK-call primitive finds direct calls; the gateway is excluded.', limitations: ['Calls through other HTTP clients are not seen.'],
});

interface Call { system: string; user: string }
function stub(content: string | (() => never), calls: Call[] = []) {
  return async (system: string, user: string): Promise<LLMResponse> => {
    calls.push({ system, user });
    if (typeof content === 'function') content();
    return { content: content as string, tokensIn: 120, tokensOut: 80, model: 'stub-model', provider: 'openai' };
  };
}

const stored = (id: string) => getDb().select().from(cpgCompileRecords).where(eq(cpgCompileRecords.id, id)).get()!;

beforeAll(() => {
  runMigrations();
  orgId = makeOrg('Compile');
});

describe('compile pipeline: every status branch is recorded (no throw)', () => {
  it('compiled: valid rule, examples verified, hash and tokens stored', async () => {
    const row = await compilePolicy(getDb(), { orgId, actor: ACTOR, request: request() }, stub(expressible()));
    expect(row.status).toBe('compiled');
    const r = serializeCompileRecord(stored(row.id));
    expect(r.compiledRule?.match.all[0]).toEqual({ kind: 'sdk_call', sdks: ['openai'] });
    expect(r.compiledRuleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.exampleResults?.map((e) => [e.kind, e.passed, e.findings])).toEqual([['violating', true, 1], ['compliant', true, 0]]);
    expect(r.suggestion).toMatchObject({ expressible: true, suggestedKey: 'corp.no-direct-openai', suggestedTier: 'prohibited' });
    expect([r.provider, r.model, r.tokensIn, r.tokensOut, r.promptVersion]).toEqual(['openai', 'stub-model', 120, 80, CPG_COMPILE_PROMPT_VERSION]);
    expect(r.rejection).toBeNull();
  });

  it('rejected_unexpressible: the reason is kept verbatim for the author', async () => {
    const reason = 'Requires a judgement about design quality, which a deterministic rule cannot make.';
    const row = await compilePolicy(getDb(), { orgId, actor: ACTOR, request: request({ plainText: 'All AI integrations must be well designed and in good taste.' }) },
      stub(JSON.stringify({ expressible: false, reason })));
    const r = serializeCompileRecord(row);
    expect(r.status).toBe('rejected_unexpressible');
    expect(r.rejection).toEqual({ code: 'unexpressible', reasons: [reason] });
    expect(r.suggestion).toEqual({ expressible: false, reason, closestExpressible: null });
    expect(r.compiledRule).toBeNull();
  });

  it('rejected_schema: not JSON, an empty object, extra keys', async () => {
    for (const content of ['I think this policy is fine.', '{}', expressible().replace('"expressible":true', '"expressible":true,"severity":"high"')]) {
      const row = await compilePolicy(getDb(), { orgId, actor: ACTOR, request: request() }, stub(content));
      expect(row.status, content.slice(0, 30)).toBe('rejected_schema');
      expect(JSON.parse(row.rejection!).reasons.length).toBeGreaterThan(0);
    }
  });

  it('rejected_validation: closed vocabulary, unsafe regex and placeholders, with every reason', async () => {
    const rule = { ...OPENAI_RULE, match: { all: [{ kind: 'line_regex', pattern: { source: '(a+)+$', flags: '' } }] }, message: 'Use {{gateway}} for every call.' };
    const row = await compilePolicy(getDb(), { orgId, actor: ACTOR, request: request() }, stub(expressible(rule)));
    expect(row.status).toBe('rejected_validation');
    const reasons = JSON.parse(row.rejection!).reasons.join('; ');
    expect(reasons).toMatch(/nested quantifiers/);
    expect(reasons).toMatch(/placeholders/);
    const unknownSdk = await compilePolicy(getDb(), { orgId, actor: ACTOR, request: request() }, stub(expressible({ ...OPENAI_RULE, match: { all: [{ kind: 'sdk_call', sdks: ['skynet'] }] } })));
    expect(unknownSdk.status).toBe('rejected_validation');
  });

  it('rejected_examples: a violating example the rule misses, or a compliant example it flags', async () => {
    const missed = await compilePolicy(getDb(), { orgId, actor: ACTOR, request: request({
      examples: { violating: [{ path: 'src/app/util.ts', code: 'export const add = (a: number, b: number) => a + b;\n' }], compliant: [] },
    }) }, stub(expressible()));
    expect(missed.status).toBe('rejected_examples');
    const results = serializeCompileRecord(missed).exampleResults!;
    expect(results).toEqual([{ kind: 'violating', index: 0, path: 'src/app/util.ts', expected: 'finding', findings: 0, lines: [], passed: false, note: 'The rule did not match this example.' }]);

    const flagged = await compilePolicy(getDb(), { orgId, actor: ACTOR, request: request({
      examples: { violating: [{ path: 'src/app/chat.ts', code: VIOLATING }], compliant: [{ path: 'src/app/other.ts', code: COMPLIANT }] },
    }) }, stub(expressible()));
    expect(flagged.status).toBe('rejected_examples');
    expect(JSON.parse(flagged.rejection!).reasons[0]).toMatch(/compliant example 1/);

    const testPath = await compilePolicy(getDb(), { orgId, actor: ACTOR, request: request({
      examples: { violating: [{ path: 'src/app/chat.test.ts', code: VIOLATING }], compliant: [] },
    }) }, stub(expressible()));
    expect(serializeCompileRecord(testPath).exampleResults![0].note).toMatch(/test files/);
  });

  it('llm_error: a provider failure is recorded, never thrown (no 5xx)', async () => {
    const row = await compilePolicy(getDb(), { orgId, actor: ACTOR, request: request() }, stub(() => { throw new Error('upstream 503: overloaded'); }));
    expect(row.status).toBe('llm_error');
    expect(JSON.parse(row.rejection!)).toEqual({ code: 'llm_error', reasons: ['upstream 503: overloaded'] });
    expect([row.provider, row.rawOutput, row.compiledRule]).toEqual([null, null, null]);
  });

  it('accepts one fenced JSON block, caps the raw output at 64 KiB', async () => {
    const fenced = `Here is the rule:\n\`\`\`json\n${expressible()}\n\`\`\`\n`;
    expect((await compilePolicy(getDb(), { orgId, actor: ACTOR, request: request() }, stub(fenced))).status).toBe('compiled');
    expect(extractJson('```json\n{"a":1}\n```\n```json\n{"b":2}\n```')).toBeUndefined();
    const huge = await compilePolicy(getDb(), { orgId, actor: ACTOR, request: request() }, stub('x'.repeat(MAX_RAW_OUTPUT + 500)));
    expect(huge.status).toBe('rejected_schema');
    expect(huge.rawOutput).toHaveLength(MAX_RAW_OUTPUT);
  });
});

describe('no example code is sent to the provider (spec §8.1, §16.2)', () => {
  it('the prompt carries the policy text and none of the example code', async () => {
    const calls: Call[] = [];
    const secretViolating = `${VIOLATING}// marker-violating-7d1f\n`;
    const secretCompliant = `${COMPLIANT}// marker-compliant-3a9c\n`;
    await compilePolicy(getDb(), { orgId, actor: ACTOR, request: request({
      examples: { violating: [{ path: 'src/app/marker-path-violating.ts', code: secretViolating }], compliant: [{ path: 'src/llm/gateway/marker-path.ts', code: secretCompliant }] },
    }) }, stub(expressible(), calls));
    expect(calls).toHaveLength(1);
    const sent = calls[0].system + calls[0].user;
    expect(calls[0].user).toContain('Do not call OpenAI directly');
    expect(calls[0].system.startsWith(CPG_COMPILE_PROMPT_PREFIX)).toBe(true);
    for (const marker of ['marker-violating-7d1f', 'marker-compliant-3a9c', 'marker-path', 'client.chat.completions.create', 'gateway.chat.completions.create']) {
      expect(sent.includes(marker), marker).toBe(false);
    }
  });

  it('the system prompt states the closed vocabulary and the unexpressible instruction', () => {
    const system = buildCompileSystemPrompt();
    for (const s of ['"sdk_call"', '"pii_in_ai_call"', '"logs_output"', 'expressible": false', 'Return one JSON object and nothing else']) expect(system).toContain(s);
  });

  it('a compile request needs at least one violating example (D21) and refuses unknown keys', () => {
    expect(compileRequestSchema.safeParse({ plainText: 'Do not call OpenAI directly from any service.', examples: { violating: [] } }).success).toBe(false);
    expect(compileRequestSchema.safeParse({ ...request(), sendExamplesToModel: true }).success).toBe(false);
  });
});

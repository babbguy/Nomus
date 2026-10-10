import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../../db/client.js';
import { z } from 'zod';
import {
  canonicalJson, compileGlobList, corporateRuleSchema, evaluateRuleOnText, isTestFile, ruleHashOf, toRepoRelative,
  validateCorporateRule, POLICY_KEY_RE, TIERS, type CorporateRule,
} from '@nomus/scanner/corporate';
import { cpgCompileRecords } from '../../db/schema-cpg.js';
import { generateWithFallback, isLlmProviderConfigured, type LLMResponse } from '../../llm/provider.js';
import {
  buildCompileSystemPrompt, buildCompileUserMessage, CPG_COMPILE_PROMPT_VERSION,
} from '../../llm/prompts/cpg-compile.js';
import { logger } from '../../logger.js';

/**
 * The policy compile pipeline (design spec §8.1): plain English → LLM →
 * structured corporate rule → deterministic checks. Every attempt is stored
 * as a cpg_compile_records row whatever its outcome; an LLM outage is a
 * recorded `llm_error`, never a 5xx. A compiled rule is never activated
 * here: at most it can be proposed, and a different person must approve it.
 *
 * Only the policy text goes to the provider. The author's example code stays
 * on the server and is used only for the deterministic example check.
 */

export const MAX_RAW_OUTPUT = 65_536;

const exampleSchema = z.object({ path: z.string().min(1).max(300), code: z.string().min(1).max(16_384) }).strict();

export const compileRequestSchema = z.object({
  plainText: z.string().trim().min(20).max(8000),
  policyId: z.string().uuid().optional(),
  examples: z.object({
    violating: z.array(exampleSchema).min(1).max(10),
    compliant: z.array(exampleSchema).max(10).default([]),
  }).strict(),
}).strict();
export type CompileRequest = z.infer<typeof compileRequestSchema>;

/** What the LLM must return (§8.1), validated strictly. */
const compileOutputSchema = z.discriminatedUnion('expressible', [
  z.object({
    expressible: z.literal(true),
    suggestedKey: z.string().regex(POLICY_KEY_RE),
    title: z.string().min(3).max(120).regex(/^[^\r\n]*$/),
    suggestedTier: z.enum(TIERS),
    rule: z.unknown(),
    rationale: z.string().min(1).max(1000),
    limitations: z.array(z.string().max(300)).max(10),
  }).strict(),
  z.object({
    expressible: z.literal(false),
    reason: z.string().min(10).max(1000),
    closestExpressible: z.string().max(500).optional(),
  }).strict(),
]);

type CompileStatus = 'compiled' | 'rejected_unexpressible' | 'rejected_schema' | 'rejected_validation' | 'rejected_examples' | 'llm_error';

interface ExampleResult {
  kind: 'violating' | 'compliant';
  index: number;
  path: string;
  expected: 'finding' | 'no_finding';
  findings: number;
  lines: number[];
  passed: boolean;
  note: string | null;
}

type Suggestion =
  | { expressible: true; suggestedKey: string; title: string; suggestedTier: (typeof TIERS)[number]; rationale: string; limitations: string[] }
  | { expressible: false; reason: string; closestExpressible: string | null };

export type CompileRecordRow = typeof cpgCompileRecords.$inferSelect;

export type Generate = (system: string, user: string) => Promise<LLMResponse>;

const defaultGenerate: Generate = (system, user) => generateWithFallback('translator', system, user);

/** Accept the whole content, or the content of exactly one fenced block. */
export function extractJson(content: string): unknown | undefined {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch { /* try a fenced block */ }
  const fences = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n?```/g)];
  if (fences.length !== 1) return undefined;
  try {
    return JSON.parse(fences[0][1]);
  } catch {
    return undefined;
  }
}

/**
 * Verify a rule against the author's examples with the same deterministic
 * matcher the scanner runs (§8.1 step 6): every violating example must give
 * at least one finding, every compliant example none.
 */
export async function verifyExamples(rule: CorporateRule, examples: CompileRequest['examples']): Promise<{ passed: boolean; results: ExampleResult[] }> {
  const include = compileGlobList(rule.files.include);
  const exclude = compileGlobList(rule.files.exclude);
  const results: ExampleResult[] = [];
  const run = async (kind: 'violating' | 'compliant', list: CompileRequest['examples']['violating']) => {
    for (let index = 0; index < list.length; index++) {
      const ex = list[index];
      const path = toRepoRelative(ex.path);
      const expected = kind === 'violating' ? 'finding' : 'no_finding';
      if (path === null) {
        results.push({ kind, index, path: ex.path, expected, findings: 0, lines: [], passed: false, note: 'The example path must be repo-relative (no leading /, no ..).' });
        continue;
      }
      const evaluation = await evaluateRuleOnText(rule, path, ex.code);
      const n = evaluation.findings.length;
      const passed = kind === 'violating' ? n > 0 : n === 0;
      let note: string | null = null;
      if (!passed && kind === 'violating') {
        if (!include(path) || exclude(path)) note = "The example path is outside the rule's file scope.";
        else if (isTestFile(path)) note = 'Detectors skip test files; use a non-test path for this example.';
        else note = 'The rule did not match this example.';
      }
      if (!passed && kind === 'compliant') note = 'The rule matched code the author marked as compliant.';
      results.push({ kind, index, path, expected, findings: n, lines: evaluation.findings.map((f) => f.anchorLine), passed, note });
    }
  };
  await run('violating', examples.violating);
  await run('compliant', examples.compliant);
  return { passed: results.every((r) => r.passed), results };
}

interface Outcome {
  status: CompileStatus;
  rejection: { code: string; reasons: string[] } | null;
  suggestion: Suggestion | null;
  rule: CorporateRule | null;
  exampleResults: ExampleResult[] | null;
}

/**
 * Run the pipeline and record the attempt. The first failing step sets the
 * status. Returns the stored row.
 */
export async function compilePolicy(
  db: Db,
  input: { orgId: string; actor: string; request: CompileRequest },
  generate: Generate = defaultGenerate,
): Promise<CompileRecordRow> {
  const { orgId, actor, request } = input;
  const system = buildCompileSystemPrompt();
  const user = buildCompileUserMessage(request.plainText);

  let response: LLMResponse | null = null;
  let outcome: Outcome;
  try {
    if (generate === defaultGenerate && !isLlmProviderConfigured('translator')) {
      throw new Error('No LLM provider is configured for the translator role');
    }
    response = await generate(system, user);
    outcome = await interpret(response.content, request);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    logger.warn({ orgId, error: message }, 'CPG policy compile: LLM call failed (recorded as llm_error)');
    outcome = { status: 'llm_error', rejection: { code: 'llm_error', reasons: [message] }, suggestion: null, rule: null, exampleResults: null };
  }

  const row: CompileRecordRow = {
    id: randomUUID(),
    orgId,
    policyId: request.policyId ?? null,
    requestedBy: actor,
    inputText: request.plainText,
    inputHash: createHash('sha256').update(request.plainText, 'utf8').digest('hex'),
    examples: canonicalJson(request.examples),
    promptVersion: CPG_COMPILE_PROMPT_VERSION,
    provider: response?.provider ?? null,
    model: response?.model ?? null,
    rawOutput: response ? response.content.slice(0, MAX_RAW_OUTPUT) : null,
    status: outcome.status,
    rejection: outcome.rejection ? canonicalJson(outcome.rejection) : null,
    suggestion: outcome.suggestion ? canonicalJson(outcome.suggestion) : null,
    compiledRule: outcome.rule ? canonicalJson(outcome.rule) : null,
    compiledRuleHash: outcome.rule ? ruleHashOf(outcome.rule) : null,
    exampleResults: outcome.exampleResults ? canonicalJson(outcome.exampleResults) : null,
    tokensIn: response?.tokensIn ?? null,
    tokensOut: response?.tokensOut ?? null,
    createdAt: new Date().toISOString(),
  };
  db.insert(cpgCompileRecords).values(row).run();
  logger.info({ orgId, compileRecordId: row.id, status: row.status }, 'CPG policy compile recorded');
  return row;
}

async function interpret(content: string, request: CompileRequest): Promise<Outcome> {
  const reject = (status: CompileStatus, code: string, reasons: string[], extra: Partial<Outcome> = {}): Outcome =>
    ({ status, rejection: { code, reasons }, suggestion: null, rule: null, exampleResults: null, ...extra });

  const json = extractJson(content);
  if (json === undefined) return reject('rejected_schema', 'not_json', ['The model did not return one JSON object.']);
  const out = compileOutputSchema.safeParse(json);
  if (!out.success) {
    return reject('rejected_schema', 'schema', out.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  if (!out.data.expressible) {
    const suggestion: Suggestion = { expressible: false, reason: out.data.reason, closestExpressible: out.data.closestExpressible ?? null };
    return reject('rejected_unexpressible', 'unexpressible', [out.data.reason], { suggestion });
  }
  const { rule: rawRule, ...meta } = out.data;
  const suggestion: Suggestion = { ...meta, expressible: true };
  const validation = validateCorporateRule(rawRule);
  if (!validation.ok) return reject('rejected_validation', 'validation', validation.reasons, { suggestion });
  const examples = await verifyExamples(validation.rule, request.examples);
  if (!examples.passed) {
    return reject('rejected_examples', 'examples', examples.results.filter((r) => !r.passed).map((r) => `${r.kind} example ${r.index + 1} (${r.path}): ${r.note ?? 'failed'}`),
      { suggestion, exampleResults: examples.results });
  }
  return { status: 'compiled', rejection: null, suggestion, rule: corporateRuleSchema.parse(validation.rule), exampleResults: examples.results };
}

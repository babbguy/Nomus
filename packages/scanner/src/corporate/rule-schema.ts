import { z } from 'zod';
import { MAX_GLOBS_PER_LIST, globError } from './glob.js';
import { checkRegexSafety, MAX_REGEX_SOURCE_LENGTH } from './regex-safety.js';
import {
  DATA_CATEGORIES, DATA_LABELS, EMITTED_CAPABILITIES, FLOW_SINKS, FLOW_SOURCES, KNOWN_SDKS, LANGUAGES,
} from './vocab.js';

/**
 * The corporate rule schema (design spec §8.4.1). A compiled corporate
 * policy is this JSON: data, not code. The deterministic matcher
 * (matcher.ts) interprets it; nothing at scan time calls an LLM.
 *
 * The same schema validates the compile step's LLM output in the engine,
 * the rules in the signed bundle, and the rules the scanner evaluates.
 */

export const CORPORATE_RULE_SCHEMA_VERSION = 1;

const glob = z.string().min(1).max(200);

export const safeRegexSchema = z.object({
  source: z.string().min(1).max(MAX_REGEX_SOURCE_LENGTH),
  flags: z.enum(['', 'i']),
  /** Match against the line with comments blanked out (detect/file-content.ts stripComments). */
  ignoreComments: z.boolean().default(true),
}).strict();

const methodName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]{0,99}$/);

export const matcherSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('sdk_call'),
    sdks: z.array(z.enum(KNOWN_SDKS)).min(1).max(20),
    /** Method paths as the SDK-usage detector reports them, e.g. `chat.completions.create`. */
    methods: z.array(methodName).min(1).max(50).optional(),
  }).strict(),
  z.object({
    kind: z.literal('sdk_import'),
    sdks: z.array(z.enum(KNOWN_SDKS)).min(1).max(20),
  }).strict(),
  z.object({
    kind: z.literal('capability'),
    capabilities: z.array(z.enum(EMITTED_CAPABILITIES)).min(1).max(20),
  }).strict(),
  z.object({
    kind: z.literal('data_pattern'),
    categories: z.array(z.enum(DATA_CATEGORIES)).min(1).max(3),
    labels: z.array(z.enum(DATA_LABELS)).min(1).max(9).optional(),
  }).strict(),
  z.object({
    kind: z.literal('data_flow'),
    sources: z.array(z.enum(FLOW_SOURCES)).min(1).max(4).optional(),
    sinks: z.array(z.enum(FLOW_SINKS)).min(1).max(4).optional(),
  }).strict(),
  z.object({
    kind: z.literal('line_regex'),
    pattern: safeRegexSchema,
  }).strict(),
]);

export const corporateRuleSchema = z.object({
  schemaVersion: z.literal(CORPORATE_RULE_SCHEMA_VERSION),
  match: z.object({
    /** Every matcher must hit; hits of all[0] are the anchors. */
    all: z.array(matcherSchema).min(1).max(4),
    /** Companion hits must be within this many lines of the anchor; null = anywhere in the same file. */
    withinLines: z.number().int().min(0).max(200).nullable().default(null),
    /** An anchor is suppressed when any of these hits in the window (or the file). */
    unless: z.array(matcherSchema).max(4).default([]),
    unlessScope: z.enum(['window', 'file']).default('file'),
  }).strict(),
  files: z.object({
    include: z.array(glob).min(1).max(MAX_GLOBS_PER_LIST).default(['**/*']),
    exclude: z.array(glob).max(MAX_GLOBS_PER_LIST).default([]),
    languages: z.array(z.enum(LANGUAGES)).min(1).max(LANGUAGES.length).optional(),
  }).strict(),
  snippet: z.object({
    contextBefore: z.number().int().min(0).max(20).default(0),
    contextAfter: z.number().int().min(0).max(20).default(0),
  }).strict().default({}),
  /** Shown to developers on every finding; plain text, no placeholders. */
  message: z.string().min(10).max(300),
}).strict();

export type CorporateMatcher = z.infer<typeof matcherSchema>;
export type MatcherKind = CorporateMatcher['kind'];
export type CorporateRule = z.infer<typeof corporateRuleSchema>;
/** The input shape (defaults optional), e.g. what an LLM or an author writes. */
export type CorporateRuleInput = z.input<typeof corporateRuleSchema>;

export type RuleValidation =
  | { ok: true; rule: CorporateRule; reasons: [] }
  | { ok: false; rule: null; reasons: string[] };

const PLACEHOLDER_RE = /\{\{|\}\}|\$\{|<%|%>|\{[A-Za-z_][A-Za-z0-9_]*\}/;

function issuePath(path: Array<string | number>): string {
  return path.length === 0 ? 'rule' : `rule.${path.join('.')}`;
}

/**
 * Deterministic validation of a corporate rule (compile pipeline step 5):
 * the schema and closed vocabularies, regex safety, globs that compile,
 * limits, and a message without template placeholders. Every reason is
 * returned, not just the first. Never throws.
 */
export function validateCorporateRule(input: unknown): RuleValidation {
  const parsed = corporateRuleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, rule: null, reasons: parsed.error.issues.map((i) => `${issuePath(i.path)}: ${i.message}`) };
  }
  const rule = parsed.data;
  const reasons: string[] = [];

  const matchers: Array<[string, CorporateMatcher]> = [
    ...rule.match.all.map((m, i) => [`rule.match.all.${i}`, m] as [string, CorporateMatcher]),
    ...rule.match.unless.map((m, i) => [`rule.match.unless.${i}`, m] as [string, CorporateMatcher]),
  ];
  for (const [path, m] of matchers) {
    if (m.kind === 'line_regex') {
      const safety = checkRegexSafety(m.pattern.source, m.pattern.flags);
      for (const r of safety.reasons) reasons.push(`${path}.pattern: ${r}`);
    }
    if (m.kind === 'data_flow' && (m.sources?.length ?? 0) + (m.sinks?.length ?? 0) === 0) {
      reasons.push(`${path}: a data_flow matcher needs at least one source or sink`);
    }
    for (const list of ['sdks', 'capabilities', 'categories', 'labels', 'methods', 'sources', 'sinks'] as const) {
      const values = (m as Record<string, unknown>)[list];
      if (Array.isArray(values) && new Set(values).size !== values.length) reasons.push(`${path}.${list}: values must not repeat`);
    }
  }
  if (rule.match.unlessScope === 'window' && rule.match.withinLines === null) {
    reasons.push('rule.match.unlessScope: "window" needs match.withinLines (null means the whole file; use "file")');
  }
  if (rule.match.unless.length === 0 && rule.match.unlessScope === 'window') {
    reasons.push('rule.match.unlessScope: "window" has no effect without match.unless');
  }

  for (const [path, list] of [['rule.files.include', rule.files.include], ['rule.files.exclude', rule.files.exclude]] as const) {
    list.forEach((g, i) => {
      const err = globError(g);
      if (err) reasons.push(`${path}.${i}: ${err}`);
    });
    if (new Set(list).size !== list.length) reasons.push(`${path}: globs must not repeat`);
  }

  if (PLACEHOLDER_RE.test(rule.message)) reasons.push('rule.message: must be plain text without template placeholders');
  if (/[\r\n]/.test(rule.message)) reasons.push('rule.message: must be a single line');

  return reasons.length === 0 ? { ok: true, rule, reasons: [] } : { ok: false, rule: null, reasons };
}

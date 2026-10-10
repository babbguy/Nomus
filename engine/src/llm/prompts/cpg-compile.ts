import type { ZodTypeAny } from 'zod';
import {
  DATA_CATEGORIES, DATA_LABELS, EMITTED_CAPABILITIES, FLOW_SINKS, FLOW_SOURCES, KNOWN_SDKS, LANGUAGES,
  MAX_BOUNDED_REPEAT, MAX_QUANTIFIERS, MAX_UNBOUNDED_QUANTIFIERS, corporateRuleSchema,
} from '@nomus/scanner/corporate';

/**
 * The corporate-policy compile prompt (design spec §8.1). The LLM turns one
 * plain-English policy into a deterministic corporate rule, or says it
 * cannot. Only the policy text is sent: the author's example code is never
 * part of the prompt (it is checked deterministically after the call).
 *
 * The system prompt starts with a fixed prefix that the release gate's fake
 * LLM recognises. Bump CPG_COMPILE_PROMPT_VERSION whenever the text changes;
 * every compile record stores the version it used.
 */

export const CPG_COMPILE_PROMPT_VERSION = 1;
export const CPG_COMPILE_PROMPT_PREFIX = 'You compile a corporate engineering policy into a deterministic Nomus rule.';

/** A compact TypeScript-style rendering of a zod schema, for the prompt. */
export function zodToPromptSchema(schema: ZodTypeAny, indent = ''): string {
  const def = (schema as unknown as { _def: Record<string, any> })._def;
  const next = `${indent}  `;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
      const fields = Object.entries(shape).map(([k, v]) => {
        const optional = ['ZodOptional', 'ZodDefault'].includes((v as unknown as { _def: { typeName: string } })._def.typeName);
        return `${next}${k}${optional ? '?' : ''}: ${zodToPromptSchema(v, next)};`;
      });
      return `{\n${fields.join('\n')}\n${indent}}`;
    }
    case 'ZodArray': {
      const min = def.minLength?.value;
      const max = def.maxLength?.value;
      const bounds = min !== undefined || max !== undefined ? ` /* ${min ?? 0}..${max ?? 'n'} items */` : '';
      return `Array<${zodToPromptSchema(def.type, indent)}>${bounds}`;
    }
    case 'ZodEnum': return (def.values as string[]).map((v) => JSON.stringify(v)).join(' | ');
    case 'ZodLiteral': return JSON.stringify(def.value);
    case 'ZodString': {
      const checks = (def.checks ?? []) as Array<{ kind: string; value?: number; regex?: RegExp }>;
      const notes = checks.map((c) => (c.kind === 'min' ? `min ${c.value}` : c.kind === 'max' ? `max ${c.value}` : c.kind === 'regex' ? `matches ${c.regex}` : c.kind)).join(', ');
      return notes ? `string /* ${notes} */` : 'string';
    }
    case 'ZodNumber': {
      const checks = (def.checks ?? []) as Array<{ kind: string; value?: number }>;
      const notes = checks.map((c) => (c.kind === 'int' ? 'integer' : `${c.kind} ${c.value}`)).join(', ');
      return notes ? `number /* ${notes} */` : 'number';
    }
    case 'ZodBoolean': return 'boolean';
    case 'ZodOptional': return zodToPromptSchema(def.innerType, indent);
    case 'ZodDefault': return `${zodToPromptSchema(def.innerType, indent)} /* default ${JSON.stringify(def.defaultValue())} */`;
    case 'ZodNullable': return `${zodToPromptSchema(def.innerType, indent)} | null`;
    case 'ZodEffects': return zodToPromptSchema(def.schema, indent);
    case 'ZodDiscriminatedUnion':
    case 'ZodUnion': {
      const options = (def.options instanceof Map ? [...def.options.values()] : def.options) as ZodTypeAny[];
      return options.map((o) => zodToPromptSchema(o, indent)).join(`\n${indent}| `);
    }
    default: return 'unknown';
  }
}

const list = (values: readonly string[]) => values.map((v) => `"${v}"`).join(', ');

export function buildCompileSystemPrompt(): string {
  return `${CPG_COMPILE_PROMPT_PREFIX}

Nomus scans source code with deterministic detectors. A corporate rule is JSON data that combines their outputs; it never asks anyone (human or model) to judge code at scan time. Your job is to translate ONE plain-English company policy into ONE rule, or to say that it cannot be expressed.

The rule must match this TypeScript-style schema exactly (no extra keys):

${zodToPromptSchema(corporateRuleSchema)}

Matcher semantics:
- sdk_call: an AI SDK method call (AST for JS/TS, patterns elsewhere). "methods" are paths like "chat.completions.create"; omit it to match every call of the SDK.
- sdk_import: an import of the SDK package or module.
- capability: a behaviour a detector found in the file (list below).
- data_pattern: personal, health or financial data patterns in source (categories and labels below).
- data_flow: a single-file flow around an AI call, from a source or to a sink.
- line_regex: a regular expression tested against each source line (comments ignored by default).
- match.all: every matcher must hit; hits of the first are the anchors. match.withinLines limits how far the other hits may be from the anchor (null = same file). match.unless suppresses an anchor when any listed matcher hits within the window (unlessScope "window") or the file ("file").
- files.include / files.exclude: globs over repo-relative paths ("/" separator, "*", "?", "**" as a whole segment, "{a,b}"). No character classes, no "!".

Closed vocabularies (use nothing else):
- SDK families: ${list(KNOWN_SDKS)}
- capabilities: ${list(EMITTED_CAPABILITIES)}
- data categories: ${list(DATA_CATEGORIES)}; data labels: ${list(DATA_LABELS)}
- flow sources: ${list(FLOW_SOURCES)}; flow sinks: ${list(FLOW_SINKS)}
- languages: ${list(LANGUAGES)}

Regex limits: flags "" or "i"; at most 200 characters; no backreferences, lookaround or named groups; no quantifier on a group that contains a quantifier or "|"; at most ${MAX_QUANTIFIERS} quantifiers, at most ${MAX_UNBOUNDED_QUANTIFIERS} of them unbounded (*, +, {n,}); bounded repeats up to {${MAX_BOUNDED_REPEAT}}; the pattern must not match an empty line.

If the policy cannot be decided by these primitives without judging intent or quality, return {"expressible": false, …}. That includes: intent or quality judgements ("well tested", "fair", "appropriate", "secure enough"), cross-file or inter-procedural data flow, runtime behaviour or configuration loaded at runtime, facts outside the repository (contracts, model cards, assessments on file), dependency or licence policies, and "X must exist somewhere in the repository" rules.

Return one JSON object and nothing else, in one of these two shapes:
{"expressible": true, "suggestedKey": "corp.<lowercase-key>", "title": "<3-120 chars>", "suggestedTier": "advisory" | "review-required" | "prohibited", "rule": <the rule>, "rationale": "<why this rule captures the policy>", "limitations": ["<what the rule cannot catch>"]}
{"expressible": false, "reason": "<why it cannot be expressed deterministically>", "closestExpressible": "<optional: a narrower policy that could be>"}

The rule "message" is shown to developers on every finding: plain text, one line, 10 to 300 characters, no placeholders.`;
}

/** The user message: the policy text only, never example code. */
export function buildCompileUserMessage(plainText: string): string {
  return `Policy:\n${plainText}`;
}

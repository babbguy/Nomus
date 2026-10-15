import { describe, it, expect } from 'vitest';
import { corporateRuleSchema, validateCorporateRule, type CorporateRuleInput } from './rule-schema.js';

const base = (over: Partial<CorporateRuleInput> = {}): CorporateRuleInput => ({
  schemaVersion: 1,
  match: { all: [{ kind: 'sdk_call', sdks: ['openai'] }] },
  files: { include: ['**/*'], exclude: ['src/llm/gateway/**'] },
  message: 'Call OpenAI only through the approved LLM gateway.',
  ...over,
});

const ACCEPT: Array<[string, CorporateRuleInput]> = [
  ['sdk_call with exclusions', base()],
  ['sdk_call with methods', base({ match: { all: [{ kind: 'sdk_call', sdks: ['openai', 'anthropic'], methods: ['chat.completions.create', 'messages.create'] }] } })],
  ['sdk_import scoped to the frontend', base({ match: { all: [{ kind: 'sdk_import', sdks: ['anthropic'] }] }, files: { include: ['web/**'] } })],
  ['capability', base({ match: { all: [{ kind: 'capability', capabilities: ['pii_in_ai_call'] }] } })],
  ['data_pattern with labels', base({ match: { all: [{ kind: 'data_pattern', categories: ['pii'], labels: ['ssn'] }] } })],
  ['data_flow sink only', base({ match: { all: [{ kind: 'data_flow', sinks: ['logs_output'] }] } })],
  ['line_regex', base({ match: { all: [{ kind: 'line_regex', pattern: { source: 'gpt-4-32k', flags: '' } }] } })],
  ['all + window unless', base({
    match: {
      all: [{ kind: 'sdk_call', sdks: ['openai'], methods: ['chat.completions.create'] }],
      withinLines: 20,
      unless: [{ kind: 'sdk_call', sdks: ['openai'], methods: ['moderations.create'] }],
      unlessScope: 'window',
    },
  })],
  ['languages and snippet context', base({ files: { include: ['**/*'], languages: ['typescript', 'python'] }, snippet: { contextBefore: 2, contextAfter: 3 } })],
];

const REJECT: Array<[string, unknown, RegExp]> = [
  ['unknown SDK', base({ match: { all: [{ kind: 'sdk_call', sdks: ['made-up-sdk' as 'openai'] }] } }), /sdks/],
  ['unknown capability', base({ match: { all: [{ kind: 'capability', capabilities: ['judges_quality' as 'text_generation'] }] } }), /capabilities/],
  ['unknown matcher kind', base({ match: { all: [{ kind: 'llm_judgement', prompt: 'is it good?' } as never] } }), /kind/],
  ['extra key', { ...base(), severity: 'high' }, /Unrecognized key/],
  ['empty all', base({ match: { all: [] } }), /all/],
  ['five matchers', base({ match: { all: Array.from({ length: 5 }, () => ({ kind: 'sdk_import' as const, sdks: ['openai' as const] })) } }), /all/],
  ['schemaVersion 2', { ...base(), schemaVersion: 2 }, /schemaVersion/],
  ['unsafe regex', base({ match: { all: [{ kind: 'line_regex', pattern: { source: '(a+)+$', flags: '' } }] } }), /nested quantifiers/],
  ['regex g flag', base({ match: { all: [{ kind: 'line_regex', pattern: { source: 'x', flags: 'g' as '' } }] } }), /flags/],
  ['invalid glob', base({ files: { include: ['src/[ab]/**'] } }), /character classes/],
  ['backslash glob', base({ files: { include: ['src\\**'] } }), /backslashes/],
  ['placeholder in message', base({ message: 'Do not call {{sdk}} directly from code.' }), /placeholders/],
  ['template literal placeholder', base({ message: 'Do not call ${sdk} directly from code.' }), /placeholders/],
  ['multi-line message', base({ message: 'Line one of the message\nline two' }), /single line/],
  ['message too short', base({ message: 'No.' }), /message/],
  ['data_flow without source or sink', base({ match: { all: [{ kind: 'data_flow' }] } }), /source or sink/],
  ['window unless without withinLines', base({ match: { all: [{ kind: 'sdk_import', sdks: ['openai'] }], unless: [{ kind: 'sdk_import', sdks: ['anthropic'] }], unlessScope: 'window' } }), /withinLines/],
  ['repeated values', base({ match: { all: [{ kind: 'sdk_import', sdks: ['openai', 'openai'] }] } }), /must not repeat/],
  ['withinLines over 200', base({ match: { all: [{ kind: 'sdk_import', sdks: ['openai'] }], withinLines: 500 } }), /withinLines/],
  ['not an object', 'rule', /Expected object/],
];

describe('corporate rule schema: accept table', () => {
  for (const [name, rule] of ACCEPT) {
    it(`accepts: ${name}`, () => {
      const v = validateCorporateRule(rule);
      expect(v.reasons).toEqual([]);
      expect(v.ok).toBe(true);
    });
  }

  it('applies defaults so the stored rule is fully explicit', () => {
    const v = validateCorporateRule({ schemaVersion: 1, match: { all: [{ kind: 'sdk_import', sdks: ['openai'] }] }, files: {}, message: 'No OpenAI imports in this codebase.' });
    expect(v.ok).toBe(true);
    expect(v.rule).toEqual({
      schemaVersion: 1,
      match: { all: [{ kind: 'sdk_import', sdks: ['openai'] }], withinLines: null, unless: [], unlessScope: 'file' },
      files: { include: ['**/*'], exclude: [] },
      snippet: { contextBefore: 0, contextAfter: 0 },
      message: 'No OpenAI imports in this codebase.',
    });
    // A parsed rule re-parses to itself (the bundle client relies on it for the rule hash).
    expect(corporateRuleSchema.parse(v.rule)).toEqual(v.rule);
  });
});

describe('corporate rule schema: reject table', () => {
  for (const [name, rule, reason] of REJECT) {
    it(`rejects: ${name}`, () => {
      const v = validateCorporateRule(rule);
      expect(v.ok).toBe(false);
      expect(v.rule).toBeNull();
      expect(v.reasons.join('; ')).toMatch(reason);
    });
  }

  it('lists every reason, not just the first', () => {
    const v = validateCorporateRule(base({
      match: { all: [{ kind: 'line_regex', pattern: { source: '(a+)+', flags: '' } }] },
      files: { include: ['!x'] },
      message: 'Use {{gateway}} for every call to the provider.',
    }));
    expect(v.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

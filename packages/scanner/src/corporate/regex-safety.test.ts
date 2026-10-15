import { describe, it, expect } from 'vitest';
import { checkRegexSafety, compileSafeRegex, MAX_REGEX_LINE_LENGTH } from './regex-safety.js';

// Rejection corpus (design spec §8.4.3): each entry must be refused, with a
// reason that names the rule it breaks.
const REJECTED: Array<[string, string, RegExp]> = [
  ['(a+)+', '', /nested quantifiers/],
  ['(a|aa)*', '', /nested quantifiers/],
  ['(\\w+\\s?)*', '', /nested quantifiers/],
  ['(?:x*y)+z', '', /nested quantifiers/],
  ['((ab)*c)+', '', /nested quantifiers/],
  ['(a+)?b', '', /nested quantifiers/],
  ['(a|b){2,5}', '', /nested quantifiers/],
  ['(a)\\1', '', /backreferences/],
  ['(?<n>a)\\k<n>', '', /named/],
  ['foo(?=bar)', '', /lookahead and lookbehind/],
  ['foo(?!bar)', '', /lookahead and lookbehind/],
  ['(?<=foo)bar', '', /lookahead and lookbehind/],
  ['(?<!foo)bar', '', /lookahead and lookbehind/],
  ['a'.repeat(201), '', /longer than 200/],
  ['abc', 'g', /flags/],
  ['abc', 'gi', /flags/],
  ['abc', 'm', /flags/],
  ['a?b?c?d?e?f?g?h?i?j?k?', '', /at most 10 quantifiers/],
  ['a*b*c*', '', /unbounded quantifiers/],
  ['x{1,}y+z*', '', /unbounded quantifiers/],
  ['a{1,500}', '', /bounded repetitions/],
  ['a*', '', /empty line/],
  ['(x)?', '', /empty line/],
  ['[abc', '', /character class|compile/],
  ['(abc', '', /unbalanced/],
  ['abc)', '', /unbalanced/],
  ['*abc', '', /quantifier must follow/],
  ['', '', /empty/],
];

// Patterns authors actually need; all must pass and are the fuzz corpus.
const ACCEPTED: Array<[string, string]> = [
  ['gpt-4-32k', ''],
  ['\\bgpt-4-32k\\b', 'i'],
  ['api[_-]?key\\s*=\\s*[\'"]sk-', ''],
  ['https?://[a-z0-9.-]{1,60}\\.internal\\b', 'i'],
  ['\\b(?:dall-e-2|dall-e-3)\\b', ''],
  ['\\bmodel\\s*:\\s*[\'"]text-davinci', ''],
  ['eval\\(', ''],
  ['[A-Z0-9]{20,40}', ''],
  ['(?:sk|pk)_live_[0-9a-zA-Z]{24}', ''],
  ['\\btemperature\\s*[:=]\\s*1\\.\\d', ''],
  ['(ab)+c', ''],
  ['TODO\\(security\\)', 'i'],
];

describe('regex safety: rejection corpus', () => {
  for (const [source, flags, reason] of REJECTED) {
    it(`rejects /${source.slice(0, 40)}/${flags}`, () => {
      const r = checkRegexSafety(source, flags);
      expect(r.ok).toBe(false);
      expect(r.reasons.join('; ')).toMatch(reason);
      expect(() => compileSafeRegex(source, flags)).toThrow();
    });
  }

  it('never throws on hostile input types', () => {
    expect(checkRegexSafety(undefined, '').ok).toBe(false);
    expect(checkRegexSafety('a', undefined).ok).toBe(false);
    expect(checkRegexSafety(42, '').ok).toBe(false);
  });
});

describe('regex safety: accepted corpus', () => {
  for (const [source, flags] of ACCEPTED) {
    it(`accepts /${source}/${flags}`, () => {
      expect(checkRegexSafety(source, flags)).toEqual({ ok: true, reasons: [] });
      expect(compileSafeRegex(source, flags)).toBeInstanceOf(RegExp);
    });
  }
});

/** Deterministic PRNG (mulberry32) so the fuzz input is the same on every run. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('regex safety: fuzz budget (spec §8.4.3)', () => {
  const LINES = 10_000;
  const BUDGET_MS = 50;
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.:=\'"(){}[]/\\\t';
  const rand = prng(20261008);
  const lines: string[] = [];
  for (let i = 0; i < LINES; i++) {
    const chars = new Array<string>(MAX_REGEX_LINE_LENGTH);
    for (let j = 0; j < MAX_REGEX_LINE_LENGTH; j++) chars[j] = ALPHABET[Math.floor(rand() * ALPHABET.length)];
    // join() gives a flat string, so the timing below measures the regex, not rope flattening.
    lines.push(chars.join(''));
  }

  it(`every accepted pattern runs ${LINES.toLocaleString('en')} random ${MAX_REGEX_LINE_LENGTH}-character lines plus adversarial lines, each line under ${BUDGET_MS} ms`, () => {
    const slow: string[] = [];
    for (const [source, flags] of ACCEPTED) {
      const re = compileSafeRegex(source, flags);
      // Adversarial lines: one character of the pattern repeated, a near-miss prefix repeated, and spaces.
      const literals = [...new Set(source.replace(/\\./g, '').replace(/[^A-Za-z0-9 _=:-]/g, ''))].slice(0, 8);
      const adversarial = [
        ...literals.map((ch) => ch.repeat(MAX_REGEX_LINE_LENGTH)),
        ' '.repeat(MAX_REGEX_LINE_LENGTH),
        source.replace(/[^A-Za-z0-9]/g, '').slice(0, 12).repeat(Math.ceil(MAX_REGEX_LINE_LENGTH / 12)).slice(0, MAX_REGEX_LINE_LENGTH),
      ];
      re.test(lines[0]); // compile the regex before timing it
      let worst = 0;
      for (const line of [...lines, ...adversarial]) {
        const t0 = performance.now();
        re.test(line);
        const dt = performance.now() - t0;
        if (dt > worst) worst = dt;
      }
      if (worst >= BUDGET_MS) slow.push(`/${source}/${flags}: ${worst.toFixed(1)} ms`);
    }
    expect(slow).toEqual([]);
  }, 120_000);

  it('the measurement catches catastrophic backtracking: a rejected pattern blows the budget on a 27-character line', () => {
    expect(checkRegexSafety('(a+)+$', '').ok).toBe(false);
    const re = new RegExp('(a+)+$');
    const t0 = performance.now();
    re.test(`${'a'.repeat(26)}!`);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(BUDGET_MS);
  }, 120_000);
});

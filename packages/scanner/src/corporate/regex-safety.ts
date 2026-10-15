/**
 * Regex safety for author-supplied `line_regex` patterns (design spec §8.4.3).
 *
 * Corporate rules run in every developer's editor and in CI, so a pattern
 * that can backtrack catastrophically is a denial of service. JavaScript has
 * no linear-time regex engine, so the defence is static and conservative:
 *
 * - at most 200 characters; flags '' or 'i' only;
 * - no backreferences (`\1`–`\9`, `\k<…>`), no lookaround, no named groups;
 * - star height at most 1: no quantifier on a group that itself contains a
 *   quantifier or an alternation (`(a+)+`, `(a|aa)*`, `(\w+\s?)*`);
 * - at most 10 quantifiers, at most 2 of them unbounded (`*`, `+`, `{n,}`),
 *   and bounded repetitions of at most {@link MAX_BOUNDED_REPEAT};
 * - the pattern must compile and must not match an empty line (it would
 *   flag every line of every file).
 *
 * Matching is per line, and lines longer than {@link MAX_REGEX_LINE_LENGTH}
 * characters are skipped and counted, never matched. There is no multi-line
 * matching. A fuzz test runs every accepted pattern of the test corpus
 * against random and adversarial 4,096-character lines.
 */

export const MAX_REGEX_SOURCE_LENGTH = 200;
export const MAX_REGEX_LINE_LENGTH = 4096;
export const MAX_QUANTIFIERS = 10;
export const MAX_UNBOUNDED_QUANTIFIERS = 2;
export const MAX_BOUNDED_REPEAT = 100;
export const REGEX_FLAGS = ['', 'i'] as const;
export type RegexFlags = (typeof REGEX_FLAGS)[number];

export interface RegexSafetyResult {
  ok: boolean;
  reasons: string[];
}

interface Frame {
  hasQuantifier: boolean;
  hasAlternation: boolean;
}

type Atom = { kind: 'simple' } | { kind: 'group'; risky: boolean } | null;

const BRACE_QUANTIFIER = /^\{(\d+)(,(\d*))?\}/;

/** Check a pattern against the static safety rules. Never throws. */
export function checkRegexSafety(source: unknown, flags: unknown): RegexSafetyResult {
  const reasons: string[] = [];
  if (typeof source !== 'string' || source.length === 0) return { ok: false, reasons: ['the pattern is empty'] };
  if (source.length > MAX_REGEX_SOURCE_LENGTH) reasons.push(`the pattern is longer than ${MAX_REGEX_SOURCE_LENGTH} characters`);
  if (typeof flags !== 'string' || !(REGEX_FLAGS as readonly string[]).includes(flags)) reasons.push("flags must be '' or 'i'");

  const stack: Frame[] = [{ hasQuantifier: false, hasAlternation: false }];
  let last: Atom = null;
  let quantifiers = 0;
  let unbounded = 0;
  const add = (r: string) => { if (!reasons.includes(r)) reasons.push(r); };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      const next = source[i + 1] ?? '';
      if (/[1-9]/.test(next)) add('backreferences are not allowed');
      if (next === 'k' && source[i + 2] === '<') add('named backreferences are not allowed');
      last = { kind: 'simple' };
      i += 2;
      continue;
    }
    if (ch === '[') {
      let j = i + 1;
      if (source[j] === '^') j++;
      if (source[j] === ']') j++; // a leading ] is literal
      while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
      if (j >= source.length) add('unterminated character class');
      last = { kind: 'simple' };
      i = j + 1;
      continue;
    }
    if (ch === '(') {
      if (source[i + 1] === '?') {
        const head = source.slice(i, i + 4);
        if (head.startsWith('(?:')) {
          i += 3;
        } else {
          if (head.startsWith('(?=') || head.startsWith('(?!') || head.startsWith('(?<=') || head.startsWith('(?<!')) add('lookahead and lookbehind are not allowed');
          else if (head.startsWith('(?<')) add('named groups are not allowed; use (?: … )');
          else add('unsupported group syntax');
          i += 2;
        }
      } else {
        i += 1;
      }
      stack.push({ hasQuantifier: false, hasAlternation: false });
      last = null;
      continue;
    }
    if (ch === ')') {
      if (stack.length === 1) {
        add('unbalanced )');
        i += 1;
        continue;
      }
      const frame = stack.pop()!;
      const parent = stack[stack.length - 1];
      // A quantifier anywhere inside makes the enclosing group "quantified" too.
      if (frame.hasQuantifier) parent.hasQuantifier = true;
      last = { kind: 'group', risky: frame.hasQuantifier || frame.hasAlternation };
      i += 1;
      continue;
    }
    if (ch === '|') {
      stack[stack.length - 1].hasAlternation = true;
      last = null;
      i += 1;
      continue;
    }
    let qLen = 0;
    let isUnbounded = false;
    if (ch === '*' || ch === '+') {
      qLen = 1;
      isUnbounded = true;
    } else if (ch === '?') {
      qLen = 1;
    } else if (ch === '{') {
      const m = BRACE_QUANTIFIER.exec(source.slice(i));
      if (m) {
        qLen = m[0].length;
        const min = Number(m[1]);
        const hasComma = m[2] !== undefined;
        const max = hasComma ? (m[3] === '' ? null : Number(m[3])) : min;
        if (max === null) isUnbounded = true;
        else if (max > MAX_BOUNDED_REPEAT || min > MAX_BOUNDED_REPEAT) add(`bounded repetitions may not exceed {${MAX_BOUNDED_REPEAT}}`);
      }
    }
    if (qLen > 0) {
      if (last === null) {
        add('a quantifier must follow something to repeat');
      } else {
        quantifiers++;
        if (isUnbounded) unbounded++;
        if (last.kind === 'group' && last.risky) add('nested quantifiers (star height above 1) are not allowed, e.g. (a+)+ or (a|b)*');
      }
      stack[stack.length - 1].hasQuantifier = true;
      i += qLen;
      if (source[i] === '?') i += 1; // lazy modifier
      last = null; // a quantified atom cannot be quantified again
      continue;
    }
    last = { kind: 'simple' };
    i += 1;
  }
  if (stack.length > 1) add('unbalanced (');
  if (quantifiers > MAX_QUANTIFIERS) add(`at most ${MAX_QUANTIFIERS} quantifiers are allowed`);
  if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) add(`at most ${MAX_UNBOUNDED_QUANTIFIERS} unbounded quantifiers (*, +, {n,}) are allowed; use a bounded {m,n}`);

  if (reasons.length === 0) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(source, flags as string);
    } catch (err) {
      add(`the pattern does not compile: ${(err as Error).message}`);
    }
    if (re && re.test('')) add('the pattern matches an empty line, so it would flag every line');
  }
  return { ok: reasons.length === 0, reasons };
}

/** Compile a pattern that passed {@link checkRegexSafety}; throws with the reasons otherwise. */
export function compileSafeRegex(source: string, flags: string): RegExp {
  const result = checkRegexSafety(source, flags);
  if (!result.ok) throw new Error(`Unsafe regex /${source}/${flags}: ${result.reasons.join('; ')}`);
  return new RegExp(source, flags);
}

/**
 * Repository-pattern globs for team scoping (design spec §7.1 semantics).
 *
 * - `/` is the only separator; `\` is rejected.
 * - `*` matches a run of characters other than `/`; `?` exactly one.
 * - `**` must be a whole segment and matches zero or more segments.
 * - `{a,b}` alternation, not nested, at most 10 alternatives.
 * - No character classes, no leading `!`, no extglobs, no leading `./`.
 * - Repo patterns are lowercase and at most 200 characters; lists hold at most 50.
 *
 * Phase 2 adds the shared glob engine to `@nomus/scanner/corporate` with the
 * same semantics; this engine-local copy exists so Phase 1 team scoping does
 * not depend on that library.
 */

export const MAX_GLOB_LENGTH = 200;
export const MAX_GLOBS_PER_LIST = 50;
const MAX_ALTERNATIVES = 10;

export class InvalidGlobError extends Error {
  constructor(public readonly glob: string, reason: string) {
    super(`Invalid glob "${glob}": ${reason}`);
    this.name = 'InvalidGlobError';
  }
}

function escapeRe(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function segmentToRe(glob: string, seg: string): string {
  if (seg.length === 0) throw new InvalidGlobError(glob, 'empty path segment');
  if (seg.includes('**')) throw new InvalidGlobError(glob, '** must be a whole segment');
  let out = '';
  for (const ch of seg) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += escapeRe(ch);
  }
  return out;
}

function alternativeToRe(glob: string, alt: string): string {
  const segs = alt.split('/');
  let re = '';
  let needSep = false;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === '**') {
      if (last) {
        re += needSep ? '(?:/[^/]+)*' : '(?:[^/]+(?:/[^/]+)*)?';
        needSep = true;
      } else {
        re += needSep ? '(?:/[^/]+)*/' : '(?:[^/]+/)*';
        needSep = false;
      }
      continue;
    }
    if (needSep) re += '/';
    re += segmentToRe(glob, seg);
    needSep = true;
  }
  return re;
}

function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{');
  if (open === -1) {
    if (glob.includes('}')) throw new InvalidGlobError(glob, 'unbalanced }');
    return [glob];
  }
  const close = glob.indexOf('}', open);
  if (close === -1) throw new InvalidGlobError(glob, 'unbalanced {');
  const inner = glob.slice(open + 1, close);
  if (inner.includes('{')) throw new InvalidGlobError(glob, 'nested alternation is not supported');
  const options = inner.split(',');
  if (options.length < 2) throw new InvalidGlobError(glob, 'alternation needs at least two options');
  if (options.length > MAX_ALTERNATIVES) throw new InvalidGlobError(glob, `at most ${MAX_ALTERNATIVES} alternatives`);
  const prefix = glob.slice(0, open);
  const rest = expandBraces(glob.slice(close + 1));
  const out: string[] = [];
  for (const o of options) for (const r of rest) out.push(prefix + o + r);
  if (out.length > MAX_ALTERNATIVES * MAX_ALTERNATIVES) throw new InvalidGlobError(glob, 'too many alternatives');
  return out;
}

/** Compile a glob to an anchored RegExp, or throw InvalidGlobError. */
export function compileGlob(glob: string): RegExp {
  if (typeof glob !== 'string' || glob.length === 0) throw new InvalidGlobError(String(glob), 'empty');
  if (glob.length > MAX_GLOB_LENGTH) throw new InvalidGlobError(glob, `longer than ${MAX_GLOB_LENGTH} characters`);
  if (glob.includes('\\')) throw new InvalidGlobError(glob, 'backslashes are not allowed; use /');
  if (glob.startsWith('./')) throw new InvalidGlobError(glob, 'leading ./ is not allowed');
  if (glob.startsWith('/')) throw new InvalidGlobError(glob, 'leading / is not allowed');
  if (glob.startsWith('!')) throw new InvalidGlobError(glob, 'negation is not supported');
  if (/[[\]]/.test(glob)) throw new InvalidGlobError(glob, 'character classes are not supported');
  if (/[@!+]\(/.test(glob)) throw new InvalidGlobError(glob, 'extglobs are not supported');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(glob)) throw new InvalidGlobError(glob, 'control characters are not allowed');
  const alts = expandBraces(glob).map((a) => alternativeToRe(glob, a));
  return new RegExp(`^(?:${alts.join('|')})$`);
}

/** Validate a repository pattern (lowercase glob). Returns null when valid, else the reason. */
export function repoPatternError(pattern: string): string | null {
  if (pattern !== pattern.toLowerCase()) return `Invalid glob "${pattern}": repository patterns must be lowercase`;
  try {
    compileGlob(pattern);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export function globMatches(glob: string | RegExp, value: string): boolean {
  const re = typeof glob === 'string' ? compileGlob(glob) : glob;
  return re.test(value);
}

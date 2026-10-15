import { describe, it, expect } from 'vitest';
import { compileGlob, compileGlobList, globError, globMatches, InvalidGlobError, MAX_GLOBS_PER_LIST, repoPatternError, toPosixPath } from './glob.js';

// The glob semantics table of design spec §7.1.
const MATCHES: Array<[string, string, boolean]> = [
  ['*', 'a.ts', true],
  ['*', 'src/a.ts', false], // * never crosses /
  ['*.ts', '.eslintrc.ts', true], // dotfiles match normally
  ['src/*.ts', 'src/a.ts', true],
  ['src/*.ts', 'src/x/a.ts', false],
  ['src/?.ts', 'src/a.ts', true],
  ['src/?.ts', 'src/ab.ts', false],
  ['src/?.ts', 'src//.ts', false], // ? never matches /
  ['**', 'a', true],
  ['**', 'a/b/c.ts', true],
  ['**/*', 'a.ts', true], // ** matches zero segments
  ['**/*', 'x/y/a.ts', true],
  ['src/**', 'src/a.ts', true],
  ['src/**', 'src/a/b/c.ts', true],
  ['src/**', 'srcx/a.ts', false],
  ['src/**/*.ts', 'src/a.ts', true],
  ['src/**/*.ts', 'src/a/b/c.ts', true],
  ['src/**/*.ts', 'lib/a.ts', false],
  ['src/**/gateway/**', 'src/llm/gateway/client.ts', true],
  ['src/**/gateway/**', 'src/gateway/client.ts', true],
  ['**/*.{ts,tsx}', 'web/app.tsx', true],
  ['**/*.{ts,tsx}', 'web/app.js', false],
  ['{web,app}/**', 'app/x.ts', true],
  ['Src/*.ts', 'src/a.ts', false], // paths are case-sensitive
  ['acme/*', 'acme/payments', true],
  ['acme/*', 'acme/payments/extra', false],
  ['*/*', 'any/repo', true],
  ['a.b', 'axb', false], // . is literal
  ['a+b(c)', 'a+b(c)', true], // regex metacharacters are literal
];

const INVALID = ['', 'src\\a.ts', './src/*', '/src/*', '!src/*', 'src/[ab].ts', 'src/@(a|b)', 'src/**x/a', 'a//b', '{a}', '{a,{b,c}}', '{a,b', 'a,b}',
  `{${Array.from({ length: 11 }, (_, i) => `o${i}`).join(',')}}`, 'x'.repeat(201), 'a\u0001b'];

describe('glob semantics (spec §7.1)', () => {
  for (const [glob, path, expected] of MATCHES) {
    it(`${glob} ${expected ? 'matches' : 'does not match'} ${path}`, () => {
      expect(globMatches(glob, path)).toBe(expected);
    });
  }

  it('compiles to an anchored RegExp', () => {
    expect(compileGlob('src/*.ts').source.startsWith('^')).toBe(true);
    expect(globMatches('a', 'xa')).toBe(false);
    expect(globMatches('a', 'ax')).toBe(false);
  });

  it('rejects every unsupported or malformed glob with InvalidGlobError', () => {
    for (const g of INVALID) {
      expect(() => compileGlob(g), JSON.stringify(g)).toThrow(InvalidGlobError);
      expect(globError(g), JSON.stringify(g)).not.toBeNull();
    }
  });

  it('repository patterns must be lowercase', () => {
    expect(repoPatternError('Acme/*')).toMatch(/lowercase/);
    expect(repoPatternError('acme/*')).toBeNull();
  });

  it(`a list holds at most ${MAX_GLOBS_PER_LIST} globs and matches when any glob matches`, () => {
    const m = compileGlobList(['web/**', 'app/**']);
    expect(m('app/a.ts')).toBe(true);
    expect(m('lib/a.ts')).toBe(false);
    expect(() => compileGlobList(Array.from({ length: MAX_GLOBS_PER_LIST + 1 }, (_, i) => `d${i}/**`))).toThrow(InvalidGlobError);
  });

  it('converts Windows separators before matching', () => {
    expect(globMatches('src/**/*.ts', toPosixPath('src\\a\\b.ts'))).toBe(true);
  });
});

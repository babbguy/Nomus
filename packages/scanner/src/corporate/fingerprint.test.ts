import { describe, it, expect } from 'vitest';
import {
  extractSnippet, fingerprintOf, MAX_SNIPPET_LINES, normalizeSnippet, parseFingerprint, snippetHash, splitLines, stripBom,
} from './fingerprint.js';

// Test vectors V1–V13 of design spec §6.4, pinned. Any change to
// normalizeSnippet or the hash breaks every approval ever recorded, so these
// values must never be edited to make a test pass.
const H_V2 = '0dac9242b9419b3d1b2df0c26701951dce5661e81c5c7f91075cb5bc5711d655';
const H_V6 = '78ae16566f74c2d31f52b992da6733ff0b191ad28afb19bfc53f9c0ca01d7ffa';

const VECTORS: Array<[string, string, string, number, string, string]> = [
  // [id, snippet, policyKey, version, normalized, fingerprint]
  ['V1', 'const r = await openai.chat.completions.create({ model: "gpt-4o" });', 'corp.no-direct-openai', 1,
    'const r = await openai.chat.completions.create({ model: "gpt-4o" });',
    '6386fda88c30b3a035719f9d8c5def038bf5a11d354b54a8dec3e589dddf5c1d:corp.no-direct-openai:1'],
  ['V2', 'const a = 1;\r\nconst b = 2;', 'corp.example', 3, 'const a = 1;\nconst b = 2;', `${H_V2}:corp.example:3`],
  ['V3', 'const a = 1;\nconst b = 2;', 'corp.example', 3, 'const a = 1;\nconst b = 2;', `${H_V2}:corp.example:3`],
  ['V4', 'const a = 1;   \t\nconst b = 2; ', 'corp.example', 3, 'const a = 1;\nconst b = 2;', `${H_V2}:corp.example:3`],
  ['V5', 'const a = 1;\rconst b = 2;', 'corp.example', 3, 'const a = 1;\nconst b = 2;', `${H_V2}:corp.example:3`],
  ['V6', 'const a = 1;\n\n\n\nconst b = 2;', 'corp.example', 3, 'const a = 1;\n\nconst b = 2;', `${H_V6}:corp.example:3`],
  ['V7', 'const a = 1;\n\nconst b = 2;', 'corp.example', 3, 'const a = 1;\n\nconst b = 2;', `${H_V6}:corp.example:3`],
  ['V8', 'a\n  \n\t\nb', 'corp.example', 1, 'a\n\nb',
    '38022fd2b8dbc5cb3d2cee74e083edbf59e3d4e13d067ebcb5db633d4cff4d8c:corp.example:1'],
  ['V9', '  const a = 1;\nconst b = 2;', 'corp.example', 3, '  const a = 1;\nconst b = 2;',
    'b680cc9d3bac957dda9b59ba023ae9baac46fd75b290f89dc8180f09b5979ffd:corp.example:3'],
  ['V10', 'const a = 1; // ok\nconst b = 2;', 'corp.example', 3, 'const a = 1; // ok\nconst b = 2;',
    '9de89b28562576538dde98958c99441fcbaf98f9cd437778e4196954afb7e76e:corp.example:3'],
  ['V11', 'const a = 1;\nconst b = 2;', 'corp.example', 4, 'const a = 1;\nconst b = 2;', `${H_V2}:corp.example:4`],
  ['V12', 'const s = "café";', 'corp.example', 1, 'const s = "café";',
    '003306b9efa9758e708d04342f61a0a4e201ec816b7f5fe8be7b46112ee3b360:corp.example:1'],
  ['V13', '', 'corp.example', 1, '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855:corp.example:1'],
];

describe('fingerprint test vectors V1–V13 (spec §6.4)', () => {
  for (const [id, snippet, key, version, normalized, fp] of VECTORS) {
    it(`${id}: normalizes and fingerprints as pinned`, () => {
      expect(normalizeSnippet(snippet)).toBe(normalized);
      expect(fingerprintOf(snippet, key, version)).toBe(fp);
    });
  }

  it('V12 is NFC: the NFD spelling of the same text re-flags (bytes differ)', () => {
    const nfc = 'const s = "café";'.normalize('NFC');
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    expect(snippetHash(nfd)).not.toBe(snippetHash(nfc));
  });

  it('V11: a new policy version keeps the hash and changes the fingerprint', () => {
    const v3 = parseFingerprint(VECTORS[2][5])!;
    const v11 = parseFingerprint(VECTORS[10][5])!;
    expect(v11.snippetHash).toBe(v3.snippetHash);
    expect(v11.policyVersion).toBe(4);
  });
});

describe('normalizeSnippet does exactly three things', () => {
  it('does not strip comments, change indentation, trim edge blank lines or change case', () => {
    expect(normalizeSnippet('\n\nA = 1 # note\n\n')).toBe('\nA = 1 # note\n');
    expect(normalizeSnippet('\tx')).toBe('\tx');
  });
});

describe('parseFingerprint', () => {
  it('splits on the first and last colon and rejects malformed input', () => {
    expect(parseFingerprint(VECTORS[0][5])).toEqual({ snippetHash: '6386fda88c30b3a035719f9d8c5def038bf5a11d354b54a8dec3e589dddf5c1d', policyKey: 'corp.no-direct-openai', policyVersion: 1 });
    for (const bad of ['', `${H_V2}:corp.example:0`, `${H_V2}:other.key:1`, `${H_V2.toUpperCase()}:corp.example:1`, `${H_V2}:corp.example`, `${H_V2}:corp.ex:ample:1`]) {
      expect(parseFingerprint(bad), bad).toBeNull();
    }
  });

  it('fingerprintOf refuses a key with a colon or a non-positive version', () => {
    expect(() => fingerprintOf('x', 'corp.a:b', 1)).toThrow();
    expect(() => fingerprintOf('x', 'corp.a', 0)).toThrow();
  });
});

describe('snippet extraction (spec §6.1)', () => {
  const lines = splitLines(stripBom('﻿l1\r\nl2\rl3\nl4\nl5'));

  it('strips one BOM and splits on CRLF, CR and LF', () => {
    expect(lines).toEqual(['l1', 'l2', 'l3', 'l4', 'l5']);
    expect(stripBom('﻿﻿x')).toBe('﻿x');
  });

  it('widens by context and clamps to the file', () => {
    expect(extractSnippet(lines, 3, 3, 1, 1)).toEqual({ startLine: 2, endLine: 4, snippet: 'l2\nl3\nl4', truncated: false });
    expect(extractSnippet(lines, 1, 2, 5, 9)).toEqual({ startLine: 1, endLine: 5, snippet: 'l1\nl2\nl3\nl4\nl5', truncated: false });
  });

  it(`caps a range at ${MAX_SNIPPET_LINES} lines and flags it`, () => {
    const many = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
    const r = extractSnippet(many, 10, 900);
    expect(r.startLine).toBe(10);
    expect(r.endLine).toBe(10 + MAX_SNIPPET_LINES - 1);
    expect(r.truncated).toBe(true);
    expect(r.snippet.split('\n')).toHaveLength(MAX_SNIPPET_LINES);
  });
});

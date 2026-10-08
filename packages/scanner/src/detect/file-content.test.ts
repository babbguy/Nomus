/**
 * isTestFile: test-ness is decided from the path relative to the scan root,
 * never from the directories that happen to contain the checkout.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isTestFile } from './file-content.js';
import { SdkUsageDetector } from './sdk-usage-detector.js';
import { PhiPatternDetector } from './phi-pattern-detector.js';
import type { DetectorContext } from './detector.js';

/** Build a Windows-style path (backslash separators) from a slash path. */
const win = (p: string): string => p.split('/').join(String.fromCharCode(92));

describe('isTestFile', () => {
  it('T1: ignores test-like directories above the scan root (POSIX)', () => {
    expect(isTestFile('/home/ci/tests/myrepo/src/app.ts', '/home/ci/tests/myrepo')).toBe(false);
    expect(isTestFile('/work/tests/fixtures/repo/src/app.py', '/work/tests/fixtures/repo')).toBe(false);
  });

  it('T2: ignores test-like directories above the scan root (Windows)', () => {
    expect(isTestFile(win('C:/src/fixtures/app/src/a.ts'), win('C:/src/fixtures/app'))).toBe(false);
    expect(isTestFile(win('c:/src/fixtures/app/src/a.ts'), win('C:/src/fixtures/app/'))).toBe(false);
  });

  it('T3: still flags test paths inside the scan root', () => {
    expect(isTestFile('/home/ci/tests/myrepo/tests/foo.py', '/home/ci/tests/myrepo')).toBe(true);
    expect(isTestFile('/home/ci/tests/myrepo/src/__mocks__/x.ts', '/home/ci/tests/myrepo')).toBe(true);
    expect(isTestFile('/home/ci/tests/myrepo/src/a.test.ts', '/home/ci/tests/myrepo')).toBe(true);
    expect(isTestFile('/home/ci/tests/myrepo/.env.example', '/home/ci/tests/myrepo')).toBe(true);
    expect(isTestFile(win('C:/r/app/spec/a.rb'), win('C:/r/app'))).toBe(true);
  });

  it('T4: relative (in-memory) paths and files outside the root keep working', () => {
    expect(isTestFile('tests/foo.py', '/repo')).toBe(true);
    expect(isTestFile('src/app.ts', '/repo')).toBe(false);
    expect(isTestFile('/elsewhere/tests/foo.py', '/repo')).toBe(true);
    expect(isTestFile('/repo/tests/foo.py')).toBe(true);
  });

  it('T5: a root that merely shares a name prefix is not treated as the root', () => {
    expect(isTestFile('/work/repo-tests/fixtures/a.ts', '/work/repo')).toBe(true);
  });
});

describe('detectors on a checkout under a test-named directory', () => {
  let tmp: string;
  let root: string;
  let ctx: DetectorContext;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nomus-root-'));
    root = join(tmp, 'tests', 'fixtures', 'repo');
    mkdirSync(join(root, 'src'), { recursive: true });
    const file = join(root, 'src', 'chat.ts');
    writeFileSync(file, [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      'export async function ask(q: string) {',
      '  const ssn = "123-67-8901";',
      "  return openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: q }] });",
      '}',
      '',
    ].join('\n'));
    ctx = { rootDir: root, files: [file], config: { jurisdictions: ['EU', 'US-FED'] } };
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('T6: SDK-usage and PHI signals are still produced', async () => {
    const sdk = await new SdkUsageDetector().detect(ctx);
    const phi = await new PhiPatternDetector().detect(ctx);
    expect(sdk.length).toBeGreaterThan(0);
    expect(phi.some((s) => s.target === 'ssn')).toBe(true);
  });
});

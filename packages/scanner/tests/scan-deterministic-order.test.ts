/**
 * The same tree must always produce the same findings in the same order, no
 * matter which order the file walk returns files in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';

const walk = { reverse: false };

vi.mock('glob', async (importOriginal) => {
  const real = await importOriginal<typeof import('glob')>();
  return {
    ...real,
    glob: async (...args: Parameters<typeof real.glob>) => {
      const files = [...(await real.glob(...args))].sort();
      return walk.reverse ? files.reverse() : files;
    },
  };
});
vi.mock('axios', () => ({ default: { post: vi.fn() } }));

const { runScan } = await import('../src/scan.js');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nomus-order-'));
  writeFileSync(join(root, 'a_chat.ts'),
    "import OpenAI from 'openai';\nconst c = new OpenAI();\nexport const ask = (q: string) => c.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: q }] });\n");
  writeFileSync(join(root, 'b_summarize.py'),
    'import anthropic\nclient = anthropic.Anthropic()\ndef summarize(t):\n    return client.messages.create(model="m", max_tokens=10, messages=[{"role": "user", "content": t}])\n');
  vi.mocked(axios.post).mockResolvedValue({
    data: {
      markets: {
        EU: {
          rules: [{
            ruleKey: 'eu.ai_act.transparency', effect: 'require_disclosure', severity: 'high',
            humanSummary: 'AI-generated content must be disclosed', legalReference: 'EU AI Act Art. 50',
            matchedOn: ['capability: text_generation'], confidence: 0,
          }],
        },
      },
    },
  });
  return () => rmSync(root, { recursive: true, force: true });
});

async function scanWith(reverse: boolean) {
  walk.reverse = reverse;
  const result = await runScan({ rootDir: root, config: { jurisdictions: ['EU'], api_key: 'k', api_url: 'http://engine.invalid' } });
  return result.findings.map((f) => `${f.file}:${f.line}:${f.rule.ruleKey}`);
}

describe('scan output order', () => {
  it('does not depend on the order the file walk returns files in', async () => {
    const forward = await scanWith(false);
    const reversed = await scanWith(true);
    expect(forward.length).toBeGreaterThan(1);
    expect(reversed).toEqual(forward);
  });
});

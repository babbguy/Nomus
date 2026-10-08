/**
 * Scanner performance benchmark — covers PB1, PB2, PB3, M4.
 *
 * Generates 10,000 synthetic source files in a temp directory and runs all
 * 5 detectors across them. Verifies completion in <30 seconds and bounded
 * memory growth. Skipped on CI by default — set BENCH=1 to run.
 *
 * Why: this is a slow test (~15s on a laptop) and we don't want it firing on
 * every PR. The QA pass and perf-tracking workflows opt in via env var.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImportDetector } from './import-detector.js';
import { SdkUsageDetector } from './sdk-usage-detector.js';
import { PhiPatternDetector } from './phi-pattern-detector.js';
import { RiskClassifier } from './risk-classifier.js';
import { DataFlowDetector } from './data-flow-detector.js';
import type { DetectorContext, DetectorPlugin } from './detector.js';

const SHOULD_RUN = process.env.BENCH === '1';
const FILE_COUNT = parseInt(process.env.BENCH_FILES ?? '10000', 10);
const TIME_BUDGET_MS = 30_000;
const HEAP_BUDGET_MB = 200;

const TEMPLATES: Array<(i: number) => { ext: string; content: string }> = [
  // 1. Clean file (no AI, no PII)
  (i) => ({
    ext: 'ts',
    content: `// helper module ${i}\nexport function add(a: number, b: number): number { return a + b; }\n`,
  }),
  // 2. AI SDK import only
  (i) => ({
    ext: 'ts',
    content: `import OpenAI from 'openai';\nexport const client${i} = new OpenAI();\n`,
  }),
  // 3. AI call with method
  (i) => ({
    ext: 'ts',
    content: `import OpenAI from 'openai';\nconst client = new OpenAI();\nasync function f${i}() { return openai.chat.completions.create({}); }\n`,
  }),
  // 4. PII variable
  (i) => ({
    ext: 'ts',
    content: `export function lookup${i}(ssn: string) { return db.find({ ssn }); }\n`,
  }),
  // 5. Full data flow
  (i) => ({
    ext: 'ts',
    content: `app.post('/q${i}', async (req, res) => {\n  const input = req.body.q;\n  const r = await openai.chat.completions.create({ messages: [{ content: input }] });\n  res.json(r);\n});\n`,
  }),
  // 6. Risk classification — biometric
  (i) => ({
    ext: 'py',
    content: `from deepface import DeepFace\ndef verify${i}(a, b): return DeepFace.verify(a, b)\n`,
  }),
  // 7. Python AI call
  (i) => ({
    ext: 'py',
    content: `import anthropic\ndef chat${i}(msg):\n    return anthropic.messages.create(messages=[{'role': 'user', 'content': msg}])\n`,
  }),
  // 8. Mixed PHI + AI
  (i) => ({
    ext: 'ts',
    content: `const patientName${i} = req.body.name;\nconst r = await openai.chat.completions.create({ messages: [{ content: patientName${i} }] });\n`,
  }),
];

function generateFixture(count: number): string {
  const root = mkdtempSync(join(tmpdir(), 'nomus-bench-'));
  // Spread files across 100 directories to mimic a real repo shape
  for (let i = 0; i < count; i++) {
    const dir = join(root, `pkg${Math.floor(i / 100)}`);
    mkdirSync(dir, { recursive: true });
    const tpl = TEMPLATES[i % TEMPLATES.length](i);
    writeFileSync(join(dir, `file${i}.${tpl.ext}`), tpl.content);
  }
  return root;
}

function listFiles(root: string): string[] {
  // Lightweight recursive listing — avoids glob overhead in the benchmark
  // since we control fixture layout.
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    const fs = require('node:fs') as typeof import('node:fs');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

describe.skipIf(!SHOULD_RUN)('Scanner performance benchmark (BENCH=1)', () => {
  it(`PB1/PB2/PB3/M4: scans ${FILE_COUNT} files in <${TIME_BUDGET_MS / 1000}s with bounded memory`, async () => {
    const root = generateFixture(FILE_COUNT);
    try {
      const files = listFiles(root);
      expect(files.length).toBe(FILE_COUNT);

      const detectors: DetectorPlugin[] = [
        new ImportDetector(),
        new SdkUsageDetector(),
        new PhiPatternDetector(),
        new RiskClassifier(),
        new DataFlowDetector(),
      ];

      const ctx: DetectorContext = {
        rootDir: root,
        files,
        config: { jurisdictions: ['EU', 'US-FED'] },
      };

      // Warm-up GC
      if (global.gc) global.gc();
      const heapBefore = process.memoryUsage().heapUsed / 1024 / 1024;
      const start = performance.now();

      for (const d of detectors) {
        await d.detect(ctx);
      }

      const elapsed = performance.now() - start;
      const heapAfter = process.memoryUsage().heapUsed / 1024 / 1024;
      const heapGrowth = heapAfter - heapBefore;

      // eslint-disable-next-line no-console
      console.log(`  ⏱  ${FILE_COUNT} files: ${elapsed.toFixed(0)}ms | heap +${heapGrowth.toFixed(0)}MB`);

      expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
      expect(heapGrowth).toBeLessThan(HEAP_BUDGET_MB);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

// Always-run smoke test so the benchmark file isn't a no-op in default CI.
describe('Scanner performance smoke (always)', () => {
  it('completes a 200-file scan in well under budget', async () => {
    const root = generateFixture(200);
    try {
      const files = listFiles(root);
      const detectors: DetectorPlugin[] = [
        new ImportDetector(),
        new SdkUsageDetector(),
        new PhiPatternDetector(),
        new RiskClassifier(),
        new DataFlowDetector(),
      ];
      const ctx: DetectorContext = { rootDir: root, files, config: { jurisdictions: ['EU'] } };
      const start = performance.now();
      for (const d of detectors) await d.detect(ctx);
      const elapsed = performance.now() - start;
      // 200 files should be near-instant
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

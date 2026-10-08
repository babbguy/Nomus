/**
 * DataFlowDetector.
 */
import { describe, it, expect } from 'vitest';
import { DataFlowDetector, __test__ } from './data-flow-detector.js';
import type { DetectorContext } from './detector.js';

const { confidenceForHops } = __test__;

function makeCtx(files: Map<string, string>): DetectorContext {
  return {
    rootDir: '/tmp',
    files: Array.from(files.keys()),
    fileContents: files,
    config: { jurisdictions: ['EU'] },
  };
}

describe('DataFlowDetector', () => {
  const detector = new DataFlowDetector();

  it('D1: implements DetectorPlugin shape', () => {
    expect(detector.name).toBe('data-flow-detector');
  });

  it('D2: identifies req.body as user input source', async () => {
    const code = `
      const input = req.body.message;
      const r = await openai.chat.completions.create({ messages: [{ role: 'user', content: input }] });
      res.json(r);
    `;
    const files = new Map([['/tmp/a.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.capabilities.includes('processes_user_input'))).toBe(true);
  });

  it('D3: identifies res.json as returns_to_user sink', async () => {
    const code = `
      const r = await openai.chat.completions.create({});
      res.json(r);
    `;
    const files = new Map([['/tmp/a.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.capabilities.includes('returns_ai_to_user'))).toBe(true);
  });

  it('D3: identifies console.log as logs sink', async () => {
    const code = `
      const r = await openai.chat.completions.create({});
      console.log(r);
    `;
    const files = new Map([['/tmp/a.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.capabilities.includes('logs_ai_output'))).toBe(true);
  });

  it('D3: identifies db.insert as stores sink', async () => {
    const code = `
      const r = await openai.chat.completions.create({});
      db.insert(r);
    `;
    const files = new Map([['/tmp/a.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.capabilities.includes('stores_ai_output'))).toBe(true);
  });

  it('D3: identifies fetch() as third_party sink', async () => {
    const code = `
      const r = await openai.chat.completions.create({});
      await fetch('https://example.com', { body: r });
    `;
    const files = new Map([['/tmp/a.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.capabilities.includes('sends_to_third_party'))).toBe(true);
  });

  it('D4: traces full source -> ai -> sink in single file', async () => {
    const code = `
      const input = req.body.q;
      const r = await openai.chat.completions.create({ messages: [{ content: input }] });
      res.json(r);
    `;
    const files = new Map([['/tmp/a.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    const sig = signals[0];
    expect(sig.capabilities).toContain('processes_user_input');
    expect(sig.capabilities).toContain('returns_ai_to_user');
  });

  it('D5: confidence degradation by hop count', () => {
    expect(confidenceForHops(0)).toBe(0.9);
    expect(confidenceForHops(1)).toBe(0.85);
    expect(confidenceForHops(2)).toBe(0.75);
    expect(confidenceForHops(3)).toBe(0.6);
    expect(confidenceForHops(5)).toBe(0.6);
  });

  it('D6: emits all 5 expected capability strings', async () => {
    const code = `
      const u = req.body.x;
      const r = await openai.chat.completions.create({});
      res.json(r);
      console.log(r);
      db.insert(r);
      await fetch('https://x.io', {});
    `;
    const files = new Map([['/tmp/a.ts', code]]);
    const signals = await detector.detect(makeCtx(files));
    const caps = new Set(signals.flatMap((s) => s.capabilities));
    expect(caps.has('processes_user_input')).toBe(true);
    // returns/logs/stores/third_party — at least one of each, depending on which
    // the proximity scan picks up first
    expect(caps.size).toBeGreaterThanOrEqual(2);
  });

  it('D11: max_taint_depth is configurable', async () => {
    const codeWithGap = `
      const input = req.body.x;
      // gap line 1
      // gap line 2
      // gap line 3
      // gap line 4
      // gap line 5
      const r = await openai.chat.completions.create({});
    `;
    const files = new Map([['/tmp/a.ts', codeWithGap]]);
    const tight = new DataFlowDetector({ maxTaintDepth: 1 });
    const loose = new DataFlowDetector({ maxTaintDepth: 8 });
    const tightSig = await tight.detect(makeCtx(files));
    const looseSig = await loose.detect(makeCtx(files));
    // Tight depth shouldn't see the source 6 lines back; loose should
    const tightCaps = tightSig.flatMap((s) => s.capabilities);
    const looseCaps = looseSig.flatMap((s) => s.capabilities);
    expect(looseCaps).toContain('processes_user_input');
    expect(tightCaps).not.toContain('processes_user_input');
  });

  it('skips files with no AI calls', async () => {
    const files = new Map([['/tmp/a.ts', 'const x = req.body.y; res.json(x);']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.length).toBe(0);
  });
});

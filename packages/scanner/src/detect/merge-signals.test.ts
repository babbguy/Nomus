/**
 * mergeSignals — priority and dedup behaviour.
 */
import { describe, it, expect } from 'vitest';
import { mergeSignals, type DetectorSignal } from './detector.js';

function sig(source: string, file: string, line: number, capabilities: string[]): DetectorSignal {
  return { source, file, line, target: 't', capabilities, confidence: 0.9, evidence: 'e' };
}

describe('mergeSignals', () => {
  it('M3: deduplicates same (file,line,capability) across detectors', () => {
    const signals = [
      sig('import-detector', '/a.ts', 10, ['contains_phi']),
      sig('phi-pattern-detector', '/a.ts', 10, ['contains_phi']),
    ];
    const { dedupedSignals, capabilities } = mergeSignals(signals);
    expect(dedupedSignals.length).toBe(1);
    expect(capabilities).toEqual(['contains_phi']);
  });

  it('M2: higher-precision detector wins on dedup', () => {
    const low = sig('import-detector', '/a.ts', 10, ['contains_phi']);
    const high = sig('data-flow-detector', '/a.ts', 10, ['contains_phi']);
    const { dedupedSignals } = mergeSignals([low, high]);
    expect(dedupedSignals[0].source).toBe('data-flow-detector');
  });

  it('M2: priority order is data-flow > sdk-usage > phi > risk > import', () => {
    const file = '/a.ts';
    const line = 5;
    const cap = 'contains_pii';
    const all = [
      sig('import-detector', file, line, [cap]),
      sig('risk-classifier', file, line, [cap]),
      sig('phi-pattern-detector', file, line, [cap]),
      sig('sdk-usage-detector', file, line, [cap]),
      sig('data-flow-detector', file, line, [cap]),
    ];
    const { dedupedSignals } = mergeSignals(all);
    expect(dedupedSignals[0].source).toBe('data-flow-detector');
  });

  it('M3: different lines are NOT deduped', () => {
    const signals = [
      sig('phi-pattern-detector', '/a.ts', 10, ['contains_phi']),
      sig('phi-pattern-detector', '/a.ts', 11, ['contains_phi']),
    ];
    const { dedupedSignals } = mergeSignals(signals);
    expect(dedupedSignals.length).toBe(2);
  });

  it('M3: different capabilities at same line keep both', () => {
    const signals = [
      sig('phi-pattern-detector', '/a.ts', 10, ['contains_phi']),
      sig('phi-pattern-detector', '/a.ts', 10, ['contains_pii']),
    ];
    const { capabilities } = mergeSignals(signals);
    expect(capabilities.sort()).toEqual(['contains_phi', 'contains_pii']);
  });

  it('returns capabilities as deduplicated array', () => {
    const signals = [
      sig('a', '/a.ts', 1, ['x', 'y']),
      sig('b', '/a.ts', 2, ['y', 'z']),
    ];
    const { capabilities } = mergeSignals(signals);
    expect([...capabilities].sort()).toEqual(['x', 'y', 'z']);
  });
});

describe('mergeSignals — import-detector narrowing', () => {
  it('drops the speculative import capabilities when the SDK calls in that file were found', () => {
    const importSig: DetectorSignal = {
      source: 'import-detector', file: '/a.ts', line: 1, target: 'openai',
      capabilities: ['text_generation', 'image_generation', 'speech_synthesis', 'vision'],
      confidence: 1, evidence: "import OpenAI from 'openai'",
    };
    const usage: DetectorSignal = {
      source: 'sdk-usage-detector', file: '/a.ts', line: 7, target: 'openai.chat.completions.create',
      capabilities: ['text_generation'], confidence: 0.95, evidence: 'openai.chat.completions.create(',
      metadata: { sdk: 'openai' },
    };
    const { capabilities } = mergeSignals([importSig, usage]);
    expect(capabilities).toEqual(['text_generation']);
  });

  it('matches the scoped package name to the SDK family (@anthropic-ai/sdk → anthropic)', () => {
    const importSig: DetectorSignal = {
      source: 'import-detector', file: '/a.ts', line: 1, target: '@anthropic-ai/sdk',
      capabilities: ['text_generation', 'tool_use', 'content_analysis'], confidence: 1, evidence: 'import',
    };
    const usage: DetectorSignal = {
      source: 'sdk-usage-detector', file: '/a.ts', line: 5, target: 'anthropic.messages.create',
      capabilities: ['text_generation'], confidence: 0.95, evidence: 'messages.create', metadata: { sdk: 'anthropic' },
    };
    expect(mergeSignals([importSig, usage]).capabilities).toEqual(['text_generation']);
  });

  it('keeps import capabilities for a file whose calls were not found', () => {
    const importSig: DetectorSignal = {
      source: 'import-detector', file: '/b.py', line: 1, target: 'openai',
      capabilities: ['text_generation', 'embeddings'], confidence: 1, evidence: 'import openai',
    };
    expect(mergeSignals([importSig]).capabilities.sort()).toEqual(['embeddings', 'text_generation']);
  });
});

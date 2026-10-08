import { describe, it, expect } from 'vitest';
import { mapCapabilities, getAllCapabilities } from '../src/detect/capabilities.js';
import type { DetectedImport } from '../src/detect/imports.js';

function makeImport(sdk: string): DetectedImport {
  return { file: 'test.ts', line: 1, sdk, language: 'javascript', importStatement: `import '${sdk}'` };
}

describe('mapCapabilities', () => {
  it('maps Anthropic SDK to text_generation', () => {
    const caps = mapCapabilities([makeImport('@anthropic-ai/sdk')]);
    expect(caps).toHaveLength(1);
    expect(caps[0].capabilities).toContain('text_generation');
  });

  it('maps OpenAI to text_generation, image_generation, and embeddings', () => {
    const caps = mapCapabilities([makeImport('openai')]);
    expect(caps).toHaveLength(1);
    expect(caps[0].capabilities).toContain('text_generation');
    expect(caps[0].capabilities).toContain('image_generation');
    expect(caps[0].capabilities).toContain('embeddings');
  });

  it('returns unknown for unrecognized SDKs', () => {
    const caps = mapCapabilities([makeImport('some-unknown-sdk')]);
    expect(caps).toHaveLength(1);
    expect(caps[0].capabilities).toEqual(['unknown']);
  });
});

describe('getAllCapabilities', () => {
  it('deduplicates capabilities across SDKs', () => {
    const caps = mapCapabilities([
      makeImport('@anthropic-ai/sdk'),
      makeImport('openai'),
    ]);
    const all = getAllCapabilities(caps);
    // text_generation appears in both, but should only be listed once
    const textGenCount = all.filter((c) => c === 'text_generation').length;
    expect(textGenCount).toBe(1);
  });

  it('merges capabilities from multiple SDKs', () => {
    const caps = mapCapabilities([
      makeImport('@anthropic-ai/sdk'),
      makeImport('openai'),
    ]);
    const all = getAllCapabilities(caps);
    expect(all).toContain('text_generation');
    expect(all).toContain('image_generation');
    expect(all).toContain('tool_use');
    expect(all).toContain('embeddings');
  });

  it('returns empty array for no inputs', () => {
    const all = getAllCapabilities([]);
    expect(all).toHaveLength(0);
  });
});

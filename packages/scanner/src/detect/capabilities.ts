import type { DetectedImport } from './imports.js';

export interface DetectedCapability {
  sdk: string;
  capabilities: string[];
}

/**
 * Map SDK imports to AI capabilities.
 */
const SDK_CAPABILITIES: Record<string, string[]> = {
  '@anthropic-ai/sdk': ['text_generation', 'tool_use', 'content_analysis'],
  'anthropic': ['text_generation', 'tool_use', 'content_analysis'],
  'openai': ['text_generation', 'image_generation', 'embeddings', 'speech_synthesis', 'vision', 'content_moderation'],
  '@google/generative-ai': ['text_generation', 'vision', 'embeddings'],
  'google.generativeai': ['text_generation', 'vision', 'embeddings'],
  '@aws-sdk/client-bedrock-runtime': ['text_generation', 'image_generation', 'embeddings'],
  'boto3-bedrock': ['text_generation', 'image_generation', 'embeddings'],
  '@huggingface/inference': ['text_generation', 'image_generation', 'classification', 'embeddings', 'translation'],
  'huggingface_hub': ['text_generation', 'image_generation', 'classification', 'embeddings', 'translation'],
  'replicate': ['text_generation', 'image_generation', 'voice_cloning', 'video_generation'],
  'cohere-ai': ['text_generation', 'embeddings', 'classification', 'reranking'],
  'cohere': ['text_generation', 'embeddings', 'classification', 'reranking'],
  'com.anthropic': ['text_generation', 'tool_use'],
  'com.openai': ['text_generation', 'image_generation', 'embeddings'],
  'aws-bedrock': ['text_generation', 'image_generation', 'embeddings'],
  'anthropic-sdk-go': ['text_generation', 'tool_use'],
  'openai-go': ['text_generation', 'image_generation', 'embeddings'],
};

/**
 * Map detected imports to the AI capabilities they enable.
 */
export function mapCapabilities(imports: DetectedImport[]): DetectedCapability[] {
  const sdkSet = new Set(imports.map((i) => i.sdk));
  const results: DetectedCapability[] = [];

  for (const sdk of sdkSet) {
    const capabilities = SDK_CAPABILITIES[sdk] ?? ['unknown'];
    results.push({ sdk, capabilities });
  }

  return results;
}

/**
 * Get a deduplicated list of all capabilities across all detected SDKs.
 */
export function getAllCapabilities(caps: DetectedCapability[]): string[] {
  const all = new Set<string>();
  for (const c of caps) {
    for (const cap of c.capabilities) {
      all.add(cap);
    }
  }
  return [...all];
}

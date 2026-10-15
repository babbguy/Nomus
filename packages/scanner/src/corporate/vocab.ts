/**
 * The closed vocabularies a corporate rule may use (design spec §8.4.1).
 *
 * Every term here is something a built-in detector emits deterministically.
 * The compile prompt shows these lists to the LLM, the rule schema accepts
 * nothing else, and vocab.test.ts fails if a detector starts emitting a
 * capability or SDK name that is missing here (vocabulary drift).
 */

/**
 * SDK families a rule can name. Detectors report SDKs under several spellings
 * (the package name, the Python module, the Go module, the SDK family); every
 * spelling maps to exactly one family through {@link canonicalSdkFamily}.
 */
export const KNOWN_SDKS = [
  'openai',
  'anthropic',
  'google-genai',
  'cohere',
  'aws-bedrock',
  'huggingface',
  'replicate',
] as const;
export type KnownSdk = (typeof KNOWN_SDKS)[number];

/** Every SDK spelling a detector can emit → its family. */
export const SDK_ALIASES: Readonly<Record<string, KnownSdk>> = {
  // import-detector targets (package / module names)
  openai: 'openai',
  'com.openai': 'openai',
  'openai-go': 'openai',
  '@anthropic-ai/sdk': 'anthropic',
  anthropic: 'anthropic',
  'com.anthropic': 'anthropic',
  'anthropic-sdk-go': 'anthropic',
  '@google/generative-ai': 'google-genai',
  'google.generativeai': 'google-genai',
  '@aws-sdk/client-bedrock-runtime': 'aws-bedrock',
  'boto3-bedrock': 'aws-bedrock',
  'aws-bedrock': 'aws-bedrock',
  '@huggingface/inference': 'huggingface',
  huggingface_hub: 'huggingface',
  replicate: 'replicate',
  'cohere-ai': 'cohere',
  cohere: 'cohere',
  // sdk-usage-detector dynamic-call names (regex engine)
  bedrock: 'aws-bedrock',
  genai: 'google-genai',
  generativeai: 'google-genai',
};

/** The family of a detector SDK name, or null when it is not a known AI SDK. */
export function canonicalSdkFamily(name: string): KnownSdk | null {
  return Object.prototype.hasOwnProperty.call(SDK_ALIASES, name) ? SDK_ALIASES[name] : null;
}

/**
 * Capabilities emitted by the behavioural detectors (sdk-usage, data-flow,
 * PHI/PII, risk classifier, transparency). The import detector's capabilities
 * are what an SDK *could* do, so the `capability` matcher does not use them
 * (§8.4.2; use `sdk_import` to match imports).
 */
export const EMITTED_CAPABILITIES = [
  // sdk-usage-detector: narrowed per called method
  'text_generation', 'embeddings', 'image_generation', 'speech_to_text', 'text_to_speech',
  'content_moderation', 'model_finetuning', 'classification', 'rerank', 'processes_user_input',
  // data-flow-detector
  'returns_ai_to_user', 'logs_ai_output', 'stores_ai_output', 'sends_to_third_party',
  // phi-pattern-detector
  'contains_phi', 'handles_phi', 'contains_pii', 'handles_pii', 'contains_financial', 'handles_financial',
  'phi_in_ai_call', 'pii_in_ai_call', 'logs_phi', 'logs_pii',
  // risk-classifier (EU AI Act Annex III)
  'high_risk_biometric', 'high_risk_critical_infra', 'high_risk_education', 'high_risk_employment',
  'high_risk_essential_services', 'high_risk_law_enforcement', 'high_risk_migration', 'high_risk_justice',
  'handles_biometric',
  // transparency-detector (EU AI Act Article 50)
  'ai_user_interaction', 'generates_ai_content', 'generates_synthetic_media', 'emotion_recognition',
] as const;
export type EmittedCapability = (typeof EMITTED_CAPABILITIES)[number];

export const DATA_CATEGORIES = ['phi', 'pii', 'financial'] as const;
export const DATA_LABELS = ['ssn', 'dob', 'email', 'phone', 'mrn', 'credit_card', 'phi_var', 'pii_var', 'fin_var'] as const;
export const FLOW_SOURCES = ['user_input', 'db_read', 'fs_read', 'env_var'] as const;
export const FLOW_SINKS = ['returns_to_user', 'logs_output', 'stores_output', 'third_party'] as const;
export const LANGUAGES = ['typescript', 'javascript', 'python', 'java', 'go', 'other'] as const;
export type Language = (typeof LANGUAGES)[number];

export const TIERS = ['advisory', 'review-required', 'prohibited'] as const;
export type Tier = (typeof TIERS)[number];

/** Policy keys: `corp.` + lowercase letters, digits, `.`, `_`, `-`; never `:` (it separates fingerprint parts). */
export const POLICY_KEY_RE = /^corp\.[a-z0-9][a-z0-9._-]{0,84}$/;

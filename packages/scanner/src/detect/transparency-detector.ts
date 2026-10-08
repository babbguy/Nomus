/**
 * TransparencyDetector — EU AI Act Article 50 transparency obligations.
 *
 * Article 50 was NOT deferred by the 2026 Digital Omnibus (unlike the Annex III
 * high-risk obligations) and applies from 2026-08-02. It covers exactly the
 * capabilities this detector looks for:
 *
 *   Art 50(1) — AI systems interacting with natural persons must disclose that
 *               the user is talking to an AI            → ai_user_interaction
 *   Art 50(2) — providers of generative AI must mark synthetic output as
 *               machine-detectable                       → generates_ai_content
 *   Art 50(2)/(4) — synthetic audio/image/video ("deepfakes") must be marked
 *               and disclosed                            → generates_synthetic_media
 *   Art 50(3) — emotion recognition / biometric categorisation systems must
 *               inform the persons exposed to them       → emotion_recognition
 *
 * Capabilities MUST match seed-phase3-rules.ts conditions.action values.
 * Pure regex pattern matching over all files, same approach as RiskClassifier:
 * transparency-triggering functionality can be implemented without an explicit
 * AI SDK import, so we do not restrict to SDK-importing files.
 */

import type { DetectorPlugin, DetectorContext, DetectorSignal } from './detector.js';
import { iterFiles, isTestFile, stripComments } from './file-content.js';

interface TransparencyCategory {
  capability: string;
  articleRef: string;
  patterns: RegExp[];
}

const CATEGORIES: TransparencyCategory[] = [
  // Art 50(1) — conversational AI facing natural persons
  {
    capability: 'ai_user_interaction',
    articleRef: 'Article 50(1)',
    patterns: [
      /\b(chat_?bot|chatbot|conversational_?(?:ai|agent|assistant)|virtual_?assistant)\b/i,
      /\b(chat_?completions?|create_?chat|chat_?session|chat_?message|chat_?window|chat_?widget)\b/i,
      /\brole\s*[:=]\s*['"](?:assistant|user)['"]/i,
      /\b(dialogflow|botpress|rasa[._-]|lex_?bot|watson_?assistant)\b/i,
      /\b(stream_?text|stream_?chat|use_?chat)\b/i,
    ],
  },
  // Art 50(2) — generative AI producing synthetic text content
  {
    capability: 'generates_ai_content',
    articleRef: 'Article 50(2)',
    patterns: [
      /\b(text_?generat(?:e|ion|or)|generate_?text|content_?generat(?:e|ion|or))\b/i,
      /\b(completions?\.create|generate_?content|llm_?generate|ai_?writer|copy_?generat)\b/i,
      /\b(autocomplete_?ai|ai_?draft|draft_?generat|summariz(?:e|er)_?ai|ai_?summar)\b/i,
    ],
  },
  // Art 50(2)/(4) — synthetic audio/image/video, incl. deepfakes and voice cloning
  {
    capability: 'generates_synthetic_media',
    articleRef: 'Article 50(2), 50(4)',
    patterns: [
      /\b(dall[-_]?e|stable_?diffusion|midjourney|imagen|sdxl|flux[-_]?(?:dev|pro|schnell))\b/i,
      /\b(text_?to_?(?:image|video|speech|audio)|image_?generat|video_?generat|audio_?generat)\b/i,
      /\b(speech_?synthesis|voice_?clon(?:e|ing)|elevenlabs|deepfake|face_?swap|lip_?sync)\b/i,
      /\b(avatar_?generat|synthetic_?(?:voice|media|video|audio|image))\b/i,
    ],
  },
  // Art 50(3) — emotion recognition / biometric categorisation exposed to persons.
  // Deliberately requires a biometric modality (face/voice/speech/facial) so
  // plain text sentiment analysis does NOT fire — that is not biometric
  // emotion recognition under the Act.
  {
    capability: 'emotion_recognition',
    articleRef: 'Article 50(3)',
    patterns: [
      // No trailing \b — must match snake_case continuations like facial_emotion_model
      /\b(?:facial|face|voice|speech|video)_?(?:emotion|affect|sentiment)/i,
      /\b(?:emotion|affect)_?(?:recognition|detect(?:ion|or)?|classif(?:y|ier|ication))\b/i,
      /\b(emotion_?ai|affective_?computing|micro_?expression)\b/i,
    ],
  },
];

interface CategoryHit {
  category: TransparencyCategory;
  line: number;
  evidence: string;
}

function findHits(content: string): CategoryHit[] {
  const hits: CategoryHit[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const cat of CATEGORIES) {
      for (const pat of cat.patterns) {
        if (pat.test(line)) {
          hits.push({ category: cat, line: i + 1, evidence: line.trim().slice(0, 200) });
          break; // one hit per category per line is enough
        }
      }
    }
  }
  return hits;
}

export class TransparencyDetector implements DetectorPlugin {
  readonly name = 'transparency-detector';
  readonly description = 'Detects EU AI Act Article 50 transparency-obligation triggers (chatbots, generative output, synthetic media, emotion recognition)';
  readonly version = '1.0.0';

  async detect(ctx: DetectorContext): Promise<DetectorSignal[]> {
    const signals: DetectorSignal[] = [];

    for (const { file, content } of iterFiles(ctx)) {
      if (isTestFile(file, ctx.rootDir)) continue;
      const stripped = stripComments(file, content);
      const hits = findHits(stripped);
      if (hits.length === 0) continue;

      for (const hit of hits) {
        signals.push({
          source: this.name,
          file,
          line: hit.line,
          target: hit.category.capability,
          capabilities: [hit.category.capability],
          confidence: 0.85,
          evidence: hit.evidence,
          metadata: { article: hit.category.articleRef },
        });
      }
    }

    return signals;
  }
}

export const __test__ = { findHits, CATEGORIES };

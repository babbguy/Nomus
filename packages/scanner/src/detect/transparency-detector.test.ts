/**
 * TransparencyDetector — EU AI Act Article 50.
 * Art 50 applies from 2026-08-02 (NOT deferred by the Digital Omnibus).
 */
import { describe, it, expect } from 'vitest';
import { TransparencyDetector } from './transparency-detector.js';
import type { DetectorContext } from './detector.js';

function makeCtx(files: Map<string, string>): DetectorContext {
  return {
    rootDir: '/tmp',
    files: Array.from(files.keys()),
    fileContents: files,
    config: { jurisdictions: ['EU'] },
  };
}

describe('TransparencyDetector', () => {
  const detector = new TransparencyDetector();

  it('implements DetectorPlugin shape', () => {
    expect(detector.name).toBe('transparency-detector');
    expect(detector.version).toBeTruthy();
  });

  it('Art 50(1): detects conversational AI interfaces', async () => {
    const files = new Map([
      ['/tmp/chat.ts', `const reply = await openai.chat.completions.create({ messages: [{ role: 'assistant', content: hi }] });`],
      ['/tmp/bot.py', 'bot = ChatBot("support")\nresponse = bot.get_response(user_input)'],
    ]);
    const signals = await detector.detect(makeCtx(files));
    const caps = signals.flatMap((s) => s.capabilities);
    expect(caps).toContain('ai_user_interaction');
    const meta = signals.find((s) => s.capabilities.includes('ai_user_interaction'));
    expect(meta?.metadata?.article).toBe('Article 50(1)');
  });

  it('Art 50(2): detects generative text content', async () => {
    const files = new Map([['/tmp/gen.ts', 'export async function generate_text(prompt: string) { return llm(prompt); }']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.capabilities.includes('generates_ai_content'))).toBe(true);
  });

  it('Art 50(2)/(4): detects synthetic media generation', async () => {
    const files = new Map([
      ['/tmp/img.py', 'image = client.images.generate(model="dall-e-3", prompt=p)'],
      ['/tmp/voice.ts', 'const audio = await elevenlabs.textToSpeech(voiceId, text);'],
    ]);
    const signals = await detector.detect(makeCtx(files));
    const caps = signals.flatMap((s) => s.capabilities);
    expect(caps).toContain('generates_synthetic_media');
  });

  it('Art 50(3): detects biometric emotion recognition', async () => {
    const files = new Map([['/tmp/emo.py', 'result = facial_emotion_model.predict(frame)']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.capabilities.includes('emotion_recognition'))).toBe(true);
  });

  it('does NOT flag plain text sentiment analysis as emotion recognition', async () => {
    const files = new Map([['/tmp/nlp.py', 'score = sentiment_analysis(review_text)\npolarity = get_sentiment(tweet)']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.some((s) => s.capabilities.includes('emotion_recognition'))).toBe(false);
  });

  it('skips test files', async () => {
    const files = new Map([['/tmp/chat.test.ts', 'const bot = new ChatBot();']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals).toHaveLength(0);
  });

  it('emits file/line/evidence for each signal', async () => {
    const files = new Map([['/tmp/a.ts', 'const x = 1;\nconst bot = new Chatbot();']]);
    const signals = await detector.detect(makeCtx(files));
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0].file).toBe('/tmp/a.ts');
    expect(signals[0].line).toBe(2);
    expect(signals[0].evidence).toContain('Chatbot');
  });
});

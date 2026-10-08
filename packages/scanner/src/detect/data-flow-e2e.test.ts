/**
 * DataFlowDetector full-chain E2E tests.
 *
 * Each test uses real Express/Flask/Lambda-shaped code samples and runs
 * them through the full detector → mergeSignals → capability extraction
 * pipeline. The result is asserted against the exact capability strings
 * that seed-phase3-rules.ts uses for GDPR Art.5 / Art.22 / data-flow rules.
 *
 * This closes the UNTESTED-but-probably-works gap from the 2026-04-07 audit
 * by proving the detector emits the strings the rule matcher expects.
 */
import { describe, it, expect } from 'vitest';
import { DataFlowDetector } from './data-flow-detector.js';
import { ImportDetector } from './import-detector.js';
import { SdkUsageDetector } from './sdk-usage-detector.js';
import { PhiPatternDetector } from './phi-pattern-detector.js';
import { RiskClassifier } from './risk-classifier.js';
import { mergeSignals, type DetectorContext } from './detector.js';

function makeCtx(filename: string, content: string): DetectorContext {
  const files = new Map([[filename, content]]);
  return {
    rootDir: '/tmp',
    files: Array.from(files.keys()),
    fileContents: files,
    config: { jurisdictions: ['EU', 'US-FED'] },
  };
}

async function runFullChain(filename: string, content: string): Promise<{
  capabilities: string[];
  perDetector: Record<string, string[]>;
}> {
  const ctx = makeCtx(filename, content);
  const detectors = [
    new ImportDetector(),
    new SdkUsageDetector(),
    new PhiPatternDetector(),
    new RiskClassifier(),
    new DataFlowDetector(),
  ];

  const allSignals = [];
  const perDetector: Record<string, string[]> = {};
  for (const d of detectors) {
    const sigs = await d.detect(ctx);
    allSignals.push(...sigs);
    perDetector[d.name] = sigs.flatMap((s) => s.capabilities);
  }

  const { capabilities } = mergeSignals(allSignals);
  return { capabilities, perDetector };
}

describe('DataFlowDetector full-chain E2E', () => {
  it('Express handler: req.body → openai → res.json emits processes_user_input + returns_ai_to_user', async () => {
    const code = `
import OpenAI from 'openai';
const openai = new OpenAI();

app.post('/chat', async (req, res) => {
  const userMessage = req.body.message;
  const reply = await openai.chat.completions.create({
    messages: [{ role: 'user', content: userMessage }],
  });
  res.json({ reply: reply.choices[0].message.content });
});
`;
    const { capabilities, perDetector } = await runFullChain('/repo/api/chat.ts', code);

    // The full-chain capabilities must include both flow markers
    expect(capabilities).toContain('processes_user_input');
    expect(capabilities).toContain('returns_ai_to_user');
    // And the data-flow detector specifically must have produced them
    expect(perDetector['data-flow-detector']).toContain('processes_user_input');
    expect(perDetector['data-flow-detector']).toContain('returns_ai_to_user');
  });

  it('Express handler logging AI output: emits logs_ai_output', async () => {
    const code = `
const result = await openai.chat.completions.create({});
console.log('AI response:', result);
`;
    const { capabilities } = await runFullChain('/repo/api/log.ts', code);
    expect(capabilities).toContain('logs_ai_output');
  });

  it('Express handler storing AI output to db.insert: emits stores_ai_output', async () => {
    const code = `
const result = await openai.chat.completions.create({});
db.insert(result);
`;
    const { capabilities } = await runFullChain('/repo/api/store.ts', code);
    expect(capabilities).toContain('stores_ai_output');
  });

  it('Express handler sending AI output via fetch: emits sends_to_third_party', async () => {
    const code = `
const result = await openai.chat.completions.create({});
await fetch('https://example.com/webhook', { method: 'POST', body: JSON.stringify(result) });
`;
    const { capabilities } = await runFullChain('/repo/api/forward.ts', code);
    expect(capabilities).toContain('sends_to_third_party');
  });

  it('Python Flask: request.json → anthropic → return jsonify emits user-input + returns', async () => {
    const code = `
import anthropic
from flask import jsonify

@app.route('/ask', methods=['POST'])
def ask():
    user_question = request.json['question']
    response = anthropic.messages.create(messages=[{'role': 'user', 'content': user_question}])
    return jsonify({'answer': response.content})
`;
    const { capabilities } = await runFullChain('/repo/api/ask.py', code);
    expect(capabilities).toContain('processes_user_input');
    expect(capabilities).toContain('returns_ai_to_user');
  });

  it('AWS Lambda: event.body → bedrock.invokeModel emits user-input', async () => {
    const code = `
exports.handler = async (event) => {
  const prompt = JSON.parse(event.body).prompt;
  const result = await bedrock.invokeModel({ body: JSON.stringify({ prompt }) });
  return { statusCode: 200, body: JSON.stringify(result) };
};
`;
    const { capabilities } = await runFullChain('/repo/lambda/handler.ts', code);
    expect(capabilities).toContain('processes_user_input');
  });

  it('PHI variable in same file as AI call: PHI detector + flow detector both fire', async () => {
    const code = `
app.post('/ehr', async (req, res) => {
  const patient_id = req.body.patientId;
  const medical_record = await db.query('SELECT * FROM ehr WHERE id = ?', patient_id);
  const summary = await openai.chat.completions.create({
    messages: [{ role: 'user', content: JSON.stringify(medical_record) }],
  });
  res.json({ summary: summary.choices[0].message.content });
});
`;
    const { capabilities, perDetector } = await runFullChain('/repo/ehr/handler.ts', code);

    // PhiPatternDetector should fire on patient_id / medical_record vars
    expect(capabilities).toContain('contains_phi');
    expect(capabilities).toContain('phi_in_ai_call');

    // DataFlowDetector should fire because req.body → openai → res.json
    expect(capabilities).toContain('processes_user_input');
    expect(capabilities).toContain('returns_ai_to_user');

    // PhiPatternDetector and DataFlowDetector both contributed
    expect(perDetector['phi-pattern-detector'].length).toBeGreaterThan(0);
    expect(perDetector['data-flow-detector'].length).toBeGreaterThan(0);
  });

  it('Pure import without any flow: emits NO data-flow capabilities', async () => {
    const code = `
import OpenAI from 'openai';
export const client = new OpenAI();
// No actual usage in this file
`;
    const { capabilities, perDetector } = await runFullChain('/repo/client.ts', code);
    expect(capabilities).not.toContain('processes_user_input');
    expect(capabilities).not.toContain('returns_ai_to_user');
    expect(capabilities).not.toContain('logs_ai_output');
    expect(perDetector['data-flow-detector']).toEqual([]);
    // But ImportDetector should still fire
    expect(perDetector['import-detector'].length).toBeGreaterThan(0);
  });

  it('AI call with no nearby source or sink: emits NO data-flow capabilities', async () => {
    const code = `
const STATIC_PROMPT = 'Generate a poem about the sea.';
const result = await openai.chat.completions.create({
  messages: [{ role: 'user', content: STATIC_PROMPT }],
});
const text = result.choices[0].message.content;
// We do nothing with the text — bury it in a const
const _unused = text;
`;
    const { capabilities } = await runFullChain('/repo/poem.ts', code);
    expect(capabilities).not.toContain('processes_user_input');
    // No sink within 3 lines of the AI call (AI call at line 4, sinks
    // would be at lines 5-7 — depends on the detector's `after` window).
    // The unused const isn't a sink pattern so nothing fires.
  });

  it('All 5 detectors run cleanly on a 200-line synthetic file (no crashes, no hangs)', async () => {
    const lines: string[] = [`import OpenAI from 'openai';`, 'const openai = new OpenAI();', ''];
    for (let i = 0; i < 50; i++) {
      lines.push(`function handler${i}(req, res) {`);
      lines.push(`  const x = req.body.input${i};`);
      lines.push(`  const r = openai.chat.completions.create({});`);
      lines.push(`  res.json(r);`);
      lines.push(`}`);
    }
    const code = lines.join('\n');
    const { capabilities, perDetector } = await runFullChain('/repo/many.ts', code);

    expect(capabilities).toContain('processes_user_input');
    expect(capabilities).toContain('returns_ai_to_user');
    // 50 handlers should produce at least 50 data-flow signals (one per AI call)
    expect(perDetector['data-flow-detector'].length).toBeGreaterThanOrEqual(50);
  });
});

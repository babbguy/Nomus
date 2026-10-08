/**
 * SdkUsageDetector v2 (AST-based), including:
 *   - AST binding resolution (aliased clients, require(), factories)
 *   - false-positive validation (strings, comments, lookalike identifiers)
 *   - data-flow proof (taint from sources into AI SDK call arguments)
 *   - Python regex fallback
 */
import { describe, it, expect } from 'vitest';
import { SdkUsageDetector } from './sdk-usage-detector.js';
import type { DetectorContext, DetectorSignal } from './detector.js';

function makeCtx(files: Map<string, string>): DetectorContext {
  return {
    rootDir: '/tmp',
    files: Array.from(files.keys()),
    fileContents: files,
    config: { jurisdictions: ['EU'] },
  };
}

const detector = new SdkUsageDetector();

async function scan(content: string, file = '/tmp/a.ts'): Promise<DetectorSignal[]> {
  return detector.detect(makeCtx(new Map([[file, content]])));
}

interface DataFlowMeta {
  sourceKind: string;
  path: Array<{ line: number; code: string }>;
}

function flowOf(signal: DetectorSignal | undefined): DataFlowMeta | null {
  return (signal?.metadata?.dataFlow as DataFlowMeta | null) ?? null;
}

describe('SdkUsageDetector — plugin contract', () => {
  it('S1: implements DetectorPlugin shape', () => {
    expect(detector.name).toBe('sdk-usage-detector');
    expect(detector.version).toBe('2.0.0');
    expect(typeof detector.detect).toBe('function');
  });
});

describe('SdkUsageDetector — known method mapping ', () => {
  it('openai.chat.completions.create -> text_generation', async () => {
    const signals = await scan('await openai.chat.completions.create({})');
    expect(signals.some((s) => s.capabilities.includes('text_generation'))).toBe(true);
    expect(signals.some((s) => s.target === 'openai.chat.completions.create')).toBe(true);
  });

  it('openai.embeddings.create -> embeddings (and NOT text_generation)', async () => {
    const signals = await scan('await openai.embeddings.create({})');
    expect(signals[0].capabilities).toContain('embeddings');
    expect(signals[0].capabilities).not.toContain('text_generation');
  });

  it('openai.images.generate -> image_generation', async () => {
    const signals = await scan('await openai.images.generate({})');
    expect(signals[0].capabilities).toContain('image_generation');
  });

  it('anthropic.messages.create -> text_generation', async () => {
    const signals = await scan('anthropic.messages.create({})');
    expect(signals[0].capabilities).toContain('text_generation');
  });

  it('cohere.embed -> embeddings', async () => {
    const signals = await scan('cohere.embed({})');
    expect(signals[0].capabilities).toContain('embeddings');
  });

  it('bedrock.invokeModel -> text_generation', async () => {
    const signals = await scan('bedrock.invokeModel({})');
    expect(signals[0].capabilities).toContain('text_generation');
  });
});

describe('SdkUsageDetector — confidence tiers', () => {
  it('dynamic call gets confidence 0.3', async () => {
    const signals = await scan('openai[methodName](args)');
    expect(signals.some((s) => s.confidence === 0.3)).toBe(true);
  });

  it('known method gets confidence 0.95', async () => {
    const signals = await scan('await openai.chat.completions.create({})');
    const known = signals.find((s) => s.target === 'openai.chat.completions.create');
    expect(known?.confidence).toBe(0.95);
  });

  it('unknown method on known SDK gets confidence 0.6', async () => {
    const signals = await scan('openai.someUnknownMethod(args)');
    const unknown = signals.find((s) => s.target === 'openai.someUnknownMethod');
    expect(unknown?.confidence).toBe(0.6);
  });

  it('dynamic call on an import-traced client gets confidence 0.3', async () => {
    const code = `
import OpenAI from 'openai';
const ai = new OpenAI();
ai[method](args);
`;
    const signals = await scan(code);
    expect(signals.some((s) => s.confidence === 0.3 && s.target === 'openai[dynamic]')).toBe(true);
  });
});

describe('SdkUsageDetector — AST binding resolution', () => {
  it('detects a call on an aliased client (v1 false negative)', async () => {
    const code = `
import OpenAI from 'openai';
const ai = new OpenAI();
export async function run(prompt) {
  return ai.chat.completions.create({ messages: [{ role: 'user', content: 'hi' }] });
}
`;
    const signals = await scan(code);
    const hit = signals.find((s) => s.target === 'openai.chat.completions.create');
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBe(0.95);
    expect(hit!.metadata?.binding).toBe('import-traced');
    expect(hit!.metadata?.engine).toBe('ast');
  });

  it('detects require() + destructured constructor', async () => {
    const code = `
const { Anthropic } = require('@anthropic-ai/sdk');
const client = new Anthropic();
client.messages.create({ messages: [] });
`;
    const signals = await scan(code, '/tmp/a.cjs');
    const hit = signals.find((s) => s.target === 'anthropic.messages.create');
    expect(hit).toBeDefined();
    expect(hit!.capabilities).toContain('text_generation');
  });

  it('follows alias-of-alias chains', async () => {
    const code = `
import OpenAI from 'openai';
const a = new OpenAI();
const b = a;
b.embeddings.create({ input: 'x' });
`;
    const signals = await scan(code);
    const hit = signals.find((s) => s.target === 'openai.embeddings.create');
    expect(hit).toBeDefined();
    expect(hit!.capabilities).toContain('embeddings');
  });

  it('tracks Google getGenerativeModel() factory result', async () => {
    const code = `
import { GoogleGenerativeAI } from '@google/generative-ai';
const genAI = new GoogleGenerativeAI(key);
const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
await model.generateContent('hello');
`;
    const signals = await scan(code);
    const hit = signals.find((s) => s.target === '@google/generative-ai.generateContent');
    expect(hit).toBeDefined();
    expect(hit!.capabilities).toContain('text_generation');
    expect(hit!.confidence).toBe(0.95);
  });

  it('detects Bedrock v3 client.send(new InvokeModelCommand())', async () => {
    const code = `
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
const client = new BedrockRuntimeClient({ region: 'us-east-1' });
await client.send(new InvokeModelCommand({ body: payload }));
`;
    const signals = await scan(code);
    const hit = signals.find((s) => s.target.includes('send(InvokeModelCommand)'));
    expect(hit).toBeDefined();
    expect(hit!.capabilities).toContain('text_generation');
    expect(hit!.confidence).toBe(0.95);
  });

  it('detects namespace import construction', async () => {
    const code = `
import * as sdk from 'openai';
const client = new sdk.OpenAI();
client.chat.completions.create({});
`;
    const signals = await scan(code);
    expect(signals.some((s) => s.target === 'openai.chat.completions.create')).toBe(true);
  });

  it('detects this.<field> client calls via name heuristic', async () => {
    const code = `
class Bot {
  async reply(text) {
    return this.openai.chat.completions.create({ messages: [] });
  }
}
`;
    const signals = await scan(code);
    expect(signals.some((s) => s.target === 'openai.chat.completions.create')).toBe(true);
  });
});

describe('SdkUsageDetector — false-positive validation', () => {
  it('S9: import-only file produces no signals', async () => {
    const signals = await scan('import OpenAI from "openai";');
    expect(signals.length).toBe(0);
  });

  it('construction without any call produces no signals', async () => {
    const signals = await scan('import OpenAI from "openai";\nexport const client = new OpenAI();');
    expect(signals.length).toBe(0);
  });

  it('SDK call text inside a string literal does NOT fire', async () => {
    const signals = await scan('const doc = "example: openai.chat.completions.create({...})";');
    expect(signals.length).toBe(0);
  });

  it('SDK call text inside a template literal does NOT fire', async () => {
    const signals = await scan('const msg = `usage: openai.chat.completions.create()`;');
    expect(signals.length).toBe(0);
  });

  it('SDK call text inside a comment does NOT fire', async () => {
    const signals = await scan('// TODO: call openai.chat.completions.create({}) here\nconst x = 1;');
    expect(signals.length).toBe(0);
  });

  it('SDK call text inside a console.log string argument does NOT fire on the string', async () => {
    const signals = await scan('console.log("openai.chat.completions.create");');
    expect(signals.length).toBe(0);
  });

  it('lookalike identifier (openaiHelper) does NOT fire', async () => {
    const signals = await scan('openaiHelper.chat.completions.create({});');
    expect(signals.length).toBe(0);
  });

  it('user-defined class with SDK-ish name does NOT fire', async () => {
    const code = `
class MyOpenAIWrapper { create() {} }
const w = new MyOpenAIWrapper();
w.create({});
`;
    const signals = await scan(code);
    expect(signals.length).toBe(0);
  });

  it('S10: skips test files', async () => {
    const signals = await scan('await openai.chat.completions.create({})', '/tmp/a.test.ts');
    expect(signals.length).toBe(0);
  });

  it('malformed / unparseable content never throws', async () => {
    const signals = await scan('const = = = }{ ((( class if openai.chat.');
    expect(Array.isArray(signals)).toBe(true);
  });
});

describe('SdkUsageDetector — data-flow proof', () => {
  it('proves a direct req.body flow into call arguments', async () => {
    const code = `
import OpenAI from 'openai';
const client = new OpenAI();
app.post('/chat', async (req, res) => {
  const reply = await client.chat.completions.create({
    messages: [{ role: 'user', content: req.body.message }],
  });
  res.json(reply);
});
`;
    const signals = await scan(code);
    const hit = signals.find((s) => s.target === 'openai.chat.completions.create');
    expect(hit).toBeDefined();
    expect(hit!.capabilities).toContain('processes_user_input');
    const flow = flowOf(hit);
    expect(flow?.sourceKind).toBe('user_input');
    expect(flow!.path.length).toBeGreaterThanOrEqual(2);
    expect(flow!.path[0].code).toContain('req.body');
  });

  it('proves a multi-hop flow (req.body -> variable -> concatenation -> call)', async () => {
    const code = `
import OpenAI from 'openai';
const client = new OpenAI();
async function handle(req, res) {
  const msg = req.body.message;
  const prompt = 'Q: ' + msg;
  await client.chat.completions.create({ messages: [{ role: 'user', content: prompt }] });
}
`;
    const signals = await scan(code);
    const hit = signals.find((s) => s.target === 'openai.chat.completions.create');
    expect(hit!.capabilities).toContain('processes_user_input');
    const flow = flowOf(hit)!;
    expect(flow.sourceKind).toBe('user_input');
    // source -> msg decl -> prompt decl -> call = 4 steps
    expect(flow.path.length).toBe(4);
    // provenance lines must be monotonically ordered source-to-call
    const lineNumbers = flow.path.map((p) => p.line);
    expect([...lineNumbers].sort((a, b) => a - b)).toEqual(lineNumbers);
  });

  it('proves a flow through a template literal hop', async () => {
    const code = `
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
async function handle(req) {
  const question = req.body.q;
  const prompt = \`Answer this: \${question}\`;
  await client.messages.create({ messages: [{ role: 'user', content: prompt }] });
}
`;
    const signals = await scan(code);
    const hit = signals.find((s) => s.target === 'anthropic.messages.create');
    expect(hit!.capabilities).toContain('processes_user_input');
    expect(flowOf(hit)?.sourceKind).toBe('user_input');
  });

  it('proves a flow through destructuring (const { message } = req.body)', async () => {
    const code = `
import OpenAI from 'openai';
const client = new OpenAI();
async function handle(req) {
  const { message } = req.body;
  await client.chat.completions.create({ messages: [{ role: 'user', content: message }] });
}
`;
    const signals = await scan(code);
    const hit = signals.find((s) => s.target === 'openai.chat.completions.create');
    expect(hit!.capabilities).toContain('processes_user_input');
  });

  it('proves a flow through reassignment (let prompt; prompt = req.body.q)', async () => {
    const code = `
import OpenAI from 'openai';
const client = new OpenAI();
async function handle(req) {
  let prompt = 'static';
  prompt = req.body.q;
  await client.chat.completions.create({ messages: [{ role: 'user', content: prompt }] });
}
`;
    const signals = await scan(code);
    const hit = signals.find((s) => s.target === 'openai.chat.completions.create');
    expect(hit!.capabilities).toContain('processes_user_input');
  });

  it('env var flow is recorded in metadata but does NOT emit processes_user_input', async () => {
    const code = `
import OpenAI from 'openai';
const client = new OpenAI();
await client.chat.completions.create({ messages: [{ role: 'system', content: process.env.SYSTEM_PROMPT }] });
`;
    const signals = await scan(code);
    const hit = signals.find((s) => s.target === 'openai.chat.completions.create');
    expect(flowOf(hit)?.sourceKind).toBe('env_var');
    expect(hit!.capabilities).not.toContain('processes_user_input');
  });

  it('Lambda event.body flow is proven as user_input', async () => {
    const code = `
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
const client = new BedrockRuntimeClient({});
export const handler = async (event) => {
  const prompt = JSON.parse(event.body).prompt;
  return client.send(new InvokeModelCommand({ body: JSON.stringify({ prompt }) }));
};
`;
    const signals = await scan(code);
    const hit = signals.find((s) => s.target.includes('send(InvokeModelCommand)'));
    expect(hit).toBeDefined();
    expect(hit!.capabilities).toContain('processes_user_input');
    expect(flowOf(hit)?.sourceKind).toBe('user_input');
  });

  it('NO flow proof for a static prompt (false-positive guard)', async () => {
    const code = `
import OpenAI from 'openai';
const client = new OpenAI();
const STATIC_PROMPT = 'Write a poem about the sea.';
await client.chat.completions.create({ messages: [{ role: 'user', content: STATIC_PROMPT }] });
`;
    const signals = await scan(code);
    const hit = signals.find((s) => s.target === 'openai.chat.completions.create');
    expect(hit).toBeDefined();
    expect(hit!.capabilities).not.toContain('processes_user_input');
    expect(flowOf(hit)).toBeNull();
  });

  it('NO flow proof when tainted data exists in the file but never reaches the call (false-positive guard)', async () => {
    const code = `
import OpenAI from 'openai';
const client = new OpenAI();
const STATIC = 'fixed prompt';
async function handle(req) {
  const name = req.body.name;
  auditLog(name);
  await client.chat.completions.create({ messages: [{ role: 'user', content: STATIC }] });
}
`;
    const signals = await scan(code);
    const hit = signals.find((s) => s.target === 'openai.chat.completions.create');
    expect(hit).toBeDefined();
    expect(hit!.capabilities).not.toContain('processes_user_input');
    expect(flowOf(hit)).toBeNull();
  });

  it('NO flow proof when only a property NAME matches a source shape (false-positive guard)', async () => {
    const code = `
import OpenAI from 'openai';
const client = new OpenAI();
const config = { body: 'static config value' };
await client.chat.completions.create({ messages: [{ role: 'user', content: config.body }] });
`;
    const signals = await scan(code);
    const hit = signals.find((s) => s.target === 'openai.chat.completions.create');
    expect(hit).toBeDefined();
    expect(flowOf(hit)).toBeNull();
  });
});

describe('SdkUsageDetector — regex fallback (non-JS/TS files)', () => {
  it('Python anthropic call is detected via the regex engine', async () => {
    const code = `
import anthropic

def chat(msg):
    return anthropic.messages.create(messages=[{'role': 'user', 'content': msg}])
`;
    const signals = await scan(code, '/tmp/app.py');
    const hit = signals.find((s) => s.target === 'anthropic.messages.create');
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBe(0.95);
    expect(hit!.metadata?.engine).toBe('regex');
  });

  it('Python comment does NOT fire', async () => {
    const signals = await scan('# anthropic.messages.create(...) example\nx = 1\n', '/tmp/app.py');
    expect(signals.length).toBe(0);
  });

  it('Python openai.embeddings.create narrows to embeddings', async () => {
    const signals = await scan('resp = openai.embeddings.create(input=text)\n', '/tmp/app.py');
    expect(signals[0].capabilities).toContain('embeddings');
  });
});

describe('SdkUsageDetector — signal shape', () => {
  it('every signal carries source, 1-indexed line, evidence, and narrowed metadata', async () => {
    const code = `
import OpenAI from 'openai';
const client = new OpenAI();
await client.chat.completions.create({});
`;
    const signals = await scan(code);
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) {
      expect(s.source).toBe('sdk-usage-detector');
      expect(s.line).toBeGreaterThanOrEqual(1);
      expect(s.evidence.length).toBeGreaterThan(0);
      expect(s.metadata?.narrowed).toBe(true);
      expect(s.confidence).toBeGreaterThan(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
    }
    // Line must point at the actual call site (line 4 of the snippet)
    expect(signals[0].line).toBe(4);
  });
});

describe('SdkUsageDetector — Python client variables (regex engine)', () => {
  it('detects calls on a client bound by `client = OpenAI(...)`', async () => {
    const signals = await scan([
      'from openai import OpenAI',
      'client = OpenAI(api_key="x")',
      'resp = client.chat.completions.create(model="gpt-4o", messages=[])',
    ].join('\n'), '/tmp/bot.py');
    const call = signals.find((s) => s.target === 'openai.chat.completions.create');
    expect(call).toBeDefined();
    expect(call!.line).toBe(3);
    expect(call!.confidence).toBe(0.95);
    expect(call!.capabilities).toEqual(['text_generation']);
  });

  it('detects `client = anthropic.Anthropic()` + client.messages.create, and does not count the constructor as a call', async () => {
    const signals = await scan([
      'import anthropic',
      'client = anthropic.Anthropic()',
      'msg = client.messages.create(model="claude", max_tokens=10, messages=[])',
    ].join('\n'), '/tmp/triage.py');
    expect(signals.map((s) => s.target)).toEqual(['anthropic.messages.create']);
    expect(signals[0].line).toBe(3);
  });

  it('detects async clients', async () => {
    const signals = await scan([
      'from openai import AsyncOpenAI',
      'llm = AsyncOpenAI()',
      'out = await llm.embeddings.create(input="x", model="m")',
    ].join('\n'), '/tmp/emb.py');
    expect(signals.map((s) => s.target)).toEqual(['openai.embeddings.create']);
  });
});

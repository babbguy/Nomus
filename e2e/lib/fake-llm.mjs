// Deterministic stand-in for an OpenAI-compatible chat completions API.
// The engine is pointed at it with OPENAI_BASE_URL. Each Nomus prompt is
// recognised by its system prompt and answered in the documented JSON shape,
// with content derived from the text it was given, so the same input always
// produces the same rules.

import http from 'node:http';
import fs from 'node:fs';

const sentences = (text) => text
  .replace(/\n+/g, ' ')
  .split(/(?<=[.;:])\s+(?=[A-Z(])/)
  .map((s) => s.trim())
  .filter((s) => /\b(shall|must|may not)\b/i.test(s) && s.length > 30);

const firstJsonArray = (text) => {
  const i = text.indexOf('[');
  const j = text.lastIndexOf(']');
  if (i < 0 || j < i) return null;
  try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; }
};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

/** Returns [promptKind, responseText]. promptKind 'unrecognized' means no known prompt matched. */
export function respond(system, user) {
  // Scout tier-2 news classifier
  if (system.startsWith('You are a regulatory intelligence classifier')) {
    const out = [];
    for (const m of user.matchAll(/^\[(\d+)\] Title: (.*)$/gm)) {
      const t = m[2];
      const relevant = /\b(AI|artificial intelligence|algorithm)/i.test(t) && /\b(act|bill|law|regulat|rule|polic|guidance|order)/i.test(t);
      const jurisdiction = /\bEU\b|European/i.test(t) ? 'EU' : /California/i.test(t) ? 'US-CA' : /UK\b|Britain/i.test(t) ? 'UK' : relevant ? 'US-FED' : null;
      out.push({ index: Number(m[1]), relevant, confidence: relevant ? 0.9 : 0.8, jurisdiction });
    }
    return ['scout-classifier', JSON.stringify(out)];
  }
  // Gatekeeper contamination check
  if (system.startsWith('You inspect scraped regulatory text for contamination')) {
    return ['gatekeeper', JSON.stringify({ issues: [], structure: { starts_with_title: true, has_legal_structure: true, proper_ending: true } })];
  }
  // Change classifier
  if (system.includes('"classification": "material"')) {
    return ['change-classifier', JSON.stringify({ classification: 'material', confidence: 0.9, summary: 'Material change detected.' })];
  }
  // Bulk requirement extraction
  if (system.startsWith('You are a regulatory compliance analyst. Extract every distinct legal requirement')) {
    const ref = (/^Legal Reference: (.+)$/m.exec(user) || /^Context: (.+)$/m.exec(user) || [])[1] || 'Unreferenced';
    return ['bulk-extractor', JSON.stringify(sentences(user).map((s) => ({
      ref,
      type: /may not/i.test(s) ? 'prohibition' : 'obligation',
      who: /employer/i.test(s) ? 'employers using AI analysis of video interviews' : 'regulated entities',
      what: s,
      conditions: 'positions based in Illinois',
      severity: /may not/i.test(s) ? 'high' : 'medium',
      effective_date: '2020-01-01',
      industries: ['all'],
      industry_scope: 'global',
      industry_notes: 'Applies to hiring.',
    })))];
  }
  // Merger: return the input array unchanged
  if (system.startsWith('You are merging regulatory requirements')) {
    return ['merger', JSON.stringify(firstJsonArray(user) ?? [])];
  }
  // Translator: requirements -> policy rules
  if (system.startsWith('You are an automated regulatory text parser')) {
    const juris = (/\(jurisdiction: ([^)]+)\)/.exec(user) || [])[1] || 'US-IL';
    const text = user.split('REGULATORY TEXT:')[1] || user;
    const reqs = firstJsonArray(text);
    const items = Array.isArray(reqs) && reqs.length ? reqs : sentences(text).map((s) => ({ ref: 'Sec. 5.', what: s }));
    return ['translator', JSON.stringify(items.slice(0, 12).map((r, i) => ({
      ruleKey: `${juris.toLowerCase().replace('-', '_')}.aivia.${slug(String(r.ref ?? 'sec'))}.${slug(String(r.what)).slice(0, 24)}_${i}`,
      jurisdiction: juris,
      category: /consent|notify|inform|explain/i.test(r.what) ? 'transparency' : /delete|destroy|share/i.test(r.what) ? 'privacy' : 'accountability',
      conditions: { action: /video/i.test(r.what) ? 'high_risk_employment' : 'processes_user_input', region: juris },
      effect: /may not/i.test(r.what) ? 'deny' : /notify|inform|explain|report/i.test(r.what) ? 'require_disclosure' : 'allow_with_audit',
      severity: /may not/i.test(r.what) ? 'high' : 'medium',
      humanSummary: `Appears to require: ${String(r.what).slice(0, 180)}`,
      legalReference: `${r.ref ?? 'Sec. 5.'} of the Artificial Intelligence Video Interview Act (820 ILCS 42)`,
      effectiveDate: '2020-01-01',
      expiresAt: null,
    })))];
  }
  // Summarizer used for large texts
  if (system.startsWith('You are a legal text summarizer')) {
    return ['summarizer', sentences(user).join('\n')];
  }
  // Rule scorer
  if (/"overallScore"/.test(system)) {
    return ['scorer', JSON.stringify({ overallScore: 9, reject: [], adjustments: [] })];
  }
  // Coverage validator
  if (/"score": N/.test(system)) {
    return ['validator', JSON.stringify({ score: 9, missing: [], errors: [], notes: 'Coverage complete (fake LLM).' })];
  }
  // Corporate policy compile (CPG, design spec §8.1): answers from phrases of the policy text.
  if (system.startsWith('You compile a corporate engineering policy into a deterministic Nomus rule.')) {
    return ['cpg-compile', cpgCompile(user)];
  }
  // CPG reviewer context (design spec §8.1, §10.3): a fixed, labelled explanation.
  if (system.startsWith('You explain flagged source code to a governance reviewer.')) {
    return ['cpg-reviewer-context', JSON.stringify({ whatItDoes: 'Calls a chat completion API (generated by the gate fake).', whyFlagged: "Matches the policy's SDK-call primitive." })];
  }
  return ['unrecognized', '{}'];
}

const cpgRule = (match, message, files = { include: ['**/*'] }) => ({ schemaVersion: 1, match, files, message });
const cpgCompiled = (suggestedKey, title, suggestedTier, rule) => JSON.stringify({
  expressible: true, suggestedKey, title, suggestedTier, rule,
  rationale: 'Deterministic primitive chosen by the gate fake.', limitations: ['Gate fake: fixed answer.'],
});

/** The fake compile answers of design spec §8.1 (anything else gives '{}', i.e. rejected_schema). */
function cpgCompile(user) {
  if (/direct OpenAI/.test(user)) {
    return cpgCompiled('corp.no-direct-openai', 'No direct OpenAI calls', 'prohibited', cpgRule(
      { all: [{ kind: 'sdk_call', sdks: ['openai'] }] },
      'Call OpenAI only through the approved LLM gateway.',
      { include: ['**/*'], exclude: ['src/llm/gateway/**'] },
    ));
  }
  if (/gpt-4-32k/.test(user)) {
    return cpgCompiled('corp.no-gpt-4-32k', 'Do not use gpt-4-32k', 'review-required', cpgRule(
      { all: [{ kind: 'line_regex', pattern: { source: 'gpt-4-32k', flags: '' } }] },
      'The gpt-4-32k model is retired for new code; use an approved model.',
    ));
  }
  if (/personal data/.test(user) && /\bAI\b/.test(user)) {
    return cpgCompiled('corp.no-pii-to-ai', 'No personal data in AI calls', 'review-required', cpgRule(
      { all: [{ kind: 'capability', capabilities: ['pii_in_ai_call'] }] },
      'Personal data must not be sent to an AI model without a Legal review.',
    ));
  }
  if (/well designed|good taste/.test(user)) {
    return JSON.stringify({ expressible: false, reason: 'Requires a judgement about design quality, which a deterministic rule cannot make.' });
  }
  return '{}';
}

/** Start the fake LLM on `port` (0 = any). Every request is appended to `logFile`. */
export function startFakeLlm({ port = 0, logFile }) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* answered below */ }
    const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
    const text = (m) => (typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p.text ?? '').join('') : '');
    const system = text(msgs.find((m) => m.role === 'system'));
    const user = text(msgs.find((m) => m.role === 'user'));
    let kind; let content;
    try { [kind, content] = respond(system, user); } catch (e) { kind = 'handler-error'; content = '{}'; }
    const entry = { t: new Date().toISOString(), url: req.url, kind, system: system.slice(0, 160), user: user.slice(0, 300), content: String(content).slice(0, 300) };
    // CPG compile prompts are kept whole, so the gate can prove no example code was sent.
    if (kind === 'cpg-compile') entry.requestBody = body;
    calls.push(entry);
    if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-gate',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: parsed.model ?? 'gate-fake',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: Math.ceil((system.length + user.length) / 4), completion_tokens: Math.ceil(String(content).length / 4), total_tokens: 0 },
    }));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      resolve({ url: `http://127.0.0.1:${p}`, calls, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

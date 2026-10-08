/**
 * DataFlowDetector — Phase 3b.
 *
 * Pragmatic single-file taint tracking. Identifies:
 *   sources : req.body, db.query, fs.read, env vars, function params (input)
 *   ai_call : any AI SDK invocation
 *   sinks   : res.json, console.log, db.insert, fs.write, fetch, return
 *
 * For every AI call site, looks at preceding lines (within max_taint_depth)
 * for sources and following lines for sinks. Emits flow-shaped capabilities
 * matching seed-phase3-rules.ts conditions.action values:
 *   processes_user_input, stores_ai_output, logs_ai_output,
 *   returns_ai_to_user, sends_to_third_party
 *
 * Confidence degrades with hop count: direct=0.9, 1-hop=0.85, 2-hop=0.75, 3+=0.6.
 * This is a heuristic — not a sound dataflow analysis. The trade-off is
 * deliberate: zero deps, fast, useful enough to fire GDPR Art.22 / Art.5 rules.
 */

import type { DetectorPlugin, DetectorContext, DetectorSignal } from './detector.js';
import { iterFiles, isTestFile, stripComments } from './file-content.js';

const DEFAULT_MAX_DEPTH = 3;

// ─── Pattern banks ──────────────────────────────────────────────────

const SOURCE_PATTERNS: Array<[string, RegExp]> = [
  ['user_input', /\breq(?:uest)?\.(?:body|query|params|cookies|headers)\b/],
  ['user_input', /\brequest\.(?:GET|POST|json|form|args)\b/], // Django/Flask
  ['user_input', /\bevent\.(?:body|queryStringParameters|pathParameters)\b/], // AWS Lambda
  ['db_read', /\b(?:db|database|conn|connection|prisma|knex|sequelize)\.(?:query|find|select|exec)\b/i],
  ['db_read', /\bawait\s+\w+\.find(?:One|Many)?\(/],
  ['fs_read', /\b(?:fs|fsp|fs\.promises)\.(?:readFile|createReadStream)\b/],
  ['env_var', /\bprocess\.env\.[A-Z_][A-Z0-9_]+/],
  ['env_var', /\bos\.environ(?:\.get)?\b/],
];

const AI_CALL_PATTERNS: RegExp[] = [
  /\bopenai\.[a-zA-Z_][\w.]*\s*\(/,
  /\banthropic\.[a-zA-Z_][\w.]*\s*\(/,
  /\bcohere\.[a-zA-Z_][\w.]*\s*\(/,
  /\b(?:bedrock|BedrockRuntime)\.[a-zA-Z_][\w.]*\s*\(/,
  /\b(?:genai|generativeai|GenerativeModel)\.[a-zA-Z_][\w.]*\s*\(/,
  /\b(?:messages|completions|embeddings|generate_content|invoke_model)\.create\s*\(/,
  /\b(?:client|llm|model|chat)\.(?:complete|generate|invoke|chat|messages?\.create)\s*\(/i,
];

const SINK_PATTERNS: Array<[string, RegExp]> = [
  ['returns_to_user', /\bres(?:ponse)?\.(?:json|send|write|render)\b/],
  ['returns_to_user', /\breturn\s+(?:Response|JsonResponse|HttpResponse|jsonify)/],
  ['logs_output', /\bconsole\.(?:log|info|warn|error|debug)\b/],
  ['logs_output', /\b(?:logger?|log)\.(?:info|warn|error|debug|log)\b/],
  ['logs_output', /\bprint(?:ln|f)?\s*\(/],
  ['stores_output', /\b(?:db|database|prisma|knex|sequelize)\.(?:insert|create|save|update)\b/i],
  ['stores_output', /\b(?:fs|fsp|fs\.promises)\.(?:writeFile|appendFile|createWriteStream)\b/],
  ['third_party', /\bfetch\s*\(\s*['"]https?:\/\//],
  ['third_party', /\baxios\.(?:get|post|put|patch|delete)\s*\(/],
  ['third_party', /\brequests\.(?:get|post|put|patch|delete)\s*\(/], // Python
];

const SINK_TO_CAPABILITY: Record<string, string> = {
  returns_to_user: 'returns_ai_to_user',
  logs_output: 'logs_ai_output',
  stores_output: 'stores_ai_output',
  third_party: 'sends_to_third_party',
};

interface AiCallSite {
  line: number; // 1-indexed
  evidence: string;
}

function findAiCalls(lines: string[]): AiCallSite[] {
  const out: AiCallSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const pat of AI_CALL_PATTERNS) {
      if (pat.test(lines[i])) {
        out.push({ line: i + 1, evidence: lines[i].trim().slice(0, 200) });
        break;
      }
    }
  }
  return out;
}

function findNearby(
  lines: string[],
  centerIdx: number,
  patterns: Array<[string, RegExp]>,
  direction: 'before' | 'after',
  maxDepth: number,
): { kind: string; hops: number } | null {
  const start = direction === 'before' ? Math.max(0, centerIdx - maxDepth) : centerIdx + 1;
  const end = direction === 'before' ? centerIdx : Math.min(lines.length, centerIdx + 1 + maxDepth);
  for (let i = start; i < end; i++) {
    const line = lines[i];
    for (const [kind, pat] of patterns) {
      if (pat.test(line)) {
        const hops = Math.abs(i - centerIdx);
        return { kind, hops };
      }
    }
  }
  return null;
}

function confidenceForHops(hops: number): number {
  if (hops === 0) return 0.9;
  if (hops === 1) return 0.85;
  if (hops === 2) return 0.75;
  return 0.6;
}

export interface DataFlowConfig {
  maxTaintDepth?: number;
}

export class DataFlowDetector implements DetectorPlugin {
  readonly name = 'data-flow-detector';
  readonly description = 'Single-file taint tracking from input sources through AI calls to output sinks';
  readonly version = '1.0.0';

  constructor(private config: DataFlowConfig = {}) {}

  async detect(ctx: DetectorContext): Promise<DetectorSignal[]> {
    const maxDepth = this.config.maxTaintDepth ?? DEFAULT_MAX_DEPTH;
    const signals: DetectorSignal[] = [];

    for (const { file, content } of iterFiles(ctx)) {
      if (isTestFile(file)) continue;
      const stripped = stripComments(file, content);
      const lines = stripped.split('\n');
      const aiCalls = findAiCalls(lines);
      if (aiCalls.length === 0) continue;

      for (const call of aiCalls) {
        const idx = call.line - 1;
        const source = findNearby(lines, idx, SOURCE_PATTERNS, 'before', maxDepth);
        const sink = findNearby(lines, idx, SINK_PATTERNS, 'after', maxDepth);

        const caps: string[] = [];
        let evidenceParts: string[] = [`ai_call(line ${call.line})`];
        let hops = 0;

        if (source) {
          if (source.kind === 'user_input') caps.push('processes_user_input');
          evidenceParts.push(`source:${source.kind}(${source.hops}h)`);
          hops = Math.max(hops, source.hops);
        }
        if (sink) {
          const sinkCap = SINK_TO_CAPABILITY[sink.kind];
          if (sinkCap) caps.push(sinkCap);
          evidenceParts.push(`sink:${sink.kind}(${sink.hops}h)`);
          hops = Math.max(hops, sink.hops);
        }

        if (caps.length === 0) continue;

        signals.push({
          source: this.name,
          file,
          line: call.line,
          target: 'data_flow',
          capabilities: caps,
          confidence: confidenceForHops(hops),
          evidence: evidenceParts.join(' | ') + ' :: ' + call.evidence,
          metadata: {
            source: source?.kind ?? null,
            sink: sink?.kind ?? null,
            hops,
            maxDepth,
          },
        });
      }
    }

    return signals;
  }
}

export const __test__ = { findAiCalls, findNearby, confidenceForHops, SOURCE_PATTERNS, SINK_PATTERNS };

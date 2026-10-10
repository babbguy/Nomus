/**
 * SdkUsageDetector — Phase 3a, v2 (AST-based).
 *
 * Identifies actual SDK method calls (not just imports) and maps them to
 * narrowed capabilities. Where ImportDetector emits the union of an SDK's
 * capabilities, SdkUsageDetector emits only what's actually called.
 *
 * JS/TS files are parsed with the TypeScript compiler API (parse only — no
 * type checking), which gives three things regex cannot:
 *
 *   1. Binding resolution — `import OpenAI from 'openai'; const ai = new
 *      OpenAI(); ai.chat.completions.create()` is detected even though the
 *      variable isn't named `openai`. Covers default/named/namespace imports,
 *      `require()`, alias chains, Google's `getGenerativeModel()` factory,
 *      and Bedrock's `client.send(new InvokeModelCommand())` pattern.
 *   2. Zero string/comment false positives — SDK call text inside a string
 *      literal, template literal, or comment is never a CallExpression.
 *   3. Data-flow proof — intra-file taint tracking from sources (req.body,
 *      event.body, process.env, db reads, fs reads) through variable
 *      declarations/assignments into the arguments of an AI SDK call. When a
 *      flow is proven, the signal carries `processes_user_input` (for
 *      user-input sources) and `metadata.dataFlow` with the full provenance
 *      chain (line + code for every hop from source to call site).
 *
 * The taint tracker is file-scoped and name-keyed (not scope-sensitive):
 * a variable shadowing the same name in another function can over-taint.
 * That trade-off is deliberate — it only affects the flow annotation, never
 * whether a call is detected, and it errs toward flagging for review.
 *
 * Non-JS/TS files (Python, Go, Java) fall back to the v1 regex engine.
 *
 * Confidence tiers (unchanged contract from v1):
 *   known method (e.g. openai.chat.completions.create)  → 0.95
 *   unknown method on a known SDK                       → 0.6
 *   dynamic / indirect (sdk[methodName]())              → 0.3
 */

import ts from 'typescript';
import type { DetectorPlugin, DetectorContext, DetectorSignal } from './detector.js';
import { iterFiles, isTestFile, stripComments, offsetToLine } from './file-content.js';

// ─── SDK knowledge base ─────────────────────────────────────────────

interface SdkSpec {
  /** SDK identifier (matches what ImportDetector reports) */
  sdk: string;
  /** Import specifiers that bind this SDK */
  modules: string[];
  /** Constructor / class names exported by the SDK */
  classNames: string[];
  /** Bare identifiers treated as this SDK by convention (v1 heuristic, kept) */
  rootNames: string[];
  /** Method path → narrowed capabilities */
  methods: Record<string, string[]>;
  /** AWS-style command classes passed to `.send(new XCommand())` */
  commands?: Record<string, string[]>;
  /** Default capabilities if method is on the SDK but not in `methods` */
  defaultCapabilities: string[];
}

const SDK_SPECS: SdkSpec[] = [
  {
    sdk: 'openai',
    modules: ['openai'],
    classNames: ['OpenAI', 'AzureOpenAI', 'AsyncOpenAI', 'AsyncAzureOpenAI'],
    rootNames: ['openai'],
    methods: {
      'chat.completions.create': ['text_generation'],
      'completions.create': ['text_generation'],
      'responses.create': ['text_generation'],
      'embeddings.create': ['embeddings'],
      'images.generate': ['image_generation'],
      'audio.transcriptions.create': ['speech_to_text'],
      'audio.speech.create': ['text_to_speech'],
      'moderations.create': ['content_moderation'],
      'fine_tuning.jobs.create': ['model_finetuning'],
    },
    defaultCapabilities: ['text_generation'],
  },
  {
    sdk: 'anthropic',
    modules: ['@anthropic-ai/sdk'],
    classNames: ['Anthropic', 'AsyncAnthropic'],
    rootNames: ['anthropic'],
    methods: {
      'messages.create': ['text_generation'],
      'messages.stream': ['text_generation'],
      'completions.create': ['text_generation'],
    },
    defaultCapabilities: ['text_generation'],
  },
  {
    sdk: '@google/generative-ai',
    modules: ['@google/generative-ai', '@google/genai'],
    classNames: ['GoogleGenerativeAI', 'GenerativeModel', 'GoogleGenAI'],
    rootNames: ['genai', 'generativeai', 'GenerativeModel', 'GoogleGenerativeAI'],
    methods: {
      'generateContent': ['text_generation'],
      'generateContentStream': ['text_generation'],
      'generate_content': ['text_generation'],
      'embedContent': ['embeddings'],
      'embed_content': ['embeddings'],
      'models.generateContent': ['text_generation'],
      'models.embedContent': ['embeddings'],
    },
    defaultCapabilities: ['text_generation'],
  },
  {
    sdk: 'cohere-ai',
    modules: ['cohere-ai'],
    classNames: ['CohereClient', 'CohereClientV2'],
    rootNames: ['cohere'],
    methods: {
      'generate': ['text_generation'],
      'chat': ['text_generation'],
      'embed': ['embeddings'],
      'classify': ['classification'],
      'rerank': ['rerank'],
    },
    defaultCapabilities: ['text_generation'],
  },
  {
    sdk: '@aws-sdk/client-bedrock-runtime',
    modules: ['@aws-sdk/client-bedrock-runtime'],
    classNames: ['BedrockRuntimeClient', 'BedrockRuntime'],
    rootNames: ['bedrock', 'BedrockRuntime', 'BedrockRuntimeClient'],
    methods: {
      'invokeModel': ['text_generation'],
      'invoke_model': ['text_generation'],
      'invokeModelWithResponseStream': ['text_generation'],
      'converse': ['text_generation'],
    },
    commands: {
      'InvokeModelCommand': ['text_generation'],
      'InvokeModelWithResponseStreamCommand': ['text_generation'],
      'ConverseCommand': ['text_generation'],
      'ConverseStreamCommand': ['text_generation'],
    },
    defaultCapabilities: ['text_generation'],
  },
];

const MODULE_INDEX = new Map<string, SdkSpec>();
const CLASS_INDEX = new Map<string, SdkSpec>();
const ROOT_INDEX = new Map<string, SdkSpec>();
for (const spec of SDK_SPECS) {
  for (const m of spec.modules) MODULE_INDEX.set(m, spec);
  for (const c of spec.classNames) CLASS_INDEX.set(c, spec);
  for (const r of spec.rootNames) ROOT_INDEX.set(r, spec);
}

// ─── Shared shapes ──────────────────────────────────────────────────

type SourceKind = 'user_input' | 'env_var' | 'db_read' | 'fs_read';

interface FlowStep {
  line: number;
  code: string;
}

interface TaintRecord {
  kind: SourceKind;
  steps: FlowStep[];
}

interface CallHit {
  sdk: string;
  method: string | null;
  capabilities: string[];
  confidence: number;
  line: number;
  /** Last line of the call expression (equals `line` for single-line calls and the regex engine). */
  endLine: number;
  evidence: string;
  /** How the call site was attributed to the SDK */
  binding: 'import-traced' | 'name-heuristic' | 'dynamic';
  /** Proven data flow into this call's arguments, if any */
  flow?: { sourceKind: SourceKind; path: FlowStep[] };
}

// ─── AST engine (JS/TS) ─────────────────────────────────────────────

const JS_TS_RE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;

const USER_INPUT_REQ_PROPS = new Set(['body', 'query', 'params', 'cookies', 'headers', 'json', 'form']);
const USER_INPUT_EVENT_PROPS = new Set(['body', 'queryStringParameters', 'pathParameters']);
const DB_ROOTS_RE = /^(db|database|conn|connection|prisma|knex|sequelize)$/i;
const DB_METHODS = new Set(['query', 'find', 'findOne', 'findMany', 'select', 'exec', 'execute']);
const FS_METHODS = new Set(['readFile', 'readFileSync', 'createReadStream']);

const KIND_PRIORITY: Record<SourceKind, number> = {
  user_input: 4,
  db_read: 3,
  fs_read: 2,
  env_var: 1,
};

interface Bindings {
  /** SDK class/namespace names in scope: 'OpenAI' → openai spec */
  classes: Map<string, SdkSpec>;
  /** SDK instance variables: 'client' → openai spec */
  instances: Map<string, SdkSpec>;
}

function scriptKindFor(file: string): ts.ScriptKind {
  return /\.(tsx|jsx)$/i.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function lineTextAt(lines: string[], line: number): string {
  return (lines[line - 1] ?? '').trim().slice(0, 200);
}

/** Pass 1 — resolve which identifiers are SDK classes and SDK client instances. */
function collectBindings(sf: ts.SourceFile): Bindings {
  const classes = new Map<string, SdkSpec>();
  const instances = new Map<string, SdkSpec>();

  const resolveNewExpr = (init: ts.NewExpression): SdkSpec | undefined => {
    const ctor = init.expression;
    if (ts.isIdentifier(ctor)) {
      return classes.get(ctor.text) ?? CLASS_INDEX.get(ctor.text);
    }
    if (ts.isPropertyAccessExpression(ctor)) {
      // new ns.OpenAI() — namespace import or matching class name
      const base = ctor.expression;
      const byNamespace = ts.isIdentifier(base) ? classes.get(base.text) : undefined;
      return byNamespace ?? CLASS_INDEX.get(ctor.name.text);
    }
    return undefined;
  };

  const bindNames = (name: ts.BindingName, spec: SdkSpec, into: Map<string, SdkSpec>): void => {
    if (ts.isIdentifier(name)) {
      into.set(name.text, spec);
    } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) into.set(el.name.text, spec);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = MODULE_INDEX.get(node.moduleSpecifier.text);
      if (spec && node.importClause) {
        if (node.importClause.name) classes.set(node.importClause.name.text, spec);
        const nb = node.importClause.namedBindings;
        if (nb) {
          if (ts.isNamespaceImport(nb)) classes.set(nb.name.text, spec);
          else for (const el of nb.elements) classes.set(el.name.text, spec);
        }
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      let init: ts.Expression = node.initializer;
      if (ts.isAwaitExpression(init)) init = init.expression;

      // const OpenAI = require('openai') / const { Anthropic } = require('@anthropic-ai/sdk')
      if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === 'require' &&
        init.arguments.length === 1 &&
        ts.isStringLiteral(init.arguments[0])
      ) {
        const spec = MODULE_INDEX.get(init.arguments[0].text);
        if (spec) bindNames(node.name, spec, classes);
      }

      if (ts.isIdentifier(node.name)) {
        // const client = new OpenAI()
        if (ts.isNewExpression(init)) {
          const spec = resolveNewExpr(init);
          if (spec) instances.set(node.name.text, spec);
        }
        // const alias = client
        else if (ts.isIdentifier(init) && instances.has(init.text)) {
          instances.set(node.name.text, instances.get(init.text)!);
        }
        // const model = genAI.getGenerativeModel({...}) — the returned model
        // carries generateContent/embedContent
        else if (
          ts.isCallExpression(init) &&
          ts.isPropertyAccessExpression(init.expression) &&
          init.expression.name.text === 'getGenerativeModel'
        ) {
          const base = init.expression.expression;
          if (
            ts.isIdentifier(base) &&
            (instances.has(base.text) || classes.has(base.text) || ROOT_INDEX.has(base.text))
          ) {
            const gspec = MODULE_INDEX.get('@google/generative-ai');
            if (gspec) instances.set(node.name.text, gspec);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { classes, instances };
}

/** Walk a callee expression into (root identifier, property path). */
function calleeChain(
  expr: ts.Expression,
): { root: string; parts: string[]; dynamic: boolean; viaNew: boolean } | null {
  const parts: string[] = [];
  let dynamic = false;
  let node: ts.Expression = expr;

  while (true) {
    if (ts.isPropertyAccessExpression(node)) {
      parts.unshift(node.name.text);
      node = node.expression;
    } else if (ts.isElementAccessExpression(node)) {
      dynamic = true;
      node = node.expression;
    } else {
      break;
    }
  }

  if (ts.isIdentifier(node)) return { root: node.text, parts, dynamic, viaNew: false };
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
    // new OpenAI().chat.completions.create()
    return { root: node.expression.text, parts, dynamic, viaNew: true };
  }
  if (node.kind === ts.SyntaxKind.ThisKeyword && parts.length >= 1) {
    // this.openai.chat.completions.create() — class field holding a client
    const root = parts.shift()!;
    return { root, parts, dynamic, viaNew: false };
  }
  return null;
}

function resolveSpec(
  chain: { root: string; viaNew: boolean },
  bindings: Bindings,
): { spec: SdkSpec; binding: CallHit['binding'] } | null {
  if (chain.viaNew) {
    const spec = bindings.classes.get(chain.root) ?? CLASS_INDEX.get(chain.root);
    return spec ? { spec, binding: 'import-traced' } : null;
  }
  const traced = bindings.instances.get(chain.root) ?? bindings.classes.get(chain.root);
  if (traced) return { spec: traced, binding: 'import-traced' };
  const heuristic = ROOT_INDEX.get(chain.root);
  return heuristic ? { spec: heuristic, binding: 'name-heuristic' } : null;
}

/** Is this a taint source expression? */
function sourceKindOf(node: ts.Node): SourceKind | null {
  if (ts.isPropertyAccessExpression(node)) {
    const base = node.expression;
    if (ts.isIdentifier(base)) {
      if ((base.text === 'req' || base.text === 'request') && USER_INPUT_REQ_PROPS.has(node.name.text)) {
        return 'user_input';
      }
      if (base.text === 'event' && USER_INPUT_EVENT_PROPS.has(node.name.text)) return 'user_input';
    }
    // process.env.X
    if (
      ts.isPropertyAccessExpression(base) &&
      ts.isIdentifier(base.expression) &&
      base.expression.text === 'process' &&
      base.name.text === 'env'
    ) {
      return 'env_var';
    }
  }
  if (ts.isElementAccessExpression(node)) {
    // process.env['X']
    const base = node.expression;
    if (
      ts.isPropertyAccessExpression(base) &&
      ts.isIdentifier(base.expression) &&
      base.expression.text === 'process' &&
      base.name.text === 'env'
    ) {
      return 'env_var';
    }
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    const base = node.expression.expression;
    if (ts.isIdentifier(base)) {
      if (DB_ROOTS_RE.test(base.text) && DB_METHODS.has(method)) return 'db_read';
      if ((base.text === 'fs' || base.text === 'fsp') && FS_METHODS.has(method)) return 'fs_read';
    }
    // fs.promises.readFile
    if (
      ts.isPropertyAccessExpression(base) &&
      ts.isIdentifier(base.expression) &&
      base.expression.text === 'fs' &&
      base.name.text === 'promises' &&
      FS_METHODS.has(method)
    ) {
      return 'fs_read';
    }
  }
  return null;
}

/** True when an identifier is a value reference (not a property/parameter name). */
function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return true;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (ts.isParameter(p) && p.name === id) return false;
  if (ts.isVariableDeclaration(p) && p.name === id) return false;
  if (ts.isFunctionDeclaration(p) && p.name === id) return false;
  if ((ts.isMethodDeclaration(p) || ts.isMethodSignature(p)) && p.name === id) return false;
  return true;
}

/**
 * Best taint found anywhere inside an expression subtree: either a direct
 * source expression or a reference to an already-tainted variable.
 */
function taintOf(expr: ts.Node, taints: Map<string, TaintRecord>, sf: ts.SourceFile): TaintRecord | null {
  let best: TaintRecord | null = null;
  const consider = (t: TaintRecord): void => {
    if (!best || KIND_PRIORITY[t.kind] > KIND_PRIORITY[best.kind]) best = t;
  };

  const visit = (node: ts.Node): void => {
    const sk = sourceKindOf(node);
    if (sk) {
      consider({
        kind: sk,
        steps: [{ line: lineOf(node, sf), code: node.getText(sf).slice(0, 120) }],
      });
    }
    if (ts.isIdentifier(node) && isValueReference(node)) {
      const t = taints.get(node.text);
      if (t) consider(t);
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return best;
}

function extendTaint(t: TaintRecord, line: number, code: string): TaintRecord {
  return { kind: t.kind, steps: [...t.steps, { line, code }] };
}

/** Pass 2 — find SDK call sites and prove data flows into their arguments. */
function findCallsAst(sf: ts.SourceFile, lines: string[], bindings: Bindings): CallHit[] {
  const hits: CallHit[] = [];
  const taints = new Map<string, TaintRecord>();

  const visit = (node: ts.Node): void => {
    // Taint propagation: const x = <tainted>, incl. destructuring
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const t = taintOf(node.initializer, taints, sf);
      if (t) {
        const line = lineOf(node, sf);
        const code = lineTextAt(lines, line);
        if (ts.isIdentifier(node.name)) {
          taints.set(node.name.text, extendTaint(t, line, code));
        } else if (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
              taints.set(el.name.text, extendTaint(t, line, code));
            }
          }
        }
      }
    }

    // Taint propagation: x = <tainted>, obj.prop = <tainted> (taints obj)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const t = taintOf(node.right, taints, sf);
      if (t) {
        const line = lineOf(node, sf);
        let target: ts.Expression = node.left;
        while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
          target = target.expression;
        }
        if (ts.isIdentifier(target)) {
          taints.set(target.text, extendTaint(t, line, lineTextAt(lines, line)));
        }
      }
    }

    // SDK call sites
    if (ts.isCallExpression(node)) {
      const chain = calleeChain(node.expression);
      if (chain) {
        const resolved = resolveSpec(chain, bindings);
        if (resolved && (chain.parts.length > 0 || chain.dynamic)) {
          const { spec, binding } = resolved;
          const line = lineOf(node, sf);
          const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
          const evidence = lineTextAt(lines, line);

          let hit: CallHit;
          if (chain.dynamic) {
            hit = {
              sdk: spec.sdk,
              method: null,
              capabilities: spec.defaultCapabilities,
              confidence: 0.3,
              line,
              endLine,
              evidence,
              binding: 'dynamic',
            };
          } else {
            const path = chain.parts.join('.');
            let method = path;
            let known = spec.methods[path];
            // Bedrock v3: client.send(new InvokeModelCommand({...}))
            if (!known && spec.commands && path === 'send' && node.arguments.length > 0) {
              const arg = node.arguments[0];
              if (ts.isNewExpression(arg) && ts.isIdentifier(arg.expression)) {
                const cmd = spec.commands[arg.expression.text];
                if (cmd) {
                  known = cmd;
                  method = `send(${arg.expression.text})`;
                }
              }
            }
            hit = {
              sdk: spec.sdk,
              method,
              capabilities: known ?? spec.defaultCapabilities,
              confidence: known ? 0.95 : 0.6,
              line,
              endLine,
              evidence,
              binding,
            };
          }

          // Data-flow proof: does tainted data reach this call's arguments?
          let flow: TaintRecord | null = null;
          for (const arg of node.arguments) {
            const t = taintOf(arg, taints, sf);
            if (t && (!flow || KIND_PRIORITY[t.kind] > KIND_PRIORITY[flow.kind])) flow = t;
          }
          if (flow) {
            hit.flow = {
              sourceKind: flow.kind,
              path: [...flow.steps, { line, code: evidence }],
            };
            if (flow.kind === 'user_input' && !hit.capabilities.includes('processes_user_input')) {
              hit.capabilities = [...hit.capabilities, 'processes_user_input'];
            }
          }

          hits.push(hit);
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function analyzeJsTsFile(file: string, content: string): CallHit[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const lines = content.split('\n');
  const bindings = collectBindings(sf);
  return findCallsAst(sf, lines, bindings);
}

// ─── Regex fallback engine (Python, Go, Java, …) ────────────────────

interface RegexMapping {
  sdk: string;
  pattern: RegExp;
  methods: Record<string, string[]>;
  defaultCapabilities: string[];
}

const REGEX_MAPPINGS: RegexMapping[] = SDK_SPECS.map((spec) => ({
  sdk: spec.sdk,
  pattern: new RegExp(
    `\\b(?:${spec.rootNames.join('|')})\\.([a-zA-Z_][\\w.]*)\\s*\\(`,
    'g',
  ),
  methods: spec.methods,
  defaultCapabilities: spec.defaultCapabilities,
}));

// Dynamic / indirect call: sdkName[var](...)
const DYNAMIC_RE = /\b(openai|anthropic|cohere|bedrock|genai|generativeai)\s*\[\s*[a-zA-Z_]/g;

// Client construction in non-JS files: `client = OpenAI(...)`,
// `client = anthropic.Anthropic()`, `model = genai.GenerativeModel(...)`,
// `client: AsyncOpenAI = AsyncOpenAI()`. Captures (variable, class).
const INSTANCE_ASSIGN_RE =
  /\b([A-Za-z_]\w*)\s*(?::\s*[\w.[\]]+\s*)?(?::=|=)\s*(?:await\s+)?(?:new\s+)?(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)\s*\(/g;

/** Variables bound to an SDK client by constructor call (regex engine). */
function collectRegexInstances(content: string): Map<string, SdkSpec> {
  const instances = new Map<string, SdkSpec>();
  INSTANCE_ASSIGN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INSTANCE_ASSIGN_RE.exec(content)) !== null) {
    const spec = CLASS_INDEX.get(m[2]);
    if (spec) instances.set(m[1], spec);
  }
  return instances;
}

function findCallsRegex(content: string): CallHit[] {
  const hits: CallHit[] = [];
  const seen = new Set<string>();
  const push = (hit: CallHit): void => {
    const key = `${hit.line}::${hit.sdk}::${hit.method ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(hit);
  };

  const scan = (sdk: string, pattern: RegExp, methods: Record<string, string[]>, defaults: string[]): void => {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const method = m[1];
      // `anthropic.Anthropic()` constructs a client — it is not an AI call.
      if (CLASS_INDEX.has(method)) continue;
      const known = methods[method];
      const line = offsetToLine(content, m.index);
      push({
        sdk,
        method,
        capabilities: known ?? defaults,
        confidence: known ? 0.95 : 0.6,
        line,
        endLine: line,
        evidence: content.slice(m.index, Math.min(m.index + 200, content.length)).split('\n')[0],
        binding: 'name-heuristic',
      });
    }
  };

  // Calls on client variables: client = OpenAI(); client.chat.completions.create(...)
  for (const [name, spec] of collectRegexInstances(content)) {
    scan(spec.sdk, new RegExp(`\\b${name}\\.([a-zA-Z_][\\w.]*)\\s*\\(`, 'g'), spec.methods, spec.defaultCapabilities);
  }

  for (const map of REGEX_MAPPINGS) {
    scan(map.sdk, map.pattern, map.methods, map.defaultCapabilities);
  }

  DYNAMIC_RE.lastIndex = 0;
  let dm: RegExpExecArray | null;
  while ((dm = DYNAMIC_RE.exec(content)) !== null) {
    const line = offsetToLine(content, dm.index);
    hits.push({
      sdk: dm[1],
      method: null,
      capabilities: ['text_generation'],
      confidence: 0.3,
      line,
      endLine: line,
      evidence: content.slice(dm.index, Math.min(dm.index + 200, content.length)).split('\n')[0],
      binding: 'dynamic',
    });
  }

  return hits;
}

// ─── Detector plugin ────────────────────────────────────────────────

export class SdkUsageDetector implements DetectorPlugin {
  readonly name = 'sdk-usage-detector';
  readonly description =
    'AST-based SDK call-site analysis: narrows capabilities to what is actually called and proves data flows into AI SDK calls';
  readonly version = '2.0.0';

  async detect(ctx: DetectorContext): Promise<DetectorSignal[]> {
    const signals: DetectorSignal[] = [];

    for (const { file, content } of iterFiles(ctx)) {
      if (isTestFile(file, ctx.rootDir)) continue;

      let hits: CallHit[];
      let engine: 'ast' | 'regex';
      if (JS_TS_RE.test(file)) {
        try {
          hits = analyzeJsTsFile(file, content);
          engine = 'ast';
        } catch {
          // Parser failure must never fail a scan — degrade to regex.
          hits = findCallsRegex(stripComments(file, content));
          engine = 'regex';
        }
      } else {
        hits = findCallsRegex(stripComments(file, content));
        engine = 'regex';
      }

      for (const hit of hits) {
        signals.push({
          source: this.name,
          file,
          line: hit.line,
          target: hit.method ? `${hit.sdk}.${hit.method}` : `${hit.sdk}[dynamic]`,
          capabilities: hit.capabilities,
          confidence: hit.confidence,
          evidence: hit.evidence,
          metadata: {
            sdk: hit.sdk,
            method: hit.method,
            endLine: hit.endLine,
            narrowed: true,
            engine,
            binding: hit.binding,
            dataFlow: hit.flow
              ? { sourceKind: hit.flow.sourceKind, path: hit.flow.path }
              : null,
          },
        });
      }
    }

    return signals;
  }
}

export const __test__ = {
  analyzeJsTsFile,
  findCallsRegex,
  SDK_SPECS,
  REGEX_MAPPINGS,
};

import type { DetectorContext, DetectorPlugin, DetectorSignal } from '../detect/detector.js';
import { ImportDetector } from '../detect/import-detector.js';
import { SdkUsageDetector } from '../detect/sdk-usage-detector.js';
import { PhiPatternDetector } from '../detect/phi-pattern-detector.js';
import { RiskClassifier } from '../detect/risk-classifier.js';
import { TransparencyDetector } from '../detect/transparency-detector.js';
import { DataFlowDetector } from '../detect/data-flow-detector.js';
import { stripComments } from '../detect/file-content.js';
import { compileGlobList, toPosixPath } from './glob.js';
import { languageOf } from './languages.js';
import { MAX_REGEX_LINE_LENGTH } from './regex-safety.js';
import { extractSnippet, fingerprintOf, normalizeSnippet, snippetHash, splitLines, stripBom } from './fingerprint.js';
import { canonicalSdkFamily } from './vocab.js';
import type { Language } from './vocab.js';
import type { CorporateMatcher, CorporateRule, MatcherKind } from './rule-schema.js';

/**
 * The deterministic corporate matcher (design spec §8.2, §8.4.2).
 *
 * Pure: the same files and rules always give the same findings. It reads no
 * clock, makes no network call and never calls an LLM; the detectors it runs
 * are the scanner's own, on in-memory content. The only inputs are the file
 * contents (keyed by repo-relative path) and the rules.
 *
 * Corporate rules ignore the repository's `.nomus.yml` ignore list and
 * detector toggles (decision D14): a developer must not be able to hide a
 * violation by editing a file they own. The only fixed exclusions are
 * `.git` and `node_modules` directories, files over 2 MB and binary files.
 */

export const MAX_CORPORATE_FILE_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_CHARS = 8192;

export interface CorporatePolicyInput {
  policyKey: string;
  version: number;
  rule: CorporateRule;
}

export interface CorporateFinding {
  policyKey: string;
  policyVersion: number;
  /** Repo-relative POSIX path. */
  filePath: string;
  language: Language;
  /** The snippet range (after context widening, clamped, capped). */
  startLine: number;
  endLine: number;
  /** The line of the anchor hit (match.all[0]). */
  anchorLine: number;
  matchedBy: MatcherKind;
  /** The normalized snippet: the exact text the fingerprint hashes. */
  snippet: string;
  snippetHash: string;
  fingerprint: string;
  truncated: boolean;
  message: string;
}

export interface SkippedFile {
  filePath: string;
  reason: 'excluded_directory' | 'too_large' | 'binary' | 'invalid_path';
}

export interface CorporateEvaluation {
  findings: CorporateFinding[];
  /** Files that were in scope of at least one rule and were evaluated. */
  scannedFileCount: number;
  /** Lines longer than the regex line limit, skipped by line_regex matchers. */
  skippedLongLines: number;
  skippedFiles: SkippedFile[];
}

interface Hit {
  line: number;
  endLine: number;
}

type DetectorName = 'import-detector' | 'sdk-usage-detector' | 'phi-pattern-detector' | 'risk-classifier' | 'transparency-detector' | 'data-flow-detector';

/** Detectors whose signals a matcher kind reads. `line_regex` needs none. */
const DETECTORS_FOR: Record<MatcherKind, DetectorName[]> = {
  sdk_call: ['sdk-usage-detector'],
  sdk_import: ['import-detector'],
  // Behavioural detectors only: the import detector's capabilities are what an
  // SDK could do, not what the code does (use sdk_import for imports).
  capability: ['sdk-usage-detector', 'phi-pattern-detector', 'risk-classifier', 'transparency-detector', 'data-flow-detector'],
  data_pattern: ['phi-pattern-detector'],
  data_flow: ['data-flow-detector'],
  line_regex: [],
};

function makeDetector(name: DetectorName): DetectorPlugin {
  switch (name) {
    case 'import-detector': return new ImportDetector();
    case 'sdk-usage-detector': return new SdkUsageDetector();
    case 'phi-pattern-detector': return new PhiPatternDetector();
    case 'risk-classifier': return new RiskClassifier();
    case 'transparency-detector': return new TransparencyDetector();
    case 'data-flow-detector': return new DataFlowDetector();
  }
}

/** Normalize a path to repo-relative POSIX form; null when it escapes the repository. */
export function toRepoRelative(path: string): string | null {
  const p = toPosixPath(path).replace(/^\.\/+/, '');
  if (p.length === 0 || p.startsWith('/') || /^[a-z]:/i.test(p)) return null;
  if (p.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return p;
}

function fixedExclusion(path: string, content: string): SkippedFile['reason'] | null {
  if (path.split('/').some((seg) => seg === '.git' || seg === 'node_modules')) return 'excluded_directory';
  if (Buffer.byteLength(content, 'utf8') > MAX_CORPORATE_FILE_BYTES) return 'too_large';
  if (content.slice(0, BINARY_SNIFF_CHARS).includes('\u0000')) return 'binary';
  return null;
}

interface PreparedRule {
  input: CorporatePolicyInput;
  inScope: (path: string, language: Language) => boolean;
  regexes: Map<CorporateMatcher, RegExp>;
}

function prepare(p: CorporatePolicyInput): PreparedRule {
  const include = compileGlobList(p.rule.files.include);
  const exclude = compileGlobList(p.rule.files.exclude);
  const languages = p.rule.files.languages ? new Set(p.rule.files.languages) : null;
  const regexes = new Map<CorporateMatcher, RegExp>();
  for (const m of [...p.rule.match.all, ...p.rule.match.unless]) {
    if (m.kind === 'line_regex') regexes.set(m, new RegExp(m.pattern.source, m.pattern.flags));
  }
  return {
    input: p,
    inScope: (path, language) => include(path) && !exclude(path) && (!languages || languages.has(language)),
    regexes,
  };
}

interface FileState {
  path: string;
  language: Language;
  /** BOM-stripped content with every line ending converted to '\n'. */
  text: string;
  lines: string[];
  stripped?: string[];
  signals: Map<DetectorName, DetectorSignal[]>;
}

function signalsOf(file: FileState, names: DetectorName[]): DetectorSignal[] {
  const out: DetectorSignal[] = [];
  for (const n of names) out.push(...(file.signals.get(n) ?? []));
  return out;
}

function metaOf(s: DetectorSignal): Record<string, unknown> {
  return (s.metadata ?? {}) as Record<string, unknown>;
}

function hitsFor(m: CorporateMatcher, file: FileState, regex: RegExp | undefined, counters: { longLines: number }): Hit[] {
  const at = (s: DetectorSignal): Hit => {
    const endLine = metaOf(s).endLine;
    return { line: s.line, endLine: typeof endLine === 'number' && endLine >= s.line ? endLine : s.line };
  };
  switch (m.kind) {
    case 'sdk_call':
      return signalsOf(file, ['sdk-usage-detector']).filter((s) => {
        const meta = metaOf(s);
        const family = typeof meta.sdk === 'string' ? canonicalSdkFamily(meta.sdk) : null;
        if (!family || !m.sdks.includes(family)) return false;
        const method = typeof meta.method === 'string' ? meta.method : null;
        // Dynamic calls (sdk[name]()) have no method: they match only when no methods are listed.
        if (m.methods) return method !== null && m.methods.includes(method);
        return true;
      }).map(at);
    case 'sdk_import':
      return signalsOf(file, ['import-detector']).filter((s) => {
        const family = canonicalSdkFamily(s.target);
        return family !== null && m.sdks.includes(family);
      }).map(at);
    case 'capability': {
      const wanted = new Set<string>(m.capabilities);
      return signalsOf(file, DETECTORS_FOR.capability).filter((s) => s.capabilities.some((c) => wanted.has(c))).map(at);
    }
    case 'data_pattern':
      return signalsOf(file, ['phi-pattern-detector']).filter((s) => {
        const category = metaOf(s).category;
        if (typeof category !== 'string' || !(m.categories as readonly string[]).includes(category)) return false;
        return !m.labels || (m.labels as readonly string[]).includes(s.target);
      }).map(at);
    case 'data_flow':
      return signalsOf(file, ['data-flow-detector']).filter((s) => {
        const meta = metaOf(s);
        if (m.sources && !(typeof meta.source === 'string' && (m.sources as readonly string[]).includes(meta.source))) return false;
        if (m.sinks && !(typeof meta.sink === 'string' && (m.sinks as readonly string[]).includes(meta.sink))) return false;
        return true;
      }).map(at);
    case 'line_regex': {
      if (!regex) return [];
      let lines = file.lines;
      if (m.pattern.ignoreComments) {
        file.stripped ??= splitLines(stripComments(file.path, file.text));
        lines = file.stripped;
      }
      const hits: Hit[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > MAX_REGEX_LINE_LENGTH) {
          counters.longLines++;
          continue;
        }
        regex.lastIndex = 0;
        if (regex.test(line)) hits.push({ line: i + 1, endLine: i + 1 });
      }
      return hits;
    }
  }
}

/** The companion hit nearest the anchor (ties: the earlier line), or null. */
function nearest(hits: Hit[], anchor: Hit, within: number | null): Hit | null {
  let best: Hit | null = null;
  let bestDist = Infinity;
  for (const h of hits) {
    const d = Math.abs(h.line - anchor.line);
    if (within !== null && d > within) continue;
    if (d < bestDist || (d === bestDist && best !== null && h.line < best.line)) {
      best = h;
      bestDist = d;
    }
  }
  return best;
}

function evaluateRule(rule: PreparedRule, file: FileState, counters: { longLines: number }): CorporateFinding[] {
  const { policyKey, version, rule: r } = rule.input;
  const within = r.match.withinLines;
  const hitCache = new Map<CorporateMatcher, Hit[]>();
  const hits = (m: CorporateMatcher) => {
    let h = hitCache.get(m);
    if (!h) {
      h = hitsFor(m, file, rule.regexes.get(m), counters);
      hitCache.set(m, h);
    }
    return h;
  };

  const [first, ...companions] = r.match.all;
  const out = new Map<string, CorporateFinding>();
  for (const anchor of hits(first)) {
    let start = anchor.line;
    let end = anchor.endLine;
    let ok = true;
    for (const m of companions) {
      const c = nearest(hits(m), anchor, within);
      if (!c) { ok = false; break; }
      start = Math.min(start, c.line);
      end = Math.max(end, c.endLine);
    }
    if (!ok) continue;
    const suppressed = r.match.unless.some((m) => {
      const scopeWithin = r.match.unlessScope === 'window' ? within : null;
      return nearest(hits(m), anchor, scopeWithin) !== null;
    });
    if (suppressed) continue;

    const range = extractSnippet(file.lines, start, end, r.snippet.contextBefore, r.snippet.contextAfter);
    const key = `${range.startLine}:${range.endLine}`;
    if (out.has(key)) continue;
    const normalized = normalizeSnippet(range.snippet);
    out.set(key, {
      policyKey,
      policyVersion: version,
      filePath: file.path,
      language: file.language,
      startLine: range.startLine,
      endLine: range.endLine,
      anchorLine: anchor.line,
      matchedBy: first.kind,
      snippet: normalized,
      snippetHash: snippetHash(normalized),
      fingerprint: fingerprintOf(normalized, policyKey, version),
      truncated: range.truncated,
      message: r.message,
    });
  }
  return [...out.values()];
}

function compareFindings(a: CorporateFinding, b: CorporateFinding): number {
  if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
  if (a.startLine !== b.startLine) return a.startLine - b.startLine;
  if (a.policyKey !== b.policyKey) return a.policyKey < b.policyKey ? -1 : 1;
  return a.endLine - b.endLine;
}

/**
 * Evaluate corporate rules over in-memory files (repo-relative path → UTF-8
 * content). One finding per (policyKey, file, startLine, endLine), sorted by
 * (file, startLine, policyKey).
 */
export async function evaluateCorporateRules(
  files: Iterable<readonly [string, string]>,
  policies: readonly CorporatePolicyInput[],
): Promise<CorporateEvaluation> {
  const prepared = policies.map(prepare);
  const skippedFiles: SkippedFile[] = [];
  const counters = { longLines: 0 };

  const scoped: Array<{ file: FileState; rules: PreparedRule[] }> = [];
  for (const [rawPath, rawContent] of files) {
    const path = toRepoRelative(rawPath);
    if (path === null) {
      skippedFiles.push({ filePath: rawPath, reason: 'invalid_path' });
      continue;
    }
    const excluded = fixedExclusion(path, rawContent);
    if (excluded) {
      skippedFiles.push({ filePath: path, reason: excluded });
      continue;
    }
    const language = languageOf(path);
    const rules = prepared.filter((p) => p.inScope(path, language));
    if (rules.length === 0) continue;
    const text = stripBom(rawContent).replace(/\r\n?/g, '\n');
    scoped.push({ file: { path, language, text, lines: splitLines(text), signals: new Map() }, rules });
  }

  // Run each needed detector once over the files whose rules need it.
  const needed = new Map<DetectorName, FileState[]>();
  for (const { file, rules } of scoped) {
    const names = new Set<DetectorName>();
    for (const r of rules) {
      for (const m of [...r.input.rule.match.all, ...r.input.rule.match.unless]) for (const n of DETECTORS_FOR[m.kind]) names.add(n);
    }
    for (const n of names) {
      const list = needed.get(n) ?? [];
      list.push(file);
      needed.set(n, list);
    }
  }
  for (const [name, list] of needed) {
    const byPath = new Map(list.map((f) => [f.path, f]));
    const ctx: DetectorContext = {
      rootDir: '',
      files: list.map((f) => f.path),
      fileContents: new Map(list.map((f) => [f.path, f.text])),
      config: { jurisdictions: [], ignore: [] },
    };
    for (const s of await makeDetector(name).detect(ctx)) {
      const f = byPath.get(s.file);
      if (!f) continue;
      const arr = f.signals.get(name) ?? [];
      arr.push(s);
      f.signals.set(name, arr);
    }
  }

  const findings: CorporateFinding[] = [];
  for (const { file, rules } of scoped) for (const r of rules) findings.push(...evaluateRule(r, file, counters));
  findings.sort(compareFindings);
  return { findings, scannedFileCount: scoped.length, skippedLongLines: counters.longLines, skippedFiles };
}

/**
 * Evaluate one rule on one in-memory file (compile pipeline step 6, example
 * verification). The fingerprints use `policyKey` / `version` as given.
 */
export async function evaluateRuleOnText(
  rule: CorporateRule,
  path: string,
  code: string,
  policyKey = 'corp.example',
  version = 1,
): Promise<CorporateEvaluation> {
  return evaluateCorporateRules([[path, code]], [{ policyKey, version, rule }]);
}

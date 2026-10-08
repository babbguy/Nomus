import { readFileSync, statSync } from 'node:fs';
import type { DetectorContext } from './detector.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB cap — skip vendored bundles

/**
 * Yield (file, content) pairs for every scannable file in the context.
 * Honors in-memory contents (GitHub webhook path) and skips files >2MB.
 * Errors are silently skipped — detectors should never fail a scan.
 */
export function* iterFiles(ctx: DetectorContext): Generator<{ file: string; content: string }> {
  if (ctx.fileContents) {
    for (const [file, content] of ctx.fileContents) {
      yield { file, content };
    }
    return;
  }

  for (const file of ctx.files) {
    try {
      const stat = statSync(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = readFileSync(file, 'utf-8');
      yield { file, content };
    } catch {
      // unreadable file — skip
    }
  }
}

/**
 * Find the 1-indexed line number for a character offset in a file.
 */
export function offsetToLine(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Express `file` relative to `rootDir` using POSIX separators.
 * Relative inputs (in-memory paths) are returned as-is; absolute paths outside
 * the root fall back to the full normalised path.
 */
function toRootRelative(file: string, rootDir?: string): string {
  const posixFile = file.replace(/\\/g, '/');
  if (!rootDir) return posixFile;
  const posixRoot = rootDir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (posixRoot === '') return posixFile;
  const windowsStyle = /^[a-z]:/i.test(posixRoot);
  const f = windowsStyle ? posixFile.toLowerCase() : posixFile;
  const r = windowsStyle ? posixRoot.toLowerCase() : posixRoot;
  if (f.startsWith(r + '/')) return posixFile.slice(posixRoot.length + 1);
  return posixFile;
}

/**
 * Detect whether a file is a test file (best-effort).
 * Used by detectors to suppress false positives in test fixtures.
 *
 * When `rootDir` is given, only the part of the path below the scan root is
 * inspected, so a repository checked out under a directory that happens to be
 * called `tests` or `fixtures` is not mistaken for test code.
 */
export function isTestFile(file: string, rootDir?: string): boolean {
  const path = '/' + toRootRelative(file, rootDir).replace(/^\/+/, '');
  return /\/(?:tests?|__tests__|spec|specs|fixtures|__fixtures__|mocks|__mocks__)\//i.test(path)
    || /\.(test|spec)\.(ts|tsx|js|jsx|mjs|py|java|go)$/i.test(path)
    || /\/\.env\.example$/i.test(path);
}

/**
 * Strip line and block comments from a JS/TS/Java/Go file before pattern matching.
 * Stateful single-pass: tracks string-literal context so it does NOT destroy
 * content inside `"// not a comment"` or template literals.
 *
 * Replaces stripped comment characters with spaces (preserving line numbers and
 * column offsets so downstream regex line counts stay accurate).
 */
export function stripCommentsCStyle(content: string): string {
  const out: string[] = [];
  let i = 0;
  const n = content.length;
  let state: 'code' | 'line_comment' | 'block_comment' | 'sq_string' | 'dq_string' | 'tpl_string' = 'code';

  while (i < n) {
    const c = content[i];
    const next = i + 1 < n ? content[i + 1] : '';

    switch (state) {
      case 'code':
        if (c === '/' && next === '/') {
          state = 'line_comment';
          out.push('  ');
          i += 2;
          continue;
        }
        if (c === '/' && next === '*') {
          state = 'block_comment';
          out.push('  ');
          i += 2;
          continue;
        }
        if (c === '"') { state = 'dq_string'; out.push(c); i++; continue; }
        if (c === "'") { state = 'sq_string'; out.push(c); i++; continue; }
        if (c === '`') { state = 'tpl_string'; out.push(c); i++; continue; }
        out.push(c);
        i++;
        break;

      case 'line_comment':
        // Replace comment chars with space, preserve newlines.
        if (c === '\n') { state = 'code'; out.push('\n'); i++; continue; }
        out.push(' ');
        i++;
        break;

      case 'block_comment':
        if (c === '*' && next === '/') {
          state = 'code';
          out.push('  ');
          i += 2;
          continue;
        }
        // Preserve newlines inside block comments so line numbers stay aligned.
        out.push(c === '\n' ? '\n' : ' ');
        i++;
        break;

      case 'dq_string':
      case 'sq_string':
      case 'tpl_string': {
        const quote = state === 'dq_string' ? '"' : state === 'sq_string' ? "'" : '`';
        if (c === '\\') {
          // Skip escape sequences as a whole — preserves both chars verbatim.
          out.push(c);
          if (i + 1 < n) out.push(content[i + 1]);
          i += 2;
          continue;
        }
        if (c === quote) {
          state = 'code';
          out.push(c);
          i++;
          continue;
        }
        out.push(c);
        i++;
        break;
      }
    }
  }

  return out.join('');
}

/**
 * Python: similar treatment for # comments. Respects single, double, and
 * triple-quoted strings (best-effort).
 */
export function stripCommentsPython(content: string): string {
  const out: string[] = [];
  let i = 0;
  const n = content.length;
  let state: 'code' | 'line_comment' | 'sq' | 'dq' | 'tsq' | 'tdq' = 'code';

  while (i < n) {
    const c = content[i];
    const three = content.slice(i, i + 3);

    switch (state) {
      case 'code':
        if (c === '#') { state = 'line_comment'; out.push(' '); i++; continue; }
        if (three === '"""') { state = 'tdq'; out.push(three); i += 3; continue; }
        if (three === "'''") { state = 'tsq'; out.push(three); i += 3; continue; }
        if (c === '"') { state = 'dq'; out.push(c); i++; continue; }
        if (c === "'") { state = 'sq'; out.push(c); i++; continue; }
        out.push(c);
        i++;
        break;
      case 'line_comment':
        if (c === '\n') { state = 'code'; out.push('\n'); i++; continue; }
        out.push(' ');
        i++;
        break;
      case 'dq':
      case 'sq': {
        const quote = state === 'dq' ? '"' : "'";
        if (c === '\\' && i + 1 < n) { out.push(c, content[i + 1]); i += 2; continue; }
        if (c === quote) { state = 'code'; out.push(c); i++; continue; }
        if (c === '\n') { state = 'code'; out.push('\n'); i++; continue; }
        out.push(c);
        i++;
        break;
      }
      case 'tdq':
      case 'tsq': {
        const triple = state === 'tdq' ? '"""' : "'''";
        if (three === triple) { state = 'code'; out.push(three); i += 3; continue; }
        out.push(c);
        i++;
        break;
      }
    }
  }

  return out.join('');
}

export function stripComments(file: string, content: string): string {
  if (/\.py$/i.test(file)) return stripCommentsPython(content);
  return stripCommentsCStyle(content);
}

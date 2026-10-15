import { createHash } from 'node:crypto';

/**
 * The corporate finding fingerprint (design spec §6). This is the only
 * implementation: the engine, the VS Code extension and the GitHub Action
 * all import it, so an approval recorded by the server matches the finding
 * the editor and CI compute.
 *
 *   fingerprint = sha256(normalizeSnippet(snippet)) + ':' + policyKey + ':' + policyVersion
 *
 * The file path and line numbers are deliberately not part of it (owner
 * decision D10): moving code does not re-flag it, editing it does.
 */

/** The largest snippet range, in lines; longer ranges are truncated and flagged. */
export const MAX_SNIPPET_LINES = 400;

/**
 * Exactly three operations (§6.2): CRLF and lone CR become LF; trailing
 * whitespace is stripped from every line; runs of blank lines collapse to
 * one. Comments, indentation, case and Unicode form are left alone, so any
 * semantic edit changes the hash.
 */
export function normalizeSnippet(s: string): string {
  const lines = s.replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd());
  const out: string[] = [];
  for (const l of lines) {
    if (l === '' && out.length > 0 && out[out.length - 1] === '') continue;
    out.push(l);
  }
  return out.join('\n');
}

/** sha256 of the UTF-8 bytes of the normalized snippet, lowercase hex. */
export function snippetHash(snippet: string): string {
  return createHash('sha256').update(normalizeSnippet(snippet), 'utf8').digest('hex');
}

export function fingerprintOf(snippet: string, policyKey: string, policyVersion: number): string {
  if (policyKey.includes(':')) throw new Error(`policyKey may not contain ':' (${policyKey})`);
  if (!Number.isInteger(policyVersion) || policyVersion < 1) throw new Error(`policyVersion must be a positive integer (${policyVersion})`);
  return `${snippetHash(snippet)}:${policyKey}:${policyVersion}`;
}

export const FINGERPRINT_RE = /^[0-9a-f]{64}:corp\.[a-z0-9][a-z0-9._-]{0,84}:[1-9][0-9]{0,6}$/;

/** Split a fingerprint on its first and last ':' (§6.3). Returns null when malformed. */
export function parseFingerprint(fp: string): { snippetHash: string; policyKey: string; policyVersion: number } | null {
  if (!FINGERPRINT_RE.test(fp)) return null;
  const first = fp.indexOf(':');
  const last = fp.lastIndexOf(':');
  return { snippetHash: fp.slice(0, first), policyKey: fp.slice(first + 1, last), policyVersion: Number(fp.slice(last + 1)) };
}

/** Drop one leading U+FEFF (§6.1): `readFileSync` keeps a BOM that VS Code's `getText()` never has. */
export function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/** Split file content into lines on CRLF, CR or LF (§6.1); line N is element N-1. */
export function splitLines(content: string): string[] {
  return content.split(/\r\n|\r|\n/);
}

export interface SnippetRange {
  startLine: number;
  endLine: number;
  /** The raw lines start..end joined with '\n'. */
  snippet: string;
  /** True when the range was longer than {@link MAX_SNIPPET_LINES} and was cut. */
  truncated: boolean;
}

/**
 * The snippet of a matched range (§6.1): widen by the context lines, clamp
 * to the file, cap at {@link MAX_SNIPPET_LINES} lines. `lines` comes from
 * {@link splitLines} of BOM-stripped content.
 */
export function extractSnippet(lines: readonly string[], start: number, end: number, contextBefore = 0, contextAfter = 0): SnippetRange {
  const total = Math.max(lines.length, 1);
  let s = Math.max(1, Math.min(start, end) - contextBefore);
  let e = Math.min(total, Math.max(start, end) + contextAfter);
  if (s > total) s = total;
  if (e < s) e = s;
  let truncated = false;
  if (e - s + 1 > MAX_SNIPPET_LINES) {
    e = s + MAX_SNIPPET_LINES - 1;
    truncated = true;
  }
  return { startLine: s, endLine: e, snippet: lines.slice(s - 1, e).join('\n'), truncated };
}

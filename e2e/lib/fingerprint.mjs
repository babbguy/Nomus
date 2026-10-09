// An INDEPENDENT re-implementation of the corporate finding fingerprint
// (design spec §6), used by the CPG gate areas to cross-check what the
// product computes. It shares no code with packages/scanner: it reads the
// file from disk, cuts the reported line range itself and hashes it.
//
//   fingerprint = sha256(normalize(lines start..end)) + ':' + policyKey + ':' + version
//   normalize   = CRLF/CR -> LF; strip trailing whitespace per line; collapse blank-line runs

import crypto from 'node:crypto';
import fs from 'node:fs';

export function normalize(text) {
  const out = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd())) {
    if (line === '' && out.length > 0 && out[out.length - 1] === '') continue;
    out.push(line);
  }
  return out.join('\n');
}

/** Lines start..end (1-based, inclusive) of a file's text, BOM removed. */
export function lineRange(text, start, end) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return body.split(/\r\n|\r|\n/).slice(start - 1, end).join('\n');
}

export function fingerprint(snippet, policyKey, version) {
  return `${crypto.createHash('sha256').update(normalize(snippet), 'utf8').digest('hex')}:${policyKey}:${version}`;
}

/** The fingerprint of a reported finding, recomputed from the file on disk. */
export function fingerprintOfFile(file, startLine, endLine, policyKey, version) {
  return fingerprint(lineRange(fs.readFileSync(file, 'utf8'), startLine, endLine), policyKey, version);
}

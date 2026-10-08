// Result recording for the release gate: every assertion becomes one row of
// the PASS/FAIL table, grouped by area. A row that fails carries what was
// expected and what the product actually did.

import fs from 'node:fs';
import path from 'node:path';

export class Gate {
  constructor(outDir) {
    this.outDir = outDir;
    this.rows = [];
    this.area = 'gate';
    this.notes = [];
    this.startedAt = Date.now();
  }

  /** Set the area that following checks are reported under. */
  section(area) {
    this.area = area;
    console.log(`\n── ${area} ${'─'.repeat(Math.max(0, 70 - area.length))}`);
  }

  /**
   * Record one assertion. `ok` is a boolean; `expected` and `observed` are
   * shown for failures (and kept in results.json for passes).
   */
  check(name, ok, expected = '', observed = '') {
    const row = { area: this.area, name, ok: Boolean(ok), expected: fmt(expected), observed: fmt(observed) };
    this.rows.push(row);
    const mark = row.ok ? 'PASS' : 'FAIL';
    console.log(`  ${mark}  ${name}${row.ok ? '' : `\n          expected: ${row.expected}\n          observed: ${row.observed}`}`);
    return row.ok;
  }

  /** Equality check with the usual expected/observed reporting. */
  equal(name, observed, expected) {
    return this.check(name, deepEqual(observed, expected), expected, observed);
  }

  /** Record a check that could not run because an earlier step failed. */
  blocked(name, reason) {
    return this.check(name, false, 'check runs', `not run: ${reason}`);
  }

  /** Run an async block; an exception becomes a failed row instead of aborting the gate. */
  async step(name, fn) {
    try {
      return await fn();
    } catch (err) {
      this.check(name, false, 'no exception', errText(err));
      return undefined;
    }
  }

  note(text) {
    this.notes.push(text);
    console.log(`  note: ${text}`);
  }

  get failed() {
    return this.rows.filter((r) => !r.ok);
  }

  table() {
    const areaW = Math.max(4, ...this.rows.map((r) => r.area.length));
    const nameW = Math.min(90, Math.max(5, ...this.rows.map((r) => r.name.length)));
    const lines = [];
    lines.push(`${'AREA'.padEnd(areaW)}  ${'CHECK'.padEnd(nameW)}  RESULT`);
    lines.push(`${'-'.repeat(areaW)}  ${'-'.repeat(nameW)}  ------`);
    for (const r of this.rows) {
      lines.push(`${r.area.padEnd(areaW)}  ${truncate(r.name, nameW).padEnd(nameW)}  ${r.ok ? 'PASS' : 'FAIL'}`);
      if (!r.ok) {
        lines.push(`${''.padEnd(areaW)}    expected: ${truncate(r.expected, 160)}`);
        lines.push(`${''.padEnd(areaW)}    observed: ${truncate(r.observed, 300)}`);
      }
    }
    return lines.join('\n');
  }

  /** Per-area totals, used for the short summary. */
  areas() {
    const byArea = new Map();
    for (const r of this.rows) {
      const a = byArea.get(r.area) ?? { area: r.area, pass: 0, fail: 0 };
      if (r.ok) a.pass++; else a.fail++;
      byArea.set(r.area, a);
    }
    return [...byArea.values()];
  }

  markdown(extraLines = []) {
    const failed = this.failed;
    const out = [];
    out.push(`## Release gate: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length} of ${this.rows.length} checks failed)`}`);
    out.push('');
    out.push('| Area | Passed | Failed |');
    out.push('|------|-------:|-------:|');
    for (const a of this.areas()) out.push(`| ${a.area} | ${a.pass} | ${a.fail} |`);
    out.push('');
    if (failed.length) {
      out.push('### Failures');
      out.push('');
      out.push('| Area | Check | Expected | Observed |');
      out.push('|------|-------|----------|----------|');
      for (const r of failed) out.push(`| ${md(r.area)} | ${md(r.name)} | ${md(truncate(r.expected, 160))} | ${md(truncate(r.observed, 300))} |`);
      out.push('');
    }
    out.push(...extraLines);
    out.push('');
    out.push('<details><summary>All checks</summary>');
    out.push('');
    out.push('| Area | Check | Result |');
    out.push('|------|-------|--------|');
    for (const r of this.rows) out.push(`| ${md(r.area)} | ${md(r.name)} | ${r.ok ? 'PASS' : '**FAIL**'} |`);
    out.push('');
    out.push('</details>');
    return out.join('\n');
  }

  write(extra = {}) {
    fs.writeFileSync(path.join(this.outDir, 'results.json'), JSON.stringify({ rows: this.rows, notes: this.notes, ...extra }, null, 2));
  }
}

export function errText(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 400);
  return String(err).slice(0, 400);
}

function fmt(v) {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function md(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function deepEqual(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

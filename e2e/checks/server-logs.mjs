// 10. Server log check over the whole run: no error-level log line, no
// unhandled rejection or uncaught exception, no stack trace and no 5xx
// response, apart from the allow-list below.

import fs from 'node:fs';
import path from 'node:path';
import { seen5xx } from '../lib/http.mjs';

/**
 * Log entries the gate expects. Every entry needs a reason; keep this list
 * short. Matched against the log message (msg) of JSON log lines.
 */
const ALLOWED = [
  // (empty) The gate configures a local Slack webhook sink, so the startup
  // "ALERTING NOT CONFIGURED" error does not fire; nothing else is expected.
];

export async function logChecks(ctx) {
  const { gate, outDir } = ctx;
  const lines = ctx.engine?.lines ?? [];
  const errors = [];
  const fiveXX = [];
  const traces = [];
  const unhandled = [];
  let warnings = 0;
  let json = 0;

  for (const { stream, text } of lines) {
    if (!text.trim()) continue;
    let entry = null;
    if (text.startsWith('{')) {
      try { entry = JSON.parse(text); } catch { /* not a log line */ }
    }
    if (entry && typeof entry.level === 'number') {
      json++;
      const msg = String(entry.msg ?? '');
      if (ALLOWED.some((a) => a.test(msg))) continue;
      if (/unhandled (promise )?rejection|uncaught exception/i.test(msg)) unhandled.push(msg);
      if (entry.level >= 50) errors.push(`${msg.slice(0, 160)}${entry.err?.message ? ` (${entry.err.message.slice(0, 120)})` : entry.error ? ` (${String(entry.error?.message ?? entry.error).slice(0, 120)})` : ''}`);
      else if (entry.level === 40) warnings++;
      if (typeof entry.status === 'number' && entry.status >= 500) fiveXX.push(msg);
      if (entry.err?.stack) traces.push(entry.err.stack.split('\n').slice(0, 2).join(' '));
      continue;
    }
    // Plain text output (stderr, console.*): stack frames and errors count.
    if (/^\s+at .+\(.+:\d+:\d+\)|^\s+at .+:\d+:\d+$/.test(text)) traces.push(`[${stream}] ${text.trim()}`);
    else if (/\b(Error|TypeError|ReferenceError|RangeError)\b[: ]|UnhandledPromiseRejection|uncaught/i.test(text)) errors.push(`[${stream}] ${text.slice(0, 200)}`);
  }

  gate.check('engine logged JSON lines (production logging)', json > 10, '> 10 JSON log lines', json);
  gate.check('no error-level log entries', errors.length === 0, 'none (allow-list in checks/server-logs.mjs)', errors.slice(0, 5));
  gate.check('no unhandled rejections or uncaught exceptions', unhandled.length === 0, 'none', unhandled.slice(0, 3));
  gate.check('no stack traces in the output', traces.length === 0, 'none', traces.slice(0, 3));
  gate.check('the engine served no 5xx response', fiveXX.length === 0, 'none', fiveXX.slice(0, 5));
  gate.check('no 5xx seen by the gate\'s HTTP clients', seen5xx.length === 0, 'none', seen5xx.slice(0, 5));
  const browser5xx = ctx.data?.browser5xx ?? [];
  gate.check('no 5xx seen by the browser', browser5xx.length === 0, 'none', browser5xx.slice(0, 5));
  if (warnings) gate.note(`${warnings} warn-level log entries (not failures); see engine.log`);
  fs.writeFileSync(path.join(outDir, 'log-findings.json'), JSON.stringify({ errors, unhandled, traces, fiveXX, gate5xx: seen5xx, browser5xx, warnings }, null, 2));
}

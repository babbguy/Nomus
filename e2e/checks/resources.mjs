// 11. Resources: the engine's peak resident set size over the whole run
// (sampled every 500 ms by lib/engine-probe.mjs) and its CPU use while idle.

import fs from 'node:fs';
import { sleep } from '../lib/http.mjs';

const RSS_LIMIT = 512 * 1024 * 1024;
const IDLE_WINDOW_MS = 10_000;
const IDLE_CPU_LIMIT_PCT = 20; // generous: catches busy loops, not noise

export async function resourceChecks(ctx) {
  const { gate } = ctx;
  if (!ctx.engine || ctx.engine.exited) {
    gate.check('engine running for the resource measurement', false, 'running', ctx.engine?.exited ?? 'not started');
    return;
  }
  // Idle: no gate traffic, no subscribers. Let in-flight work settle first.
  await sleep(2000);
  const t0 = Date.now();
  await sleep(IDLE_WINDOW_MS);
  ctx.idleWindow = [t0, Date.now()];
  const r = readProbe(ctx.probeFile, ctx.idleWindow);
  ctx.resources = r;
  if (!r) {
    gate.check('resource samples recorded', false, 'probe samples', 'none');
    return;
  }
  gate.check('peak RSS during the gate <= 512 MiB', r.peakRss <= RSS_LIMIT, '<= 512 MiB', `${(r.peakRss / 1048576).toFixed(1)} MiB over ${r.samples} samples`);
  gate.check(`idle CPU (${IDLE_WINDOW_MS / 1000} s, no traffic) under ${IDLE_CPU_LIMIT_PCT} % of one core`, r.idleCpuPct !== undefined && r.idleCpuPct < IDLE_CPU_LIMIT_PCT,
    `< ${IDLE_CPU_LIMIT_PCT} %`, r.idleCpuPct === undefined ? 'not measured' : `${r.idleCpuPct.toFixed(2)} %`);
}

/** Parse the probe file: peak RSS over the run and CPU % inside `idleWindow` ([from, to] ms). */
export function readProbe(file, idleWindow) {
  if (!file || !fs.existsSync(file)) return null;
  const res = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((x) => x?.kind === 'res');
  if (res.length === 0) return null;
  const out = { samples: res.length, peakRss: Math.max(...res.map((x) => x.rss)) };
  const win = idleWindow ?? globalThis.__gateIdleWindow;
  if (win) {
    const inWin = res.filter((x) => x.t >= win[0] && x.t <= win[1]);
    if (inWin.length >= 2) {
      const a = inWin[0];
      const b = inWin[inWin.length - 1];
      const cpuMs = (b.cpuUserUs + b.cpuSystemUs - a.cpuUserUs - a.cpuSystemUs) / 1000;
      out.idleCpuPct = (cpuMs / (b.t - a.t)) * 100;
      out.idleWindowS = Math.round((b.t - a.t) / 1000);
    }
  }
  return out;
}

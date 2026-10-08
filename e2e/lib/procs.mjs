// Process helpers: free ports, the engine process, and child commands with
// captured output. Everything the gate starts is tracked so it can be
// stopped on exit, including after a failure.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const children = new Set();

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Start the built engine (engine/dist/index.js) with the resource/network
 * probe preloaded. Output is captured line by line into `logFile` and into
 * the returned `lines` array.
 */
export function startEngine({ repoRoot, workDir, env, logFile, probeFile }) {
  const probe = new URL('./engine-probe.mjs', import.meta.url).href;
  const entry = path.join(repoRoot, 'engine', 'dist', 'index.js');
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  const lines = [];
  // cwd is the gate's work directory, so a developer's engine/.env is never read.
  const child = spawn(process.execPath, ['--import', probe, entry], {
    cwd: workDir,
    env: { ...cleanEnv(), ...env, NOMUS_GATE_PROBE_FILE: probeFile },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  const onData = (stream) => {
    let buf = '';
    child[stream].on('data', (d) => {
      out.write(d);
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push({ stream, text: buf.slice(0, i).replace(/\r$/, '') });
        buf = buf.slice(i + 1);
      }
    });
    child[stream].on('end', () => { if (buf) lines.push({ stream, text: buf }); });
  };
  onData('stdout');
  onData('stderr');
  let exited = null;
  const exitPromise = new Promise((resolve) => child.on('exit', (code, signal) => { exited = { code, signal }; children.delete(child); out.end(); resolve(exited); }));
  return {
    child,
    lines,
    get exited() { return exited; },
    exitPromise,
    async stop() {
      if (exited) return exited;
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 5000);
      const r = await exitPromise;
      clearTimeout(t);
      return r;
    },
  };
}

/** Run a command to completion; resolves { code, stdout, stderr, ms }. */
export function run(cmd, args, { cwd, env, timeout = 120_000, input, shell = false } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd, env: { ...cleanEnv(), ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { stderr += `\n[gate] timed out after ${timeout} ms`; child.kill('SIGKILL'); }, timeout);
    child.on('error', (err) => { stderr += `\n[gate] spawn error: ${err.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, stdout, stderr, ms: Date.now() - t0 });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

/** Spawn a long-lived child (e.g. the MCP server) that the caller drives. */
export function spawnTracked(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { ...opts, env: { ...cleanEnv(), ...opts.env }, windowsHide: true });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

export function killAll() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* already gone */ }
  }
  children.clear();
}

/**
 * The parent environment minus anything that would leak a developer's own
 * Nomus, LLM or GitHub configuration into the products under test.
 */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(NOMUS_|OPENAI_|ANTHROPIC_|GOOGLE_|GITHUB_|INPUT_|RUNNER_|ACTIONS_)/i.test(k)) delete env[k];
  }
  return env;
}

// Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0), as an
// editor or coding agent drives a local MCP server.

import { spawnTracked } from './procs.mjs';

export async function startMcp(entry, env, { timeout = 30_000 } = {}) {
  const child = spawnTracked(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  const notJson = [];
  child.stderr.on('data', (d) => { stderr += d; });
  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { notJson.push(line.slice(0, 200)); continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  let nextId = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); resolve({ id, error: { code: -1, message: `timeout after ${timeout} ms` } }); }, timeout);
    pending.set(id, { resolve, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  return {
    rpc,
    notify,
    get stderr() { return stderr; },
    notJson,
    exited,
    async close() { child.stdin.end(); child.kill(); await exited; },
    /** tools/call returning { isError, text, json, error } */
    async call(name, args) {
      const r = await rpc('tools/call', { name, arguments: args });
      const text = r.result?.content?.[0]?.text ?? '';
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { isError: Boolean(r.result?.isError), text, json, error: r.error ?? null };
    },
  };
}

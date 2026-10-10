// A pass-through HTTP proxy in front of the gate's web server, for the CPG
// editor area: the extension under test talks to it, the gate reads its
// request log (method, path, If-None-Match, status) and can close it to make
// the Nomus server unreachable without changing the extension's settings.

import http from 'node:http';
import { startFaultProxy } from './fault-proxy.mjs';

export function startPassProxy({ target, port = 0 }) {
  const upstream = new URL(target);
  const log = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const entry = { method: req.method, path: req.url, ifNoneMatch: req.headers['if-none-match'] ?? null, status: null };
    log.push(entry);
    const up = http.request({ hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: { ...req.headers, host: upstream.host } }, (upRes) => {
      entry.status = upRes.statusCode ?? null;
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', (err) => {
      entry.status = 502;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `bad gateway: ${err.message}` }));
    });
    req.on('aborted', () => up.destroy());
    res.on('close', () => up.destroy());
    req.pipe(up);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      resolve({
        url: `http://127.0.0.1:${p}`,
        port: p,
        log,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  });
}

/**
 * A proxy that changes the body of GET /api/v1/cpg/bundle with `rewrite`
 * (a tampering attacker in the middle) and passes everything else through.
 */
export async function startTamperProxy({ target, rewrite }) {
  const proxy = await startFaultProxy({ target });
  proxy.fault = { method: 'GET', path: '/api/v1/cpg/bundle', kind: 'rewrite', rewrite };
  return { url: proxy.url, get tampered() { return proxy.hits; }, close: proxy.close };
}

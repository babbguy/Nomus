// A fault-injecting HTTP proxy in front of the engine. Everything is
// forwarded unchanged except requests matching `fault` (method and path
// prefix), which the proxy can drop (close the connection), answer 500
// itself (the engine is never reached), or forward and rewrite the JSON
// body of a 200 answer (a tampering attacker in the middle). Set or clear
// `proxy.fault` between runs; `proxy.hits` counts the faults applied.

import http from 'node:http';

/** @typedef {{ method: string, path: string } & ({ kind: 'drop' | 500 } | { kind: 'rewrite', rewrite: (json: any) => any })} Fault */

export function startFaultProxy({ target }) {
  const upstream = new URL(target);
  const sockets = new Set();
  const proxy = { url: '', /** @type {Fault | null} */ fault: null, hits: 0, close: null };
  const server = http.createServer((req, res) => {
    const f = proxy.fault;
    const matched = f && req.method === f.method && req.url.startsWith(f.path) ? f : null;
    if (matched?.kind === 'drop') { proxy.hits++; req.socket.destroy(); return; }
    if (matched?.kind === 500) {
      proxy.hits++;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'injected fault', code: 'internal' }));
      return;
    }
    const headers = { ...req.headers, host: upstream.host };
    if (matched) { delete headers['if-none-match']; delete headers['accept-encoding']; }
    const up = http.request({ hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers }, (upRes) => {
      if (!matched || upRes.statusCode !== 200) {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
        return;
      }
      let body = '';
      upRes.setEncoding('utf8');
      upRes.on('data', (c) => { body += c; });
      upRes.on('end', () => {
        const out = JSON.stringify(matched.rewrite(JSON.parse(body)));
        proxy.hits++;
        const h = { ...upRes.headers, 'content-length': String(Buffer.byteLength(out)) };
        delete h['transfer-encoding'];
        res.writeHead(200, h);
        res.end(out);
      });
    });
    up.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `bad gateway: ${err.message}` }));
    });
    req.pipe(up);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      proxy.url = `http://127.0.0.1:${server.address().port}`;
      proxy.close = () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); });
      resolve(proxy);
    });
  });
}

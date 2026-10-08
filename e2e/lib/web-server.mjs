// Serves the production dashboard build the way infra/nginx-dashboard.conf
// does: static files with an SPA fallback to index.html, /health answered
// locally, and /api/ and /.well-known/ proxied to the engine on the same
// origin (unbuffered, so Server-Sent Events stream through).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

export function startWebServer({ port = 0, distDir, engineUrl }) {
  const engine = new URL(engineUrl);
  const root = path.resolve(distDir);
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://web');
    if (u.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/.well-known/')) {
      const remote = req.socket.remoteAddress ?? '';
      const headers = { ...req.headers, host: req.headers.host, 'x-real-ip': remote, 'x-forwarded-for': req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${remote}` : remote, 'x-forwarded-proto': 'http' };
      const up = http.request({ hostname: engine.hostname, port: engine.port, method: req.method, path: req.url, headers }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      });
      up.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `bad gateway: ${err.message}` }));
      });
      req.on('aborted', () => up.destroy());
      res.on('close', () => up.destroy());
      req.pipe(up);
      return undefined;
    }
    // Static file or SPA fallback
    let file = path.join(root, decodeURIComponent(u.pathname));
    if (!file.startsWith(root)) { res.writeHead(400); return res.end(); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
    return undefined;
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      resolve({
        url: `http://127.0.0.1:${p}`,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  });
}

// A local HTTP sink that records every request (used as the Slack incoming
// webhook, so the engine's alerting is configured and its alerts stay on
// this machine). Answers 200 "ok" like Slack does.

import http from 'node:http';
import fs from 'node:fs';

export function startSink({ port = 0, logFile }) {
  const received = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const entry = { t: new Date().toISOString(), method: req.method, path: req.url, body: body.slice(0, 2000) };
    received.push(entry);
    if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      resolve({ url: `http://127.0.0.1:${p}`, received, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

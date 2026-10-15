// A local HTTP sink that records every request (used as the Slack incoming
// webhook, so the engine's alerting is configured and its alerts stay on
// this machine, and as the fake Resend API and CPG webhook receiver).
// Answers 200 "ok" like Slack does, or what `respond(entry)` returns
// ({ status, json }). failFirst(n, status, pathPrefix) makes the next n
// requests under pathPrefix fail with that status.

import http from 'node:http';
import fs from 'node:fs';

export function startSink({ port = 0, logFile, respond } = {}) {
  const received = [];
  const failing = { left: 0, status: 503, prefix: '' };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const entry = { t: new Date().toISOString(), method: req.method, path: req.url, headers: req.headers, body };
    received.push(entry);
    if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ ...entry, headers: undefined, body: body.slice(0, 2000) })}\n`);
    if (failing.left > 0 && req.url.startsWith(failing.prefix)) {
      failing.left -= 1;
      entry.answered = failing.status;
      res.writeHead(failing.status, { 'content-type': 'text/plain' });
      res.end('unavailable');
      return;
    }
    const answer = respond?.(entry);
    entry.answered = answer?.status ?? 200;
    if (answer) {
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.json ?? {}));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      resolve({
        url: `http://127.0.0.1:${p}`, received,
        failFirst: (n, status, prefix = '') => Object.assign(failing, { left: n, status, prefix }),
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// Fake GitHub REST API for the Nomus GitHub Action. It keeps state like
// GitHub does (reviews, issue comments, check runs, SARIF uploads) so the
// gate can check what the Action posted and that a second run updates
// instead of duplicating. It rejects what GitHub rejects: review comments on
// lines outside the pull request's diff, more than 50 annotations per check
// run request, and summaries over 65535 characters.

import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * @param {{ port?: number, logFile?: string, prFiles: Array<{ filename: string, status: string, patch: string }> }} opts
 */
export function startFakeGithub({ port = 0, logFile, prFiles }) {
  const state = {
    requests: [],
    reviews: [],        // { id, commit_id, event, body, comments: [...] }
    reviewComments: [], // flattened review comments, as GET /pulls/:n/comments returns them
    issueComments: [],  // { id, body, created, updated }
    checkRuns: [],
    sarifs: [],         // { commit_sha, ref, sarif (decoded JSON) }
    rejected: [],
  };
  let nextId = 1000;

  // Lines a review comment may target on the RIGHT side, per file.
  const commentable = new Map(prFiles.map((f) => [f.filename, rightSideLines(f.patch)]));

  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch { /* left null */ }
    const u = new URL(req.url, 'http://fake');
    const entry = { method: req.method, path: u.pathname, query: u.search, auth: req.headers.authorization ? 'present' : 'missing' };
    state.requests.push(entry);
    if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ ...entry, body: json })}\n`);
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const reject = (status, message) => { state.rejected.push({ ...entry, status, message }); send(status, { message }); };

    const p = u.pathname;
    let m;
    if (req.method === 'GET' && /\/pulls\/\d+\/files$/.test(p)) return send(200, page(prFiles, u));
    if (req.method === 'GET' && /\/pulls\/\d+\/comments$/.test(p)) return send(200, page(state.reviewComments, u));
    if (req.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(p)) {
      for (const c of json?.comments ?? []) {
        const lines = commentable.get(c.path);
        if (!lines || !lines.has(c.line)) return reject(422, `Unprocessable Entity: Line could not be resolved: ${c.path}:${c.line}`);
      }
      const review = { id: nextId++, commit_id: json?.commit_id, event: json?.event, body: json?.body ?? '', comments: json?.comments ?? [] };
      state.reviews.push(review);
      for (const c of review.comments) {
        state.reviewComments.push({ id: nextId++, pull_request_review_id: review.id, path: c.path, line: c.line, side: c.side ?? 'RIGHT', body: c.body, commit_id: review.commit_id });
      }
      return send(200, { id: review.id });
    }
    if (req.method === 'GET' && /\/issues\/\d+\/comments$/.test(p)) return send(200, page(state.issueComments, u));
    if (req.method === 'POST' && /\/issues\/\d+\/comments$/.test(p)) {
      const c = { id: nextId++, body: json?.body ?? '', updates: 0 };
      state.issueComments.push(c);
      return send(201, c);
    }
    if (req.method === 'PATCH' && (m = /\/issues\/comments\/(\d+)$/.exec(p))) {
      const c = state.issueComments.find((x) => x.id === Number(m[1]));
      if (!c) return reject(404, 'Not Found');
      c.body = json?.body ?? c.body;
      c.updates++;
      return send(200, c);
    }
    if (req.method === 'POST' && /\/check-runs$/.test(p)) {
      if ((json?.output?.annotations?.length ?? 0) > 50) return reject(422, 'annotations: at most 50 per request');
      if ((json?.output?.summary?.length ?? 0) > 65535) return reject(422, 'output.summary is too long (maximum is 65535 characters)');
      const run = { id: nextId++, ...json };
      state.checkRuns.push(run);
      return send(201, { id: run.id });
    }
    if (req.method === 'POST' && /\/code-scanning\/sarifs$/.test(p)) {
      let sarif = null;
      try { sarif = JSON.parse(zlib.gunzipSync(Buffer.from(json?.sarif ?? '', 'base64')).toString('utf8')); } catch { /* invalid upload */ }
      if (!sarif) return reject(400, 'sarif: invalid gzip+base64 SARIF');
      state.sarifs.push({ commit_sha: json?.commit_sha, ref: json?.ref, sarif });
      return send(202, { id: `sarif-${nextId++}` });
    }
    return reject(404, 'Not Found');
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: pt } = server.address();
      resolve({ url: `http://127.0.0.1:${pt}`, state, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** Lines on the new side of a unified diff patch (added and context lines). */
export function rightSideLines(patch) {
  const lines = new Set();
  let n = 0;
  for (const l of String(patch ?? '').split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { n = Number(h[1]); continue; }
    if (l.startsWith('-')) continue;
    if (l.startsWith('+') || l.startsWith(' ')) { lines.add(n); n++; }
  }
  return lines;
}

function page(items, u) {
  const per = Number(u.searchParams.get('per_page') ?? 30);
  const pg = Number(u.searchParams.get('page') ?? 1);
  return items.slice((pg - 1) * per, pg * per);
}

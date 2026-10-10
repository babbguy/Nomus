// A local fake of the Jira Cloud REST v3 subset Nomus uses: create issue,
// add comment, and the JQL label search. Requires HTTP Basic auth with the
// configured account email and API token, and records every request.

import http from 'node:http';

export function startFakeJira({ email, token }) {
  const issues = []; // { key, fields, comments: [] }
  const requests = [];
  const expected = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const url = new URL(req.url, 'http://jira');
    requests.push({ method: req.method, path: url.pathname, query: url.search, body, authorized: req.headers.authorization === expected });
    const send = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== expected) return send(401, { errorMessages: ['Unauthorized'] });
    let m;
    if (req.method === 'POST' && url.pathname === '/rest/api/3/issue') {
      const fields = JSON.parse(body).fields;
      const key = `${fields.project.key}-${issues.length + 1}`;
      issues.push({ key, fields, comments: [] });
      return send(201, { id: String(issues.length), key, self: `http://jira/rest/api/3/issue/${issues.length}` });
    }
    if (req.method === 'POST' && (m = /^\/rest\/api\/3\/issue\/([A-Z0-9_]+-\d+)\/comment$/.exec(url.pathname))) {
      const issue = issues.find((i) => i.key === m[1]);
      if (!issue) return send(404, { errorMessages: ['Issue does not exist'] });
      issue.comments.push(JSON.parse(body).body);
      return send(201, { id: String(issue.comments.length) });
    }
    if (req.method === 'GET' && url.pathname === '/rest/api/3/search/jql') {
      const label = /labels = "([^"]+)"/.exec(url.searchParams.get('jql') ?? '')?.[1];
      return send(200, { issues: issues.filter((i) => i.fields.labels.includes(label)).map((i) => ({ key: i.key })) });
    }
    return send(404, { errorMessages: ['Not found'] });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, email, token, issues, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

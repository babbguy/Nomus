// Small HTTP client for the gate: JSON in/out, bearer keys or a session
// cookie, and a record of every 5xx the gate's own clients saw.

export const seen5xx = [];

export class Client {
  /**
   * @param {string} base  origin, e.g. http://127.0.0.1:4100
   * @param {{ key?: string, cookie?: string }} auth
   */
  constructor(base, auth = {}) {
    this.base = base.replace(/\/$/, '');
    this.key = auth.key ?? null;
    this.cookie = auth.cookie ?? null;
  }

  withKey(key) { return new Client(this.base, { key }); }
  anonymous() { return new Client(this.base, {}); }

  async request(method, path, body, { headers = {}, raw = false, redirect = 'follow' } = {}) {
    const h = { Accept: 'application/json', ...headers };
    if (this.key) h.Authorization = `Bearer ${this.key}`;
    if (this.cookie) h.Cookie = this.cookie;
    let payload;
    if (body !== undefined && body !== null) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + path, { method, headers: h, body: payload, redirect, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (res.status >= 500) seen5xx.push(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    const out = { status: res.status, json, text, headers: res.headers };
    if (raw) out.res = res;
    return out;
  }

  get(path, opts) { return this.request('GET', path, undefined, opts); }
  post(path, body, opts) { return this.request('POST', path, body ?? {}, opts); }
  patch(path, body, opts) { return this.request('PATCH', path, body ?? {}, opts); }
  put(path, body, opts) { return this.request('PUT', path, body ?? {}, opts); }
  del(path, opts) { return this.request('DELETE', path, undefined, opts); }

  /** Sign in with email + password; returns a client carrying the session cookie. */
  async login(email, password) {
    const res = await fetch(`${this.base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const json = await res.json().catch(() => null);
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const session = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('nomus_session='));
    return { status: res.status, json, client: session ? new Client(this.base, { cookie: session }) : null, sessionCookie: session ?? null };
  }
}

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const isStr = (v) => typeof v === 'string' && v.length > 0;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns a truthy value or the timeout passes. */
export async function waitFor(fn, { timeout = 30_000, interval = 250 } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  return last;
}

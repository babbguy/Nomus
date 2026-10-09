/**
 * Repository identity (design spec §2.2): lowercase `owner/name` for
 * github.com, `host/owner/name` for any other host. The engine, the
 * extension and the action all canonicalise through {@link canonicalRepo},
 * so a case opened from the editor and a CI run of the same repository land
 * on the same record.
 */

export const CANONICAL_REPO_RE = /^[a-z0-9.-]+(\/[a-z0-9._-]+){1,2}$/;

/**
 * Canonicalise a repository reference: `owner/name`, `host/owner/name`,
 * `https://host/owner/name(.git)`, `git@host:owner/name(.git)` or
 * `ssh://git@host[:port]/owner/name(.git)`. Returns null when the input is
 * not a repository reference.
 */
export function canonicalRepo(input: string): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (s.length === 0 || s.length > 400) return null;

  let host: string | null = null;
  let path: string;
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(s); // git@host:owner/name
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    host = url.hostname;
    path = url.pathname;
  } else {
    path = s;
  }

  s = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  const parts = s.split('/');
  if (host !== null) {
    if (parts.length !== 2) return null;
    parts.unshift(host);
  }
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.length === 3 && parts[0].toLowerCase() === 'github.com') parts.shift();
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  const repo = parts.join('/').toLowerCase();
  return CANONICAL_REPO_RE.test(repo) && repo.length <= 200 ? repo : null;
}

export function isCanonicalRepo(repo: string): boolean {
  return canonicalRepo(repo) === repo;
}

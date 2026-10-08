/**
 * Validate that a URL is safe for the engine to fetch.
 *
 * Blocks SSRF vectors: private IPv4 ranges, loopback, link-local, IPv6
 * loopback / unique-local, and known cloud-metadata hostnames. Use this on
 * every code path that takes a URL from a request body (admin or otherwise)
 * before it is persisted or fetched. (Originally from forge.ts; extracted
 * for reuse)
 */
export function isSsrfSafe(rawUrl: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: `protocol ${parsed.protocol} not allowed` };
  }

  const host = parsed.hostname.toLowerCase();

  const blockedHosts = new Set([
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    'metadata.google.internal',
  ]);
  if (blockedHosts.has(host)) return { ok: false, reason: 'blocked host' };

  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [a, b] = ipv4Match.slice(1).map(Number);
    if (a === 10) return { ok: false, reason: 'private 10.0.0.0/8' };
    if (a === 127) return { ok: false, reason: 'loopback 127.0.0.0/8' };
    if (a === 169 && b === 254) return { ok: false, reason: 'link-local / cloud metadata 169.254.0.0/16' };
    if (a === 172 && b >= 16 && b <= 31) return { ok: false, reason: 'private 172.16.0.0/12' };
    if (a === 192 && b === 168) return { ok: false, reason: 'private 192.168.0.0/16' };
    if (a === 0) return { ok: false, reason: 'reserved 0.0.0.0/8' };
  }

  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc00:') || host.startsWith('fd00:')) {
    return { ok: false, reason: 'private IPv6 range' };
  }

  return { ok: true };
}

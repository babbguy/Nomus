import { createPublicKey, verify } from 'node:crypto';
import { NomusApiError } from '../errors.js';
import {
  bundleHashOf, bundleSignedText, corporateBundleSchema, policyActivationPayload, ruleHashOf, type CorporateBundle,
} from './contracts.js';
import { canonicalJson } from './canonical.js';

/**
 * Fetch and verify the org's signed corporate policy bundle (design spec
 * §8.6). Shared by the CLI, the GitHub Action and the VS Code extension.
 *
 * Fail closed: a network error, a non-2xx status (other than 404), a
 * response that does not match the contract, a bundle hash that does not
 * recompute or any signature that does not verify throws NomusApiError.
 * The one non-error outcome without a bundle is a 404 from an engine that
 * predates CPG ({ available: false }): no corporate policy can exist there.
 */

export type BundleFetchResult =
  | { available: false }
  | { available: true; bundle: CorporateBundle; etag: string | null; notModified: boolean };

export interface FetchBundleOptions {
  apiUrl: string;
  apiKey: string;
  /** A previously verified bundle and its ETag: sent as If-None-Match; a 304 returns it after re-verification. */
  cached?: { bundle: CorporateBundle; etag: string };
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The instance public key (base64 SPKI DER) from /.well-known/nomus-keys. */
export async function fetchSigningKey(apiUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/.well-known/nomus-keys`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new NomusApiError('Could not reach the Nomus signing-key endpoint', err);
  }
  if (!res.ok) throw new NomusApiError(`The Nomus signing-key endpoint answered ${res.status}`, res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new NomusApiError('The Nomus signing-key endpoint returned invalid JSON', err);
  }
  const key = (body as { keys?: Array<{ spki?: unknown }> } | null)?.keys?.[0]?.spki;
  if (typeof key !== 'string' || key.length === 0) throw new NomusApiError('The Nomus signing-key endpoint returned no key', body);
  return key;
}

function verifyEd25519(text: string, signatureB64: string, spkiB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Verify a bundle offline against the instance public key: the contract,
 * the bundle signature, the recomputed bundle hash, every rule hash and
 * every activation signature. Throws NomusApiError on the first failure.
 */
export function verifyCorporateBundle(raw: unknown, spkiB64: string): CorporateBundle {
  const parsed = corporateBundleSchema.safeParse(raw);
  if (!parsed.success) throw new NomusApiError('The corporate policy bundle does not match the contract', parsed.error.issues);
  const bundle = parsed.data;
  if (!verifyEd25519(bundleSignedText(bundle), bundle.signature, spkiB64)) {
    throw new NomusApiError('The corporate policy bundle signature does not verify');
  }
  if (bundleHashOf(bundle.policies) !== bundle.bundleHash) {
    throw new NomusApiError('The corporate policy bundle hash does not match its policies');
  }
  if (!bundle.enabled && bundle.policies.length > 0) {
    throw new NomusApiError('A disabled corporate policy bundle must not carry policies');
  }
  const keys = new Set<string>();
  for (const p of bundle.policies) {
    if (keys.has(p.policyKey)) throw new NomusApiError(`The corporate policy bundle lists ${p.policyKey} twice`);
    keys.add(p.policyKey);
    if (ruleHashOf(p.rule) !== p.ruleHash) throw new NomusApiError(`The rule of ${p.policyKey} v${p.version} does not match its hash`);
    const payload = canonicalJson(policyActivationPayload(bundle.orgId, p));
    if (!verifyEd25519(payload, p.activationSignature, spkiB64)) {
      throw new NomusApiError(`The activation signature of ${p.policyKey} v${p.version} does not verify`);
    }
  }
  return bundle;
}

/** Fetch `/api/v1/cpg/bundle` and verify it (see the module comment for the fail-closed rules). */
export async function fetchCorporateBundle(opts: FetchBundleOptions): Promise<BundleFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = opts.apiUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.apiKey}`, Accept: 'application/json' };
  if (opts.cached) headers['If-None-Match'] = opts.cached.etag;

  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/v1/cpg/bundle`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new NomusApiError('Could not reach the Nomus corporate policy bundle endpoint', err);
  }
  if (res.status === 404) return { available: false };
  const spki = await fetchSigningKey(base, fetchImpl, timeoutMs);
  if (res.status === 304 && opts.cached) {
    return { available: true, bundle: verifyCorporateBundle(opts.cached.bundle, spki), etag: opts.cached.etag, notModified: true };
  }
  if (res.status !== 200) {
    let detail: unknown = res.status;
    try { detail = await res.json(); } catch { /* keep the status */ }
    throw new NomusApiError(`The Nomus corporate policy bundle endpoint answered ${res.status}`, detail);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new NomusApiError('The Nomus corporate policy bundle is not valid JSON', err);
  }
  const bundle = verifyCorporateBundle(body, spki);
  return { available: true, bundle, etag: res.headers.get('etag'), notModified: false };
}

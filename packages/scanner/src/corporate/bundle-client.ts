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
  | {
    available: true;
    bundle: CorporateBundle;
    etag: string | null;
    notModified: boolean;
    /** The instance key (base64 SPKI) the bundle was verified with, so a cached copy can be re-verified offline. */
    publicKeySpki: string;
  };

/**
 * Why fetching or verifying a bundle failed. `unreachable`: no answer;
 * `http`: an unexpected status; `invalid`: an answer that does not match the
 * contract or does not verify (never use it, and never use a cached copy in
 * its place without re-verifying it).
 */
export type BundleFailure =
  | { kind: 'unreachable' }
  | { kind: 'http'; status: number }
  | { kind: 'invalid' };

/** A NomusApiError (same name, same fail-closed handling) that says why the bundle is unusable. */
export class CorporateBundleError extends NomusApiError {
  readonly failure: BundleFailure;

  constructor(failure: BundleFailure, message: string, detail?: unknown) {
    super(message, detail);
    this.failure = failure;
  }
}

/** The failure behind an error thrown by this module; anything unexpected counts as `invalid`. */
export function bundleFailureOf(err: unknown): BundleFailure {
  const f = (err as { failure?: BundleFailure } | null)?.failure;
  if (f && typeof f === 'object' && (f.kind === 'unreachable' || f.kind === 'invalid' || (f.kind === 'http' && typeof f.status === 'number'))) return f;
  return { kind: 'invalid' };
}

const unreachable = (message: string, detail?: unknown) => new CorporateBundleError({ kind: 'unreachable' }, message, detail);
const invalid = (message: string, detail?: unknown) => new CorporateBundleError({ kind: 'invalid' }, message, detail);

function httpError(what: string, status: number, detail?: unknown): CorporateBundleError {
  const hint = status === 401 ? ': the API key was rejected (401)' : status === 403 ? ': the API key lacks the read:policies scope (403)' : '';
  return new CorporateBundleError({ kind: 'http', status }, `${what} answered ${status}${hint}`, detail);
}

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
    throw unreachable('Could not reach the Nomus signing-key endpoint', err);
  }
  if (!res.ok) throw httpError('The Nomus signing-key endpoint', res.status, res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw invalid('The Nomus signing-key endpoint returned invalid JSON', err);
  }
  const key = (body as { keys?: Array<{ spki?: unknown }> } | null)?.keys?.[0]?.spki;
  if (typeof key !== 'string' || key.length === 0) throw invalid('The Nomus signing-key endpoint returned no key', body);
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
  if (!parsed.success) throw invalid('The corporate policy bundle does not match the contract', parsed.error.issues);
  const bundle = parsed.data;
  if (!verifyEd25519(bundleSignedText(bundle), bundle.signature, spkiB64)) {
    throw invalid('The corporate policy bundle signature does not verify');
  }
  if (bundleHashOf(bundle.policies) !== bundle.bundleHash) {
    throw invalid('The corporate policy bundle hash does not match its policies');
  }
  if (!bundle.enabled && bundle.policies.length > 0) {
    throw invalid('A disabled corporate policy bundle must not carry policies');
  }
  const keys = new Set<string>();
  for (const p of bundle.policies) {
    if (keys.has(p.policyKey)) throw invalid(`The corporate policy bundle lists ${p.policyKey} twice`);
    keys.add(p.policyKey);
    if (ruleHashOf(p.rule) !== p.ruleHash) throw invalid(`The rule of ${p.policyKey} v${p.version} does not match its hash`);
    const payload = canonicalJson(policyActivationPayload(bundle.orgId, p));
    if (!verifyEd25519(payload, p.activationSignature, spkiB64)) {
      throw invalid(`The activation signature of ${p.policyKey} v${p.version} does not verify`);
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
    throw unreachable('Could not reach the Nomus corporate policy bundle endpoint', err);
  }
  if (res.status === 404) return { available: false };
  const spki = await fetchSigningKey(base, fetchImpl, timeoutMs);
  if (res.status === 304 && opts.cached) {
    return { available: true, bundle: verifyCorporateBundle(opts.cached.bundle, spki), etag: opts.cached.etag, notModified: true, publicKeySpki: spki };
  }
  if (res.status !== 200) {
    let detail: unknown = res.status;
    try { detail = await res.json(); } catch { /* keep the status */ }
    throw httpError('The Nomus corporate policy bundle endpoint', res.status, detail);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw invalid('The Nomus corporate policy bundle is not valid JSON', err);
  }
  const bundle = verifyCorporateBundle(body, spki);
  return { available: true, bundle, etag: res.headers.get('etag'), notModified: false, publicKeySpki: spki };
}

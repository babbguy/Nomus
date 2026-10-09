// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import type { BundleFetchResult, CorporateBundle, FetchBundleOptions } from '@nomus/scanner/corporate';

/** The scanner's corporate library, loaded on first use (it pulls in the detectors). */
type CorporateLib = typeof import('@nomus/scanner/corporate');
let libPromise: Promise<CorporateLib> | null = null;
const corporateLib = (): Promise<CorporateLib> => (libPromise ??= import('@nomus/scanner/corporate'));

/**
 * The extension's copy of the org's signed corporate policy bundle (design
 * spec §10.1, §10.5).
 *
 * - Stored per API URL in `globalState` under `nomus.cpg.bundle:<apiUrl>`,
 *   with the instance public key it was verified with.
 * - Every load from the cache re-verifies the signatures; a cache that
 *   fails is discarded and reported, never used.
 * - Revalidated with `If-None-Match` at most every 5 minutes (or on demand).
 * - Offline, a verified cache is used until it is older than the maximum
 *   age; after that it is "expired" and no corporate findings are shown.
 *
 * No state here ever means "no violations": every failure is a distinct,
 * visible state, and the caller clears corporate diagnostics for it.
 */

export const BUNDLE_CACHE_PREFIX = 'nomus.cpg.bundle:';
export const REVALIDATE_MS = 5 * 60_000;
export const DEFAULT_MAX_CACHE_AGE_HOURS = 72;

export interface BundleStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface CachedBundleRecord {
  version: 1;
  bundle: CorporateBundle;
  etag: string | null;
  /** Base64 SPKI of the instance key the bundle was verified with. */
  publicKeySpki: string;
  /** When the server last confirmed this bundle (200 or 304), ISO-8601 UTC. */
  fetchedAt: string;
}

export type BundleState =
  | { kind: 'verified'; bundle: CorporateBundle; fetchedAt: string; checkedAt: string }
  | { kind: 'offline'; bundle: CorporateBundle; fetchedAt: string; reason: string }
  | { kind: 'not_supported' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'expired'; fetchedAt: string; reason: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'denied'; status: number; reason: string };

export interface BundleLoad {
  state: BundleState;
  /** A cached copy failed verification during this load and was deleted. */
  discardedCache: string | null;
}

export interface BundleCacheOptions {
  store: BundleStore;
  fetchBundle?: (opts: FetchBundleOptions) => Promise<BundleFetchResult>;
  now?: () => Date;
  maxAgeHours?: () => number;
}

function isRecord(v: unknown): v is CachedBundleRecord {
  const r = v as Partial<CachedBundleRecord> | null | undefined;
  return !!r && typeof r === 'object' && r.version === 1 && typeof r.publicKeySpki === 'string'
    && typeof r.fetchedAt === 'string' && !Number.isNaN(Date.parse(r.fetchedAt)) && !!r.bundle;
}

export class BundleCache {
  private readonly store: BundleStore;
  private readonly fetchBundle: ((opts: FetchBundleOptions) => Promise<BundleFetchResult>) | null;
  private readonly now: () => Date;
  private readonly maxAgeHours: () => number;
  /** apiUrl → epoch ms of the last successful server check (in memory: a restart revalidates). */
  private readonly lastCheck = new Map<string, number>();

  constructor(opts: BundleCacheOptions) {
    this.store = opts.store;
    this.fetchBundle = opts.fetchBundle ?? null;
    this.now = opts.now ?? (() => new Date());
    this.maxAgeHours = opts.maxAgeHours ?? (() => DEFAULT_MAX_CACHE_AGE_HOURS);
  }

  static keyFor(apiUrl: string): string {
    return `${BUNDLE_CACHE_PREFIX}${apiUrl.replace(/\/+$/, '')}`;
  }

  /** The cached record, re-verified; a record that fails is deleted and the reason returned. */
  private async readVerified(key: string): Promise<{ record: CachedBundleRecord | null; discarded: string | null }> {
    const raw = this.store.get<unknown>(key);
    if (raw === undefined || raw === null) return { record: null, discarded: null };
    if (!isRecord(raw)) {
      await this.store.update(key, undefined);
      return { record: null, discarded: 'the cached copy is malformed' };
    }
    try {
      const bundle = (await corporateLib()).verifyCorporateBundle(raw.bundle, raw.publicKeySpki);
      return { record: { ...raw, bundle }, discarded: null };
    } catch (err) {
      await this.store.update(key, undefined);
      return { record: null, discarded: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Forget the server-check time so the next load revalidates. */
  invalidate(apiUrl?: string): void {
    if (apiUrl) this.lastCheck.delete(apiUrl.replace(/\/+$/, ''));
    else this.lastCheck.clear();
  }

  async load(apiUrl: string, apiKey: string, opts: { force?: boolean } = {}): Promise<BundleLoad> {
    const base = apiUrl.replace(/\/+$/, '');
    const key = BundleCache.keyFor(base);
    const { record: cached, discarded } = await this.readVerified(key);
    const now = this.now();
    const checked = this.lastCheck.get(base);

    if (cached && !opts.force && checked !== undefined && now.getTime() - checked < REVALIDATE_MS) {
      return { state: { kind: 'verified', bundle: cached.bundle, fetchedAt: cached.fetchedAt, checkedAt: new Date(checked).toISOString() }, discardedCache: discarded };
    }

    const lib = await corporateLib();
    const fetchBundle = this.fetchBundle ?? lib.fetchCorporateBundle;
    let res: BundleFetchResult;
    try {
      res = await fetchBundle({
        apiUrl: base,
        apiKey,
        ...(cached?.etag ? { cached: { bundle: cached.bundle, etag: cached.etag } } : {}),
      });
    } catch (err) {
      this.lastCheck.delete(base);
      const failure = lib.bundleFailureOf(err);
      const reason = err instanceof Error ? err.message : String(err);
      if (failure.kind === 'invalid') {
        // The server sent something that does not verify: never use it, and drop the cache too.
        await this.store.update(key, undefined);
        return { state: { kind: 'rejected', reason }, discardedCache: discarded };
      }
      if (failure.kind === 'http' && (failure.status === 401 || failure.status === 403)) {
        return { state: { kind: 'denied', status: failure.status, reason }, discardedCache: discarded };
      }
      // Unreachable, or a server error: fall back to a verified cache that is not too old.
      if (cached) {
        const ageMs = now.getTime() - Date.parse(cached.fetchedAt);
        const maxMs = this.maxAgeHours() * 3_600_000;
        if (ageMs > maxMs) return { state: { kind: 'expired', fetchedAt: cached.fetchedAt, reason }, discardedCache: discarded };
        return { state: { kind: 'offline', bundle: cached.bundle, fetchedAt: cached.fetchedAt, reason }, discardedCache: discarded };
      }
      return { state: { kind: 'unavailable', reason }, discardedCache: discarded };
    }

    this.lastCheck.set(base, now.getTime());
    if (!res.available) {
      await this.store.update(key, undefined);
      return { state: { kind: 'not_supported' }, discardedCache: discarded };
    }
    const record: CachedBundleRecord = {
      version: 1,
      bundle: res.bundle,
      etag: res.etag,
      publicKeySpki: res.publicKeySpki,
      fetchedAt: now.toISOString(),
    };
    await this.store.update(key, record);
    return { state: { kind: 'verified', bundle: res.bundle, fetchedAt: record.fetchedAt, checkedAt: record.fetchedAt }, discardedCache: discarded };
  }
}

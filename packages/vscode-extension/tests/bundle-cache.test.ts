import { describe, it, expect, beforeEach } from 'vitest';
import { CorporateBundleError, type BundleFetchResult, type FetchBundleOptions } from '@nomus/scanner/corporate';
import { BundleCache, REVALIDATE_MS, type CachedBundleRecord } from '../src/cpg/bundle-cache';
import { SPKI, signedBundle, signedPolicy } from './helpers/corporate';

const API = 'https://nomus.example.org';
const KEY = BundleCache.keyFor(API);

class MemoryStore {
  data = new Map<string, unknown>();
  get<T>(k: string): T | undefined { return this.data.get(k) as T | undefined; }
  async update(k: string, v: unknown) { if (v === undefined) this.data.delete(k); else this.data.set(k, v); }
}

let store: MemoryStore;
let clock: number;
let calls: FetchBundleOptions[];
let respond: (o: FetchBundleOptions) => Promise<BundleFetchResult>;

const cacheOf = (maxAgeHours = 72) => new BundleCache({
  store, now: () => new Date(clock), maxAgeHours: () => maxAgeHours,
  fetchBundle: (o) => { calls.push(o); return respond(o); },
});
const ok = (bundle = signedBundle(), etag: string | null = '"e1"', notModified = false) => async (): Promise<BundleFetchResult> => ({ available: true, bundle, etag, notModified, publicKeySpki: SPKI });
const fail = (failure: ConstructorParameters<typeof CorporateBundleError>[0]) => async (): Promise<BundleFetchResult> => { throw new CorporateBundleError(failure, `failure ${failure.kind}`); };

beforeEach(() => {
  store = new MemoryStore();
  clock = Date.parse('2026-10-09T12:00:00.000Z');
  calls = [];
  respond = ok();
});

describe('BundleCache (design spec §10.1, §10.5)', () => {
  it('fetches, verifies and stores the bundle with its key; within 5 minutes it reuses the re-verified cache', async () => {
    const cache = cacheOf();
    const first = await cache.load(API, 'k');
    expect(first.state.kind).toBe('verified');
    const rec = store.get<CachedBundleRecord>(KEY)!;
    expect(rec).toMatchObject({ version: 1, etag: '"e1"', publicKeySpki: SPKI, fetchedAt: '2026-10-09T12:00:00.000Z' });
    clock += REVALIDATE_MS - 1;
    const second = await cache.load(API, 'k');
    expect(second.state.kind).toBe('verified');
    expect(calls).toHaveLength(1);
  });

  it('after 5 minutes (or on refresh) it revalidates with If-None-Match: the cached bundle and its ETag', async () => {
    const cache = cacheOf();
    await cache.load(API, 'k');
    respond = ok(signedBundle(), '"e1"', true);
    clock += REVALIDATE_MS;
    await cache.load(API, 'k');
    await cache.load(API, 'k', { force: true });
    expect(calls).toHaveLength(3);
    expect(calls[1].cached?.etag).toBe('"e1"');
    expect(calls[2].cached?.etag).toBe('"e1"');
    expect(store.get<CachedBundleRecord>(KEY)!.fetchedAt).toBe(new Date(clock).toISOString());
  });

  it('offline with a verified cache: the cached bundle, marked offline with its time', async () => {
    const cache = cacheOf();
    await cache.load(API, 'k');
    respond = fail({ kind: 'unreachable' });
    clock += 60 * 60_000;
    const r = await cache.load(API, 'k', { force: true });
    expect(r.state).toMatchObject({ kind: 'offline', fetchedAt: '2026-10-09T12:00:00.000Z' });
    respond = fail({ kind: 'http', status: 502 });
    expect((await cache.load(API, 'k', { force: true })).state.kind).toBe('offline');
  });

  it('offline with a cache older than the maximum age: expired, the bundle is not returned', async () => {
    const cache = cacheOf(72);
    await cache.load(API, 'k');
    respond = fail({ kind: 'unreachable' });
    clock += 73 * 3_600_000;
    const r = await cache.load(API, 'k', { force: true });
    expect(r.state.kind).toBe('expired');
    expect('bundle' in r.state).toBe(false);
  });

  it('offline with no cache: unavailable (never an empty bundle)', async () => {
    respond = fail({ kind: 'unreachable' });
    const r = await cacheOf().load(API, 'k');
    expect(r.state.kind).toBe('unavailable');
  });

  it('a tampered cache is discarded and reported; online a fresh bundle replaces it', async () => {
    const cache = cacheOf();
    await cache.load(API, 'k');
    const rec = store.get<CachedBundleRecord>(KEY)!;
    store.data.set(KEY, { ...rec, bundle: { ...rec.bundle, policies: rec.bundle.policies.map((p) => ({ ...p, tier: 'advisory' })) } });
    clock += REVALIDATE_MS;
    const r = await cache.load(API, 'k');
    expect(r.discardedCache).toMatch(/hash/);
    expect(r.state.kind).toBe('verified');
    expect(calls.at(-1)?.cached).toBeUndefined();
    expect(store.get<CachedBundleRecord>(KEY)!.bundle.policies[0].tier).toBe('prohibited');
  });

  it('a tampered cache while offline: discarded, unavailable; never used', async () => {
    const cache = cacheOf();
    await cache.load(API, 'k');
    const rec = store.get<CachedBundleRecord>(KEY)!;
    store.data.set(KEY, { ...rec, bundle: { ...rec.bundle, enabled: false, policies: [] } });
    respond = fail({ kind: 'unreachable' });
    const r = await cache.load(API, 'k');
    expect(r.discardedCache).toMatch(/signature/);
    expect(r.state.kind).toBe('unavailable');
    expect(store.get(KEY)).toBeUndefined();
  });

  it('a cache verified with a key that does not match is discarded', async () => {
    store.data.set(KEY, { version: 1, bundle: signedBundle(), etag: '"x"', publicKeySpki: 'AAAA', fetchedAt: '2026-10-09T11:00:00.000Z' });
    respond = fail({ kind: 'unreachable' });
    const r = await cacheOf().load(API, 'k');
    expect(r.discardedCache).not.toBeNull();
    expect(r.state.kind).toBe('unavailable');
  });

  it('a malformed cache record is discarded', async () => {
    store.data.set(KEY, { version: 9, junk: true });
    const r = await cacheOf().load(API, 'k');
    expect(r.discardedCache).toBe('the cached copy is malformed');
    expect(r.state.kind).toBe('verified');
  });

  it('a bundle the server sends that does not verify: rejected, and the cache is deleted too', async () => {
    const cache = cacheOf();
    await cache.load(API, 'k');
    respond = fail({ kind: 'invalid' });
    const r = await cache.load(API, 'k', { force: true });
    expect(r.state.kind).toBe('rejected');
    expect(store.get(KEY)).toBeUndefined();
  });

  it('401/403: denied (the cache is not presented as current)', async () => {
    const cache = cacheOf();
    await cache.load(API, 'k');
    respond = fail({ kind: 'http', status: 401 });
    const r = await cache.load(API, 'k', { force: true });
    expect(r.state).toMatchObject({ kind: 'denied', status: 401 });
  });

  it('an engine without CPG (404): not supported, and any cache is dropped', async () => {
    const cache = cacheOf();
    await cache.load(API, 'k');
    respond = async () => ({ available: false });
    const r = await cache.load(API, 'k', { force: true });
    expect(r.state.kind).toBe('not_supported');
    expect(store.get(KEY)).toBeUndefined();
  });

  it('the cache is per API URL', async () => {
    await cacheOf().load(API, 'k');
    respond = fail({ kind: 'unreachable' });
    const other = await cacheOf().load('https://other.example.org', 'k');
    expect(other.state.kind).toBe('unavailable');
    expect(BundleCache.keyFor(`${API}/`)).toBe(KEY);
  });

  it('a disabled org is a verified bundle with no policies', async () => {
    respond = ok(signedBundle([signedPolicy()], false));
    const r = await cacheOf().load(API, 'k');
    expect(r.state.kind === 'verified' && r.state.bundle.enabled).toBe(false);
  });
});

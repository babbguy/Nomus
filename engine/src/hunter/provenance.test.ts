/**
 * Provenance model tests — the trust tiers, promotion gate, serving-honesty
 * decision, and per-section manifest verification that back Nomus's
 * "byte-exact and COMPLETE or it is not promoted" invariant.
 */
import { describe, it, expect } from 'vitest';
import {
  describeProvenance,
  normalizeProvenanceMode,
  isPromotableProvenance,
  isByteExactProvenance,
  compareSectionManifest,
  chooseServedSnapshot,
  type ManifestEntry,
  type ServableSnapshot,
} from './provenance.js';

describe('provenance trust model', () => {
  it('byte_exact is byte-exact and promotable', () => {
    const d = describeProvenance('byte_exact');
    expect(d.byteExact).toBe(true);
    expect(d.promotable).toBe(true);
  });

  it('assembled and healed are promotable but NOT byte-exact', () => {
    for (const mode of ['assembled', 'healed'] as const) {
      const d = describeProvenance(mode);
      expect(d.promotable).toBe(true);
      expect(d.byteExact).toBe(false);
    }
  });

  it('stale_cache is NEVER promotable', () => {
    expect(isPromotableProvenance('stale_cache')).toBe(false);
    expect(describeProvenance('stale_cache').byteExact).toBe(false);
  });

  it('rendered (headless) is promotable, NOT byte-exact, labeled, and ranks between healed and stale_cache', () => {
    const d = describeProvenance('rendered');
    expect(d.promotable).toBe(true);
    expect(d.byteExact).toBe(false);
    expect(d.label).toBe('Rendered (headless browser)');
    // Trust ordering: healed (3) < rendered < stale_cache (9).
    expect(d.trustTier).toBeGreaterThan(describeProvenance('healed').trustTier);
    expect(d.trustTier).toBeLessThan(describeProvenance('stale_cache').trustTier);
    // A rendered capture normalizes to itself (not downgraded to stale_cache).
    expect(normalizeProvenanceMode('rendered')).toBe('rendered');
  });

  it('maps legacy strings (raw→byte_exact, cache→stale_cache)', () => {
    expect(normalizeProvenanceMode('raw')).toBe('byte_exact');
    expect(normalizeProvenanceMode('cache')).toBe('stale_cache');
  });

  it('treats unknown/garbage provenance as non-promotable (fail-closed)', () => {
    expect(normalizeProvenanceMode('who-knows')).toBe('stale_cache');
    expect(isPromotableProvenance('who-knows')).toBe(false);
    expect(isByteExactProvenance(undefined)).toBe(true); // default = byte_exact
  });
});

describe('compareSectionManifest (assembled per-section verification)', () => {
  const stored: ManifestEntry[] = [
    { url: 'https://law.example/a', bytesHash: 'hashA' },
    { url: 'https://law.example/b', bytesHash: 'hashB' },
    { url: 'https://law.example/c', bytesHash: 'hashC' },
  ];

  it('MATCH only when every section is byte-identical', () => {
    const live = new Map([
      ['https://law.example/a', 'hashA'],
      ['https://law.example/b', 'hashB'],
      ['https://law.example/c', 'hashC'],
    ]);
    const r = compareSectionManifest(stored, live);
    expect(r.outcome).toBe('MATCH');
    expect(r.matched).toBe(3);
  });

  it('DRIFT when a section differs (top-level re-assembly is NOT enough)', () => {
    const live = new Map([
      ['https://law.example/a', 'hashA'],
      ['https://law.example/b', 'DIFFERENT'],
      ['https://law.example/c', 'hashC'],
    ]);
    const r = compareSectionManifest(stored, live);
    expect(r.outcome).toBe('DRIFT');
    expect(r.drifted).toBe(1);
    expect(r.sections.find((s) => s.url.endsWith('/b'))!.match).toBe(false);
  });

  it('UNREACHABLE when a section could not be re-fetched — never claims MATCH', () => {
    const live = new Map([
      ['https://law.example/a', 'hashA'],
      ['https://law.example/c', 'hashC'],
    ]);
    const r = compareSectionManifest(stored, live);
    expect(r.outcome).toBe('UNREACHABLE');
    expect(r.unreachable).toBe(1);
  });
});

describe('chooseServedSnapshot (serving honesty / fail-closed read path)', () => {
  const promoted: ServableSnapshot = {
    id: 'p1', scrapedAt: '2026-07-01T00:00:00Z', provenanceMode: 'byte_exact', promoted: true,
  };
  const heldStale: ServableSnapshot = {
    id: 's1', scrapedAt: '2026-07-20T00:00:00Z', provenanceMode: 'stale_cache', promoted: false,
  };

  it('serves the last known-good promoted snapshot as current law', () => {
    const d = chooseServedSnapshot(promoted, promoted);
    expect(d.served!.id).toBe('p1');
    expect(d.verified).toBe(true);
    expect(d.updatePending).toBe(false);
  });

  it('holds a newer stale capture and keeps serving last known-good with update-pending', () => {
    // latest = the held stale capture; lastPromoted = the older good one
    const d = chooseServedSnapshot(heldStale, promoted);
    expect(d.served!.id).toBe('p1');       // NOT the stale one
    expect(d.verified).toBe(true);
    expect(d.updatePending).toBe(true);
    expect(d.pending!.provenanceMode).toBe('stale_cache');
    expect(d.pending!.capturedAt).toBe('2026-07-20T00:00:00Z');
  });

  it('serves an unverified capture as NOT current when no promoted snapshot exists', () => {
    const d = chooseServedSnapshot(heldStale, null);
    expect(d.served!.id).toBe('s1');
    expect(d.verified).toBe(false);
    expect(d.updatePending).toBe(true);
  });

  it('returns nothing when there are no snapshots at all', () => {
    const d = chooseServedSnapshot(null, null);
    expect(d.served).toBeNull();
    expect(d.verified).toBe(false);
  });
});

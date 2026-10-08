/**
 * Provenance Model — the single source of truth for how trustworthy a stored
 * regulatory snapshot is, and whether it may be served/promoted as CURRENT law.
 * =========================================================================
 *
 * Regulatory text is LAW. A snapshot is only allowed to represent "the current
 * regulation" if we can prove it is byte-exact and COMPLETE. When we cannot,
 * the owner decision (2026-07-26) is REFUSE TO GUESS / fail-closed: hold the
 * capture as unverified and keep serving the last known-good promoted snapshot.
 *
 * Trust tiers (highest → lowest):
 *   byte_exact  — one unmodified HTTP body; rawBytesHash == the server's bytes.
 *   upload      — the customer supplied the document file directly.
 *   assembled   — Nomus concatenated multiple fetches (multi-page / GitHub).
 *                 Only reaches storage when EVERY expected section was captured
 *                 (see scraper.ts — any skipped section hard-fails the fetch).
 *   healed      — content came from an alternative source (Wayback / direct PDF)
 *                 after the primary fetch failed quality.
 *   rendered    — content is the DOM a headless browser produced AFTER running
 *                 the page's JavaScript. It is NOT the raw HTTP body (JS mutated
 *                 it), so it can never be byte-exact — but it is a genuine live
 *                 capture of the published page, hashed and promotable. Used as
 *                 the ACCESS-ESCALATION tier for JS-rendered / bot-walled sources
 *                 that a plain HTTP fetch cannot capture.
 *   stale_cache — served from the local content cache with no live HTTP
 *                 provenance. NEVER promotable as current law.
 *
 * Anything that is not `byte_exact` is a lower tier of trust and MUST be
 * visibly distinguishable to any consumer (serving honesty).
 */

export type ProvenanceMode =
  | 'byte_exact'
  | 'assembled'
  | 'healed'
  | 'rendered'
  | 'stale_cache'
  | 'upload';

export interface ProvenanceDescriptor {
  mode: ProvenanceMode;
  /** True only when a single served HTTP body's bytes are hashed 1:1. */
  byteExact: boolean;
  /** True when a snapshot in this mode may be promoted / served as current law. */
  promotable: boolean;
  /** 0 = highest trust. */
  trustTier: number;
  /** Human-facing label for dashboards / API consumers. */
  label: string;
}

const DESCRIPTORS: Record<ProvenanceMode, ProvenanceDescriptor> = {
  byte_exact: {
    mode: 'byte_exact',
    byteExact: true,
    promotable: true,
    trustTier: 0,
    label: 'Byte-exact (single source body)',
  },
  upload: {
    mode: 'upload',
    byteExact: false,
    promotable: true,
    trustTier: 1,
    label: 'Customer upload',
  },
  assembled: {
    mode: 'assembled',
    byteExact: false,
    promotable: true,
    trustTier: 2,
    label: 'Assembled (multi-page — complete)',
  },
  healed: {
    mode: 'healed',
    byteExact: false,
    promotable: true,
    trustTier: 3,
    label: 'Healed (alternative source)',
  },
  rendered: {
    mode: 'rendered',
    byteExact: false,
    // A live, hashed capture of the published page — promotable as current law,
    // but the JS-mutated DOM is never presented as the byte-exact HTTP body.
    promotable: true,
    trustTier: 4,
    label: 'Rendered (headless browser)',
  },
  stale_cache: {
    mode: 'stale_cache',
    byteExact: false,
    promotable: false,
    trustTier: 9,
    label: 'Stale cache (no live provenance)',
  },
};

/**
 * Legacy provenance strings that pre-date this canonical model. Kept so a DB
 * that was written before the 2026-07-26 rename still resolves sensibly if a
 * migration has not yet run.
 */
const LEGACY_ALIASES: Record<string, ProvenanceMode> = {
  raw: 'byte_exact',
  cache: 'stale_cache',
};

/** Normalize any stored/incoming provenance string to a canonical mode. */
export function normalizeProvenanceMode(mode: string | null | undefined): ProvenanceMode {
  if (!mode) return 'byte_exact';
  if (mode in DESCRIPTORS) return mode as ProvenanceMode;
  if (mode in LEGACY_ALIASES) return LEGACY_ALIASES[mode];
  // Unknown/garbage provenance is treated as the LEAST trusted, non-promotable
  // tier — fail-closed. We never assume an unknown mode is byte-exact.
  return 'stale_cache';
}

export function describeProvenance(mode: string | null | undefined): ProvenanceDescriptor {
  return DESCRIPTORS[normalizeProvenanceMode(mode)];
}

/**
 * May a snapshot in this provenance mode be PROMOTED and served as the current
 * regulation? False for stale_cache (and any unknown mode) — those are held as
 * unverified while the last known-good promoted snapshot keeps serving.
 */
export function isPromotableProvenance(mode: string | null | undefined): boolean {
  return describeProvenance(mode).promotable;
}

export function isByteExactProvenance(mode: string | null | undefined): boolean {
  return describeProvenance(mode).byteExact;
}

// ─── Per-section manifest verification (assembled sources) ──────────────────
//
// For assembled snapshots the top-level rawBytesHash only proves Nomus
// re-assembled its own concatenation identically — NOT that the content matches
// the publisher. Real per-section fidelity is proven by re-fetching each URL in
// the manifest and comparing its byte hash. MATCH is only reported when every
// section's live bytes hash equals the stored section hash.

export interface ManifestEntry {
  url: string;
  bytesHash: string;
  bytesSize?: number;
  status?: number;
}

export interface SectionVerifyResult {
  url: string;
  storedHash: string;
  liveHash: string | null;
  match: boolean;
}

export interface ManifestVerifyReport {
  outcome: 'MATCH' | 'DRIFT' | 'UNREACHABLE';
  sections: SectionVerifyResult[];
  matched: number;
  drifted: number;
  unreachable: number;
}

/**
 * Compare a stored per-section manifest against freshly re-fetched section
 * hashes (keyed by url).
 *
 *   MATCH        — every section was reachable and byte-identical.
 *   DRIFT        — every section was reachable, but at least one differs.
 *   UNREACHABLE  — at least one section could not be re-fetched (we cannot
 *                  prove fidelity, so we never claim MATCH).
 */
export function compareSectionManifest(
  stored: ManifestEntry[],
  liveHashes: Map<string, string>,
): ManifestVerifyReport {
  const sections: SectionVerifyResult[] = [];
  let matched = 0;
  let drifted = 0;
  let unreachable = 0;

  for (const entry of stored) {
    const liveHash = liveHashes.get(entry.url) ?? null;
    if (liveHash === null) {
      unreachable++;
      sections.push({ url: entry.url, storedHash: entry.bytesHash, liveHash: null, match: false });
    } else if (liveHash === entry.bytesHash) {
      matched++;
      sections.push({ url: entry.url, storedHash: entry.bytesHash, liveHash, match: true });
    } else {
      drifted++;
      sections.push({ url: entry.url, storedHash: entry.bytesHash, liveHash, match: false });
    }
  }

  let outcome: ManifestVerifyReport['outcome'];
  if (unreachable > 0) outcome = 'UNREACHABLE';
  else if (drifted > 0) outcome = 'DRIFT';
  else outcome = 'MATCH';

  return { outcome, sections, matched, drifted, unreachable };
}

// ─── Serving honesty ────────────────────────────────────────────────────────
//
// The read path must never present a held/partial/stale capture as current law.
// When the newest capture is not a promotable, promoted snapshot, we serve the
// last known-good promoted snapshot with an explicit as-of timestamp and an
// update-pending flag.

export interface ServableSnapshot {
  id: string;
  scrapedAt: string;
  provenanceMode: string | null;
  /** Whether this row was written by a successful promotion. */
  promoted?: boolean | number | null;
}

export interface ServingDecision<T extends ServableSnapshot> {
  /** The snapshot to actually serve (last known-good), or null if none exists. */
  served: T | null;
  /** True when we are serving a promoted, promotable snapshot (current law). */
  verified: boolean;
  /** True when a newer capture exists that has NOT been promoted (held). */
  updatePending: boolean;
  pending: {
    capturedAt: string;
    provenanceMode: ProvenanceMode;
    reason: string;
  } | null;
}

function isPromoted(row: ServableSnapshot): boolean {
  return row.promoted === true || row.promoted === 1;
}

/**
 * Decide which snapshot to serve as the authoritative current regulation.
 *
 * @param latest       Most recent snapshot for the source (any status), or null.
 * @param lastPromoted Most recent snapshot written by a successful promotion, or null.
 */
export function chooseServedSnapshot<T extends ServableSnapshot>(
  latest: T | null,
  lastPromoted: T | null,
): ServingDecision<T> {
  // Prefer the last known-good promoted snapshot as the authoritative current law.
  if (lastPromoted && isPromotableProvenance(lastPromoted.provenanceMode)) {
    const newerHeld = latest && latest.id !== lastPromoted.id;
    return {
      served: lastPromoted,
      verified: true,
      updatePending: !!newerHeld,
      pending: newerHeld
        ? {
            capturedAt: latest!.scrapedAt,
            provenanceMode: normalizeProvenanceMode(latest!.provenanceMode),
            reason:
              'A newer capture exists but has not been verified/promoted; ' +
              'serving the last known-good version.',
          }
        : null,
    };
  }

  // No promotable promoted snapshot exists. If we only have an unverified/held
  // capture, serve it but flag it explicitly as NOT current-verified law.
  if (latest) {
    return {
      served: latest,
      verified: false,
      updatePending: true,
      pending: {
        capturedAt: latest.scrapedAt,
        provenanceMode: normalizeProvenanceMode(latest.provenanceMode),
        reason: isPromoted(latest)
          ? 'Latest snapshot has non-promotable provenance.'
          : 'No promoted snapshot exists yet; this capture is unverified.',
      },
    };
  }

  return { served: null, verified: false, updatePending: false, pending: null };
}

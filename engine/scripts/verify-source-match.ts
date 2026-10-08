/**
 * Source-Exact Verification — Re-fetch and Compare
 * ===================================================
 *
 * For each stored regulatory snapshot in the DB, re-fetches the live source
 * URL using the same scraper code path and compares the new raw_bytes_hash
 * against the stored one.
 *
 * Three outcomes per source:
 *   MATCH       — stored content is byte-identical to current source
 *   DRIFT       — source has changed since the last scrape (legitimate if regulation
 *                 was updated; suspicious otherwise)
 *   UNREACHABLE — source is currently inaccessible (network error, WAF, etc.)
 *
 * This is the receipt that lets us tell a customer "the EU AI Act text we
 * showed you on 2026-04-07 was a byte-for-byte copy of what eur-lex was
 * publishing at that timestamp." With per-section manifests for multi-page
 * sources, we can prove it section by section.
 *
 * Run:
 *   npx tsx engine/scripts/verify-source-match.ts                # all sources
 *   npx tsx engine/scripts/verify-source-match.ts --names="GDPR" # subset
 *   npx tsx engine/scripts/verify-source-match.ts --json out.json
 *
 * Exit code: 0 if all sources MATCH, 1 if any DRIFT, 2 if any UNREACHABLE.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { desc, eq } from 'drizzle-orm';

import { getDb, closeDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { regulatorySources, rawSnapshots } from '../src/db/schema.js';
import { scrapeSource } from '../src/hunter/scraper.js';
import {
  compareSectionManifest,
  normalizeProvenanceMode,
  type ManifestEntry,
  type SectionVerifyResult,
} from '../src/hunter/provenance.js';

interface VerifyReport {
  name: string;
  url: string;
  provenanceMode?: string;
  storedAt?: string;
  storedHash?: string;
  storedSize?: number;
  liveHash?: string;
  liveSize?: number;
  outcome: 'MATCH' | 'DRIFT' | 'UNREACHABLE' | 'NO_SNAPSHOT' | 'NO_PROVENANCE';
  /** Per-section results for assembled (multi-page / GitHub) sources. */
  sections?: SectionVerifyResult[];
  durationMs: number;
  error?: string;
}

/** Re-fetch a URL and return the SHA-256 of its unmodified body, or null. */
async function fetchRawHash(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

function parseArgs(): { names: Set<string> | null; jsonOut: string | null } {
  const args = process.argv.slice(2);
  let names: Set<string> | null = null;
  let jsonOut: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--names=')) {
      names = new Set(a.slice('--names='.length).split(',').map((s) => s.trim()).filter(Boolean));
    } else if (a === '--json' && i + 1 < args.length) {
      jsonOut = args[++i];
    }
  }
  return { names, jsonOut };
}

async function verifyOne(source: { id: string; name: string; url: string; parserType: 'html' | 'pdf'; selectorConfig: string }): Promise<VerifyReport> {
  const t0 = performance.now();
  const r: VerifyReport = {
    name: source.name,
    url: source.url,
    outcome: 'NO_SNAPSHOT',
    durationMs: 0,
  };

  const db = getDb();
  const snapshot = db
    .select()
    .from(rawSnapshots)
    .where(eq(rawSnapshots.sourceId, source.id))
    .orderBy(desc(rawSnapshots.scrapedAt))
    .limit(1)
    .get();

  if (!snapshot) {
    r.durationMs = Math.round(performance.now() - t0);
    return r;
  }

  r.storedAt = snapshot.scrapedAt;
  r.storedHash = snapshot.rawBytesHash ?? undefined;
  r.storedSize = snapshot.rawBytesSize ?? undefined;
  const mode = normalizeProvenanceMode(snapshot.provenanceMode);
  r.provenanceMode = mode;

  if (!snapshot.rawBytesHash) {
    r.outcome = 'NO_PROVENANCE';
    r.durationMs = Math.round(performance.now() - t0);
    return r;
  }

  // ─── Assembled (multi-page / GitHub): verify the PER-SECTION manifest ──────
  // The top-level rawBytesHash only proves Nomus re-assembled its own
  // concatenation identically — NOT that the content matches the publisher.
  // Real fidelity is proven section by section: re-fetch each manifest URL and
  // compare byte hashes. MATCH only when every section is byte-identical.
  if (mode === 'assembled') {
    let manifest: ManifestEntry[] = [];
    try {
      manifest = JSON.parse(snapshot.provenanceManifest ?? '[]');
    } catch {
      manifest = [];
    }

    if (!Array.isArray(manifest) || manifest.length === 0) {
      r.outcome = 'NO_PROVENANCE';
      r.error = 'Assembled snapshot has no per-section manifest to verify';
      r.durationMs = Math.round(performance.now() - t0);
      return r;
    }

    const liveHashes = new Map<string, string>();
    for (const entry of manifest) {
      const h = await fetchRawHash(entry.url);
      if (h !== null) liveHashes.set(entry.url, h);
    }

    const report = compareSectionManifest(manifest, liveHashes);
    r.sections = report.sections;
    r.outcome = report.outcome; // MATCH only if every section is byte-identical
    if (report.outcome !== 'MATCH') {
      r.error = `${report.matched} matched, ${report.drifted} drifted, ${report.unreachable} unreachable of ${manifest.length} sections`;
    }
    r.durationMs = Math.round(performance.now() - t0);
    return r;
  }

  // ─── Byte-exact single-page: re-fetch and compare the top-level hash ───────
  let parsedSelector;
  try {
    parsedSelector = JSON.parse(source.selectorConfig);
  } catch {
    parsedSelector = {};
  }

  try {
    const live = await scrapeSource(source.url, source.parserType, parsedSelector, {
      sourceId: `verify-${source.id}`,
      sourceName: source.name,
    });
    r.liveHash = live.rawBytesHash;
    r.liveSize = live.rawBytesSize;
    r.outcome = live.rawBytesHash === snapshot.rawBytesHash ? 'MATCH' : 'DRIFT';
  } catch (err) {
    r.outcome = 'UNREACHABLE';
    r.error = err instanceof Error ? err.message : String(err);
  }

  r.durationMs = Math.round(performance.now() - t0);
  return r;
}

async function main(): Promise<void> {
  const { names, jsonOut } = parseArgs();
  runMigrations();

  const db = getDb();
  const allSources = db.select().from(regulatorySources).all();
  const targets = names
    ? allSources.filter((s) => names.has(s.name))
    : allSources.filter((s) => s.ingestionMode === 'auto');

  if (targets.length === 0) {
    console.error('No matching sources in DB. Run a live scrape first to populate snapshots.');
    closeDb();
    process.exit(1);
  }

  console.log(`\n\x1b[1mNomus Source-Exact Verification\x1b[0m`);
  console.log(`Sources: ${targets.length}`);
  console.log(`Strategy: re-fetch live, compare raw_bytes_hash to stored snapshot\n`);

  const reports: VerifyReport[] = [];
  let match = 0, drift = 0, unreachable = 0, noSnapshot = 0, noProv = 0;

  for (const source of targets) {
    process.stdout.write(`  ${source.name.padEnd(60, '.')} `);
    const r = await verifyOne(source);
    reports.push(r);

    let mark = '';
    switch (r.outcome) {
      case 'MATCH':         mark = '\x1b[32m✓ MATCH\x1b[0m';            match++; break;
      case 'DRIFT':         mark = '\x1b[33m~ DRIFT\x1b[0m';            drift++; break;
      case 'UNREACHABLE':   mark = '\x1b[31m✗ UNREACHABLE\x1b[0m';      unreachable++; break;
      case 'NO_SNAPSHOT':   mark = '\x1b[90m- NO_SNAPSHOT\x1b[0m';      noSnapshot++; break;
      case 'NO_PROVENANCE': mark = '\x1b[90m- NO_PROVENANCE\x1b[0m';    noProv++; break;
    }
    console.log(`${mark}  ${r.durationMs}ms${r.error ? '  ' + r.error.slice(0, 60) : ''}`);
  }

  console.log('\n\x1b[1mSummary\x1b[0m');
  console.log(`  MATCH:          \x1b[32m${match}\x1b[0m / ${targets.length}`);
  console.log(`  DRIFT:          \x1b[33m${drift}\x1b[0m  (source changed since last scrape)`);
  console.log(`  UNREACHABLE:    \x1b[31m${unreachable}\x1b[0m`);
  console.log(`  NO_SNAPSHOT:    \x1b[90m${noSnapshot}\x1b[0m  (source never scraped)`);
  console.log(`  NO_PROVENANCE:  \x1b[90m${noProv}\x1b[0m  (snapshot pre-dates raw_bytes_hash)`);

  if (jsonOut) {
    writeFileSync(resolve(jsonOut), JSON.stringify({ reports, match, drift, unreachable, noSnapshot, noProv }, null, 2));
    console.log(`\nReport written to ${jsonOut}`);
  }

  closeDb();
  if (unreachable > 0) process.exit(2);
  if (drift > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error('Verification crashed:', err);
  closeDb();
  process.exit(3);
});

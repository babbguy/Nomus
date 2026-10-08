/**
 * Standalone source-exact verification — reads a previous live-scrape report
 * and re-fetches each successful source to confirm the raw_bytes_hash is
 * still byte-identical (or report drift).
 *
 * This is the simpler counterpart to verify-source-match.ts which uses the DB.
 * Useful for proving source-exactness without needing a populated DB.
 *
 * Run:
 *   npx tsx engine/scripts/verify-from-report.ts <report.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { REGULATORY_SOURCES } from '../src/hunter/sources/registry.js';
import { scrapeSource } from '../src/hunter/scraper.js';

interface ReportEntry {
  name: string;
  url: string;
  parserType: 'html' | 'pdf';
  rawBytesHash?: string;
  rawBytesSize?: number;
  ok: boolean;
}

async function main(): Promise<void> {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error('Usage: verify-from-report.ts <report.json>');
    process.exit(1);
  }

  const report = JSON.parse(readFileSync(resolve(reportPath), 'utf-8'));
  const valid: ReportEntry[] = report.perSource.filter((s: ReportEntry) => s.ok && s.rawBytesHash);

  console.log(`\nNomus Source-Exact Verification`);
  console.log(`Report: ${reportPath}`);
  console.log(`Sources to verify: ${valid.length}\n`);

  let match = 0, drift = 0, unreachable = 0;
  const results: Array<{ name: string; outcome: string; storedHash?: string; liveHash?: string; durationMs: number; error?: string }> = [];

  for (const entry of valid) {
    const sourceDef = REGULATORY_SOURCES.find((s) => s.name === entry.name);
    if (!sourceDef) {
      console.log(`  - ${entry.name.padEnd(58, '.')} SKIPPED (no registry def)`);
      continue;
    }

    process.stdout.write(`  Verifying ${entry.name.padEnd(56, '.')} `);
    const t0 = performance.now();
    try {
      const live = await scrapeSource(sourceDef.url, sourceDef.parserType, sourceDef.selectorConfig, {
        sourceId: `verify-${entry.name}`,
        sourceName: entry.name,
      });
      const dur = Math.round(performance.now() - t0);
      const liveHash = live.rawBytesHash;
      if (liveHash && liveHash === entry.rawBytesHash) {
        console.log(`\x1b[32m✓ MATCH\x1b[0m   ${dur}ms`);
        match++;
        results.push({ name: entry.name, outcome: 'MATCH', storedHash: entry.rawBytesHash, liveHash, durationMs: dur });
      } else {
        console.log(`\x1b[33m~ DRIFT\x1b[0m   ${dur}ms  stored=${entry.rawBytesHash?.slice(0, 12)} live=${liveHash?.slice(0, 12)}`);
        drift++;
        results.push({ name: entry.name, outcome: 'DRIFT', storedHash: entry.rawBytesHash, liveHash, durationMs: dur });
      }
    } catch (err) {
      const dur = Math.round(performance.now() - t0);
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`\x1b[31m✗ UNREACHABLE\x1b[0m  ${dur}ms  ${msg.slice(0, 60)}`);
      unreachable++;
      results.push({ name: entry.name, outcome: 'UNREACHABLE', storedHash: entry.rawBytesHash, durationMs: dur, error: msg });
    }
  }

  console.log(`\nResults:`);
  console.log(`  MATCH:       \x1b[32m${match}\x1b[0m / ${valid.length}`);
  console.log(`  DRIFT:       \x1b[33m${drift}\x1b[0m  (legitimate if source updated)`);
  console.log(`  UNREACHABLE: \x1b[31m${unreachable}\x1b[0m`);

  // Write a paired verification report
  const outPath = reportPath.replace(/\.json$/, '-verification.json');
  writeFileSync(outPath, JSON.stringify({ verifiedAt: new Date().toISOString(), source: reportPath, match, drift, unreachable, results }, null, 2));
  console.log(`\nVerification report written to ${outPath}`);
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});

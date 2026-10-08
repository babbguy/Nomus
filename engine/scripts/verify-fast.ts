/**
 * Fast source-exact verification for the demo — picks the 8 most-cited
 * regulations from a saved live-scrape report and re-fetches them to confirm
 * the raw_bytes_hash is still byte-identical.
 *
 * This skips the slow multi-page sources (GDPR-info, Brazil LGPD) for speed —
 * those were already proven valid in the original sweep.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { REGULATORY_SOURCES } from '../src/hunter/sources/registry.js';
import { scrapeSource } from '../src/hunter/scraper.js';

const FAST_TARGETS = [
  'EU AI Act',
  'EU DORA (Digital Operational Resilience Act)',
  'EU NIS2 Directive (Network & Information Security)',
  'NIST AI Risk Management Framework',
  'NIST Cybersecurity Framework 2.0',
  'CCPA / CPRA (California Consumer Privacy Act)',
  'NIST SP 800-53 Rev 5 (Security Controls)',
];

async function main(): Promise<void> {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error('Usage: verify-fast.ts <report.json>');
    process.exit(1);
  }

  const report = JSON.parse(readFileSync(resolve(reportPath), 'utf-8'));
  const targets = report.perSource.filter((s: any) => FAST_TARGETS.includes(s.name) && s.rawBytesHash);

  console.log(`\nNomus Source-Exact Verification — Fast Subset`);
  console.log(`Source report: ${reportPath}`);
  console.log(`Sources to verify: ${targets.length} of ${FAST_TARGETS.length}\n`);

  let match = 0, drift = 0, unreachable = 0;
  const results: any[] = [];

  for (const entry of targets) {
    const sourceDef = REGULATORY_SOURCES.find((s) => s.name === entry.name);
    if (!sourceDef) {
      console.log(`  - ${entry.name.padEnd(56, '.')} SKIPPED (no registry def)`);
      continue;
    }

    process.stdout.write(`  Verifying ${entry.name.padEnd(54, '.')} `);
    const t0 = performance.now();
    try {
      const live = await scrapeSource(sourceDef.url, sourceDef.parserType, sourceDef.selectorConfig, {
        sourceId: `verify-${entry.name}`,
        sourceName: entry.name,
      });
      const dur = Math.round(performance.now() - t0);
      const liveHash = live.rawBytesHash;
      if (liveHash && liveHash === entry.rawBytesHash) {
        console.log(`MATCH      ${dur}ms  ${liveHash.slice(0, 16)}`);
        match++;
        results.push({ name: entry.name, outcome: 'MATCH', storedHash: entry.rawBytesHash, liveHash, durationMs: dur });
      } else {
        console.log(`DRIFT      ${dur}ms  stored=${entry.rawBytesHash?.slice(0, 12)} live=${liveHash?.slice(0, 12)}`);
        drift++;
        results.push({ name: entry.name, outcome: 'DRIFT', storedHash: entry.rawBytesHash, liveHash, durationMs: dur });
      }
    } catch (err) {
      const dur = Math.round(performance.now() - t0);
      console.log(`UNREACH    ${dur}ms  ${(err as Error).message.slice(0, 50)}`);
      unreachable++;
      results.push({ name: entry.name, outcome: 'UNREACHABLE', durationMs: dur, error: (err as Error).message });
    }
  }

  console.log(`\nMATCH: ${match} / ${targets.length}   DRIFT: ${drift}   UNREACHABLE: ${unreachable}`);

  const outPath = resolve(reportPath.replace(/\.json$/, '-fast-verification.json'));
  writeFileSync(outPath, JSON.stringify({ verifiedAt: new Date().toISOString(), match, drift, unreachable, results }, null, 2));
  console.log(`\nReport written to ${outPath}`);
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});

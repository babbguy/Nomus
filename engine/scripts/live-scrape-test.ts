/**
 * Live Scrape Test — Real-Time Source Verification
 * ==================================================
 *
 * Hits every auto-ingestion source in the registry over the live network,
 * captures full provenance, and reports per-source results. NO MOCKS, NO
 * FAKES, NO DATABASE — pure scraper isolation so we can prove the scraper
 * actually works against real sources.
 *
 * Run:
 *   npx tsx engine/scripts/live-scrape-test.ts                # all auto sources
 *   npx tsx engine/scripts/live-scrape-test.ts --names="EU AI Act,GDPR"  # subset
 *   npx tsx engine/scripts/live-scrape-test.ts --json out.json           # write report
 *   npx tsx engine/scripts/live-scrape-test.ts --raw-dir ./raw/          # dump raw bytes
 *
 * For each source, captures:
 *   - HTTP status, final URL (after redirects), content-type
 *   - SHA-256 of unmodified HTTP body + body size
 *   - Length and SHA-256 of extracted text
 *   - Validation result (valid / suspicious / rejected) + reason
 *   - Time elapsed, User-Agent that succeeded
 *
 * Exit code: 0 if every source returned valid content, 1 otherwise.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { REGULATORY_SOURCES } from '../src/hunter/sources/registry.js';
import { scrapeSource, type ScrapeResult } from '../src/hunter/scraper.js';

interface PerSourceReport {
  name: string;
  url: string;
  parserType: 'html' | 'pdf';
  ok: boolean;
  startedAt: string;
  durationMs: number;
  // Network
  httpStatus?: number;
  fetchedUrl?: string;
  contentType?: string;
  userAgent?: string;
  // Provenance
  rawBytesSize?: number;
  rawBytesHash?: string;
  // Extraction
  extractedTextLength?: number;
  extractedTextHash?: string;
  extractedWordCount?: number;
  // Validation
  contentQuality?: 'valid' | 'suspicious' | 'rejected';
  rejectionReason?: string;
  // Notification trail (tier 1/2/3 events)
  events: Array<{ tier: number; message: string }>;
  // Failure
  error?: string;
}

interface OverallReport {
  startedAt: string;
  finishedAt: string;
  totalSources: number;
  attempted: number;
  validCount: number;
  suspiciousCount: number;
  rejectedCount: number;
  errorCount: number;
  perSource: PerSourceReport[];
}

function parseArgs(): { names: Set<string> | null; jsonOut: string | null; rawDir: string | null } {
  const args = process.argv.slice(2);
  let names: Set<string> | null = null;
  let jsonOut: string | null = null;
  let rawDir: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--names=')) {
      names = new Set(a.slice('--names='.length).split(',').map((s) => s.trim()).filter(Boolean));
    } else if (a === '--json' && i + 1 < args.length) {
      jsonOut = args[++i];
    } else if (a === '--raw-dir' && i + 1 < args.length) {
      rawDir = args[++i];
    }
  }
  return { names, jsonOut, rawDir };
}

function bar(label: string, ok: boolean, detail: string): string {
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  return `${mark} ${label.padEnd(60, ' ')} ${detail}`;
}

function fmtBytes(n: number | undefined): string {
  if (n === undefined) return '-';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

async function runOne(source: typeof REGULATORY_SOURCES[number], rawDir: string | null): Promise<PerSourceReport> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const events: Array<{ tier: number; message: string }> = [];

  const report: PerSourceReport = {
    name: source.name,
    url: source.url,
    parserType: source.parserType,
    ok: false,
    startedAt,
    durationMs: 0,
    events,
  };

  try {
    const result: ScrapeResult = await scrapeSource(
      source.url,
      source.parserType,
      source.selectorConfig,
      {
        sourceId: `live-test-${source.name.replace(/\s+/g, '-')}`,
        sourceName: source.name,
        onEvent: (tier, message) => events.push({ tier, message }),
      },
    );

    report.httpStatus = result.httpStatus;
    report.fetchedUrl = result.fetchedUrl;
    report.contentType = result.contentType;
    report.userAgent = result.userAgent;
    report.rawBytesSize = result.rawBytesSize;
    report.rawBytesHash = result.rawBytesHash;
    report.extractedTextLength = result.content.length;
    report.extractedTextHash = createHash('sha256').update(result.content).digest('hex');
    report.extractedWordCount = result.wordCount;
    report.contentQuality = result.contentQuality;
    report.rejectionReason = result.rejectionReason;
    report.ok = result.contentQuality === 'valid';

    if (rawDir && result.rawContent) {
      const safeName = source.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const ext = source.parserType === 'pdf' ? '.pdf.b64' : '.html';
      writeFileSync(join(rawDir, safeName + ext), result.rawContent);
    }
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  }

  report.durationMs = Math.round(performance.now() - t0);
  return report;
}

async function main(): Promise<void> {
  const { names, jsonOut, rawDir } = parseArgs();

  if (rawDir) {
    mkdirSync(resolve(rawDir), { recursive: true });
  }

  const auto = REGULATORY_SOURCES.filter((s) => s.ingestionMode === 'auto');
  const targets = names ? auto.filter((s) => names.has(s.name)) : auto;

  if (targets.length === 0) {
    console.error('No matching auto sources to test.');
    process.exit(1);
  }

  console.log(`\n\x1b[1mNomus Live Scrape Test\x1b[0m`);
  console.log(`Sources: ${targets.length} (of ${auto.length} auto-ingestion)`);
  console.log(`Strategy: real HTTP, no mocks, no DB writes`);
  console.log(`Started:  ${new Date().toISOString()}\n`);

  const overall: OverallReport = {
    startedAt: new Date().toISOString(),
    finishedAt: '',
    totalSources: targets.length,
    attempted: 0,
    validCount: 0,
    suspiciousCount: 0,
    rejectedCount: 0,
    errorCount: 0,
    perSource: [],
  };

  for (const source of targets) {
    overall.attempted++;
    process.stdout.write(`  Scraping ${source.name.padEnd(58, '.')}\n`);
    const report = await runOne(source, rawDir);
    overall.perSource.push(report);

    if (report.error) {
      overall.errorCount++;
      console.log(bar(source.name, false, `ERROR  ${report.durationMs}ms  ${report.error.slice(0, 80)}`));
    } else if (report.contentQuality === 'valid') {
      overall.validCount++;
      const detail = `${report.httpStatus}  ${fmtBytes(report.rawBytesSize)}->${fmtBytes(report.extractedTextLength)}  ${report.extractedWordCount}w  ${report.durationMs}ms`;
      console.log(bar(source.name, true, detail));
    } else if (report.contentQuality === 'suspicious') {
      overall.suspiciousCount++;
      console.log(bar(source.name, false, `SUSPICIOUS  ${report.rejectionReason ?? ''}`));
    } else {
      overall.rejectedCount++;
      console.log(bar(source.name, false, `REJECTED  ${report.rejectionReason ?? ''}`));
    }

    // Incremental write so a partial run still leaves a usable report
    if (jsonOut) {
      overall.finishedAt = new Date().toISOString();
      writeFileSync(resolve(jsonOut), JSON.stringify(overall, null, 2));
    }
  }

  overall.finishedAt = new Date().toISOString();

  console.log('\n\x1b[1mSummary\x1b[0m');
  console.log(`  Valid:      \x1b[32m${overall.validCount}\x1b[0m / ${overall.attempted}`);
  console.log(`  Suspicious: \x1b[33m${overall.suspiciousCount}\x1b[0m`);
  console.log(`  Rejected:   \x1b[31m${overall.rejectedCount}\x1b[0m`);
  console.log(`  Errored:    \x1b[31m${overall.errorCount}\x1b[0m`);

  if (jsonOut) {
    writeFileSync(resolve(jsonOut), JSON.stringify(overall, null, 2));
    console.log(`\nReport written to ${jsonOut}`);
  }

  if (overall.validCount !== overall.attempted) {
    console.log('\n\x1b[31mFAILED:\x1b[0m not all sources returned valid content');
    process.exit(1);
  }
  console.log('\n\x1b[32mALL SOURCES VALID\x1b[0m');
}

main().catch((err) => {
  console.error('Live scrape test crashed:', err);
  process.exit(2);
});

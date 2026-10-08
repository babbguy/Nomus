#!/usr/bin/env node

import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runScan, isNomusApiError } from './scan.js';
import { formatConsoleReport, formatJsonReport } from './output/reporter.js';

/**
 * Exit codes:
 *   0 — scan completed, findings below the --fail-on threshold
 *   1 — scan completed, findings at/above the --fail-on threshold
 *   2 — unexpected error (bad config, crash)
 *   3 — Nomus API unreachable/unusable: compliance status UNKNOWN (fail closed)
 */
const EXIT_FINDINGS = 1;
const EXIT_ERROR = 2;
const EXIT_API_UNAVAILABLE = 3;

function getVersion(): string {
  try {
    const dir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(dir, '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main() {
  const args = process.argv.slice(2);
  // The scan root is the first positional argument; flags may come in any order.
  const rootDir = resolve(args.find((a) => !a.startsWith('--')) ?? '.');
  const outputFormat = args.includes('--json') ? 'json' : args.includes('--sarif') ? 'sarif' : 'console';
  const failOn = args.find((a) => a.startsWith('--fail-on='))?.split('=')[1] ?? 'critical';

  if (outputFormat === 'console') {
    console.log(`🛡️  Nomus Regulatory Applicability Engine v${getVersion()}`);
    console.log(`   Scanning: ${rootDir}\n`);
  }

  const result = await runScan({ rootDir, failOn });

  if (outputFormat === 'json') {
    console.log(JSON.stringify(formatJsonReport(result.findings), null, 2));
  } else if (outputFormat === 'sarif') {
    const { formatSarifReport } = await import('./output/sarif.js');
    console.log(JSON.stringify(formatSarifReport(result.findings, rootDir), null, 2));
  } else {
    if (result.importCount > 0) {
      console.log(`   Found ${result.fileCount} source files`);
      console.log(`   Detected ${result.importCount} AI SDK import(s)`);
      console.log(`   Capabilities: ${result.capabilities.join(', ')}\n`);
    }
    console.log(formatConsoleReport(result.findings));
  }

  if (result.status === 'fail') process.exit(EXIT_FINDINGS);
}

main().catch((err) => {
  if (isNomusApiError(err)) {
    console.error(`Nomus API unreachable — compliance status UNKNOWN; failing closed. (${err.message})`);
    process.exit(EXIT_API_UNAVAILABLE);
  }
  console.error('Nomus scan failed:', err);
  process.exit(EXIT_ERROR);
});

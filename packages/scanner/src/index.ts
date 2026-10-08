#!/usr/bin/env node

import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runScan, isNomusApiError } from './scan.js';
import { formatConsoleReport, formatJsonReport } from './output/reporter.js';
import { parseCliArgs, USAGE } from './cli-args.js';

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
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.kind === 'help') {
    console.log(USAGE);
    return;
  }
  if (parsed.kind === 'version') {
    console.log(getVersion());
    return;
  }
  if (parsed.kind === 'error') {
    console.error(`${parsed.message}

${USAGE}`);
    process.exit(EXIT_ERROR);
  }
  const { failOn, outputFormat } = parsed;
  const rootDir = resolve(parsed.rootArg);

  if (outputFormat === 'console') {
    console.log(`🛡️  Nomus Regulatory Applicability Engine v${getVersion()}`);
    console.log(`   Scanning: ${rootDir}\n`);
  }

  const result = await runScan({ rootDir, failOn });

  if (outputFormat === 'json') {
    console.log(JSON.stringify(formatJsonReport(result.findings, { failOn, rootDir }), null, 2));
  } else if (outputFormat === 'sarif') {
    const { formatSarifReport } = await import('./output/sarif.js');
    console.log(JSON.stringify(formatSarifReport(result.findings, rootDir), null, 2));
  } else {
    if (result.importCount > 0) {
      console.log(`   Found ${result.fileCount} source files`);
      console.log(`   Detected ${result.importCount} AI SDK import(s)`);
      console.log(`   Capabilities: ${result.capabilities.join(', ')}\n`);
    }
    console.log(formatConsoleReport(result.findings, { failOn, rootDir }));
  }

  if (result.status === 'fail') process.exit(EXIT_FINDINGS);
}

main().catch((err) => {
  if (isNomusApiError(err)) {
    console.error(`Nomus API unavailable — compliance status UNKNOWN; failing closed. (${err.message})`);
    process.exit(EXIT_API_UNAVAILABLE);
  }
  // Configuration and usage errors are reported by message; the stack trace is
  // only useful when debugging the scanner itself.
  console.error(`Nomus scan failed: ${err instanceof Error ? err.message : String(err)}`);
  if (process.env.NOMUS_DEBUG) console.error(err);
  process.exit(EXIT_ERROR);
});

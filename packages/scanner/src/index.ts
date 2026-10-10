#!/usr/bin/env node

import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runScan, isNomusApiError, dashboardUrlFromApiUrl, resolveCorporateBundle, bundleFailureOf, type CorporateScanOptions,
} from './scan.js';
import { formatConsoleReport, formatCorporateConsoleReport, formatCorporateJson, formatJsonReport } from './output/reporter.js';
import { parseCliArgs, USAGE } from './cli-args.js';
import { loadConfig } from './config/loader.js';

/**
 * Exit codes:
 *   0 — scan completed, findings below the --fail-on threshold
 *   1 — scan completed, findings at/above the --fail-on threshold
 *   2 — unexpected error (bad config, crash)
 *   3 — Nomus API unreachable/unusable: compliance status UNKNOWN (fail closed).
 *       This includes a corporate policy bundle that does not verify
 *       (tampered, wrong key, broken contract): its rules are never used and
 *       nothing is reported.
 *
 * A corporate policy bundle that cannot be fetched (no answer, or an HTTP
 * error) does not change the exit code by itself: the CLI says on stderr that
 * corporate policies were NOT checked (status unknown) and runs the regulatory
 * scan exactly as v1.1.0 did, which still fails closed when it needs the API.
 *
 * Corporate policy findings never change the exit code: the CLI reports
 * them; enforcement in CI is a separate step.
 */
// Exit codes are set with process.exitCode, never process.exit(): exiting
// while fetch sockets are still closing can crash Node on Windows
// (0xC0000409) and can truncate piped output. Nothing keeps the event loop
// alive after main() settles, so the process ends with the code set here.
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
    process.exitCode = EXIT_ERROR;
    return;
  }
  const { failOn, outputFormat } = parsed;
  const rootDir = resolve(parsed.rootArg);

  if (outputFormat === 'console') {
    console.log(`🛡️  Nomus Regulatory Applicability Engine v${getVersion()}`);
    console.log(`   Scanning: ${rootDir}\n`);
  }

  // Corporate policies: fetch and verify the org bundle before anything else.
  let corporate: CorporateScanOptions = { mode: 'off' };
  if (parsed.corporate) {
    const config = loadConfig(rootDir);
    try {
      const bundle = await resolveCorporateBundle({ mode: 'auto' }, config.nomus.api_url, config.nomus.api_key);
      if (bundle) corporate = { mode: 'auto', bundle };
    } catch (err) {
      // A bundle that does not verify is never used: fail closed (exit 3).
      if (bundleFailureOf(err).kind === 'invalid') throw err;
      console.error(`Warning: corporate policies were NOT checked — the policy bundle could not be fetched (${err instanceof Error ? err.message : String(err)}). Corporate policy status UNKNOWN.`);
    }
  }

  const result = await runScan({ rootDir, failOn, corporate });
  // Corporate output appears only when the org has corporate policies switched
  // on; otherwise every format is exactly the v1.1.0 report.
  const corporateOn = result.corporate.enabled;

  if (outputFormat === 'json') {
    const report = formatJsonReport(result.findings, { failOn, rootDir });
    const out = corporateOn ? { ...report, ...formatCorporateJson(result.corporateFindings, result.corporate) } : report;
    console.log(JSON.stringify(out, null, 2));
  } else if (outputFormat === 'sarif') {
    const { formatSarifReport } = await import('./output/sarif.js');
    const sarif = formatSarifReport(result.findings, rootDir);
    if (corporateOn) {
      const { formatCorporateSarifRun } = await import('./output/sarif-corporate.js');
      const dashboardUrl = dashboardUrlFromApiUrl(loadConfig(rootDir).nomus.api_url);
      (sarif.runs as unknown[]).push(formatCorporateSarifRun(result.corporateFindings, { dashboardUrl }));
    }
    console.log(JSON.stringify(sarif, null, 2));
  } else {
    if (result.importCount > 0) {
      // With corporate policies on, say what this count is: the corporate section counts other files.
      console.log(corporateOn
        ? `   Found ${result.fileCount} source files for the regulatory scan`
        : `   Found ${result.fileCount} source files`);
      console.log(`   Detected ${result.importCount} AI SDK import(s)`);
      console.log(`   Capabilities: ${result.capabilities.join(', ')}\n`);
    }
    console.log(formatConsoleReport(result.findings, { failOn, rootDir }));
    if (corporateOn) console.log(formatCorporateConsoleReport(result.corporateFindings, result.corporate));
  }

  if (result.status === 'fail') process.exitCode = EXIT_FINDINGS;
}

main().catch((err) => {
  if (isNomusApiError(err) && (err as { failure?: unknown }).failure !== undefined) {
    // The corporate policy bundle did not verify: none of its rules is used.
    console.error(`Nomus corporate policy bundle failed verification — compliance status UNKNOWN; failing closed. (${err.message})`);
    console.error('No findings were reported. Check the Nomus server you are connected to, or run with --no-corporate to scan regulatory obligations only.');
    process.exitCode = EXIT_API_UNAVAILABLE;
    return;
  }
  if (isNomusApiError(err)) {
    console.error(`Nomus API unavailable — compliance status UNKNOWN; failing closed. (${err.message})`);
    process.exitCode = EXIT_API_UNAVAILABLE;
    return;
  }
  // Configuration and usage errors are reported by message; the stack trace is
  // only useful when debugging the scanner itself.
  console.error(`Nomus scan failed: ${err instanceof Error ? err.message : String(err)}`);
  if (process.env.NOMUS_DEBUG) console.error(err);
  process.exitCode = EXIT_ERROR;
});

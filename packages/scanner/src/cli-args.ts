// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/** Command-line parsing for the nomus-scan CLI. */

export const FAIL_ON_LEVELS = ['critical', 'high', 'medium', 'low'] as const;

export const USAGE = `Usage: nomus-scan [path] [--json | --sarif] [--fail-on <critical|high|medium|low>]

  path           Directory to scan (default: current directory)
  --json         Print the report as JSON
  --sarif        Print the report as SARIF 2.1.0
  --fail-on X    Exit 1 when a finding is at or above severity X (default: critical)
  --version      Print the version
  --help         Print this help

Exit codes: 0 pass, 1 findings at/above --fail-on, 2 usage or configuration error,
3 Nomus API unreachable (status unknown, fails closed).`;

export type CliArgs =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string }
  | { kind: 'scan'; rootArg: string; failOn: string; outputFormat: 'console' | 'json' | 'sarif' };

/**
 * Parse argv (without the node and script entries). Unknown flags are usage
 * errors: `--help` used to start a scan and a typo such as `--jsno` silently
 * produced console output instead of JSON.
 */
export function parseCliArgs(args: string[]): CliArgs {
  let failOn = 'critical';
  let outputFormat: 'console' | 'json' | 'sarif' = 'console';
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { kind: 'help' };
    if (a === '--version' || a === '-v') return { kind: 'version' };
    if (a.startsWith('--fail-on=')) failOn = a.slice('--fail-on='.length);
    else if (a === '--fail-on') failOn = args[++i] ?? '';
    else if (a === '--json' || a === '--sarif') {
      const format = a === '--json' ? 'json' : 'sarif';
      if (outputFormat !== 'console' && outputFormat !== format) {
        return { kind: 'error', message: 'Use only one of --json and --sarif.' };
      }
      outputFormat = format;
    } else if (a.startsWith('-')) return { kind: 'error', message: `Unknown option "${a}".` };
    else positional.push(a);
  }
  if (!(FAIL_ON_LEVELS as readonly string[]).includes(failOn)) {
    return { kind: 'error', message: `Invalid --fail-on value "${failOn}". Use one of: ${FAIL_ON_LEVELS.join(', ')}.` };
  }
  if (positional.length > 1) {
    return { kind: 'error', message: `Expected one path, got ${positional.length}: ${positional.join(' ')}.` };
  }
  return { kind: 'scan', rootArg: positional[0] ?? '.', failOn, outputFormat };
}

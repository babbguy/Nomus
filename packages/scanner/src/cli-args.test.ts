// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { parseCliArgs } from './cli-args.js';

describe('parseCliArgs', () => {
  it('returns help instead of scanning for --help / -h', () => {
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['.', '-h'])).toEqual({ kind: 'help' });
  });

  it('returns version for --version', () => {
    expect(parseCliArgs(['--version'])).toEqual({ kind: 'version' });
  });

  it('rejects unknown flags rather than ignoring them', () => {
    const r = parseCliArgs(['.', '--jsno']);
    expect(r.kind).toBe('error');
    expect(r.kind === 'error' && r.message).toContain('--jsno');
  });

  it('rejects conflicting output formats and extra paths', () => {
    expect(parseCliArgs(['--json', '--sarif']).kind).toBe('error');
    expect(parseCliArgs(['a', 'b']).kind).toBe('error');
  });

  it('parses path, format and both --fail-on forms in any order', () => {
    expect(parseCliArgs(['--fail-on', 'high', 'src', '--json'])).toEqual({ kind: 'scan', rootArg: 'src', failOn: 'high', outputFormat: 'json' });
    expect(parseCliArgs(['--fail-on=low'])).toEqual({ kind: 'scan', rootArg: '.', failOn: 'low', outputFormat: 'console' });
    expect(parseCliArgs(['--fail-on=urgent']).kind).toBe('error');
  });
});

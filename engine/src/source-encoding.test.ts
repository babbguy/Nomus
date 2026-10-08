// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * Every source file must be valid UTF-8.
 *
 * engine/src/server/routes/tenants.ts was saved as Windows-1252: its em dash
 * (byte 0x97) reached clients as U+FFFD, so the API-key creation response read
 * "Store this key securely � it cannot be retrieved again."
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const ROOTS = ['engine/src', 'dashboard/src', 'packages'];
const EXT = /\.(ts|tsx|js|mjs|cjs|json|md|css|html|yml|yaml)$/;
const SKIP = new Set(['node_modules', 'dist', 'out', '.vite']);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (EXT.test(name)) yield full;
  }
}

describe('source encoding', () => {
  it('all source files decode as UTF-8', () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const bad: string[] = [];
    let checked = 0;
    for (const root of ROOTS) {
      for (const file of walk(join(REPO, root))) {
        checked++;
        try { decoder.decode(readFileSync(file)); } catch { bad.push(file.slice(REPO.length + 1)); }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  });
});

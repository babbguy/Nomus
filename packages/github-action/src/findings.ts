// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, relative, resolve } from 'node:path';
import type { Finding } from '@nomus/scanner';

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** The repository checkout root: GITHUB_WORKSPACE on a runner, else the cwd. */
export function repoRoot(): string {
  return process.env.GITHUB_WORKSPACE || process.cwd();
}

/**
 * A finding's file as a repository-relative POSIX path — the form GitHub
 * (reviews, check annotations, Code Scanning) and the Nomus dashboard expect.
 * The scanner reports absolute paths on the runner; uploading or commenting
 * with those leaks the runner layout and never matches a diff path.
 */
export function toRepoPath(file: string): string {
  const abs = isAbsolute(file) ? file : resolve(repoRoot(), file);
  return relative(repoRoot(), abs).replace(/\\/g, '/');
}

/** Findings ordered most severe first (stable within a severity). */
export function bySeverity<T extends Pick<Finding, 'rule'>>(findings: readonly T[]): T[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) =>
      (SEVERITY_RANK[b.f.rule.severity] ?? 0) - (SEVERITY_RANK[a.f.rule.severity] ?? 0) || a.i - b.i)
    .map(({ f }) => f);
}

/**
 * Right-side line numbers a review comment may target, from a unified-diff
 * `patch` (as returned by pulls.listFiles). GitHub rejects the whole review
 * with 422 when any comment points at a line outside the diff hunks.
 * Returns null when the patch is absent (binary or too-large files).
 */
export function commentableLines(patch: string | undefined | null): Set<number> | null {
  if (!patch) return null;
  const lines = new Set<number>();
  let next = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('-')) continue; // removed: left side only
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    lines.add(next); // added (+) or context ( ) line
    next++;
  }
  return lines;
}

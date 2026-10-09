// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The repository, branch and head commit of a workspace, read from `.git`
 * with `fs` only (design spec §10.1): no `child_process`, no git binary.
 *
 * Handles `.git` as a directory or as a `gitdir:` file (worktrees and
 * submodules, with `commondir`), `HEAD` on a branch or detached, loose and
 * packed refs, and the `origin` URL from `config`, canonicalised by the
 * scanner's `canonicalRepo()` so the editor names a repository exactly as
 * CI and the server do.
 */

export type GitContext =
  | { ok: true; repo: string; branch: string; headSha: string | null }
  | { ok: false; error: GitContextError; message: string };

export type GitContextError = 'no_repository' | 'detached_head' | 'no_origin' | 'invalid_repo' | 'unreadable';

const SHA_RE = /^[0-9a-f]{40}$/;

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The git directory and the common directory (they differ in a linked worktree). */
function locateGitDirs(root: string): { gitDir: string; commonDir: string } | null {
  const dotGit = path.join(root, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  let gitDir = dotGit;
  if (stat.isFile()) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? '');
    if (!m) return null;
    gitDir = path.resolve(root, m[1]);
  } else if (!stat.isDirectory()) {
    return null;
  }
  const common = readText(path.join(gitDir, 'commondir'))?.trim();
  return { gitDir, commonDir: common ? path.resolve(gitDir, common) : gitDir };
}

/** The SHA a branch points at, from the loose ref or packed-refs; null for an unborn branch. */
function resolveBranchSha(gitDir: string, commonDir: string, branch: string): string | null {
  for (const dir of [gitDir, commonDir]) {
    const loose = readText(path.join(dir, 'refs', 'heads', ...branch.split('/')))?.trim();
    if (loose && SHA_RE.test(loose)) return loose;
  }
  const packed = readText(path.join(commonDir, 'packed-refs')) ?? '';
  for (const line of packed.split(/\r?\n/)) {
    const m = /^([0-9a-f]{40}) refs\/heads\/(.+)$/.exec(line.trim());
    if (m && m[2] === branch) return m[1];
  }
  return null;
}

/** The `url` of `[remote "origin"]` in a git config file. */
export function originUrlFromConfig(config: string): string | null {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const m = /^url\s*=\s*(.+)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

export async function readGitContext(root: string): Promise<GitContext> {
  const dirs = locateGitDirs(root);
  if (!dirs) return { ok: false, error: 'no_repository', message: 'The workspace folder is not a git repository (no .git).' };
  const head = readText(path.join(dirs.gitDir, 'HEAD'))?.trim();
  if (!head) return { ok: false, error: 'unreadable', message: 'The repository HEAD could not be read.' };
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (!ref) {
    return SHA_RE.test(head)
      ? { ok: false, error: 'detached_head', message: `HEAD is detached at ${head.slice(0, 12)}; check out a branch.` }
      : { ok: false, error: 'unreadable', message: 'The repository HEAD is not a branch or a commit.' };
  }
  const branch = ref[1];
  const url = originUrlFromConfig(readText(path.join(dirs.commonDir, 'config')) ?? '');
  if (!url) return { ok: false, error: 'no_origin', message: 'The repository has no "origin" remote.' };
  // A remote on the local filesystem is not a hosted repository (canonicalRepo would read its first segment as a host).
  if (/^(?:\/|\.{1,2}[\\/]|[A-Za-z]:[\\/]|file:)/.test(url)) {
    return { ok: false, error: 'invalid_repo', message: 'The "origin" remote is a local path, not a hosted repository.' };
  }
  // Loaded on first use: the corporate library pulls in the detectors.
  const { canonicalRepo } = await import('@nomus/scanner/corporate');
  const repo = canonicalRepo(url);
  if (!repo) return { ok: false, error: 'invalid_repo', message: 'The "origin" remote is not a recognised repository URL.' };
  return { ok: true, repo, branch, headSha: resolveBranchSha(dirs.gitDir, dirs.commonDir, branch) };
}

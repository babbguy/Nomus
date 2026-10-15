import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readGitContext, originUrlFromConfig } from '../src/cpg/git-context';

const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SHA2 = '9f2c1e0d8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d';
const CONFIG = '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/someone/else.git\n[remote "origin"]\n\turl = git@github.com:Acme/Payments.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'nomus-git-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe('readGitContext (fs only, design spec §10.1)', () => {
  it('a .git directory on a branch with a loose ref', async () => {
    const root = repo({ '.git/HEAD': 'ref: refs/heads/feat/x\n', '.git/config': CONFIG, '.git/refs/heads/feat/x': `${SHA}\n` });
    expect(await readGitContext(root)).toEqual({ ok: true, repo: 'acme/payments', branch: 'feat/x', headSha: SHA });
  });

  it('a branch only in packed-refs', async () => {
    const root = repo({ '.git/HEAD': 'ref: refs/heads/main\n', '.git/config': CONFIG, '.git/packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${SHA2} refs/heads/dev\n${SHA} refs/heads/main\n` });
    expect(await readGitContext(root)).toEqual({ ok: true, repo: 'acme/payments', branch: 'main', headSha: SHA });
  });

  it('a linked worktree: a .git file pointing at gitdir, with commondir', async () => {
    const root = repo({
      'main/.git/config': CONFIG,
      'main/.git/refs/heads/feat/wt': `${SHA2}\n`,
      'main/.git/worktrees/wt/HEAD': 'ref: refs/heads/feat/wt\n',
      'main/.git/worktrees/wt/commondir': '../..\n',
    });
    const wt = join(root, 'wt');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), `gitdir: ${join(root, 'main', '.git', 'worktrees', 'wt')}\n`);
    expect(await readGitContext(wt)).toEqual({ ok: true, repo: 'acme/payments', branch: 'feat/wt', headSha: SHA2 });
  });

  it('an unborn branch has no head SHA', async () => {
    const root = repo({ '.git/HEAD': 'ref: refs/heads/main\n', '.git/config': CONFIG });
    expect(await readGitContext(root)).toEqual({ ok: true, repo: 'acme/payments', branch: 'main', headSha: null });
  });

  it('detached HEAD, no origin, an unrecognised origin and no repository are errors that say why', async () => {
    const detached = await readGitContext(repo({ '.git/HEAD': `${SHA}\n`, '.git/config': CONFIG }));
    expect(detached).toMatchObject({ ok: false, error: 'detached_head' });
    const noOrigin = await readGitContext(repo({ '.git/HEAD': 'ref: refs/heads/main\n', '.git/config': '[core]\n\tbare = false\n' }));
    expect(noOrigin).toMatchObject({ ok: false, error: 'no_origin' });
    const badOrigin = await readGitContext(repo({ '.git/HEAD': 'ref: refs/heads/main\n', '.git/config': '[remote "origin"]\n\turl = /srv/git/payments\n' }));
    expect(badOrigin).toMatchObject({ ok: false, error: 'invalid_repo' });
    const none = await readGitContext(repo({ 'src/a.ts': 'x' }));
    expect(none).toMatchObject({ ok: false, error: 'no_repository' });
    for (const r of [detached, noOrigin, badOrigin, none]) expect(!r.ok && r.message.length > 10).toBe(true);
  });

  it('originUrlFromConfig reads only [remote "origin"]', () => {
    expect(originUrlFromConfig(CONFIG)).toBe('git@github.com:Acme/Payments.git');
    expect(originUrlFromConfig('[remote "upstream"]\n\turl = x\n')).toBeNull();
  });
});

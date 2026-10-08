import { logger } from '../logger.js';
import { getInstallationToken } from './token-manager.js';

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs',
  '.py',
  '.java',
  '.go',
]);

/**
 * Fetch all source files from a GitHub repo via the Contents API.
 * Returns a Map of filePath → content.
 */
export async function fetchRepoSourceFiles(
  installationId: number,
  owner: string,
  repo: string,
  sha: string,
): Promise<Map<string, string>> {
  const token = await getInstallationToken(installationId);
  const files = new Map<string, string>();

  // Get the full file tree
  const treeResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!treeResponse.ok) {
    throw new Error(`Failed to fetch tree: ${treeResponse.status}`);
  }

  const tree = await treeResponse.json() as { tree: TreeEntry[]; truncated: boolean };

  if (tree.truncated) {
    logger.warn({ owner, repo, sha }, 'Tree was truncated — very large repo, some files may be missed');
  }

  // Filter to source files, skip ignored patterns
  const sourceEntries = tree.tree.filter((entry) => {
    if (entry.type !== 'blob') return false;
    if (entry.path.includes('node_modules/')) return false;
    if (entry.path.includes('dist/')) return false;
    if (entry.path.includes('.git/')) return false;
    if (entry.path.includes('vendor/')) return false;
    if (entry.path.includes('__pycache__/')) return false;
    if (entry.path.match(/\.(test|spec)\.[^.]+$/)) return false;

    const ext = entry.path.match(/\.[^.]+$/)?.[0];
    return ext ? SOURCE_EXTENSIONS.has(ext) : false;
  });

  // Fetch content for each source file (batch via Promise.allSettled)
  const BATCH_SIZE = 20;
  for (let i = 0; i < sourceEntries.length; i += BATCH_SIZE) {
    const batch = sourceEntries.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (entry) => {
        const contentResponse = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${entry.path}?ref=${sha}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github.raw+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          },
        );

        if (!contentResponse.ok) return null;
        const content = await contentResponse.text();
        return { path: entry.path, content };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        files.set(result.value.path, result.value.content);
      }
    }
  }

  logger.info({ owner, repo, sha, fileCount: files.size }, 'Fetched source files from GitHub');
  return files;
}

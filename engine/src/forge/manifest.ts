/**
 * Manifest Reader/Writer
 *
 * Manages metadata.json files for each document in the regulations directory.
 * Tracks what has been fetched, content hashes for dedup, and source metadata.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import type { DocumentManifest, HarvestSource } from './types.js';

const MANIFEST_FILE = 'metadata.json';
const SUPPORTED_EXTENSIONS = new Set(['.html', '.htm', '.pdf', '.md']);

/**
 * Resolve the regulations directory path from env or default.
 */
export function getRegulationsDir(): string {
  return process.env.FORGE_REGULATIONS_DIR || join(process.cwd(), 'data', 'regulations');
}

/**
 * Ensure the regulations directory exists.
 */
export function ensureRegulationsDir(): string {
  const dir = getRegulationsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    logger.info({ dir }, 'Created regulations directory');
  }
  return dir;
}

/**
 * Generate a filesystem-safe slug from a name.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * Get the document directory path for a given jurisdiction and source name.
 */
export function getDocumentDir(jurisdiction: string, sourceName: string): string {
  const regDir = getRegulationsDir();
  const jurisSlug = slugify(jurisdiction);
  const sourceSlug = slugify(sourceName);
  return join(regDir, jurisSlug, sourceSlug);
}

/**
 * Write a manifest file for a document.
 */
export function writeManifest(docDir: string, manifest: DocumentManifest): void {
  if (!existsSync(docDir)) {
    mkdirSync(docDir, { recursive: true });
  }
  const path = join(docDir, MANIFEST_FILE);
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf-8');
  logger.info({ path, name: manifest.name }, 'Wrote document manifest');
}

/**
 * Read a manifest file from a document directory.
 * Returns null if the manifest doesn't exist or is invalid.
 */
export function readManifest(docDir: string): DocumentManifest | null {
  const path = join(docDir, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as DocumentManifest;
  } catch (err) {
    logger.warn({ path, error: (err as Error).message }, 'Failed to parse manifest');
    return null;
  }
}

/**
 * Compute SHA-256 hash of file content.
 */
export function hashFileContent(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Compute SHA-256 hash of a string.
 */
export function hashString(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Find the primary document file in a document directory.
 * Returns the path to the first supported file found.
 */
export function findDocumentFile(docDir: string): string | null {
  if (!existsSync(docDir)) return null;
  const entries = readdirSync(docDir);
  // Prefer source.* files, then any supported extension
  for (const name of ['source.html', 'source.htm', 'source.pdf', 'source.md']) {
    if (entries.includes(name)) return join(docDir, name);
  }
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (SUPPORTED_EXTENSIONS.has(ext) && entry !== MANIFEST_FILE) {
      return join(docDir, entry);
    }
  }
  return null;
}

/**
 * Detect file type from extension.
 */
export function detectFileType(filePath: string): 'html' | 'pdf' | 'md' {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.md') return 'md';
  return 'html';
}

/**
 * Scan the regulations directory and return all document directories
 * with their manifests and document files.
 */
export function scanRegulationsDir(): Array<{
  docDir: string;
  manifest: DocumentManifest | null;
  documentFile: string | null;
  jurisdiction: string;
  sourceName: string;
}> {
  const regDir = getRegulationsDir();
  if (!existsSync(regDir)) return [];

  const results: Array<{
    docDir: string;
    manifest: DocumentManifest | null;
    documentFile: string | null;
    jurisdiction: string;
    sourceName: string;
  }> = [];

  // Walk two levels: /{jurisdiction}/{source-slug}/
  let jurisdictionDirs: string[];
  try {
    jurisdictionDirs = readdirSync(regDir).filter((entry) => {
      const full = join(regDir, entry);
      return statSync(full).isDirectory();
    });
  } catch {
    return [];
  }

  for (const jurisDir of jurisdictionDirs) {
    const jurisPath = join(regDir, jurisDir);
    let sourceDirs: string[];
    try {
      sourceDirs = readdirSync(jurisPath).filter((entry) => {
        const full = join(jurisPath, entry);
        return statSync(full).isDirectory();
      });
    } catch {
      continue;
    }

    for (const sourceDir of sourceDirs) {
      const docDir = join(jurisPath, sourceDir);
      const manifest = readManifest(docDir);
      const documentFile = findDocumentFile(docDir);
      results.push({
        docDir,
        manifest,
        documentFile,
        jurisdiction: manifest?.jurisdiction ?? jurisDir.toUpperCase().replace(/-/g, '_'),
        sourceName: manifest?.name ?? sourceDir.replace(/-/g, ' '),
      });
    }
  }

  return results;
}

/**
 * Check if a document has already been processed (by content hash).
 */
export function isAlreadyFetched(docDir: string, contentHash: string): boolean {
  const manifest = readManifest(docDir);
  return manifest?.contentHash === contentHash;
}

/**
 * Save document content to a document directory.
 * Returns the file path where content was saved.
 */
export function saveDocumentContent(
  docDir: string,
  content: string | Buffer,
  fileType: 'html' | 'pdf' | 'md',
): string {
  if (!existsSync(docDir)) {
    mkdirSync(docDir, { recursive: true });
  }
  const ext = fileType === 'pdf' ? '.pdf' : fileType === 'md' ? '.md' : '.html';
  const filePath = join(docDir, `source${ext}`);

  if (Buffer.isBuffer(content)) {
    writeFileSync(filePath, content);
  } else {
    writeFileSync(filePath, content, 'utf-8');
  }

  logger.info({ path: filePath, size: Buffer.isBuffer(content) ? content.length : content.length },
    'Saved document content');
  return filePath;
}

/**
 * Content Cache — Local fallback for when live sources are blocked.
 *
 * Priority: Live URL -> Content Cache -> Error
 *
 * Cache is stored in data/content-cache/{sourceId}.html (or .pdf)
 * Populated automatically on successful scrapes.
 * Used as fallback when live source is unreachable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../logger.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CacheMetadata {
  cachedAt: string;
  contentHash: string;
  sourceUrl: string;
  wordCount: number;
}

export interface CacheEntry {
  sourceId: string;
  content: string;
  metadata: CacheMetadata;
}

export interface CacheSummaryItem {
  sourceId: string;
  parserType: string;
  sizeBytes: number;
  ageHours: number;
  cachedAt: string;
  contentHash: string;
  sourceUrl: string;
  wordCount: number;
}

// ─── Cache Directory ────────────────────────────────────────────
//
// Resolved lazily from process.cwd() each call so tests (and any future
// chdir-aware deployments) can redirect the cache location without a
// module reload. Override with NOMUS_CONTENT_CACHE_DIR for explicit
// out-of-tree caching (e.g. /var/lib/nomus/cache).

function getCacheDir(): string {
  return process.env.NOMUS_CONTENT_CACHE_DIR
    ?? join(process.cwd(), 'data', 'content-cache');
}

function ensureCacheDir(): void {
  const dir = getCacheDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function getContentPath(sourceId: string, parserType: string): string {
  const ext = parserType === 'pdf' ? 'pdf' : 'html';
  return join(getCacheDir(), `${sourceId}.${ext}`);
}

function getMetaPath(sourceId: string): string {
  return join(getCacheDir(), `${sourceId}.meta.json`);
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Retrieve cached content for a source.
 * Returns the content string if available, null otherwise.
 */
export function getCachedContent(sourceId: string): CacheEntry | null {
  ensureCacheDir();

  const metaPath = getMetaPath(sourceId);
  if (!existsSync(metaPath)) {
    return null;
  }

  try {
    const metaRaw = readFileSync(metaPath, 'utf-8');
    const metadata: CacheMetadata = JSON.parse(metaRaw);

    // Find the content file (html or pdf)
    const htmlPath = join(getCacheDir(), `${sourceId}.html`);
    const pdfPath = join(getCacheDir(), `${sourceId}.pdf`);
    let contentPath: string | null = null;

    if (existsSync(htmlPath)) contentPath = htmlPath;
    else if (existsSync(pdfPath)) contentPath = pdfPath;

    if (!contentPath) {
      return null;
    }

    const content = readFileSync(contentPath, 'utf-8');
    return { sourceId, content, metadata };
  } catch (err) {
    logger.error({ sourceId, error: err instanceof Error ? err.message : String(err) },
      'Failed to read content cache');
    return null;
  }
}

/**
 * Save content to the local cache.
 * Creates a content file and a metadata JSON sidecar.
 */
export function saveCacheContent(sourceId: string, content: string, parserType: string, sourceUrl?: string): void {
  ensureCacheDir();

  const contentPath = getContentPath(sourceId, parserType);
  const metaPath = getMetaPath(sourceId);

  const contentHash = createHash('sha256').update(content).digest('hex');
  const wordCount = content.split(/\s+/).filter((w) => w.length > 0).length;
  const now = new Date().toISOString();

  const metadata: CacheMetadata = {
    cachedAt: now,
    contentHash,
    sourceUrl: sourceUrl ?? '',
    wordCount,
  };

  try {
    writeFileSync(contentPath, content, 'utf-8');
    writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');

    logger.info({ sourceId, parserType, sizeBytes: content.length, wordCount },
      'Content cached successfully');
  } catch (err) {
    logger.error({ sourceId, error: err instanceof Error ? err.message : String(err) },
      'Failed to save content cache');
  }
}

/**
 * Check if cached content exists for a source.
 */
export function hasCachedContent(sourceId: string): boolean {
  ensureCacheDir();
  return existsSync(getMetaPath(sourceId));
}

/**
 * Get the age of cached content in hours.
 * Returns null if no cache exists.
 */
export function getCacheAge(sourceId: string): number | null {
  ensureCacheDir();

  const metaPath = getMetaPath(sourceId);
  if (!existsSync(metaPath)) {
    return null;
  }

  try {
    const metaRaw = readFileSync(metaPath, 'utf-8');
    const metadata: CacheMetadata = JSON.parse(metaRaw);
    const cachedAt = new Date(metadata.cachedAt).getTime();
    const ageMs = Date.now() - cachedAt;
    return Math.round((ageMs / (1000 * 60 * 60)) * 100) / 100; // round to 2 decimals
  } catch {
    return null;
  }
}

/**
 * Delete cached content for a source.
 */
export function clearCache(sourceId: string): boolean {
  ensureCacheDir();

  let deleted = false;

  const metaPath = getMetaPath(sourceId);
  const htmlPath = join(getCacheDir(), `${sourceId}.html`);
  const pdfPath = join(getCacheDir(), `${sourceId}.pdf`);

  if (existsSync(metaPath)) { unlinkSync(metaPath); deleted = true; }
  if (existsSync(htmlPath)) { unlinkSync(htmlPath); deleted = true; }
  if (existsSync(pdfPath)) { unlinkSync(pdfPath); deleted = true; }

  if (deleted) {
    logger.info({ sourceId }, 'Content cache cleared');
  }

  return deleted;
}

/**
 * Get a summary of all cached sources with sizes and ages.
 */
export function getCacheSummary(): CacheSummaryItem[] {
  ensureCacheDir();

  const items: CacheSummaryItem[] = [];

  let files: string[];
  try {
    files = readdirSync(getCacheDir());
  } catch {
    return items;
  }

  // Find all .meta.json files and build summary
  const metaFiles = files.filter((f) => f.endsWith('.meta.json'));

  for (const metaFile of metaFiles) {
    const sourceId = metaFile.replace('.meta.json', '');
    const metaPath = join(getCacheDir(), metaFile);

    try {
      const metaRaw = readFileSync(metaPath, 'utf-8');
      const metadata: CacheMetadata = JSON.parse(metaRaw);

      // Find associated content file
      const htmlPath = join(getCacheDir(), `${sourceId}.html`);
      const pdfPath = join(getCacheDir(), `${sourceId}.pdf`);
      let contentPath: string | null = null;
      let parserType = 'html';

      if (existsSync(htmlPath)) {
        contentPath = htmlPath;
        parserType = 'html';
      } else if (existsSync(pdfPath)) {
        contentPath = pdfPath;
        parserType = 'pdf';
      }

      const sizeBytes = contentPath ? statSync(contentPath).size : 0;
      const cachedAt = new Date(metadata.cachedAt).getTime();
      const ageHours = Math.round(((Date.now() - cachedAt) / (1000 * 60 * 60)) * 100) / 100;

      items.push({
        sourceId,
        parserType,
        sizeBytes,
        ageHours,
        cachedAt: metadata.cachedAt,
        contentHash: metadata.contentHash,
        sourceUrl: metadata.sourceUrl,
        wordCount: metadata.wordCount,
      });
    } catch {
      // Skip malformed cache entries
    }
  }

  return items;
}

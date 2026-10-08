import type { DocumentQuality } from './quality-scorer.js';
import { logger } from '../logger.js';

export interface SemanticChunk {
  content: string;
  breadcrumb: string;     // "Part II > Chapter 3 > Article 9"
  index: number;
  totalChunks: number;
  estimatedTokens: number;
  strategy: 'semantic' | 'window' | 'llm-assisted';
}

/** Target tokens per chunk — larger chunks = fewer LLM calls = lower cost */
const TARGET_TOKENS = 8000;
/** Max tokens per chunk */
const MAX_TOKENS = 12000;
/** Chars per token estimate */
const CHARS_PER_TOKEN = 3.5;
/** Overlap sentences between consecutive chunks */
const OVERLAP_SENTENCES = 1;

/**
 * Adaptively chunk a document based on its quality grade.
 * Grade A/B: heading-aware semantic splits
 * Grade C/D: sliding window with overlap
 */
export function semanticChunk(content: string, quality: DocumentQuality): SemanticChunk[] {
  const strategy = quality.overallGrade <= 'B' && quality.headingCount >= 3
    ? 'semantic'
    : 'window';

  logger.info({
    strategy,
    grade: quality.overallGrade,
    headings: quality.headingCount,
    contentLength: content.length,
  }, `Chunking with ${strategy} strategy`);

  const chunks = strategy === 'semantic'
    ? headingAwareChunk(content)
    : slidingWindowChunk(content);

  // Set total count on each chunk
  const total = chunks.length;
  return chunks.map((c, i) => ({ ...c, index: i, totalChunks: total }));
}

/**
 * Grade A/B: Split on markdown heading boundaries.
 * Each chunk carries its breadcrumb path for context.
 */
function headingAwareChunk(content: string): SemanticChunk[] {
  const lines = content.split('\n');
  const chunks: SemanticChunk[] = [];

  let currentChunk: string[] = [];
  let currentBreadcrumb: string[] = [];
  let currentTokens = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,5})\s+(.+)/);

    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      // If current chunk is big enough, flush it
      if (currentTokens > TARGET_TOKENS) {
        flushChunk(chunks, currentChunk, currentBreadcrumb);
        currentChunk = [];
        currentTokens = 0;
      }

      // Update breadcrumb at the appropriate level
      currentBreadcrumb = currentBreadcrumb.slice(0, level - 1);
      currentBreadcrumb[level - 1] = title;
    }

    currentChunk.push(line);
    currentTokens += Math.ceil(line.length / CHARS_PER_TOKEN);

    // Force flush if exceeding max
    if (currentTokens > MAX_TOKENS) {
      flushChunk(chunks, currentChunk, currentBreadcrumb);
      currentChunk = [];
      currentTokens = 0;
    }
  }

  // Flush remaining
  if (currentChunk.length > 0) {
    flushChunk(chunks, currentChunk, currentBreadcrumb);
  }

  return chunks;
}

function flushChunk(chunks: SemanticChunk[], lines: string[], breadcrumb: string[]): void {
  const content = lines.join('\n').trim();
  if (content.length < 50) return; // Skip tiny fragments

  chunks.push({
    content,
    breadcrumb: breadcrumb.filter(Boolean).join(' > ') || 'Root',
    index: 0,
    totalChunks: 0,
    estimatedTokens: Math.ceil(content.length / CHARS_PER_TOKEN),
    strategy: 'semantic',
  });
}

/**
 * Grade C/D: Fixed-size sliding window with overlap.
 * Simple, reliable, never fails.
 */
function slidingWindowChunk(content: string): SemanticChunk[] {
  const maxChars = TARGET_TOKENS * CHARS_PER_TOKEN;
  const overlapChars = Math.floor(maxChars * 0.15); // 15% overlap
  const chunks: SemanticChunk[] = [];

  // Split on paragraph boundaries for clean breaks
  const paragraphs = content.split(/\n\n+/);
  let current = '';
  let chunkIndex = 0;

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current.length > 0) {
      chunks.push({
        content: current.trim(),
        breadcrumb: `Window ${chunkIndex + 1}`,
        index: chunkIndex,
        totalChunks: 0,
        estimatedTokens: Math.ceil(current.length / CHARS_PER_TOKEN),
        strategy: 'window',
      });

      // Start next chunk with overlap from end of current
      const sentences = current.split(/(?<=[.!?])\s+/);
      const overlapText = sentences.slice(-OVERLAP_SENTENCES).join(' ');
      current = overlapText + '\n\n' + para;
      chunkIndex++;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }

  // Flush remaining
  if (current.trim().length > 50) {
    chunks.push({
      content: current.trim(),
      breadcrumb: `Window ${chunkIndex + 1}`,
      index: chunkIndex,
      totalChunks: 0,
      estimatedTokens: Math.ceil(current.length / CHARS_PER_TOKEN),
      strategy: 'window',
    });
  }

  return chunks;
}

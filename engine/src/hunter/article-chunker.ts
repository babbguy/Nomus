/**
 * Article-Boundary Chunker — Precision Mode
 * ==========================================
 * Splits regulatory documents at legal article boundaries so every
 * extracted requirement traces back to its exact source location.
 *
 * Supports:
 *   - Markdown headings (# ## ### from HTML parser output)
 *   - EU/UK legal patterns: Article X, Recital X, Section X, Chapter X
 *   - US legal patterns: Section X, § X, Part X
 *   - Numbered sections: 1.2.3 style
 *
 * Falls back to enhanced window chunking if no article structure detected,
 * but window chunks still try to identify the nearest article reference.
 */

import { logger } from '../logger.js';

export interface ArticleChunk {
  content: string;
  /** Full legal reference path: "Title III > Chapter 2 > Article 9" */
  breadcrumb: string;
  /** Specific article/section reference: "Article 9" or "Section 3.2" */
  articleRef: string;
  /** Source document location for bidirectional mapping */
  sourceLocation: {
    startLine: number;
    endLine: number;
    startChar: number;
    endChar: number;
  };
  index: number;
  totalChunks: number;
  estimatedTokens: number;
  strategy: 'article' | 'heading' | 'window';
}

/** Max tokens per chunk — articles can be long */
const MAX_TOKENS = 14000;
/** Target tokens — prefer smaller for better LLM extraction */
const TARGET_TOKENS = 8000;
/** Chars per token estimate */
const CHARS_PER_TOKEN = 3.5;

// ─── Article Detection Patterns ──────────────────────────────────

/** Patterns that indicate an article/section boundary */
const ARTICLE_PATTERNS = [
  // EU/UK style: "Article 1", "Article 1(2)", "Recital (1)"
  /^#{1,5}\s*(Article\s+\d+[a-z]?(?:\(\d+\))?)/i,
  /^(Article\s+\d+[a-z]?(?:\(\d+\))?)\s*$/im,
  /^(Article\s+\d+[a-z]?)\s*[-–—]/im,

  // Recitals
  /^#{1,5}\s*(Recital\s*\(?\d+\)?)/i,
  /^\((\d+)\)\s+(?=[A-Z])/m,  // EUR-Lex recital style: "(1) Whereas..."

  // Chapter / Title / Part / Section (structural)
  /^#{1,5}\s*((?:Title|Chapter|Part|Section|TITLE|CHAPTER|PART|SECTION)\s+[IVXLCDM\d]+[a-z]?)/i,

  // US style: "Section 1", "§ 1", "Sec. 1"
  /^#{1,5}\s*((?:Section|Sec\.|§)\s*\d+[\w.]*)/i,
  /^((?:Section|Sec\.|§)\s*\d+[\w.]*)\s*[-–—.]/im,

  // Numbered sections: "1.2.3" style
  /^#{1,5}\s*(\d+\.\d+(?:\.\d+)?)\s/,

  // Annex
  /^#{1,5}\s*(Annex\s+[IVXLCDM\d]+[a-z]?)/i,
];

/** Structural hierarchy patterns (used for breadcrumb building) */
const HIERARCHY_PATTERNS: Array<{ pattern: RegExp; level: number; label: string }> = [
  { pattern: /^#{1,2}\s*(Title\s+[IVXLCDM\d]+)/i, level: 1, label: 'Title' },
  { pattern: /^#{1,3}\s*((?:CHAPTER|Chapter)\s+[IVXLCDM\d]+)/i, level: 2, label: 'Chapter' },
  { pattern: /^#{1,4}\s*(Section\s+\d+)/i, level: 3, label: 'Section' },
  { pattern: /^#{1,5}\s*(Article\s+\d+[a-z]?)/i, level: 4, label: 'Article' },
  { pattern: /^#{1,5}\s*(Annex\s+[IVXLCDM\d]+)/i, level: 2, label: 'Annex' },
  // Plain text versions (no markdown heading)
  { pattern: /^(Title\s+[IVXLCDM\d]+)\s*$/im, level: 1, label: 'Title' },
  { pattern: /^((?:CHAPTER|Chapter)\s+[IVXLCDM\d]+)/m, level: 2, label: 'Chapter' },
  { pattern: /^(Article\s+\d+[a-z]?)\s*$/im, level: 4, label: 'Article' },
];

// ─── Main Entry Point ────────────────────────────────────────────

/**
 * Split a regulatory document into article-boundary chunks.
 * Every chunk carries its exact legal reference for traceability.
 */
export function articleChunk(content: string): ArticleChunk[] {
  const lines = content.split('\n');

  // First pass: detect all article boundaries
  const boundaries = detectBoundaries(lines);

  if (boundaries.length >= 3) {
    // Enough structure found — use article-aware chunking
    const chunks = buildArticleChunks(lines, boundaries);
    logger.info({
      strategy: 'article',
      boundaries: boundaries.length,
      chunks: chunks.length,
    }, `Article chunker: ${boundaries.length} boundaries → ${chunks.length} chunks`);
    return finalizeChunks(chunks);
  }

  // Not enough article structure — try heading-based
  const headings = lines.filter((l) => /^#{1,5}\s/.test(l)).length;
  if (headings >= 3) {
    const chunks = headingChunk(lines);
    logger.info({
      strategy: 'heading',
      headings,
      chunks: chunks.length,
    }, `Article chunker: heading fallback with ${headings} headings → ${chunks.length} chunks`);
    return finalizeChunks(chunks);
  }

  // Last resort: enhanced window chunking with article reference detection
  const chunks = enhancedWindowChunk(content, lines);
  logger.info({
    strategy: 'window',
    chunks: chunks.length,
  }, `Article chunker: window fallback → ${chunks.length} chunks`);
  return finalizeChunks(chunks);
}

// ─── Boundary Detection ──────────────────────────────────────────

interface Boundary {
  lineIndex: number;
  charOffset: number;
  ref: string;       // "Article 9" or "Section 3.2"
  level: number;     // hierarchy depth: 1=Title, 2=Chapter, 3=Section, 4=Article
  label: string;     // "Title", "Chapter", "Section", "Article"
}

function detectBoundaries(lines: string[]): Boundary[] {
  const boundaries: Boundary[] = [];
  let charOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check hierarchy patterns first (more specific)
    for (const hp of HIERARCHY_PATTERNS) {
      const match = line.match(hp.pattern);
      if (match) {
        boundaries.push({
          lineIndex: i,
          charOffset,
          ref: match[1].trim(),
          level: hp.level,
          label: hp.label,
        });
        break; // Only match one pattern per line
      }
    }

    // If no hierarchy match, check article patterns
    if (!boundaries.some((b) => b.lineIndex === i)) {
      for (const ap of ARTICLE_PATTERNS) {
        const match = line.match(ap);
        if (match) {
          boundaries.push({
            lineIndex: i,
            charOffset,
            ref: match[1]?.trim() || `Line ${i}`,
            level: 4,
            label: 'Article',
          });
          break;
        }
      }
    }

    charOffset += line.length + 1; // +1 for \n
  }

  return boundaries;
}

// ─── Article-Aware Chunking ──────────────────────────────────────

function buildArticleChunks(lines: string[], boundaries: Boundary[]): ArticleChunk[] {
  const chunks: ArticleChunk[] = [];
  const hierarchyStack: string[] = []; // Current breadcrumb path

  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    const nextBoundary = boundaries[i + 1];
    const startLine = boundary.lineIndex;
    const endLine = nextBoundary ? nextBoundary.lineIndex - 1 : lines.length - 1;

    // Update hierarchy stack based on level
    while (hierarchyStack.length >= boundary.level) {
      hierarchyStack.pop();
    }
    hierarchyStack.push(boundary.ref);

    // Extract the content for this article/section
    const sectionLines = lines.slice(startLine, endLine + 1);
    const content = sectionLines.join('\n').trim();

    if (content.length < 30) continue; // Skip empty sections

    const estimatedTokens = Math.ceil(content.length / CHARS_PER_TOKEN);

    // If section is too large, split it into sub-chunks
    if (estimatedTokens > MAX_TOKENS) {
      const subChunks = splitLargeArticle(content, boundary, hierarchyStack, startLine);
      chunks.push(...subChunks);
    } else {
      chunks.push({
        content,
        breadcrumb: hierarchyStack.join(' > '),
        articleRef: boundary.ref,
        sourceLocation: {
          startLine,
          endLine,
          startChar: boundary.charOffset,
          endChar: boundary.charOffset + content.length,
        },
        index: 0,
        totalChunks: 0,
        estimatedTokens,
        strategy: 'article',
      });
    }
  }

  // Handle content before the first boundary (preamble/recitals)
  if (boundaries.length > 0 && boundaries[0].lineIndex > 0) {
    const preamble = lines.slice(0, boundaries[0].lineIndex).join('\n').trim();
    if (preamble.length > 100) {
      chunks.unshift({
        content: preamble,
        breadcrumb: 'Preamble',
        articleRef: 'Preamble',
        sourceLocation: { startLine: 0, endLine: boundaries[0].lineIndex - 1, startChar: 0, endChar: preamble.length },
        index: 0,
        totalChunks: 0,
        estimatedTokens: Math.ceil(preamble.length / CHARS_PER_TOKEN),
        strategy: 'article',
      });
    }
  }

  return chunks;
}

/**
 * Split a large article into sub-chunks while preserving the article reference.
 * Splits on paragraph boundaries within the article.
 */
function splitLargeArticle(
  content: string,
  boundary: Boundary,
  hierarchyStack: string[],
  startLine: number,
): ArticleChunk[] {
  const paragraphs = content.split(/\n\n+/);
  const subChunks: ArticleChunk[] = [];
  let current = '';
  let partNum = 1;
  let charPos = boundary.charOffset;

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > TARGET_TOKENS * CHARS_PER_TOKEN && current.length > 100) {
      subChunks.push({
        content: current.trim(),
        breadcrumb: `${hierarchyStack.join(' > ')} (Part ${partNum})`,
        articleRef: `${boundary.ref} (Part ${partNum})`,
        sourceLocation: {
          startLine,
          endLine: startLine, // approximate
          startChar: charPos,
          endChar: charPos + current.length,
        },
        index: 0,
        totalChunks: 0,
        estimatedTokens: Math.ceil(current.length / CHARS_PER_TOKEN),
        strategy: 'article',
      });
      charPos += current.length;
      current = para;
      partNum++;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }

  if (current.trim().length > 50) {
    subChunks.push({
      content: current.trim(),
      breadcrumb: partNum > 1 ? `${hierarchyStack.join(' > ')} (Part ${partNum})` : hierarchyStack.join(' > '),
      articleRef: partNum > 1 ? `${boundary.ref} (Part ${partNum})` : boundary.ref,
      sourceLocation: {
        startLine,
        endLine: startLine,
        startChar: charPos,
        endChar: charPos + current.length,
      },
      index: 0,
      totalChunks: 0,
      estimatedTokens: Math.ceil(current.length / CHARS_PER_TOKEN),
      strategy: 'article',
    });
  }

  return subChunks;
}

// ─── Heading-Based Chunking ──────────────────────────────────────

function headingChunk(lines: string[]): ArticleChunk[] {
  const chunks: ArticleChunk[] = [];
  let currentLines: string[] = [];
  let breadcrumb: string[] = [];
  let currentTokens = 0;
  let chunkStartLine = 0;
  let charOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,5})\s+(.+)/);

    if (headingMatch && currentTokens > TARGET_TOKENS) {
      // Flush current chunk
      const content = currentLines.join('\n').trim();
      if (content.length > 50) {
        const articleRef = findArticleRef(content) || breadcrumb[breadcrumb.length - 1] || `Section ${chunks.length + 1}`;
        chunks.push({
          content,
          breadcrumb: breadcrumb.filter(Boolean).join(' > ') || 'Root',
          articleRef,
          sourceLocation: { startLine: chunkStartLine, endLine: i - 1, startChar: charOffset, endChar: charOffset + content.length },
          index: 0, totalChunks: 0,
          estimatedTokens: Math.ceil(content.length / CHARS_PER_TOKEN),
          strategy: 'heading',
        });
      }
      currentLines = [];
      currentTokens = 0;
      chunkStartLine = i;
    }

    if (headingMatch) {
      const level = headingMatch[1].length;
      breadcrumb = breadcrumb.slice(0, level - 1);
      breadcrumb[level - 1] = headingMatch[2].trim();
    }

    currentLines.push(line);
    currentTokens += Math.ceil(line.length / CHARS_PER_TOKEN);
    charOffset += line.length + 1;

    if (currentTokens > MAX_TOKENS) {
      const content = currentLines.join('\n').trim();
      if (content.length > 50) {
        const articleRef = findArticleRef(content) || breadcrumb[breadcrumb.length - 1] || `Section ${chunks.length + 1}`;
        chunks.push({
          content,
          breadcrumb: breadcrumb.filter(Boolean).join(' > ') || 'Root',
          articleRef,
          sourceLocation: { startLine: chunkStartLine, endLine: i, startChar: charOffset - content.length, endChar: charOffset },
          index: 0, totalChunks: 0,
          estimatedTokens: Math.ceil(content.length / CHARS_PER_TOKEN),
          strategy: 'heading',
        });
      }
      currentLines = [];
      currentTokens = 0;
      chunkStartLine = i + 1;
    }
  }

  // Flush remaining
  if (currentLines.length > 0) {
    const content = currentLines.join('\n').trim();
    if (content.length > 50) {
      const articleRef = findArticleRef(content) || breadcrumb[breadcrumb.length - 1] || `Section ${chunks.length + 1}`;
      chunks.push({
        content,
        breadcrumb: breadcrumb.filter(Boolean).join(' > ') || 'Root',
        articleRef,
        sourceLocation: { startLine: chunkStartLine, endLine: lines.length - 1, startChar: charOffset - content.length, endChar: charOffset },
        index: 0, totalChunks: 0,
        estimatedTokens: Math.ceil(content.length / CHARS_PER_TOKEN),
        strategy: 'heading',
      });
    }
  }

  return chunks;
}

// ─── Enhanced Window Chunking ────────────────────────────────────

/**
 * Window chunking that still tries to find article references
 * within each window for better traceability.
 */
function enhancedWindowChunk(content: string, lines: string[]): ArticleChunk[] {
  const maxChars = TARGET_TOKENS * CHARS_PER_TOKEN;
  const paragraphs = content.split(/\n\n+/);
  const chunks: ArticleChunk[] = [];
  let current = '';
  let chunkIndex = 0;
  let charOffset = 0;

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current.length > 100) {
      const articleRef = findArticleRef(current) || `Section ${chunkIndex + 1}`;
      chunks.push({
        content: current.trim(),
        breadcrumb: articleRef,
        articleRef,
        sourceLocation: { startLine: 0, endLine: 0, startChar: charOffset, endChar: charOffset + current.length },
        index: chunkIndex,
        totalChunks: 0,
        estimatedTokens: Math.ceil(current.length / CHARS_PER_TOKEN),
        strategy: 'window',
      });
      charOffset += current.length;

      // Overlap: keep last paragraph for context
      current = para;
      chunkIndex++;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }

  if (current.trim().length > 50) {
    const articleRef = findArticleRef(current) || `Section ${chunkIndex + 1}`;
    chunks.push({
      content: current.trim(),
      breadcrumb: articleRef,
      articleRef,
      sourceLocation: { startLine: 0, endLine: 0, startChar: charOffset, endChar: charOffset + current.length },
      index: chunkIndex,
      totalChunks: 0,
      estimatedTokens: Math.ceil(current.length / CHARS_PER_TOKEN),
      strategy: 'window',
    });
  }

  return chunks;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Try to find the most specific article reference within a text block */
function findArticleRef(text: string): string | null {
  // Look for the most specific reference in the text
  const patterns = [
    /Article\s+\d+[a-z]?(?:\(\d+\))?/i,
    /Section\s+\d+[\w.]*/i,
    /§\s*\d+[\w.]*/,
    /Recital\s*\(?\d+\)?/i,
    /Annex\s+[IVXLCDM\d]+/i,
  ];

  for (const p of patterns) {
    const match = text.match(p);
    if (match) return match[0];
  }

  return null;
}

/** Set final index and totalChunks on all chunks */
function finalizeChunks(chunks: ArticleChunk[]): ArticleChunk[] {
  const total = chunks.length;
  return chunks.map((c, i) => ({ ...c, index: i, totalChunks: total }));
}

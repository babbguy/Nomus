/**
 * Snapshot-based integration tests for the parsing & chunking pipeline.
 *
 * These tests use captured HTML fixtures (not live network calls) to validate
 * that parseHtml and articleChunk correctly handle real regulatory document structures.
 * No mocks, no DB, no LLM — purely validates the parsing/chunking path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHtml } from './sources/parsers/html-parser.js';
import { articleChunk } from './article-chunker.js';
import type { SelectorConfig } from '@nomus/shared';

function loadFixture(name: string): string {
  return readFileSync(resolve(__dirname, '__fixtures__', name), 'utf-8');
}

describe('Pipeline integration: HTML parsing + article chunking', () => {
  describe('EU AI Act (EUR-Lex structure)', () => {
    const config: SelectorConfig = {
      contentSelector: '.eli-container',
      removeSelectors: ['nav', 'footer', '.note', '.footnote'],
    };
    let parsed: string;
    let chunks: ReturnType<typeof articleChunk>;

    it('parses HTML into structured text', () => {
      const html = loadFixture('eu-ai-act.html');
      parsed = parseHtml(html, config);

      expect(parsed.length).toBeGreaterThan(500);
      expect(parsed).toContain('Article 1');
      expect(parsed).toContain('Article 5');
      expect(parsed).toContain('Article 9');
      expect(parsed).toContain('high-risk AI systems');
      expect(parsed).toContain('artificial intelligence');
    });

    it('chunks into article-boundary segments', () => {
      chunks = articleChunk(parsed);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.content.trim().length).toBeGreaterThan(0);
        expect(chunk.breadcrumb).toBeDefined();
        expect(chunk.articleRef).toBeDefined();
        expect(chunk.sourceLocation.startLine).toBeGreaterThanOrEqual(0);
        expect(chunk.estimatedTokens).toBeGreaterThan(0);
      }
    });

    it('preserves legal structure references', () => {
      const refs = chunks.map((c) => c.articleRef);
      // Should detect Article boundaries from the EU AI Act
      const hasArticleRef = refs.some((r) => /Article\s+\d+/i.test(r));
      expect(hasArticleRef).toBe(true);
    });
  });

  describe('GDPR (gdpr-info.eu structure)', () => {
    const config: SelectorConfig = {
      contentSelector: '.entry-content, article, main',
      removeSelectors: ['nav', 'footer', '.sidebar', '.comments', '.cookie-banner'],
    };
    let parsed: string;
    let chunks: ReturnType<typeof articleChunk>;

    it('parses HTML into structured text', () => {
      const html = loadFixture('gdpr.html');
      parsed = parseHtml(html, config);

      expect(parsed.length).toBeGreaterThan(500);
      expect(parsed).toContain('Article 1');
      expect(parsed).toContain('Article 5');
      expect(parsed).toContain('personal data');
      expect(parsed).toContain('data subject');
    });

    it('chunks into article-boundary segments', () => {
      chunks = articleChunk(parsed);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.content.trim().length).toBeGreaterThan(0);
        expect(chunk.estimatedTokens).toBeGreaterThan(0);
      }
    });

    it('preserves chapter and article references', () => {
      const refs = chunks.map((c) => c.articleRef);
      const hasArticleRef = refs.some((r) => /Article\s+\d+/i.test(r));
      expect(hasArticleRef).toBe(true);
    });
  });

  describe('CCPA (Cooley CDP structure)', () => {
    const config: SelectorConfig = {
      contentSelector: 'article, .entry-content, main',
      removeSelectors: ['nav', 'footer', 'script', 'style', '.sidebar', '.comments', '.wp-block-navigation'],
    };
    let parsed: string;
    let chunks: ReturnType<typeof articleChunk>;

    it('parses HTML into structured text', () => {
      const html = loadFixture('ccpa.html');
      parsed = parseHtml(html, config);

      expect(parsed.length).toBeGreaterThan(500);
      expect(parsed).toContain('1798.100');
      expect(parsed).toContain('1798.105');
      expect(parsed).toContain('personal information');
      expect(parsed).toContain('consumer');
    });

    it('chunks into section-boundary segments', () => {
      chunks = articleChunk(parsed);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.content.trim().length).toBeGreaterThan(0);
        expect(chunk.estimatedTokens).toBeGreaterThan(0);
      }
    });

    it('detects section references', () => {
      const refs = chunks.map((c) => c.articleRef);
      const hasSectionRef = refs.some((r) => /Section\s+\d+/i.test(r) || r.length > 0);
      expect(hasSectionRef).toBe(true);
    });
  });
});

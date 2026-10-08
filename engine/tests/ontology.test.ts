import { describe, it, expect, beforeAll } from 'vitest';
// Test env vars loaded from .env.test via vitest setupFiles

import { importOntologyTerms, replaceOntologyTerms, getActiveOntologyTerms, getOntologyForPrompt, transformRawTerms } from '../src/db/ontology.js';
import { createTestTables } from './setup.js';

describe('Ontology Transform', () => {
  it('splits multi-jurisdiction terms into separate rows', () => {
    const raw = [{
      term: 'AI System',
      type: 'definition',
      jurisdiction: 'EU, NIST, US',
      source_article: '[EU: Art. 3] | [NIST: Sec. 1] | [US: Sec. 3]',
      description: '[EU] European def.\n\n[NIST] NIST def.\n\n[US] US def.',
    }];
    const result = transformRawTerms(raw);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.jurisdiction)).toEqual(['EU', 'NIST', 'US-FED']);
  });

  it('normalizes compound types to primary type', () => {
    const raw = [{
      term: 'High-Risk AI',
      type: 'definition, risk_level, obligation, penalty',
      jurisdiction: 'EU',
      source_article: 'Art. 6',
      description: 'High-risk definition.',
    }];
    const result = transformRawTerms(raw);
    expect(result[0].type).toBe('definition');
  });

  it('extracts jurisdiction-specific descriptions', () => {
    const raw = [{
      term: 'Test Term',
      type: 'definition',
      jurisdiction: 'EU, US',
      source_article: '[EU: Art. 1] | [US: Sec. 1]',
      description: '[EU] European description here.\n\n[US] American description here.',
    }];
    const result = transformRawTerms(raw);
    expect(result[0].description).toBe('European description here.');
    expect(result[1].description).toBe('American description here.');
  });

  it('extracts jurisdiction-specific source articles', () => {
    const raw = [{
      term: 'Test',
      type: 'definition',
      jurisdiction: 'EU, NIST',
      source_article: '[EU: Art. 3(1)] | [NIST: Sec. 1.1]',
      description: 'Test.',
    }];
    const result = transformRawTerms(raw);
    expect(result[0].source_article).toBe('Art. 3(1)');
    expect(result[1].source_article).toBe('Sec. 1.1');
  });

  it('normalizes US to US-FED', () => {
    const raw = [{
      term: 'Test',
      type: 'definition',
      jurisdiction: 'US',
      source_article: 'Sec. 1',
      description: 'Test.',
    }];
    const result = transformRawTerms(raw);
    expect(result[0].jurisdiction).toBe('US-FED');
  });

  it('passes through single-jurisdiction terms unchanged', () => {
    const raw = [{
      term: 'Provider',
      type: 'definition',
      jurisdiction: 'EU',
      source_article: 'Art. 3(3)',
      description: 'A provider of AI systems.',
    }];
    const result = transformRawTerms(raw);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('A provider of AI systems.');
  });
});

describe('Ontology Import', () => {
  beforeAll(() => {
    createTestTables();
  });

  it('imports terms and returns count', () => {
    const result = importOntologyTerms([
      { term: 'Test Term A', type: 'definition', jurisdiction: 'EU', source_article: 'Art. 1', description: 'Def A' },
      { term: 'Test Term B', type: 'obligation', jurisdiction: 'US', source_article: 'Sec. 1', description: 'Obl B' },
    ]);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it('skips duplicates (same term + jurisdiction)', () => {
    const result = importOntologyTerms([
      { term: 'Test Term A', type: 'definition', jurisdiction: 'EU', source_article: 'Art. 1', description: 'Def A' },
    ]);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('replaces all terms when using replaceOntologyTerms', () => {
    const result = replaceOntologyTerms([
      { term: 'Fresh Term', type: 'definition', jurisdiction: 'UK', source_article: 'Ch. 1', description: 'Fresh' },
    ]);
    expect(result.deleted).toBeGreaterThan(0);
    expect(result.imported).toBe(1);
  });

  it('filters active terms by jurisdiction', () => {
    replaceOntologyTerms([
      { term: 'EU Term', type: 'definition', jurisdiction: 'EU', source_article: 'Art. 1', description: 'EU' },
      { term: 'UK Term', type: 'definition', jurisdiction: 'UK', source_article: 'Ch. 1', description: 'UK' },
    ]);
    const euTerms = getActiveOntologyTerms(undefined, 'EU');
    expect(euTerms.every((t) => t.jurisdiction === 'EU')).toBe(true);
  });

  it('generates prompt string from active terms', () => {
    const prompt = getOntologyForPrompt('EU');
    expect(prompt).toContain('REFERENCE ONTOLOGY');
    expect(prompt).toContain('EU Term');
  });

  it('returns empty string when no terms match', () => {
    const prompt = getOntologyForPrompt('JP');
    expect(prompt).toBe('');
  });
});

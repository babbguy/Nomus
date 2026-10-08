import { randomUUID } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import { getDb } from './client.js';
import { ontologyTerms } from './schema.js';
import { logger } from '../logger.js';

/** Valid ontology term types */
const VALID_TYPES = ['obligation', 'definition', 'risk_level', 'technical_requirement', 'penalty', 'applicability'] as const;
type OntologyType = typeof VALID_TYPES[number];

/** Raw input format — may have compound types/jurisdictions */
export interface RawOntologyTerm {
  term: string;
  type: string;
  jurisdiction: string;
  source_article: string;
  description: string;
}

/** Normalized single-jurisdiction, single-type row */
export interface OntologyTerm {
  term: string;
  type: OntologyType;
  jurisdiction: string;
  source_article: string;
  description: string;
}

/** Jurisdiction code normalization map */
const JURISDICTION_ALIASES: Record<string, string> = {
  'EU': 'EU',
  'US': 'US-FED',
  'US-FED': 'US-FED',
  'NIST': 'NIST',
  'UK': 'UK',
  'CA': 'CA',
};

/**
 * Normalize a compound type string to the primary valid type.
 * "definition, risk_level, obligation, penalty" → "definition"
 */
function normalizeType(raw: string): OntologyType {
  const parts = raw.split(',').map((s) => s.trim().toLowerCase().replace(/\s+/g, '_'));
  for (const part of parts) {
    if (VALID_TYPES.includes(part as OntologyType)) return part as OntologyType;
  }
  return 'definition'; // safe fallback
}

/**
 * Parse compound jurisdictions: "EU, NIST, US" → ["EU", "NIST", "US-FED"]
 */
function parseJurisdictions(raw: string): string[] {
  return raw.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((j) => JURISDICTION_ALIASES[j] ?? j);
}

/**
 * Extract the jurisdiction-specific portion of a multi-jurisdiction description.
 * Descriptions use "[EU] ...\n\n[NIST] ...\n\n[US] ..." format.
 * Returns the relevant section or the full description if no tags found.
 */
function extractJurisdictionDescription(description: string, jurisdiction: string): string {
  // Map jurisdiction codes to description tags
  const tagMap: Record<string, string[]> = {
    'EU': ['[EU]'],
    'US-FED': ['[US]'],
    'NIST': ['[NIST]'],
    'UK': ['[UK]'],
    'CA': ['[CA]'],
  };

  const tags = tagMap[jurisdiction];
  if (!tags) return description;

  // Split by jurisdiction tags and find the matching section
  const allTags = ['[EU]', '[NIST]', '[US]', '[UK]', '[CA]'];
  const tagPattern = allTags.map((t) => t.replace(/[[\]]/g, '\\$&')).join('|');
  const regex = new RegExp(`(${tagPattern})`, 'g');

  const sections: { tag: string; text: string }[] = [];
  let lastIdx = 0;
  let lastTag = '';
  let match;

  while ((match = regex.exec(description)) !== null) {
    if (lastTag) {
      sections.push({ tag: lastTag, text: description.slice(lastIdx, match.index).trim() });
    }
    lastTag = match[1];
    lastIdx = match.index + match[1].length;
  }
  if (lastTag) {
    sections.push({ tag: lastTag, text: description.slice(lastIdx).trim() });
  }

  // If no tags found, return full description
  if (sections.length === 0) return description;

  // Find matching section
  for (const section of sections) {
    if (tags.includes(section.tag)) return section.text;
  }

  // Fallback: return first section
  return sections[0].text;
}

/**
 * Extract jurisdiction-specific source articles from compound source_article strings.
 * Format: "[EU: Art. 3(1)] | [NIST: Sec. 1.1] | [US: Sec. 3(e)]"
 */
function extractJurisdictionSource(sourceArticle: string, jurisdiction: string): string {
  const tagMap: Record<string, string> = {
    'EU': 'EU',
    'US-FED': 'US',
    'NIST': 'NIST',
    'UK': 'UK',
    'CA': 'CA',
  };

  const tag = tagMap[jurisdiction];
  if (!tag) return sourceArticle;

  // Try to extract [TAG: content] sections
  const parts = sourceArticle.split('|').map((s) => s.trim());
  for (const part of parts) {
    const match = part.match(new RegExp(`\\[${tag}:\\s*(.+?)\\]`));
    if (match) return match[1].trim();
  }

  // No jurisdiction-specific sections found — return as-is
  return sourceArticle;
}

/**
 * Transform raw terms (may have compound types/jurisdictions) into normalized rows.
 * One row per jurisdiction, single type, jurisdiction-specific description.
 */
export function transformRawTerms(rawTerms: RawOntologyTerm[]): OntologyTerm[] {
  const result: OntologyTerm[] = [];

  for (const raw of rawTerms) {
    const type = normalizeType(raw.type);
    const jurisdictions = parseJurisdictions(raw.jurisdiction);

    for (const jurisdiction of jurisdictions) {
      result.push({
        term: raw.term,
        type,
        jurisdiction,
        source_article: extractJurisdictionSource(raw.source_article, jurisdiction),
        description: extractJurisdictionDescription(raw.description, jurisdiction),
      });
    }
  }

  return result;
}

/**
 * Bulk import ontology terms from a JSON array.
 * Accepts raw (compound) or normalized terms.
 * Splits multi-jurisdiction entries into separate rows.
 * Skips duplicates (matching term + jurisdiction).
 */
export function importOntologyTerms(terms: RawOntologyTerm[]): { imported: number; skipped: number; total: number } {
  const normalized = transformRawTerms(terms);
  const db = getDb();
  const now = new Date().toISOString();
  let imported = 0;
  let skipped = 0;

  db.transaction((tx) => {
    for (const t of normalized) {
      // Efficient dedup: direct WHERE query instead of loading all rows
      const existing = tx.select({ id: ontologyTerms.id })
        .from(ontologyTerms)
        .where(and(
          eq(ontologyTerms.term, t.term),
          eq(ontologyTerms.jurisdiction, t.jurisdiction),
        ))
        .get();

      if (existing) {
        skipped++;
        continue;
      }

      tx.insert(ontologyTerms).values({
        id: randomUUID(),
        term: t.term,
        type: t.type,
        jurisdiction: t.jurisdiction,
        sourceArticle: t.source_article,
        description: t.description,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      }).run();
      imported++;
    }
  });

  logger.info({ imported, skipped, total: normalized.length }, `Ontology import complete`);
  return { imported, skipped, total: normalized.length };
}

/**
 * Replace all ontology terms with a fresh import.
 * Wipes existing terms, then imports normalized rows.
 */
export function replaceOntologyTerms(terms: RawOntologyTerm[]): { imported: number; deleted: number; total: number } {
  const normalized = transformRawTerms(terms);
  const db = getDb();
  const now = new Date().toISOString();
  let deleted = 0;
  let imported = 0;

  db.transaction((tx) => {
    // Wipe existing
    const deleteResult = tx.delete(ontologyTerms).run();
    deleted = deleteResult.changes;

    // Insert all normalized terms
    const seen = new Set<string>();

    for (const t of normalized) {
      const dedupKey = `${t.term}::${t.jurisdiction}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      tx.insert(ontologyTerms).values({
        id: randomUUID(),
        term: t.term,
        type: t.type,
        jurisdiction: t.jurisdiction,
        sourceArticle: t.source_article,
        description: t.description,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      }).run();
      imported++;
    }
  });

  logger.info({ imported, deleted, total: normalized.length }, `Ontology replaced`);
  return { imported, deleted, total: normalized.length };
}

/**
 * Get all active ontology terms, optionally filtered.
 */
export function getActiveOntologyTerms(type?: string, jurisdiction?: string) {
  const db = getDb();
  let terms = db.select().from(ontologyTerms)
    .where(eq(ontologyTerms.isActive, true))
    .all();

  if (type) terms = terms.filter((t) => t.type === type);
  if (jurisdiction) terms = terms.filter((t) => t.jurisdiction === jurisdiction || t.jurisdiction === 'universal');

  return terms;
}

/**
 * Get ontology terms formatted for LLM prompt injection.
 * Uses truncated descriptions to conserve tokens.
 */
export function getOntologyForPrompt(jurisdiction?: string): string {
  const terms = getActiveOntologyTerms(undefined, jurisdiction);
  if (terms.length === 0) return '';

  const grouped: Record<string, string[]> = {};
  for (const t of terms) {
    if (!grouped[t.type]) grouped[t.type] = [];
    // Truncate description to first sentence or 200 chars for prompt efficiency
    const shortDesc = truncateToFirstSentence(t.description, 200);
    grouped[t.type].push(`- ${t.term}: ${shortDesc} [${t.sourceArticle}]`);
  }

  let prompt = '\n\nREFERENCE ONTOLOGY — Use these established terms and classifications when generating rules:\n';
  for (const [type, entries] of Object.entries(grouped)) {
    prompt += `\n${type.toUpperCase().replace(/_/g, ' ')}S:\n${entries.join('\n')}\n`;
  }
  prompt += '\nIf you encounter a concept not in this ontology, still include it but mark the ruleKey with a "_new" suffix so it can be reviewed.\n';

  return prompt;
}

/** Truncate to first sentence or maxLen, whichever is shorter. */
function truncateToFirstSentence(text: string, maxLen: number): string {
  const firstSentence = text.match(/^[^.!?]+[.!?]/);
  const short = firstSentence ? firstSentence[0] : text;
  return short.length <= maxLen ? short : short.slice(0, maxLen - 3) + '...';
}

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { ontologyTerms, policyRules, regulatorySources } from './schema.js';
import { signData } from '../core/signing.js';
import { canonicalJSON } from '../core/policy-compiler.js';
import { logger } from '../logger.js';

/** Map ontology types to policy effects */
const TYPE_TO_EFFECT: Record<string, 'deny' | 'allow_with_audit' | 'require_disclosure' | 'flag'> = {
  obligation: 'allow_with_audit',
  definition: 'flag',
  risk_level: 'require_disclosure',
  technical_requirement: 'allow_with_audit',
  penalty: 'deny',
  applicability: 'flag',
};

/** Map ontology types to policy severity */
const TYPE_TO_SEVERITY: Record<string, 'critical' | 'high' | 'medium' | 'low'> = {
  obligation: 'high',
  definition: 'low',
  risk_level: 'high',
  technical_requirement: 'medium',
  penalty: 'critical',
  applicability: 'low',
};

/** Map ontology types to policy categories */
const TYPE_TO_CATEGORY: Record<string, string> = {
  obligation: 'accountability',
  definition: 'transparency',
  risk_level: 'risk_assessment',
  technical_requirement: 'safety',
  penalty: 'accountability',
  applicability: 'transparency',
};

/**
 * Generate policy rules directly from ontology terms.
 * Zero LLM cost — uses the structured ontology data we already have.
 * Only runs if the policy_rules table is empty (first boot).
 */
export function seedRulesFromOntology(): { created: number; skipped: number } {
  const db = getDb();

  // Skip if rules already exist
  const existingCount = db.select({ id: policyRules.id })
    .from(policyRules)
    .all().length;

  if (existingCount > 0) {
    return { created: 0, skipped: existingCount };
  }

  // Get all active ontology terms
  const terms = db.select().from(ontologyTerms)
    .where(eq(ontologyTerms.isActive, true))
    .all();

  if (terms.length === 0) {
    return { created: 0, skipped: 0 };
  }

  // Find a source ID for each jurisdiction (for foreign key)
  const sources = db.select().from(regulatorySources).all();
  const sourceByJurisdiction = new Map<string, string>();
  for (const s of sources) {
    sourceByJurisdiction.set(s.jurisdiction, s.id);
  }

  const now = new Date().toISOString();
  let created = 0;
  const seenKeys = new Set<string>();

  for (const term of terms) {
    // Only create rules from obligation, risk_level, technical_requirement, and penalty types
    // Definitions and applicability are informational — they become "flag" rules
    const effect = TYPE_TO_EFFECT[term.type] ?? 'flag';
    const severity = TYPE_TO_SEVERITY[term.type] ?? 'low';
    const category = TYPE_TO_CATEGORY[term.type] ?? 'transparency';

    // Build ruleKey from term name
    const jurisdictionPrefix = term.jurisdiction.toLowerCase().replace(/-/g, '_');
    const termSlug = term.term
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 60);
    const ruleKey = `${jurisdictionPrefix}.ontology.${termSlug}`;

    // Skip duplicates
    if (seenKeys.has(ruleKey)) continue;
    seenKeys.add(ruleKey);

    // Find the source for this jurisdiction
    const sourceId = sourceByJurisdiction.get(term.jurisdiction);
    if (!sourceId) continue;

    // Build conditions from term metadata
    const conditions: Record<string, string> = {
      action: 'ai_operation',
      region: term.jurisdiction,
    };

    // Add risk level for penalty/obligation terms
    if (term.type === 'penalty' || term.type === 'obligation') {
      conditions.risk_level = 'high';
    }

    // Truncate description for humanSummary (max 500 chars)
    const humanSummary = term.description.length > 490
      ? term.description.slice(0, 487) + '...'
      : term.description;

    // Create canonical form for signing
    const canonical = canonicalJSON({
      ruleKey,
      version: 1,
      jurisdiction: term.jurisdiction,
      category,
      conditions,
      effect,
      severity,
      humanSummary,
      legalReference: term.sourceArticle,
    });
    const signature = signData(canonical);

    db.insert(policyRules).values({
      id: randomUUID(),
      sourceId,
      ruleKey,
      version: 1,
      jurisdiction: term.jurisdiction,
      category,
      conditions: JSON.stringify(conditions),
      effect,
      severity,
      humanSummary,
      legalReference: term.sourceArticle,
      effectiveDate: now,
      expiresAt: null,
      isActive: true,
      signature,
      createdAt: now,
      updatedAt: now,
    }).run();

    created++;
  }

  logger.info({ created, totalTerms: terms.length }, 'Seeded policy rules from ontology (zero LLM cost)');
  return { created, skipped: 0 };
}

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getDb } from './client.js';
import { policyRules, regulatorySources } from './schema.js';
import { signData } from '../core/signing.js';
import { canonicalJSON } from '../core/policy-compiler.js';
import { logger } from '../logger.js';

/**
 * NIS2 Directive (EU 2022/2555) — Network and Information Security.
 * Applies to essential and important entities across critical sectors.
 * Effective: 18 October 2024 (transposition deadline for Member States).
 */

export interface SeedRule {
  ruleKey: string;
  jurisdiction: string;
  category: string;
  conditions: Record<string, string>;
  effect: 'deny' | 'allow_with_audit' | 'require_disclosure' | 'flag';
  severity: 'critical' | 'high' | 'medium' | 'low';
  humanSummary: string;
  legalReference: string;
  industries: string[];
  industryScope: string;
  industryNotes: string;
}

export const NIS2_RULES: SeedRule[] = [
  // NIS2 Article 21 — Cybersecurity risk-management measures
  {
    ruleKey: 'nis2.art21.risk_management',
    jurisdiction: 'EU',
    category: 'security',
    conditions: { action: 'text_generation' },
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'NIS2 requires essential and important entities to implement appropriate cybersecurity risk-management measures for AI systems, including incident handling, supply chain security, and encryption policies.',
    legalReference: 'NIS2 Directive Article 21 — Cybersecurity risk-management measures',
    industries: ['critical_infrastructure', 'healthcare', 'finance', 'government'],
    industryScope: 'sector_specific',
    industryNotes: 'Applies to essential entities (Annex I) and important entities (Annex II) as defined by NIS2.',
  },

  // NIS2 Article 23 — Reporting obligations
  {
    ruleKey: 'nis2.art23.incident_reporting',
    jurisdiction: 'EU',
    category: 'accountability',
    conditions: { action: 'sends_to_third_party' },
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary:
      'NIS2 mandates significant incident reporting within 24 hours (early warning) and 72 hours (full notification). AI systems sending data to third parties must have incident detection and reporting capabilities.',
    legalReference: 'NIS2 Directive Article 23 — Reporting obligations',
    industries: ['critical_infrastructure', 'healthcare', 'finance', 'government'],
    industryScope: 'sector_specific',
    industryNotes: 'Early warning within 24h, full notification within 72h, final report within 1 month.',
  },

  // NIS2 Article 21(2)(d) — Supply chain security
  {
    ruleKey: 'nis2.art21.supply_chain',
    jurisdiction: 'EU',
    category: 'security',
    conditions: { action: 'sends_to_third_party' },
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'NIS2 requires security in supply chains including relationships with third-party AI service providers. AI outputs sent to external services must be covered by supply chain security assessments.',
    legalReference: 'NIS2 Directive Article 21(2)(d) — Supply chain security',
    industries: ['critical_infrastructure', 'healthcare', 'finance', 'government'],
    industryScope: 'sector_specific',
    industryNotes: 'Covers direct suppliers and service providers; must assess vulnerabilities specific to each supplier.',
  },

  // NIS2 Article 21(2)(g) — Basic cyber hygiene and training (logging)
  {
    ruleKey: 'nis2.art21.logging',
    jurisdiction: 'EU',
    category: 'transparency',
    conditions: { action: 'logs_ai_output' },
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'NIS2 requires entities to maintain logging and monitoring systems. AI output logging must be retained per incident response requirements and protected from unauthorized modification.',
    legalReference: 'NIS2 Directive Article 21(2)(g) — Basic cyber hygiene and training',
    industries: ['critical_infrastructure', 'healthcare', 'finance', 'government'],
    industryScope: 'sector_specific',
    industryNotes: 'Logs must support forensic analysis and incident response timelines.',
  },
];

/**
 * Seed NIS2 Directive rules into policy_rules.
 * Idempotent — checks ruleKey existence before insert.
 */
export function seedNis2Rules(db: ReturnType<typeof getDb>): { created: number; skipped: number } {
  // Find EU source for foreign key
  const euSource = db
    .select()
    .from(regulatorySources)
    .where(eq(regulatorySources.jurisdiction, 'EU'))
    .all();

  // Prefer the NIS2 source, fallback to any EU source
  const sourceId =
    euSource.find((s) => s.name.includes('NIS2'))?.id ??
    euSource[0]?.id;

  if (!sourceId) {
    logger.warn('No EU regulatory source found — skipping NIS2 rule seeding');
    return { created: 0, skipped: 0 };
  }

  const now = new Date().toISOString();
  let created = 0;
  let skipped = 0;

  for (const rule of NIS2_RULES) {
    // Idempotency: skip if ruleKey already exists
    const existing = db
      .select({ id: policyRules.id })
      .from(policyRules)
      .where(eq(policyRules.ruleKey, rule.ruleKey))
      .get();

    if (existing) {
      skipped++;
      continue;
    }

    const canonical = canonicalJSON({
      ruleKey: rule.ruleKey,
      version: 1,
      jurisdiction: rule.jurisdiction,
      category: rule.category,
      conditions: rule.conditions,
      effect: rule.effect,
      severity: rule.severity,
      humanSummary: rule.humanSummary,
      legalReference: rule.legalReference,
    });
    const signature = signData(canonical);

    db.insert(policyRules)
      .values({
        id: randomUUID(),
        sourceId,
        ruleKey: rule.ruleKey,
        version: 1,
        jurisdiction: rule.jurisdiction,
        category: rule.category,
        conditions: JSON.stringify(rule.conditions),
        effect: rule.effect,
        severity: rule.severity,
        humanSummary: rule.humanSummary,
        legalReference: rule.legalReference,
        effectiveDate: '2024-10-18',
        expiresAt: null,
        industries: JSON.stringify(rule.industries),
        industryScope: rule.industryScope,
        industryNotes: rule.industryNotes,
        isActive: true,
        signature,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    created++;
  }

  if (created > 0) {
    logger.info({ created, skipped }, 'Seeded NIS2 Directive rules');
  }

  return { created, skipped };
}

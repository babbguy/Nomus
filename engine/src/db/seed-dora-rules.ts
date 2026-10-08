import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getDb } from './client.js';
import { policyRules, regulatorySources } from './schema.js';
import { signData } from '../core/signing.js';
import { canonicalJSON } from '../core/policy-compiler.js';
import { logger } from '../logger.js';

/**
 * DORA (EU 2022/2554) — Digital Operational Resilience Act.
 * Applies to financial entities: credit institutions, investment firms,
 * insurance undertakings, payment institutions, and their ICT service providers.
 * Effective: 17 January 2025.
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

export const DORA_RULES: SeedRule[] = [
  // DORA Article 6 — ICT risk management framework
  {
    ruleKey: 'dora.art6.ict_risk_management',
    jurisdiction: 'EU',
    category: 'risk_assessment',
    conditions: { action: 'text_generation' },
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'DORA requires financial entities to establish a comprehensive ICT risk management framework. AI systems must be included in the ICT risk assessment, with documented risk tolerance and mitigation strategies.',
    legalReference: 'DORA Article 6 — ICT risk management framework',
    industries: ['finance'],
    industryScope: 'sector_specific',
    industryNotes: 'Applies to all financial entities under DORA scope (Art. 2), including credit institutions, investment firms, and payment institutions.',
  },

  // DORA Article 11 — Response and recovery
  {
    ruleKey: 'dora.art11.response_recovery',
    jurisdiction: 'EU',
    category: 'safety',
    conditions: { action: 'stores_ai_output' },
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'DORA mandates business continuity and disaster recovery plans covering ICT systems. AI outputs stored in databases must be included in backup and recovery procedures.',
    legalReference: 'DORA Article 11 — Response and recovery',
    industries: ['finance'],
    industryScope: 'sector_specific',
    industryNotes: 'ICT business continuity policy must be tested at least annually.',
  },

  // DORA Article 28 — Third-party ICT service providers
  {
    ruleKey: 'dora.art28.third_party_risk',
    jurisdiction: 'EU',
    category: 'accountability',
    conditions: { action: 'sends_to_third_party' },
    effect: 'require_disclosure',
    severity: 'critical',
    humanSummary:
      'DORA imposes strict requirements on contracts with third-party ICT providers including AI services. AI calls to external APIs must be governed by contractual arrangements covering security, audit rights, exit strategies, and sub-outsourcing.',
    legalReference: 'DORA Article 28 — General principles for third-party ICT service providers',
    industries: ['finance'],
    industryScope: 'sector_specific',
    industryNotes: 'Critical ICT third-party providers are subject to direct EU oversight under DORA Arts. 31-44.',
  },

  // DORA Article 15 — ICT-related incident management
  {
    ruleKey: 'dora.art15.incident_management',
    jurisdiction: 'EU',
    category: 'accountability',
    conditions: { action: 'processes_user_input' },
    effect: 'allow_with_audit',
    severity: 'medium',
    humanSummary:
      'DORA requires classification and reporting of ICT-related incidents. AI systems processing user input must have mechanisms to detect, log, and report operational incidents.',
    legalReference: 'DORA Article 15 — ICT-related incident management process',
    industries: ['finance'],
    industryScope: 'sector_specific',
    industryNotes: 'Major ICT-related incidents must be reported to competent authorities per Art. 19.',
  },

  // DORA Article 9 — Protection and prevention
  {
    ruleKey: 'dora.art9.data_protection',
    jurisdiction: 'EU',
    category: 'security',
    conditions: { action: 'contains_pii' },
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'DORA requires financial entities to implement ICT security policies for data protection. Personal data in AI pipelines must be protected with encryption, access control, and data loss prevention measures.',
    legalReference: 'DORA Article 9 — Protection and prevention',
    industries: ['finance'],
    industryScope: 'sector_specific',
    industryNotes: 'Includes requirements for encryption at rest and in transit, network segmentation, and access management.',
  },
];

/**
 * Seed DORA rules into policy_rules.
 * Idempotent — checks ruleKey existence before insert.
 */
export function seedDoraRules(db: ReturnType<typeof getDb>): { created: number; skipped: number } {
  // Find EU source for foreign key
  const euSource = db
    .select()
    .from(regulatorySources)
    .where(eq(regulatorySources.jurisdiction, 'EU'))
    .all();

  // Prefer the DORA source, fallback to any EU source
  const sourceId =
    euSource.find((s) => s.name.includes('DORA'))?.id ??
    euSource[0]?.id;

  if (!sourceId) {
    logger.warn('No EU regulatory source found — skipping DORA rule seeding');
    return { created: 0, skipped: 0 };
  }

  const now = new Date().toISOString();
  let created = 0;
  let skipped = 0;

  for (const rule of DORA_RULES) {
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
        effectiveDate: '2025-01-17',
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
    logger.info({ created, skipped }, 'Seeded DORA rules');
  }

  return { created, skipped };
}

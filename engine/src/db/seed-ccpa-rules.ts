import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { policyRules, regulatorySources } from './schema.js';
import { logger } from '../logger.js';

/**
 * CCPA / CPRA (California Consumer Privacy Act / California Privacy Rights Act) rules.
 *
 * Covers key consumer rights: right to know, right to delete, right to opt-out,
 * sensitive personal information, automated decision-making, and data sharing
 * restrictions as they apply to AI systems processing California residents' data.
 *
 * Idempotent — skips any rule whose ruleKey already exists (unique index).
 */

interface CcpaRule {
  ruleKey: string;
  sourceName: string;
  jurisdiction: string;
  category: string;
  conditions: string;
  effect: 'deny' | 'allow_with_audit' | 'require_disclosure' | 'flag';
  severity: 'critical' | 'high' | 'medium' | 'low';
  humanSummary: string;
  legalReference: string;
  industries: string;
  industryScope: string;
}

// ─── Rule Definitions ──────────────────────────────────────────────

const CCPA_RULES: CcpaRule[] = [
  // ─── Core Consumer Rights ────────────────────────────────────────

  {
    ruleKey: 'ccpa.1798_100.right_to_know',
    sourceName: 'CCPA / CPRA (California Consumer Privacy Act)',
    jurisdiction: 'US-CA',
    category: 'transparency',
    conditions: JSON.stringify({ action: 'processes_user_input', region: 'US-CA' }),
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary:
      'CCPA gives consumers the right to know what personal information is collected and how it is used. AI systems processing California consumer data must be able to disclose data collection categories, processing purposes, and categories of third parties with whom data is shared.',
    legalReference: 'Cal. Civ. Code \u00a7 1798.100 \u2014 Consumer right to know about personal information collected',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'ccpa.1798_105.right_to_delete',
    sourceName: 'CCPA / CPRA (California Consumer Privacy Act)',
    jurisdiction: 'US-CA',
    category: 'data_governance',
    conditions: JSON.stringify({ action: 'stores_ai_output', region: 'US-CA' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'CCPA gives consumers the right to request deletion of their personal information. AI systems that store outputs derived from California consumer data must support verifiable deletion requests, including removal from training datasets and derived model artifacts where feasible.',
    legalReference: 'Cal. Civ. Code \u00a7 1798.105 \u2014 Consumer right to deletion of personal information',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'ccpa.1798_110.right_to_access',
    sourceName: 'CCPA / CPRA (California Consumer Privacy Act)',
    jurisdiction: 'US-CA',
    category: 'transparency',
    conditions: JSON.stringify({ action: 'contains_pii', region: 'US-CA' }),
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary:
      'CCPA gives consumers the right to access specific pieces of personal information collected about them. AI systems handling California consumer PII must be capable of producing the specific personal information collected in response to verifiable consumer requests.',
    legalReference: 'Cal. Civ. Code \u00a7 1798.110 \u2014 Consumer right to access personal information',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'ccpa.1798_120.right_to_opt_out',
    sourceName: 'CCPA / CPRA (California Consumer Privacy Act)',
    jurisdiction: 'US-CA',
    category: 'privacy',
    conditions: JSON.stringify({ action: 'sends_to_third_party', region: 'US-CA' }),
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary:
      'CCPA gives consumers the right to opt out of the sale or sharing of their personal information. AI systems that transmit California consumer data to third parties must provide a clear opt-out mechanism and honor Global Privacy Control (GPC) signals.',
    legalReference: 'Cal. Civ. Code \u00a7 1798.120 \u2014 Consumer right to opt-out of sale or sharing',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'ccpa.1798_121.limit_sensitive_pi',
    sourceName: 'CCPA / CPRA (California Consumer Privacy Act)',
    jurisdiction: 'US-CA',
    category: 'privacy',
    conditions: JSON.stringify({ action: 'contains_pii', region: 'US-CA' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'CPRA gives consumers the right to limit the use and disclosure of sensitive personal information. AI systems processing sensitive PI categories (SSN, financial accounts, precise geolocation, racial/ethnic origin, health data) must limit use to what is necessary for the disclosed purpose.',
    legalReference: 'Cal. Civ. Code \u00a7 1798.121 \u2014 Consumer right to limit use of sensitive personal information',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── Automated Decision-Making ──────────────────────────────────

  {
    ruleKey: 'ccpa.1798_185.automated_decision_making',
    sourceName: 'CCPA / CPRA (California Consumer Privacy Act)',
    jurisdiction: 'US-CA',
    category: 'human_oversight',
    conditions: JSON.stringify({ action: 'returns_ai_to_user', region: 'US-CA' }),
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary:
      'CPRA directs regulations on automated decision-making technology (ADMT). AI systems that make significant decisions about California consumers must provide meaningful information about the logic involved, allow consumers to opt out of ADMT, and provide access to information about the outcome of such decisions.',
    legalReference: 'Cal. Civ. Code \u00a7 1798.185(a)(16) \u2014 Automated decision-making technology regulations',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── Sensitive Personal Information Categories ──────────────────

  {
    ruleKey: 'ccpa.1798_140.biometric_data',
    sourceName: 'CCPA / CPRA (California Consumer Privacy Act)',
    jurisdiction: 'US-CA',
    category: 'privacy',
    conditions: JSON.stringify({ action: 'handles_biometric', region: 'US-CA' }),
    effect: 'deny',
    severity: 'critical',
    humanSummary:
      'CCPA classifies biometric information as sensitive personal information. AI systems processing biometric data of California consumers (fingerprints, face geometry, voice prints, iris scans) require explicit opt-in consent and must limit processing to disclosed purposes only.',
    legalReference: 'Cal. Civ. Code \u00a7 1798.140(ae)(1)(E) \u2014 Sensitive personal information: biometric',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'ccpa.1798_140.geolocation_data',
    sourceName: 'CCPA / CPRA (California Consumer Privacy Act)',
    jurisdiction: 'US-CA',
    category: 'privacy',
    conditions: JSON.stringify({ action: 'contains_pii', data_type: 'geolocation', region: 'US-CA' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'CCPA classifies precise geolocation data as sensitive personal information. AI systems processing location data of California consumers within a radius of 1,850 feet must treat it as sensitive PI, providing opt-out mechanisms and limiting use to disclosed purposes.',
    legalReference: 'Cal. Civ. Code \u00a7 1798.140(ae)(1)(A) \u2014 Sensitive personal information: precise geolocation',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── Data Sharing and Service Provider Requirements ─────────────

  {
    ruleKey: 'ccpa.1798_100.data_sharing_disclosure',
    sourceName: 'CCPA / CPRA (California Consumer Privacy Act)',
    jurisdiction: 'US-CA',
    category: 'transparency',
    conditions: JSON.stringify({ action: 'sends_to_third_party', region: 'US-CA' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'CCPA requires businesses to disclose categories of personal information shared with third parties. AI systems sending California consumer data to external model providers or analytics services must document data sharing in the privacy policy and maintain service provider agreements restricting further use.',
    legalReference: 'Cal. Civ. Code \u00a7 1798.100(a)(3) \u2014 Disclosure of categories of third parties',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
];

// ─── Seed Function ─────────────────────────────────────────────────

/**
 * Seed CCPA/CPRA rules into the policy_rules table.
 *
 * Idempotent: skips any rule whose ruleKey already exists (unique index).
 * Looks up sourceId by matching source name in regulatory_sources table.
 *
 * @returns Count of rules created and skipped.
 */
export function seedCcpaRules(db: BetterSQLite3Database<typeof schema>): { created: number; skipped: number } {
  const now = new Date().toISOString();

  // Build source name -> id lookup from regulatory_sources
  const sources = db.select({ id: regulatorySources.id, name: regulatorySources.name })
    .from(regulatorySources)
    .all();
  const sourceByName = new Map<string, string>();
  for (const s of sources) {
    sourceByName.set(s.name, s.id);
  }

  let created = 0;
  let skipped = 0;

  for (const rule of CCPA_RULES) {
    // Check if rule already exists (idempotency)
    const existing = db.select({ id: policyRules.id })
      .from(policyRules)
      .where(eq(policyRules.ruleKey, rule.ruleKey))
      .get();

    if (existing) {
      skipped++;
      continue;
    }

    // Resolve sourceId from source name
    const sourceId = sourceByName.get(rule.sourceName);
    if (!sourceId) {
      logger.warn({ sourceName: rule.sourceName, ruleKey: rule.ruleKey },
        'Skipping CCPA/CPRA rule: regulatory source not found in database');
      skipped++;
      continue;
    }

    db.insert(policyRules).values({
      id: randomUUID(),
      sourceId,
      ruleKey: rule.ruleKey,
      version: 1,
      jurisdiction: rule.jurisdiction,
      category: rule.category,
      conditions: rule.conditions,
      effect: rule.effect,
      severity: rule.severity,
      humanSummary: rule.humanSummary,
      legalReference: rule.legalReference,
      // CCPA as amended by CPRA — amendments operative 2023-01-01
      // (the obligation's date, not the seed-run timestamp).
      effectiveDate: '2023-01-01',
      expiresAt: null,
      industries: rule.industries,
      industryScope: rule.industryScope,
      isActive: true,
      signature: 'unsigned',
      createdAt: now,
      updatedAt: now,
    }).run();

    created++;
  }

  if (created > 0) {
    logger.info({ created, skipped }, 'Seeded CCPA/CPRA rules');
  }

  return { created, skipped };
}

/** Exported for testing */
export const CCPA_RULE_DEFINITIONS = CCPA_RULES;

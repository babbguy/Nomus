import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { policyRules, regulatorySources } from './schema.js';
import type * as schema from './schema.js';
import { logger } from '../logger.js';

/**
 * SOC 2 Trust Service Criteria (TSC) — AICPA.
 *
 * SOC 2 audits evaluate controls relevant to security, availability,
 * processing integrity, confidentiality, and privacy. The criteria are
 * publicly documented by AICPA even though the full standard requires purchase.
 *
 * These rules map the five Trust Service Categories to AI system obligations:
 * - Common Criteria (CC) — Security
 * - Availability (A)
 * - Processing Integrity (PI)
 * - Confidentiality (C)
 * - Privacy (P) — covered by GDPR/HIPAA rules elsewhere
 *
 * Idempotent — uses ruleKey unique index to skip existing rules.
 */

interface Soc2Rule {
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

/**
 * SOC 2 effective-date anchor.
 * Every rule below cites criteria from the 2017 Trust Services Criteria
 * (AICPA TSP section 100). The AICPA required the 2017 TSC for all SOC 2
 * reports covering periods ending on or after 2018-12-15 — that mandatory
 * date is the criteria's effective date. The 2022 revision changed only the
 * points of focus, not the criteria themselves, and no rule below references
 * points of focus, so the 2017 vintage applies.
 * Source: AICPA, "2017 Trust Services Criteria (With Revised Points of
 * Focus — 2022)", https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022
 * Never the seed-run timestamp.
 */
export const TSC_2017_EFFECTIVE_DATE = '2018-12-15';

// ─── Rule Definitions ──────────────────────────────────────────────

const SOC2_RULES: Soc2Rule[] = [
  // ─── CC6.1 — Logical and physical access controls ──────────────
  {
    ruleKey: 'soc2.cc6_1.access_controls',
    sourceName: 'SOC 2 Trust Services Criteria (Requires Purchase)',
    jurisdiction: 'INTL',
    category: 'security',
    conditions: JSON.stringify({ action: 'handles_pii' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'SOC 2 CC6.1 requires logical and physical access controls to protect information assets. AI systems handling personal data must implement authentication, authorization, and access monitoring controls.',
    legalReference: 'AICPA TSC CC6.1 — Logical and Physical Access Controls',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── CC6.3 — Role-based access ─────────────────────────────────
  {
    ruleKey: 'soc2.cc6_3.role_based_access',
    sourceName: 'SOC 2 Trust Services Criteria (Requires Purchase)',
    jurisdiction: 'INTL',
    category: 'security',
    conditions: JSON.stringify({ action: 'handles_phi' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'SOC 2 CC6.3 requires role-based access controls. Access to AI systems processing sensitive data must be assigned based on job responsibilities with regular access reviews.',
    legalReference: 'AICPA TSC CC6.3 — Role-Based Access',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── CC7.2 — System monitoring ─────────────────────────────────
  {
    ruleKey: 'soc2.cc7_2.monitoring',
    sourceName: 'SOC 2 Trust Services Criteria (Requires Purchase)',
    jurisdiction: 'INTL',
    category: 'security',
    conditions: JSON.stringify({ action: 'logs_ai_output' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'SOC 2 CC7.2 requires monitoring of system components for anomalies. AI output logging supports the monitoring requirement but logs must be reviewed regularly and anomalies investigated.',
    legalReference: 'AICPA TSC CC7.2 — System Monitoring',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── CC8.1 — Change management ─────────────────────────────────
  {
    ruleKey: 'soc2.cc8_1.change_management',
    sourceName: 'SOC 2 Trust Services Criteria (Requires Purchase)',
    jurisdiction: 'INTL',
    category: 'accountability',
    conditions: JSON.stringify({ action: 'text_generation' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'SOC 2 CC8.1 requires change management processes for infrastructure and software. AI model updates, prompt changes, and configuration modifications must follow documented change management procedures.',
    legalReference: 'AICPA TSC CC8.1 — Change Management',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── A1.2 — Availability commitment ────────────────────────────
  {
    ruleKey: 'soc2.a1_2.availability',
    sourceName: 'SOC 2 Trust Services Criteria (Requires Purchase)',
    jurisdiction: 'INTL',
    category: 'safety',
    conditions: JSON.stringify({ action: 'returns_ai_to_user' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'SOC 2 A1.2 requires measures to maintain system availability commitments. AI systems returning output to users must have availability monitoring, failover mechanisms, and incident response plans.',
    legalReference: 'AICPA TSC A1.2 — Environmental Protections and Availability',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── C1.1 — Confidentiality ────────────────────────────────────
  {
    ruleKey: 'soc2.c1_1.confidentiality',
    sourceName: 'SOC 2 Trust Services Criteria (Requires Purchase)',
    jurisdiction: 'INTL',
    category: 'security',
    conditions: JSON.stringify({ action: 'contains_secret' }),
    effect: 'deny',
    severity: 'critical',
    humanSummary:
      'SOC 2 C1.1 requires identification and protection of confidential information. Secrets (API keys, credentials, tokens) in source code violate confidentiality controls.',
    legalReference: 'AICPA TSC C1.1 — Identification of Confidential Information',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── PI1.1 — Processing integrity ──────────────────────────────
  {
    ruleKey: 'soc2.pi1_1.processing_integrity',
    sourceName: 'SOC 2 Trust Services Criteria (Requires Purchase)',
    jurisdiction: 'INTL',
    category: 'safety',
    conditions: JSON.stringify({ action: 'processes_user_input' }),
    effect: 'allow_with_audit',
    severity: 'medium',
    humanSummary:
      'SOC 2 PI1.1 requires that system processing is complete, valid, accurate, and timely. AI systems processing user input must implement input validation, output verification, and error handling.',
    legalReference: 'AICPA TSC PI1.1 — Processing Integrity',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
];

// ─── Seed Function ─────────────────────────────────────────────────

/**
 * Seed SOC 2 Trust Service Criteria rules into the policy_rules table.
 *
 * Idempotent: skips any rule whose ruleKey already exists (unique index).
 * Looks up sourceId by matching source name in regulatory_sources table.
 *
 * @returns Count of rules created and skipped.
 */
export function seedSoc2Rules(db: BetterSQLite3Database<typeof schema>): { created: number; skipped: number } {
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
  let refreshed = 0;

  for (const rule of SOC2_RULES) {
    // Check if rule already exists (idempotency)
    const existing = db.select({
      id: policyRules.id,
      effectiveDate: policyRules.effectiveDate,
      version: policyRules.version,
      signature: policyRules.signature,
    })
      .from(policyRules)
      .where(eq(policyRules.ruleKey, rule.ruleKey))
      .get();

    if (existing) {
      // Refresh the effective date on statically-seeded rows that predate the
      // fix (they carry their seed-run timestamp). Only rows the Hunter
      // pipeline has never touched: version 1 and unsigned.
      if (
        existing.version === 1 &&
        existing.signature === 'unsigned' &&
        existing.effectiveDate !== TSC_2017_EFFECTIVE_DATE
      ) {
        db.update(policyRules)
          .set({ effectiveDate: TSC_2017_EFFECTIVE_DATE, updatedAt: now })
          .where(eq(policyRules.id, existing.id))
          .run();
        refreshed++;
      } else {
        skipped++;
      }
      continue;
    }

    // Resolve sourceId from source name
    const sourceId = sourceByName.get(rule.sourceName);
    if (!sourceId) {
      logger.warn({ sourceName: rule.sourceName, ruleKey: rule.ruleKey },
        'Skipping SOC 2 rule: regulatory source not found in database');
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
      // 2017 TSC (TSP §100) mandatory date for SOC 2 reports.
      effectiveDate: TSC_2017_EFFECTIVE_DATE,
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

  if (created > 0 || refreshed > 0) {
    logger.info({ created, skipped, refreshed }, 'Seeded SOC 2 Trust Service Criteria rules');
  }

  return { created, skipped };
}

/** Exported for testing */
export const SOC2_RULE_DEFINITIONS = SOC2_RULES;

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { policyRules, regulatorySources } from './schema.js';
import type * as schema from './schema.js';
import { logger } from '../logger.js';

/**
 * GLBA (Gramm-Leach-Bliley Act) Safeguards Rule — 16 CFR Part 314.
 *
 * Protects consumer financial information held by financial institutions.
 * The 2021 amendments (effective June 2023) significantly expanded requirements
 * for information security programs, including AI systems that process
 * customer financial data.
 *
 * Idempotent — uses ruleKey unique index to skip existing rules.
 */

interface GlbaRule {
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

const GLBA_RULES: GlbaRule[] = [
  // ─── § 314.4 — Information security program ─────────────────────
  {
    ruleKey: 'glba.314_4.info_security_program',
    sourceName: 'GLBA (Gramm-Leach-Bliley Act) Safeguards Rule',
    jurisdiction: 'US-FED',
    category: 'security',
    conditions: JSON.stringify({ action: 'contains_pii', sector: 'finance', region: 'US-FED' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'GLBA Safeguards Rule requires financial institutions to develop, implement, and maintain a comprehensive information security program. AI systems handling customer financial information must be included in the security program scope.',
    legalReference: '16 CFR § 314.4 — Elements of an information security program',
    industries: JSON.stringify(['finance']),
    industryScope: 'sector_specific',
  },

  // ─── § 314.4(c) — Risk assessment ──────────────────────────────
  {
    ruleKey: 'glba.314_4c.risk_assessment',
    sourceName: 'GLBA (Gramm-Leach-Bliley Act) Safeguards Rule',
    jurisdiction: 'US-FED',
    category: 'risk_assessment',
    conditions: JSON.stringify({ action: 'processes_user_input', sector: 'finance', region: 'US-FED' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'GLBA requires periodic risk assessments for systems handling customer information. AI systems processing financial customer data must undergo risk assessment covering confidentiality, integrity, and availability threats.',
    legalReference: '16 CFR § 314.4(c) — Risk assessment requirements',
    industries: JSON.stringify(['finance']),
    industryScope: 'sector_specific',
  },

  // ─── § 314.4(d)(2) — Access controls ───────────────────────────
  {
    ruleKey: 'glba.314_4d.access_controls',
    sourceName: 'GLBA (Gramm-Leach-Bliley Act) Safeguards Rule',
    jurisdiction: 'US-FED',
    category: 'security',
    conditions: JSON.stringify({ action: 'handles_financial', region: 'US-FED' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'GLBA requires access controls limiting who can access customer financial information. AI systems must implement authentication, authorization, and least-privilege access to financial data.',
    legalReference: '16 CFR § 314.4(d)(2) — Access controls',
    industries: JSON.stringify(['finance']),
    industryScope: 'sector_specific',
  },

  // ─── § 314.4(d)(3) — Encryption ────────────────────────────────
  {
    ruleKey: 'glba.314_4d.encryption',
    sourceName: 'GLBA (Gramm-Leach-Bliley Act) Safeguards Rule',
    jurisdiction: 'US-FED',
    category: 'security',
    conditions: JSON.stringify({ action: 'sends_to_third_party', sector: 'finance', region: 'US-FED' }),
    effect: 'deny',
    severity: 'critical',
    humanSummary:
      'GLBA requires encryption of customer information in transit and at rest. AI outputs containing financial customer data sent to third parties must use encryption meeting current standards.',
    legalReference: '16 CFR § 314.4(d)(3) — Encryption of customer information',
    industries: JSON.stringify(['finance']),
    industryScope: 'sector_specific',
  },

  // ─── § 314.4(f) — Service provider oversight ───────────────────
  {
    ruleKey: 'glba.314_4f.service_provider_oversight',
    sourceName: 'GLBA (Gramm-Leach-Bliley Act) Safeguards Rule',
    jurisdiction: 'US-FED',
    category: 'accountability',
    conditions: JSON.stringify({ action: 'sends_to_third_party', sector: 'finance', region: 'US-FED' }),
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary:
      'GLBA requires financial institutions to oversee service providers handling customer information. Third-party AI API providers must be contractually required to maintain appropriate safeguards.',
    legalReference: '16 CFR § 314.4(f) — Overseeing service providers',
    industries: JSON.stringify(['finance']),
    industryScope: 'sector_specific',
  },

  // ─── § 314.4(d) — Financial data in logs ───────────────────────
  {
    ruleKey: 'glba.314.financial_in_logs',
    sourceName: 'GLBA (Gramm-Leach-Bliley Act) Safeguards Rule',
    jurisdiction: 'US-FED',
    category: 'security',
    conditions: JSON.stringify({ action: 'logs_pii', sector: 'finance', region: 'US-FED' }),
    effect: 'deny',
    severity: 'critical',
    humanSummary:
      'Financial customer information detected in application logs. GLBA prohibits unauthorized disclosure of customer financial information. Log statements must not contain account numbers, SSNs, or financial transaction details.',
    legalReference: '16 CFR § 314.4(d) — Safeguards design and implementation',
    industries: JSON.stringify(['finance']),
    industryScope: 'sector_specific',
  },
];

// ─── Seed Function ─────────────────────────────────────────────────

/**
 * Seed GLBA Safeguards Rule rules into the policy_rules table.
 *
 * Idempotent: skips any rule whose ruleKey already exists (unique index).
 * Looks up sourceId by matching source name in regulatory_sources table.
 *
 * @returns Count of rules created and skipped.
 */
export function seedGlbaRules(db: BetterSQLite3Database<typeof schema>): { created: number; skipped: number } {
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

  for (const rule of GLBA_RULES) {
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
        'Skipping GLBA rule: regulatory source not found in database');
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
      // FTC Safeguards Rule amendments (16 CFR 314) compliance date.
      effectiveDate: '2023-06-09',
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
    logger.info({ created, skipped }, 'Seeded GLBA Safeguards Rule rules');
  }

  return { created, skipped };
}

/** Exported for testing */
export const GLBA_RULE_DEFINITIONS = GLBA_RULES;

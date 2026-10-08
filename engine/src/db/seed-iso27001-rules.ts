import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { policyRules, regulatorySources } from './schema.js';
import { logger } from '../logger.js';

/**
 * ISO 27001:2022 Annex A control rules for AI system security.
 *
 * Maps publicly known Annex A control numbers to AI-specific detector
 * capabilities. Covers information security policies, asset management,
 * data protection, cryptography, and secure development.
 *
 * Idempotent — skips any rule whose ruleKey already exists (unique index).
 */

interface Iso27001Rule {
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

const ISO27001_RULES: Iso27001Rule[] = [
  // ─── A.5 — Organizational Controls ──────────────────────────────

  {
    ruleKey: 'iso27001.annex_a.5_1.information_security_policy',
    sourceName: 'ISO 27001 Summary (Information Security)',
    jurisdiction: 'INTL',
    category: 'accountability',
    conditions: JSON.stringify({ action: 'text_generation' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'ISO 27001 A.5.1 requires information security policies to be defined, approved by management, and communicated to relevant personnel. AI systems must operate within the scope of documented information security policies covering acceptable use and risk tolerance.',
    legalReference: 'ISO/IEC 27001:2022 Annex A — A.5.1: Policies for information security',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'iso27001.annex_a.5_31.legal_statutory_requirements',
    sourceName: 'ISO 27001 Summary (Information Security)',
    jurisdiction: 'INTL',
    category: 'accountability',
    conditions: JSON.stringify({ action: 'text_generation' }),
    effect: 'allow_with_audit',
    severity: 'medium',
    humanSummary:
      'ISO 27001 A.5.31 requires identification and documentation of legal, statutory, regulatory, and contractual requirements relevant to information security. AI system deployments must be mapped to applicable legal obligations with compliance evidence maintained.',
    legalReference: 'ISO/IEC 27001:2022 Annex A — A.5.31: Legal, statutory, regulatory and contractual requirements',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── A.8 — Technology Controls ──────────────────────────────────

  {
    ruleKey: 'iso27001.annex_a.8_2.asset_classification',
    sourceName: 'ISO 27001 Summary (Information Security)',
    jurisdiction: 'INTL',
    category: 'risk_assessment',
    conditions: JSON.stringify({ action: 'stores_ai_output' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'ISO 27001 A.8.2 requires information assets to be classified according to sensitivity and criticality. AI models, training datasets, and generated outputs are information assets that must be inventoried and classified with appropriate handling requirements.',
    legalReference: 'ISO/IEC 27001:2022 Annex A — A.8.2: Information classification',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'iso27001.annex_a.8_9.configuration_management',
    sourceName: 'ISO 27001 Summary (Information Security)',
    jurisdiction: 'INTL',
    category: 'safety',
    conditions: JSON.stringify({ action: 'text_generation' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'ISO 27001 A.8.9 requires configurations of hardware, software, services, and networks to be established, documented, and maintained. AI model configurations, hyperparameters, and deployment settings must be version-controlled with change management procedures.',
    legalReference: 'ISO/IEC 27001:2022 Annex A — A.8.9: Configuration management',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'iso27001.annex_a.8_10.information_deletion',
    sourceName: 'ISO 27001 Summary (Information Security)',
    jurisdiction: 'INTL',
    category: 'data_governance',
    conditions: JSON.stringify({ action: 'stores_ai_output' }),
    effect: 'allow_with_audit',
    severity: 'medium',
    humanSummary:
      'ISO 27001 A.8.10 requires that information stored in systems and devices is deleted when no longer required. AI training data, model outputs, and cached inferences must have defined retention periods with verifiable deletion procedures.',
    legalReference: 'ISO/IEC 27001:2022 Annex A — A.8.10: Information deletion',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'iso27001.annex_a.8_11.data_masking',
    sourceName: 'ISO 27001 Summary (Information Security)',
    jurisdiction: 'INTL',
    category: 'privacy',
    conditions: JSON.stringify({ action: 'contains_pii' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'ISO 27001 A.8.11 requires data masking in accordance with access control policies and business requirements. Personal data and sensitive information flowing through AI pipelines must be masked or pseudonymized to limit exposure to authorized processing purposes.',
    legalReference: 'ISO/IEC 27001:2022 Annex A — A.8.11: Data masking',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'iso27001.annex_a.8_12.data_leakage_prevention',
    sourceName: 'ISO 27001 Summary (Information Security)',
    jurisdiction: 'INTL',
    category: 'security',
    conditions: JSON.stringify({ action: 'sends_to_third_party' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'ISO 27001 A.8.12 requires data leakage prevention measures for systems, networks, and devices that process or store sensitive information. AI systems sending data to external APIs or third-party models must have DLP controls preventing unauthorized information disclosure.',
    legalReference: 'ISO/IEC 27001:2022 Annex A — A.8.12: Data leakage prevention',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'iso27001.annex_a.8_24.use_of_cryptography',
    sourceName: 'ISO 27001 Summary (Information Security)',
    jurisdiction: 'INTL',
    category: 'security',
    conditions: JSON.stringify({ action: 'sends_to_third_party' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'ISO 27001 A.8.24 requires effective use of cryptography including key management. AI API communications and model data transfers must use encryption in transit (TLS 1.2+) and at rest, with cryptographic key lifecycle management documented.',
    legalReference: 'ISO/IEC 27001:2022 Annex A — A.8.24: Use of cryptography',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'iso27001.annex_a.8_25.secure_development_lifecycle',
    sourceName: 'ISO 27001 Summary (Information Security)',
    jurisdiction: 'INTL',
    category: 'safety',
    conditions: JSON.stringify({ action: 'text_generation' }),
    effect: 'allow_with_audit',
    severity: 'medium',
    humanSummary:
      'ISO 27001 A.8.25 requires rules for secure development of software and systems to be established and applied. AI model development, training pipelines, and integration code must follow a secure development lifecycle with security testing at each stage.',
    legalReference: 'ISO/IEC 27001:2022 Annex A — A.8.25: Secure development life cycle',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'iso27001.annex_a.8_28.secure_coding',
    sourceName: 'ISO 27001 Summary (Information Security)',
    jurisdiction: 'INTL',
    category: 'security',
    conditions: JSON.stringify({ action: 'processes_user_input' }),
    effect: 'allow_with_audit',
    severity: 'medium',
    humanSummary:
      'ISO 27001 A.8.28 requires secure coding principles to be applied to software development. AI integration code must follow secure coding practices including input validation, output encoding, prompt injection prevention, and safe handling of model responses.',
    legalReference: 'ISO/IEC 27001:2022 Annex A — A.8.28: Secure coding',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'iso27001.annex_a.8_16.monitoring_activities',
    sourceName: 'ISO 27001 Summary (Information Security)',
    jurisdiction: 'INTL',
    category: 'accountability',
    conditions: JSON.stringify({ action: 'returns_ai_to_user' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'ISO 27001 A.8.16 requires monitoring of networks, systems, and applications for anomalous behavior. AI system outputs and usage patterns must be monitored for security anomalies including unexpected model behavior, prompt injection attempts, and data exfiltration.',
    legalReference: 'ISO/IEC 27001:2022 Annex A — A.8.16: Monitoring activities',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
];

// ─── Seed Function ─────────────────────────────────────────────────

/**
 * Seed ISO 27001:2022 Annex A rules into the policy_rules table.
 *
 * Idempotent: skips any rule whose ruleKey already exists (unique index).
 * Looks up sourceId by matching source name in regulatory_sources table.
 *
 * @returns Count of rules created and skipped.
 */
export function seedIso27001Rules(db: BetterSQLite3Database<typeof schema>): { created: number; skipped: number } {
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

  for (const rule of ISO27001_RULES) {
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
        'Skipping ISO 27001 rule: regulatory source not found in database');
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
      // ISO/IEC 27001:2022 publication date.
      effectiveDate: '2022-10-25',
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
    logger.info({ created, skipped }, 'Seeded ISO 27001:2022 Annex A rules');
  }

  return { created, skipped };
}

/** Exported for testing */
export const ISO27001_RULE_DEFINITIONS = ISO27001_RULES;

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { policyRules, regulatorySources } from './schema.js';
import { logger } from '../logger.js';

/**
 * NIST AI Risk Management Framework (AI RMF 1.0) rules.
 *
 * Covers all 4 core functions: GOVERN, MAP, MEASURE, MANAGE.
 * Each rule maps to a real NIST AI RMF subcategory ID.
 *
 * Idempotent — skips any rule whose ruleKey already exists (unique index).
 */

interface NistRule {
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

const NIST_RULES: NistRule[] = [
  // ─── GOVERN Function ─────────────────────────────────────────────

  {
    ruleKey: 'nist_ai_rmf.govern_1_1.legal_compliance',
    sourceName: 'NIST AI Risk Management Framework',
    jurisdiction: 'US-FED',
    category: 'accountability',
    conditions: JSON.stringify({ action: 'text_generation', region: 'US-FED' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'NIST AI RMF GOVERN 1.1 requires organizations to identify legal and regulatory requirements applicable to their AI systems. AI deployments must be mapped to applicable regulations and compliance obligations documented.',
    legalReference: 'NIST AI RMF 1.0 — GOVERN 1.1: Legal and regulatory requirements and compliance obligations',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'nist_ai_rmf.govern_1_2.trustworthy_ai',
    sourceName: 'NIST AI Risk Management Framework',
    jurisdiction: 'US-FED',
    category: 'accountability',
    conditions: JSON.stringify({ action: 'text_generation', region: 'US-FED' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'NIST AI RMF GOVERN 1.2 requires that trustworthy AI characteristics are integrated into organizational policies, processes, and procedures. Organizations must define and document acceptable risk thresholds for AI systems.',
    legalReference: 'NIST AI RMF 1.0 — GOVERN 1.2: Trustworthy AI characteristics integrated into policies',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'nist_ai_rmf.govern_2_1.roles_responsibilities',
    sourceName: 'NIST AI Risk Management Framework',
    jurisdiction: 'US-FED',
    category: 'human_oversight',
    conditions: JSON.stringify({ action: 'high_risk_employment', region: 'US-FED' }),
    effect: 'allow_with_audit',
    severity: 'medium',
    humanSummary:
      'NIST AI RMF GOVERN 2.1 requires clearly defined roles, responsibilities, and lines of authority for AI risk management. Personnel involved in AI system lifecycle must have accountability structures in place.',
    legalReference: 'NIST AI RMF 1.0 — GOVERN 2.1: Roles, responsibilities, and authority for AI risk management',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── MAP Function ────────────────────────────────────────────────

  {
    ruleKey: 'nist_ai_rmf.map_1_1.intended_purpose',
    sourceName: 'NIST AI Risk Management Framework',
    jurisdiction: 'US-FED',
    category: 'transparency',
    conditions: JSON.stringify({ action: 'processes_user_input', region: 'US-FED' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'NIST AI RMF MAP 1.1 requires that the intended purpose, potential beneficial uses, and context of use of the AI system are documented. System requirements must be clearly specified before deployment.',
    legalReference: 'NIST AI RMF 1.0 — MAP 1.1: Intended purposes, potentially beneficial uses, context of use',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'nist_ai_rmf.map_2_3.dataset_bias',
    sourceName: 'NIST AI Risk Management Framework',
    jurisdiction: 'US-FED',
    category: 'fairness',
    conditions: JSON.stringify({ action: 'processes_user_input', region: 'US-FED' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'NIST AI RMF MAP 2.3 requires assessment of AI data and models for representativeness, relevance, and bias. Training and evaluation datasets must be examined for sources of bias that could produce inequitable outcomes.',
    legalReference: 'NIST AI RMF 1.0 — MAP 2.3: AI system data and models examined for bias',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'nist_ai_rmf.map_3_4.third_party_risks',
    sourceName: 'NIST AI Risk Management Framework',
    jurisdiction: 'US-FED',
    category: 'risk_assessment',
    conditions: JSON.stringify({ action: 'sends_to_third_party', region: 'US-FED' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'NIST AI RMF MAP 3.4 requires identification and assessment of risks arising from third-party AI components, data, and services. Third-party AI dependencies must be inventoried with associated risk profiles documented.',
    legalReference: 'NIST AI RMF 1.0 — MAP 3.4: Risks due to third-party entities identified and assessed',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'nist_ai_rmf.map_5_1.ai_system_impacts',
    sourceName: 'NIST AI Risk Management Framework',
    jurisdiction: 'US-FED',
    category: 'risk_assessment',
    conditions: JSON.stringify({ action: 'processes_user_input', region: 'US-FED' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'NIST AI RMF MAP 5.1 requires identification of potential positive and negative impacts of the AI system on individuals, groups, communities, organizations, and society. Impact assessments must be documented prior to deployment.',
    legalReference: 'NIST AI RMF 1.0 — MAP 5.1: Potential impacts on individuals, communities, and society',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── MEASURE Function ───────────────────────────────────────────

  {
    ruleKey: 'nist_ai_rmf.measure_1_1.risk_metrics',
    sourceName: 'NIST AI Risk Management Framework',
    jurisdiction: 'US-FED',
    category: 'risk_assessment',
    conditions: JSON.stringify({ action: 'returns_ai_to_user', region: 'US-FED' }),
    effect: 'allow_with_audit',
    severity: 'medium',
    humanSummary:
      'NIST AI RMF MEASURE 1.1 requires that appropriate methods and metrics are identified and applied to quantify AI risks. Risk measurement approaches must be documented and validated for the specific context of use.',
    legalReference: 'NIST AI RMF 1.0 — MEASURE 1.1: AI risks and benefits characterized and quantified',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'nist_ai_rmf.measure_2_6.performance_monitoring',
    sourceName: 'NIST AI Risk Management Framework',
    jurisdiction: 'US-FED',
    category: 'safety',
    conditions: JSON.stringify({ action: 'returns_ai_to_user', region: 'US-FED' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'NIST AI RMF MEASURE 2.6 requires ongoing monitoring of AI system performance including accuracy, fairness, reliability, and robustness metrics. Measurable performance thresholds must be defined and tracked over time.',
    legalReference: 'NIST AI RMF 1.0 — MEASURE 2.6: AI system performance evaluated regularly',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── MANAGE Function ────────────────────────────────────────────

  {
    ruleKey: 'nist_ai_rmf.manage_1_1.risk_treatment',
    sourceName: 'NIST AI Risk Management Framework',
    jurisdiction: 'US-FED',
    category: 'risk_assessment',
    conditions: JSON.stringify({ action: 'stores_ai_output', region: 'US-FED' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'NIST AI RMF MANAGE 1.1 requires development and documentation of risk treatment plans for identified AI risks. Plans must describe risk response actions including mitigation, transfer, avoidance, or acceptance with rationale.',
    legalReference: 'NIST AI RMF 1.0 — MANAGE 1.1: AI risk treatment plans developed and implemented',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'nist_ai_rmf.manage_2_2.incident_response',
    sourceName: 'NIST AI Risk Management Framework',
    jurisdiction: 'US-FED',
    category: 'safety',
    conditions: JSON.stringify({ action: 'stores_ai_output', region: 'US-FED' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'NIST AI RMF MANAGE 2.2 requires AI incident response and recovery plans. Organizations must have documented procedures for detecting, reporting, and responding to AI-related incidents including model failures and unintended outputs.',
    legalReference: 'NIST AI RMF 1.0 — MANAGE 2.2: AI incident response and recovery plans',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'nist_ai_rmf.manage_3_1.pre_deployment_testing',
    sourceName: 'NIST AI Risk Management Framework',
    jurisdiction: 'US-FED',
    category: 'safety',
    conditions: JSON.stringify({ action: 'high_risk_critical_infra', region: 'US-FED' }),
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary:
      'NIST AI RMF MANAGE 3.1 requires pre-deployment testing and validation of AI systems. Testing must evaluate system behavior under expected and stressed conditions, with results documented and reviewed before deployment authorization.',
    legalReference: 'NIST AI RMF 1.0 — MANAGE 3.1: Pre-deployment testing performed and documented',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'nist_ai_rmf.manage_4_1.post_deployment_monitoring',
    sourceName: 'NIST AI Risk Management Framework',
    jurisdiction: 'US-FED',
    category: 'accountability',
    conditions: JSON.stringify({ action: 'stores_ai_output', region: 'US-FED' }),
    effect: 'allow_with_audit',
    severity: 'medium',
    humanSummary:
      'NIST AI RMF MANAGE 4.1 requires ongoing post-deployment monitoring of AI systems. Deployed systems must be monitored for performance degradation, emergent risks, and changes in context of use that may alter the risk profile.',
    legalReference: 'NIST AI RMF 1.0 — MANAGE 4.1: Post-deployment AI system monitoring implemented',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
];

// ─── Seed Function ─────────────────────────────────────────────────

/**
 * Seed NIST AI RMF rules into the policy_rules table.
 *
 * Idempotent: skips any rule whose ruleKey already exists (unique index).
 * Looks up sourceId by matching source name in regulatory_sources table.
 *
 * @returns Count of rules created and skipped.
 */
export function seedNistRules(db: BetterSQLite3Database<typeof schema>): { created: number; skipped: number } {
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

  for (const rule of NIST_RULES) {
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
        'Skipping NIST AI RMF rule: regulatory source not found in database');
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
      // NIST AI RMF 1.0 release date.
      effectiveDate: '2023-01-26',
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
    logger.info({ created, skipped }, 'Seeded NIST AI RMF rules (GOVERN, MAP, MEASURE, MANAGE)');
  }

  return { created, skipped };
}

/** Exported for testing */
export const NIST_RULE_DEFINITIONS = NIST_RULES;

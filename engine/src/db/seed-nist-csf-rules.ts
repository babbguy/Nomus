import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = BetterSQLite3Database<any>;
import { policyRules, regulatorySources } from './schema.js';
import { logger } from '../logger.js';

/**
 * NIST Cybersecurity Framework 2.0 rules.
 * Maps the 6 CSF functions (GOVERN, IDENTIFY, PROTECT, DETECT, RESPOND, RECOVER)
 * to AI system capabilities.
 *
 * Idempotent — skips any rule whose ruleKey already exists.
 */

interface NistCsfRule {
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

const NIST_CSF_RULES: NistCsfRule[] = [
  // ─── GOVERN (GV) — Organizational context and risk strategy ───
  {
    ruleKey: 'nist_csf.gv_rm.risk_strategy',
    sourceName: 'NIST Cybersecurity Framework 2.0',
    jurisdiction: 'NIST',
    category: 'risk_assessment',
    conditions: JSON.stringify({ action: 'ai_operation' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'NIST CSF GV.RM requires organizations to establish and communicate a cybersecurity risk management strategy. AI systems should be included in the organizational risk register with defined risk appetite, tolerances, and treatment plans for AI-specific risks including model failure, adversarial attack, and data poisoning.',
    legalReference: 'NIST CSF 2.0 — GV.RM: Risk Management Strategy',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── IDENTIFY (ID) — Asset management ─────────────────────────
  {
    ruleKey: 'nist_csf.id_am.asset_management',
    sourceName: 'NIST Cybersecurity Framework 2.0',
    jurisdiction: 'NIST',
    category: 'accountability',
    conditions: JSON.stringify({ action: 'text_generation' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'NIST CSF ID.AM requires identification and management of all technology assets. AI models, training datasets, inference endpoints, and associated infrastructure must be inventoried, classified by criticality, and assigned ownership. Model versioning and lineage tracking support asset management objectives.',
    legalReference: 'NIST CSF 2.0 — ID.AM: Asset Management',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── PROTECT (PR) — Data security ─────────────────────────────
  {
    ruleKey: 'nist_csf.pr_ds.data_security',
    sourceName: 'NIST Cybersecurity Framework 2.0',
    jurisdiction: 'NIST',
    category: 'security',
    conditions: JSON.stringify({ action: 'contains_secret' }),
    effect: 'deny',
    severity: 'critical',
    humanSummary:
      'NIST CSF PR.DS requires protection of data confidentiality, integrity, and availability. Secrets (API keys, passwords, tokens, private keys) in source code violate data security controls. Credentials must be stored in approved secrets management solutions with access controls and rotation policies.',
    legalReference: 'NIST CSF 2.0 — PR.DS: Data Security',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'nist_csf.pr_ds.pii_protection',
    sourceName: 'NIST Cybersecurity Framework 2.0',
    jurisdiction: 'NIST',
    category: 'security',
    conditions: JSON.stringify({ action: 'contains_pii' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'NIST CSF PR.DS requires data-at-rest and data-in-transit protections. Personally identifiable information processed by AI systems must be encrypted, access-controlled, and subject to data loss prevention controls. Ensure AI model inputs and outputs containing PII are protected throughout the processing lifecycle.',
    legalReference: 'NIST CSF 2.0 — PR.DS: Data Security; PR.DS-01, PR.DS-02',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── PROTECT (PR) — Access control ────────────────────────────
  {
    ruleKey: 'nist_csf.pr_aa.access_control',
    sourceName: 'NIST Cybersecurity Framework 2.0',
    jurisdiction: 'NIST',
    category: 'security',
    conditions: JSON.stringify({ action: 'processes_user_input' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'NIST CSF PR.AA requires identity management, authentication, and access control. AI systems accepting user input must implement proper authentication, authorization, and input validation. Ensure least-privilege access to AI model endpoints and audit all inference requests.',
    legalReference: 'NIST CSF 2.0 — PR.AA: Identity Management, Authentication, and Access Control',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── DETECT (DE) — Continuous monitoring ──────────────────────
  {
    ruleKey: 'nist_csf.de_cm.continuous_monitoring',
    sourceName: 'NIST Cybersecurity Framework 2.0',
    jurisdiction: 'NIST',
    category: 'security',
    conditions: JSON.stringify({ action: 'returns_ai_to_user' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'NIST CSF DE.CM requires continuous monitoring of assets for anomalies and potential cybersecurity events. AI systems returning outputs to users should be monitored for anomalous behavior including unexpected outputs, model drift, adversarial manipulation, and prompt injection indicators.',
    legalReference: 'NIST CSF 2.0 — DE.CM: Continuous Monitoring',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── RESPOND (RS) — Incident analysis ─────────────────────────
  {
    ruleKey: 'nist_csf.rs_an.incident_analysis',
    sourceName: 'NIST Cybersecurity Framework 2.0',
    jurisdiction: 'NIST',
    category: 'accountability',
    conditions: JSON.stringify({ action: 'logs_ai_output' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'NIST CSF RS.AN requires investigation and analysis of detected cybersecurity incidents. AI system logs must capture sufficient detail for forensic analysis including input prompts, model versions, output content, and user context. Retain AI audit logs per organizational retention policies to support incident investigation.',
    legalReference: 'NIST CSF 2.0 — RS.AN: Incident Analysis',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── RECOVER (RC) — Incident recovery ─────────────────────────
  {
    ruleKey: 'nist_csf.rc_rp.recovery_planning',
    sourceName: 'NIST Cybersecurity Framework 2.0',
    jurisdiction: 'NIST',
    category: 'safety',
    conditions: JSON.stringify({ action: 'high_risk_critical_infra' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'NIST CSF RC.RP requires recovery planning and execution to restore systems affected by cybersecurity incidents. AI systems managing critical infrastructure must have documented recovery procedures including model rollback plans, fallback to non-AI operation, data restoration procedures, and tested recovery time objectives.',
    legalReference: 'NIST CSF 2.0 — RC.RP: Incident Recovery Plan Execution',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
];

// ─── Seed Function ─────────────────────────────────────────────────

/**
 * Seed NIST CSF 2.0 rules into the policy_rules table.
 *
 * Idempotent: skips any rule whose ruleKey already exists (unique index).
 * Looks up sourceId by matching source name in regulatory_sources table.
 */
export function seedNistCsfRules(db: AnyDb): { created: number; skipped: number } {
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

  for (const rule of NIST_CSF_RULES) {
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
        'Skipping NIST CSF rule: regulatory source not found in database');
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
      // NIST CSF 2.0 release date.
      effectiveDate: '2024-02-26',
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
    logger.info({ created, skipped }, 'Seeded NIST CSF 2.0 rules (Cybersecurity Framework)');
  }

  return { created, skipped };
}

/** Exported for testing */
export const NIST_CSF_RULE_DEFINITIONS = NIST_CSF_RULES;

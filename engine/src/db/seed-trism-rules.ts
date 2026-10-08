import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = BetterSQLite3Database<any>;
import { policyRules, regulatorySources } from './schema.js';
import { logger } from '../logger.js';

/**
 * Gartner AI TRiSM (Trust, Risk, and Security Management) framework rules.
 * Covers the 4 pillars: Explainability, ModelOps, AI Application Security, Privacy.
 *
 * TRiSM is a Gartner framework, not a regulation — all rules use 'flag' effect.
 * Idempotent — skips any rule whose ruleKey already exists.
 */

interface TrismRule {
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
 * TRiSM effective-date anchor.
 * Gartner AI TRiSM is a vendor framework, not law — no legal effective date
 * exists. The policy_rules.effective_date column is NOT NULL, and this
 * repo's convention for non-regulatory frameworks is to carry the
 * framework's publication date (NIST AI RMF 1.0 → 2023-01-26, NIST CSF 2.0
 * → 2024-02-26, ISO 27001:2022 → 2022-10-25). Anchor: Gartner, "Market
 * Guide for AI Trust, Risk and Security Management" (Avivah Litan, Farhan
 * Choudhary, Jeremy D'Hoinne), published 2021-09-01 — the research that
 * defined the four TRiSM pillars these rules cite. Publication date, NOT a
 * legal application date, and never the seed-run timestamp.
 * Citation confirmed via Gartner-licensed vendor reprint announcements,
 * e.g. https://arize.com/blog/arize-ai-listed-in-gartner-market-guide/
 */
export const TRISM_PUBLICATION_DATE = '2021-09-01';

// ─── Rule Definitions ──────────────────────────────────────────────

const TRISM_RULES: TrismRule[] = [
  // ─── Pillar 1: Explainability / Model Monitoring ──────────────
  {
    ruleKey: 'trism.explainability.model_monitoring',
    sourceName: 'Gartner AI TRiSM Framework',
    jurisdiction: 'INTL',
    category: 'transparency',
    conditions: JSON.stringify({ action: 'returns_ai_to_user' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'TRiSM framework recommends AI model monitoring and explainability. AI outputs delivered to users should be accompanied by explanation capabilities and monitored for drift, bias, and anomalous outputs.',
    legalReference: 'Gartner AI TRiSM — Explainability and Model Monitoring pillar',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'trism.explainability.bias_detection',
    sourceName: 'Gartner AI TRiSM Framework',
    jurisdiction: 'INTL',
    category: 'fairness',
    conditions: JSON.stringify({ action: 'high_risk_employment' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'TRiSM recommends continuous bias detection and fairness monitoring for AI systems making consequential decisions. Employment-related AI should implement fairness metrics, disparate impact testing, and bias mitigation strategies across protected demographic groups.',
    legalReference: 'Gartner AI TRiSM — Explainability pillar; Bias and Fairness monitoring',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── Pillar 2: ModelOps (AI model lifecycle) ──────────────────
  {
    ruleKey: 'trism.modelops.lifecycle',
    sourceName: 'Gartner AI TRiSM Framework',
    jurisdiction: 'INTL',
    category: 'accountability',
    conditions: JSON.stringify({ action: 'text_generation' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'TRiSM recommends ModelOps practices for AI system lifecycle management including model versioning, deployment pipelines, A/B testing, rollback capabilities, and continuous integration of ML models.',
    legalReference: 'Gartner AI TRiSM — ModelOps pillar',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'trism.modelops.inventory',
    sourceName: 'Gartner AI TRiSM Framework',
    jurisdiction: 'INTL',
    category: 'accountability',
    conditions: JSON.stringify({ action: 'ai_operation' }),
    effect: 'flag',
    severity: 'low',
    humanSummary:
      'TRiSM recommends maintaining a comprehensive AI model inventory tracking all deployed models, their versions, training data lineage, performance baselines, and responsible owners. Organizations should implement model registries for governance and auditability.',
    legalReference: 'Gartner AI TRiSM — ModelOps pillar; AI Model Inventory management',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── Pillar 3: AI Application Security ────────────────────────
  {
    ruleKey: 'trism.security.application',
    sourceName: 'Gartner AI TRiSM Framework',
    jurisdiction: 'INTL',
    category: 'security',
    conditions: JSON.stringify({ action: 'processes_user_input' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'TRiSM framework identifies AI-specific attack surfaces including prompt injection, data poisoning, model inversion, and adversarial inputs. AI systems processing external input should implement input validation and adversarial robustness measures.',
    legalReference: 'Gartner AI TRiSM — AI Application Security pillar',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'trism.security.supply_chain',
    sourceName: 'Gartner AI TRiSM Framework',
    jurisdiction: 'INTL',
    category: 'security',
    conditions: JSON.stringify({ action: 'sends_to_third_party' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'TRiSM recommends securing the AI supply chain including third-party model providers, training data sources, and inference APIs. Organizations should assess vendor security posture, implement model provenance tracking, and maintain contractual security requirements for AI service providers.',
    legalReference: 'Gartner AI TRiSM — AI Application Security pillar; Supply chain risk',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── Pillar 4: Privacy ────────────────────────────────────────
  {
    ruleKey: 'trism.privacy.data_protection',
    sourceName: 'Gartner AI TRiSM Framework',
    jurisdiction: 'INTL',
    category: 'privacy',
    conditions: JSON.stringify({ action: 'contains_pii' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'TRiSM recommends privacy-preserving techniques for AI including differential privacy, federated learning, synthetic data, and data minimization. AI systems handling personal data should implement privacy-by-design principles.',
    legalReference: 'Gartner AI TRiSM — Privacy pillar',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'trism.privacy.training_data',
    sourceName: 'Gartner AI TRiSM Framework',
    jurisdiction: 'INTL',
    category: 'privacy',
    conditions: JSON.stringify({ action: 'stores_ai_output' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'TRiSM recommends data governance for AI training and output data. Stored AI outputs may contain memorized personal data from training sets. Organizations should implement output filtering, data retention policies, and audit AI outputs for unintended personal data leakage.',
    legalReference: 'Gartner AI TRiSM — Privacy pillar; Training data governance',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
];

// ─── Seed Function ─────────────────────────────────────────────────

/**
 * Seed TRiSM rules into the policy_rules table.
 *
 * Idempotent: skips any rule whose ruleKey already exists (unique index).
 * Looks up sourceId by matching source name in regulatory_sources table.
 */
export function seedTrismRules(db: AnyDb): { created: number; skipped: number } {
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

  for (const rule of TRISM_RULES) {
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
        existing.effectiveDate !== TRISM_PUBLICATION_DATE
      ) {
        db.update(policyRules)
          .set({ effectiveDate: TRISM_PUBLICATION_DATE, updatedAt: now })
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
        'Skipping TRiSM rule: regulatory source not found in database');
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
      // Gartner AI TRiSM Market Guide publication date — vendor framework,
      // not law; see TRISM_PUBLICATION_DATE for the semantics.
      effectiveDate: TRISM_PUBLICATION_DATE,
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
    logger.info({ created, skipped, refreshed }, 'Seeded TRiSM rules (Gartner AI Trust, Risk, and Security Management)');
  }

  return { created, skipped };
}

/** Exported for testing */
export const TRISM_RULE_DEFINITIONS = TRISM_RULES;

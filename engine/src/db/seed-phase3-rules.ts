import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './schema.js';
import { policyRules, regulatorySources } from './schema.js';
import { logger } from '../logger.js';

/**
 * Phase 3 detector rules: HIPAA (P9-P10), GDPR (P11, D7-D8),
 * PCI DSS (P12), EU AI Act Annex III (R10), plus general data-handling rules.
 *
 * These rules provide the policy_rules entries that match the capability strings
 * emitted by Phase 3 detectors. Without them, detectors find signals but
 * simulate/scan produce no findings.
 *
 * Idempotent — uses INSERT OR IGNORE on the unique ruleKey index.
 */

interface Phase3Rule {
  ruleKey: string;
  /** Name of the regulatory source in the registry (used to look up sourceId) */
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
  /**
   * The LAW's application date (ISO), when it differs from the framework-level
   * date in FRAMEWORK_EFFECTIVE_DATES. Never the seed-run timestamp
   * effective_date must state when the obligation applies, not when we
   * inserted the row).
   */
  effectiveDate?: string;
}

/**
 * Framework-level application dates by source name.
 * Each date is the obligation's legal compliance/application date:
 *  - HIPAA Privacy Rule compliance date: 2003-04-14 (68 FR 8334)
 *  - HIPAA Security Rule compliance date: 2005-04-20 (68 FR 8334)
 *  - GDPR application date: 2018-05-25 (Art 99(2))
 *  - PCI DSS v4.0 mandatory date: 2024-04-01 (v3.2.1 retired 2024-03-31)
 *  - EU AI Act Annex III high-risk obligations: 2027-12-02 as deferred by the
 *    Digital Omnibus (CELEX 32026R1744, final Council approval 2026-06-29).
 *    Article 50 rules carry their own earlier date (2026-08-02, NOT deferred).
 */
const FRAMEWORK_EFFECTIVE_DATES: Record<string, string> = {
  'HIPAA Privacy Rule': '2003-04-14',
  'HIPAA Security Rule': '2005-04-20',
  'GDPR (EU General Data Protection Regulation)': '2018-05-25',
  'PCI-DSS v4.0 (Requires Registration)': '2024-04-01',
  'EU AI Act': '2027-12-02',
};

/** Art 50 transparency obligations apply from 2026-08-02 (not deferred by the omnibus). */
const EU_AI_ACT_ART50_DATE = '2026-08-02';

// ─── Rule Definitions ──────────────────────────────────────────────

const PHASE3_RULES: Phase3Rule[] = [
  // ─── HIPAA (P9): PHI in AI code paths ────────────────────────────
  {
    ruleKey: 'hipaa.164_502.phi_in_ai_pipeline',
    sourceName: 'HIPAA Privacy Rule',
    jurisdiction: 'US-FED',
    category: 'privacy',
    conditions: JSON.stringify({ action: 'phi_in_ai_call', data_type: 'health', region: 'US-FED' }),
    effect: 'deny',
    severity: 'critical',
    humanSummary:
      'Protected Health Information (PHI) detected flowing into AI model calls. HIPAA requires covered entities to implement safeguards preventing unauthorized PHI disclosure. AI processing of PHI without BAA and proper authorization violates the Privacy Rule.',
    legalReference: '45 CFR \u00a7 164.502(a) \u2014 Uses and disclosures of protected health information: General rules',
    industries: JSON.stringify(['healthcare']),
    industryScope: 'sector_specific',
  },
  {
    ruleKey: 'hipaa.164_502.phi_in_source',
    sourceName: 'HIPAA Privacy Rule',
    jurisdiction: 'US-FED',
    category: 'privacy',
    conditions: JSON.stringify({ action: 'contains_phi', data_type: 'health', region: 'US-FED' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'Protected Health Information patterns detected in source code. Ensure PHI handling complies with HIPAA minimum necessary standard and is covered by appropriate Business Associate Agreements.',
    legalReference: '45 CFR \u00a7 164.502(b) \u2014 Minimum necessary standard',
    industries: JSON.stringify(['healthcare']),
    industryScope: 'sector_specific',
  },

  // ─── HIPAA (P10): PHI in log statements ──────────────────────────
  {
    ruleKey: 'hipaa.164_312.phi_logged',
    sourceName: 'HIPAA Security Rule',
    jurisdiction: 'US-FED',
    category: 'security',
    conditions: JSON.stringify({ action: 'logs_phi', data_type: 'health', region: 'US-FED' }),
    effect: 'deny',
    severity: 'critical',
    humanSummary:
      'PHI detected in application log statements. HIPAA Security Rule requires audit controls and access safeguards for all ePHI. Logging PHI to unprotected outputs creates unauthorized disclosure risk.',
    legalReference: '45 CFR \u00a7 164.312(b) \u2014 Audit controls; \u00a7 164.312(a)(1) \u2014 Access control',
    industries: JSON.stringify(['healthcare']),
    industryScope: 'sector_specific',
  },

  // ─── GDPR (P11): PII in AI pipelines ────────────────────────────
  {
    ruleKey: 'gdpr.art5.pii_in_ai_pipeline',
    sourceName: 'GDPR (EU General Data Protection Regulation)',
    jurisdiction: 'EU',
    category: 'data_governance',
    conditions: JSON.stringify({ action: 'pii_in_ai_call', region: 'EU' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'Personal data detected flowing into AI model calls. GDPR requires lawful basis for processing, data minimization, and purpose limitation. Verify AI processing has legal basis and implements data protection by design.',
    legalReference: 'GDPR Article 5(1)(a-c) \u2014 Principles relating to processing of personal data',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'gdpr.art5.pii_in_source',
    sourceName: 'GDPR (EU General Data Protection Regulation)',
    jurisdiction: 'EU',
    category: 'data_governance',
    conditions: JSON.stringify({ action: 'contains_pii', region: 'EU' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'Personal data patterns detected in source code. GDPR requires data minimization \u2014 ensure personal data is adequate, relevant, and limited to what is necessary for the processing purpose.',
    legalReference: 'GDPR Article 5(1)(c) \u2014 Data minimisation',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── GDPR (D7): Automated decision-making ───────────────────────
  {
    ruleKey: 'gdpr.art22.automated_decisions',
    sourceName: 'GDPR (EU General Data Protection Regulation)',
    jurisdiction: 'EU',
    category: 'human_oversight',
    conditions: JSON.stringify({ action: 'returns_ai_to_user', region: 'EU' }),
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary:
      'AI output returned directly to end users detected. GDPR grants data subjects the right not to be subject to solely automated decisions with legal or significant effects. Implement human oversight and provide meaningful information about the logic involved.',
    legalReference: 'GDPR Article 22(1) \u2014 Automated individual decision-making, including profiling',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'gdpr.art22.user_input_to_ai',
    sourceName: 'GDPR (EU General Data Protection Regulation)',
    jurisdiction: 'EU',
    category: 'human_oversight',
    conditions: JSON.stringify({ action: 'processes_user_input', region: 'EU' }),
    effect: 'allow_with_audit',
    severity: 'medium',
    humanSummary:
      'User-provided data flows into AI processing pipeline. Under GDPR Art.22, automated processing of personal data that produces legal or significant effects requires safeguards including human intervention rights.',
    legalReference: 'GDPR Article 22(3) \u2014 Safeguards for automated decision-making',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── GDPR (D8): Data minimization / storage ─────────────────────
  {
    ruleKey: 'gdpr.art5.ai_output_stored',
    sourceName: 'GDPR (EU General Data Protection Regulation)',
    jurisdiction: 'EU',
    category: 'data_governance',
    conditions: JSON.stringify({ action: 'stores_ai_output', region: 'EU' }),
    effect: 'allow_with_audit',
    severity: 'medium',
    humanSummary:
      'AI model output stored in persistent storage. GDPR requires storage limitation \u2014 personal data should be kept only as long as necessary. Ensure AI outputs containing personal data have retention policies.',
    legalReference: 'GDPR Article 5(1)(e) \u2014 Storage limitation',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'gdpr.art5.ai_output_logged',
    sourceName: 'GDPR (EU General Data Protection Regulation)',
    jurisdiction: 'EU',
    category: 'data_governance',
    conditions: JSON.stringify({ action: 'logs_ai_output', region: 'EU' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'AI model output written to application logs. If logs contain personal data, GDPR data minimization applies. Implement log retention policies and ensure logs do not contain unnecessary personal data.',
    legalReference: 'GDPR Article 5(1)(c-e) \u2014 Data minimisation and storage limitation',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'gdpr.art5.ai_output_to_third_party',
    sourceName: 'GDPR (EU General Data Protection Regulation)',
    jurisdiction: 'EU',
    category: 'data_governance',
    conditions: JSON.stringify({ action: 'sends_to_third_party', region: 'EU' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'AI model output sent to external third-party service. GDPR requires legal basis for data transfers, including adequate safeguards for international transfers. Verify data processing agreements are in place.',
    legalReference: 'GDPR Articles 28, 44-49 \u2014 Processor obligations and international transfers',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // ─── PCI DSS (P12): Financial data in source ────────────────────
  {
    ruleKey: 'pci_dss.req3.financial_in_source',
    sourceName: 'PCI-DSS v4.0 (Requires Registration)',
    jurisdiction: 'INTL',
    category: 'security',
    conditions: JSON.stringify({ action: 'contains_financial' }),
    effect: 'deny',
    severity: 'critical',
    humanSummary:
      'Financial data patterns (credit card numbers, account data) detected in source code. PCI DSS prohibits storing sensitive authentication data after authorization. Card numbers must never appear in source code.',
    legalReference: 'PCI DSS v4.0 Requirement 3.3 \u2014 Sensitive authentication data is not stored after authorization',
    industries: JSON.stringify(['finance', 'all']),
    industryScope: 'global',
  },

  // ─── EU AI Act Annex III (R10): High-risk categories ─────────────
  {
    ruleKey: 'eu_ai_act.annex_iii.1a.biometric',
    sourceName: 'EU AI Act',
    jurisdiction: 'EU',
    category: 'risk_assessment',
    conditions: JSON.stringify({ action: 'high_risk_biometric', region: 'EU' }),
    effect: 'deny',
    severity: 'critical',
    humanSummary:
      'AI system classified as high-risk: biometric identification. EU AI Act requires conformity assessment, CE marking, and registration in the EU database before deployment. Real-time remote biometric identification in public spaces is prohibited with limited exceptions.',
    legalReference: 'EU AI Act Article 6(2), Annex III, 1(a) \u2014 Biometric identification and categorisation',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'eu_ai_act.annex_iii.2.critical_infra',
    sourceName: 'EU AI Act',
    jurisdiction: 'EU',
    category: 'safety',
    conditions: JSON.stringify({ action: 'high_risk_critical_infra', region: 'EU' }),
    effect: 'deny',
    severity: 'critical',
    humanSummary:
      'AI system classified as high-risk: critical infrastructure management. Requires conformity assessment and ongoing monitoring. Operators must implement human oversight measures.',
    legalReference: 'EU AI Act Article 6(2), Annex III, 2 \u2014 Management and operation of critical infrastructure',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'eu_ai_act.annex_iii.3.education',
    sourceName: 'EU AI Act',
    jurisdiction: 'EU',
    category: 'fairness',
    conditions: JSON.stringify({ action: 'high_risk_education', region: 'EU' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'AI system classified as high-risk: education and vocational training. AI used for determining access to education, evaluating learning outcomes, or monitoring students requires conformity assessment and bias testing.',
    legalReference: 'EU AI Act Article 6(2), Annex III, 3 \u2014 Education and vocational training',
    industries: JSON.stringify(['education']),
    industryScope: 'sector_specific',
  },
  {
    ruleKey: 'eu_ai_act.annex_iii.4.employment',
    sourceName: 'EU AI Act',
    jurisdiction: 'EU',
    category: 'fairness',
    conditions: JSON.stringify({ action: 'high_risk_employment', region: 'EU' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'AI system classified as high-risk: employment and worker management. AI for recruitment, hiring decisions, performance evaluation, or task allocation requires conformity assessment, transparency, and human oversight.',
    legalReference: 'EU AI Act Article 6(2), Annex III, 4 \u2014 Employment, workers management',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
  {
    ruleKey: 'eu_ai_act.annex_iii.5.essential_services',
    sourceName: 'EU AI Act',
    jurisdiction: 'EU',
    category: 'fairness',
    conditions: JSON.stringify({ action: 'high_risk_essential_services', region: 'EU' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'AI system classified as high-risk: access to essential services. AI for credit scoring, insurance pricing, emergency dispatch, or benefit eligibility requires conformity assessment and non-discrimination testing.',
    legalReference: 'EU AI Act Article 6(2), Annex III, 5 \u2014 Access to essential private/public services',
    industries: JSON.stringify(['finance', 'healthcare']),
    industryScope: 'sector_specific',
  },
  {
    ruleKey: 'eu_ai_act.annex_iii.6.law_enforcement',
    sourceName: 'EU AI Act',
    jurisdiction: 'EU',
    category: 'human_oversight',
    conditions: JSON.stringify({ action: 'high_risk_law_enforcement', region: 'EU' }),
    effect: 'deny',
    severity: 'critical',
    humanSummary:
      'AI system classified as high-risk: law enforcement. Predictive policing, evidence evaluation, and profiling in law enforcement requires fundamental rights impact assessment, conformity assessment, and mandatory human oversight.',
    legalReference: 'EU AI Act Article 6(2), Annex III, 6 \u2014 Law enforcement',
    industries: JSON.stringify(['government']),
    industryScope: 'sector_specific',
  },
  {
    ruleKey: 'eu_ai_act.annex_iii.7.migration',
    sourceName: 'EU AI Act',
    jurisdiction: 'EU',
    category: 'human_oversight',
    conditions: JSON.stringify({ action: 'high_risk_migration', region: 'EU' }),
    effect: 'deny',
    severity: 'critical',
    humanSummary:
      'AI system classified as high-risk: migration, asylum, and border control. AI for visa processing, border surveillance, or asylum decision support requires fundamental rights impact assessment and human oversight.',
    legalReference: 'EU AI Act Article 6(2), Annex III, 7 \u2014 Migration, asylum and border control',
    industries: JSON.stringify(['government']),
    industryScope: 'sector_specific',
  },
  {
    ruleKey: 'eu_ai_act.annex_iii.8.justice',
    sourceName: 'EU AI Act',
    jurisdiction: 'EU',
    category: 'human_oversight',
    conditions: JSON.stringify({ action: 'high_risk_justice', region: 'EU' }),
    effect: 'deny',
    severity: 'critical',
    humanSummary:
      'AI system classified as high-risk: administration of justice and democratic processes. AI for sentencing, judicial decisions, or election integrity requires fundamental rights impact assessment and mandatory human oversight.',
    legalReference: 'EU AI Act Article 6(2), Annex III, 8 \u2014 Administration of justice and democratic processes',
    industries: JSON.stringify(['government']),
    industryScope: 'sector_specific',
  },

  // ─── Additional data-handling capability rules ───────────────────

  // EU AI Act Article 50: Transparency obligations.
  // NOT deferred by the 2026 Digital Omnibus (CELEX 32026R1744) — these apply
  // from 2026-08-02, while the Annex III obligations above were deferred to
  // 2027-12-02. Capabilities emitted by @nomus/scanner TransparencyDetector.
  {
    ruleKey: 'eu_ai_act.art50.1.chatbot_disclosure',
    sourceName: 'EU AI Act',
    jurisdiction: 'EU',
    category: 'transparency',
    conditions: JSON.stringify({ action: 'ai_user_interaction', region: 'EU' }),
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary:
      'AI system interacting with natural persons detected (chatbot/conversational interface). EU AI Act Article 50(1) requires that users are informed they are interacting with an AI system, unless this is obvious from the context. Applies from 2 August 2026.',
    legalReference: 'EU AI Act Article 50(1) — Transparency obligations for AI systems interacting with natural persons',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
    effectiveDate: EU_AI_ACT_ART50_DATE,
  },
  {
    ruleKey: 'eu_ai_act.art50.2.synthetic_content_marking',
    sourceName: 'EU AI Act',
    jurisdiction: 'EU',
    category: 'transparency',
    conditions: JSON.stringify({ action: 'generates_ai_content', region: 'EU' }),
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary:
      'Generative AI content output detected. EU AI Act Article 50(2) requires providers to ensure AI-generated content is marked in a machine-readable format and detectable as artificially generated. Applies from 2 August 2026.',
    legalReference: 'EU AI Act Article 50(2) — Marking of synthetic content',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
    effectiveDate: EU_AI_ACT_ART50_DATE,
  },
  {
    ruleKey: 'eu_ai_act.art50.2.synthetic_media_marking',
    sourceName: 'EU AI Act',
    jurisdiction: 'EU',
    category: 'transparency',
    conditions: JSON.stringify({ action: 'generates_synthetic_media', region: 'EU' }),
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary:
      'Synthetic audio/image/video generation detected. EU AI Act Article 50(2) requires machine-readable marking of synthetic media; Article 50(4) additionally requires deployers to disclose deep fakes — content appreciably resembling real persons, places, or events. Applies from 2 August 2026.',
    legalReference: 'EU AI Act Article 50(2), 50(4) — Synthetic media marking and deep fake disclosure',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
    effectiveDate: EU_AI_ACT_ART50_DATE,
  },
  {
    ruleKey: 'eu_ai_act.art50.3.emotion_recognition_disclosure',
    sourceName: 'EU AI Act',
    jurisdiction: 'EU',
    category: 'transparency',
    conditions: JSON.stringify({ action: 'emotion_recognition', region: 'EU' }),
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary:
      'Biometric emotion recognition detected. EU AI Act Article 50(3) requires deployers of emotion recognition or biometric categorisation systems to inform the persons exposed to them. Note: emotion recognition in workplace and education settings is prohibited outright under Article 5(1)(f). Applies from 2 August 2026.',
    legalReference: 'EU AI Act Article 50(3) — Emotion recognition and biometric categorisation transparency; Article 5(1)(f) — Prohibited practices',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
    effectiveDate: EU_AI_ACT_ART50_DATE,
  },

  // handles_phi -> HIPAA general flag
  {
    ruleKey: 'hipaa.164_502.handles_phi',
    sourceName: 'HIPAA Privacy Rule',
    jurisdiction: 'US-FED',
    category: 'privacy',
    conditions: JSON.stringify({ action: 'handles_phi', data_type: 'health', region: 'US-FED' }),
    effect: 'flag',
    severity: 'high',
    humanSummary:
      'Code path handles Protected Health Information (PHI). HIPAA requires administrative, physical, and technical safeguards for all PHI. Verify Business Associate Agreements, access controls, and encryption are in place.',
    legalReference: '45 CFR \u00a7 164.502 \u2014 Uses and disclosures of protected health information',
    industries: JSON.stringify(['healthcare']),
    industryScope: 'sector_specific',
  },

  // handles_pii -> GDPR general flag
  {
    ruleKey: 'gdpr.art5.handles_pii',
    sourceName: 'GDPR (EU General Data Protection Regulation)',
    jurisdiction: 'EU',
    category: 'data_governance',
    conditions: JSON.stringify({ action: 'handles_pii', region: 'EU' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'Code path handles personal data subject to GDPR. Ensure processing has a lawful basis under Article 6, implements data protection by design (Article 25), and maintains records of processing activities (Article 30).',
    legalReference: 'GDPR Articles 5, 6, 25, 30 \u2014 Processing principles, lawful basis, and accountability',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // contains_secret -> general security rule
  {
    ruleKey: 'security.general.contains_secret',
    sourceName: 'OWASP Top 10 (2025)',
    jurisdiction: 'INTL',
    category: 'security',
    conditions: JSON.stringify({ action: 'contains_secret' }),
    effect: 'deny',
    severity: 'critical',
    humanSummary:
      'Secret material (API keys, passwords, tokens, private keys) detected in source code. Secrets in source code are a critical security vulnerability. Use environment variables or a secrets manager instead.',
    legalReference: 'OWASP Top 10 A07:2021 \u2014 Identification and Authentication Failures; CWE-798 Use of Hard-coded Credentials',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // handles_financial -> PCI flag
  {
    ruleKey: 'pci_dss.req3.handles_financial',
    sourceName: 'PCI-DSS v4.0 (Requires Registration)',
    jurisdiction: 'INTL',
    category: 'security',
    conditions: JSON.stringify({ action: 'handles_financial' }),
    effect: 'flag',
    severity: 'high',
    humanSummary:
      'Code path handles financial data (payment card numbers, account data). PCI DSS requires protection of stored account data with encryption, access controls, and audit trails. Ensure cardholder data environment (CDE) boundaries are maintained.',
    legalReference: 'PCI DSS v4.0 Requirement 3 \u2014 Protect stored account data',
    industries: JSON.stringify(['finance', 'all']),
    industryScope: 'global',
  },

  // handles_biometric -> GDPR Art.9 special categories
  {
    ruleKey: 'gdpr.art9.handles_biometric',
    sourceName: 'GDPR (EU General Data Protection Regulation)',
    jurisdiction: 'EU',
    category: 'privacy',
    conditions: JSON.stringify({ action: 'handles_biometric', region: 'EU' }),
    effect: 'deny',
    severity: 'critical',
    humanSummary:
      'Biometric data processing detected. GDPR Article 9 prohibits processing of biometric data for uniquely identifying a natural person unless an explicit exception applies (e.g., explicit consent, substantial public interest). Requires Data Protection Impact Assessment.',
    legalReference: 'GDPR Article 9(1-2) \u2014 Processing of special categories of personal data',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },

  // logs_pii -> GDPR Art.5
  {
    ruleKey: 'gdpr.art5.logs_pii',
    sourceName: 'GDPR (EU General Data Protection Regulation)',
    jurisdiction: 'EU',
    category: 'data_governance',
    conditions: JSON.stringify({ action: 'logs_pii', region: 'EU' }),
    effect: 'deny',
    severity: 'high',
    humanSummary:
      'Personal data detected in application log statements. GDPR data minimization principle requires that personal data in logs is limited to what is strictly necessary. Implement log scrubbing or pseudonymization to prevent unauthorized disclosure.',
    legalReference: 'GDPR Article 5(1)(c) \u2014 Data minimisation; Article 32 \u2014 Security of processing',
    industries: JSON.stringify(['all']),
    industryScope: 'global',
  },
];

// ─── Seed Function ─────────────────────────────────────────────────

/**
 * Seed Phase 3 detector rules into the policy_rules table.
 *
 * Idempotent: skips any rule whose ruleKey already exists (unique index).
 * Looks up sourceId by matching source name in regulatory_sources table.
 *
 * @returns Count of rules created and skipped.
 */
export function seedPhase3Rules(db: BetterSQLite3Database<typeof schema>): { created: number; skipped: number } {
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

  for (const rule of PHASE3_RULES) {
    // The obligation's application date: per-rule override, then framework
    // date, then insertion time as a last resort.
    const effectiveDate =
      rule.effectiveDate ?? FRAMEWORK_EFFECTIVE_DATES[rule.sourceName] ?? now;

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
        existing.effectiveDate !== effectiveDate
      ) {
        db.update(policyRules)
          .set({ effectiveDate, updatedAt: now })
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
        'Skipping Phase 3 rule: regulatory source not found in database');
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
      effectiveDate,
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
    logger.info({ created, skipped, refreshed }, 'Seeded Phase 3 detector rules (HIPAA, GDPR, PCI DSS, EU AI Act)');
  }

  return { created, skipped };
}

/** Exported for testing */
export const PHASE3_RULE_DEFINITIONS = PHASE3_RULES;

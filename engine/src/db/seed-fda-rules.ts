import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb } from './client.js';
import { policyRules, regulatorySources } from './schema.js';
import { signData } from '../core/signing.js';
import { canonicalJSON } from '../core/policy-compiler.js';
import { logger } from '../logger.js';

/**
 * FDA + SaMD regulatory rules for healthcare AI compliance.
 *
 * Covers:
 * - 21 CFR Part 11 (electronic records and signatures)
 * - FDA AI/ML-Based SaMD guidance (PCCP, GMLP, transparency, post-market)
 * - IEC 62304 software lifecycle
 * - IMDRF SaMD risk classification
 * - FDA premarket cybersecurity guidance
 *
 * All rule keys, legal references, and guidance document titles are real.
 * No speculative or fabricated regulatory citations.
 */

interface FdaRuleDefinition {
  ruleKey: string;
  sourceName: string;
  jurisdiction: string;
  category: string;
  conditions: Record<string, string>;
  effect: 'deny' | 'allow_with_audit' | 'require_disclosure' | 'flag';
  severity: 'critical' | 'high' | 'medium' | 'low';
  humanSummary: string;
  legalReference: string;
  industries: string[];
  industryScope: 'global' | 'sector_specific' | 'subsector_specific';
  /**
   * The obligation's application/publication date (ISO), when it differs
   * from the framework-level date in FRAMEWORK_EFFECTIVE_DATES. Never the
   * seed-run timestamp (effective_date must state when the obligation
   * applies, not when we inserted the row).
   */
  effectiveDate?: string;
}

/**
 * Framework-level application dates by source name.
 *  - 21 CFR Part 11 final rule: 62 FR 13430 (published 1997-03-20),
 *    effective 1997-08-20.
 *    https://www.federalregister.gov/documents/1997/03/20/97-6833/electronic-records-electronic-signatures
 *    (FDA's 2003 "Part 11 — Scope and Application" guidance, 68 FR announced
 *    2003-09-05, narrows enforcement discretion but does not change the
 *    rule's effective date.)
 *  - FDA AI/ML-Based SaMD Action Plan: published 2021-01-12.
 *    https://www.fda.gov/medical-devices/software-medical-device-samd/artificial-intelligence-software-medical-device
 *    Also anchors the TPLC-approach rule, which the Action Plan carries
 *    forward from the 2019 discussion paper.
 *  - IEC 62304:2006/AMD1:2015: amendment published 2015-06-26 (IEC webstore
 *    publication date). https://webstore.iec.ch/en/publication/22790
 *    Publication date of a voluntary consensus standard, not a legal date.
 */
const FRAMEWORK_EFFECTIVE_DATES: Record<string, string> = {
  'FDA 21 CFR Part 11': '1997-08-20',
  'FDA AI/ML-Based SaMD Action Plan': '2021-01-12',
  'IEC 62304 Medical Device Software Lifecycle (Requires Purchase)': '2015-06-26',
};

/**
 * GMLP guiding principles (FDA / Health Canada / MHRA joint publication),
 * published 2021-10-27.
 * https://www.fda.gov/medical-devices/software-medical-device-samd/good-machine-learning-practice-medical-device-development-guiding-principles
 */
const GMLP_DATE = '2021-10-27';

/**
 * PCCP draft guidance — the "(2023)" document this rule cites — Federal
 * Register notice of availability 2023-04-03. Finalized 2024-12-04 as
 * "Marketing Submission Recommendations for a Predetermined Change Control
 * Plan for Artificial Intelligence-Enabled Device Software Functions"
 * (FR doc 2024-28361); update the legalReference and this date together if
 * the rule is re-pointed at the final guidance.
 * https://www.federalregister.gov/documents/2024/12/04/2024-28361/marketing-submission-recommendations-for-a-predetermined-change-control-plan-for-artificial
 */
const PCCP_GUIDANCE_DATE = '2023-04-03';

/**
 * "Cybersecurity in Medical Devices: Quality System Considerations and
 * Content of Premarket Submissions" final guidance — Federal Register notice
 * of availability 2023-09-27 (FR doc 2023-20955).
 * https://www.federalregister.gov/documents/2023/09/27/2023-20955/cybersecurity-in-medical-devices-quality-system-considerations-and-content-of-premarket-submissions
 */
const CYBERSECURITY_GUIDANCE_DATE = '2023-09-27';

/**
 * IMDRF/SaMD WG/N12FINAL:2014 "Software as a Medical Device: Possible
 * Framework for Risk Categorization and Corresponding Considerations",
 * final document dated 2014-09-18.
 * https://www.imdrf.org/documents/software-medical-device-possible-framework-risk-categorization-and-corresponding-considerations
 */
const IMDRF_N12_DATE = '2014-09-18';

const FDA_RULES: FdaRuleDefinition[] = [
  // ─── 21 CFR Part 11 — Electronic Records; Electronic Signatures ───

  {
    ruleKey: 'fda.21cfr11.10.system_controls',
    sourceName: 'FDA 21 CFR Part 11',
    jurisdiction: 'US-FED',
    category: 'accountability',
    conditions: { action: 'stores_ai_output', data_type: 'health', region: 'US-FED' },
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'FDA 21 CFR Part 11 requires procedures and controls for closed systems handling electronic records. AI outputs stored as part of medical device records must maintain audit trails, record integrity, and authority checks.',
    legalReference: '21 CFR \u00a7 11.10 \u2014 Controls for closed systems',
    industries: ['healthcare'],
    industryScope: 'sector_specific',
  },
  {
    ruleKey: 'fda.21cfr11.10e.audit_trails',
    sourceName: 'FDA 21 CFR Part 11',
    jurisdiction: 'US-FED',
    category: 'accountability',
    conditions: { action: 'logs_ai_output', data_type: 'health', region: 'US-FED' },
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary:
      'FDA requires computer-generated, time-stamped audit trails for electronic records. AI system logs must capture all record creation, modification, and deletion events with operator identification.',
    legalReference: '21 CFR \u00a7 11.10(e) \u2014 Use of secure audit trails',
    industries: ['healthcare'],
    industryScope: 'sector_specific',
  },
  {
    ruleKey: 'fda.21cfr11.50.signature_integrity',
    sourceName: 'FDA 21 CFR Part 11',
    jurisdiction: 'US-FED',
    category: 'accountability',
    conditions: { action: 'stores_ai_output', data_type: 'health', region: 'US-FED' },
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'FDA 21 CFR Part 11 Subpart C requires electronic signatures to be unique, verifiable, and linked to their respective electronic records. AI-generated medical records requiring signatures must use compliant electronic signature systems.',
    legalReference: '21 CFR \u00a7 11.50 \u2014 Signature manifestations',
    industries: ['healthcare'],
    industryScope: 'sector_specific',
  },

  // ─── FDA AI/ML-Based SaMD Guidance ────────────────────────────────

  {
    ruleKey: 'fda.aiml_samd.predetermined_change_control',
    sourceName: 'FDA AI/ML-Based SaMD Action Plan',
    jurisdiction: 'US-FED',
    category: 'safety',
    conditions: { action: 'text_generation', sector: 'healthcare', region: 'US-FED' },
    effect: 'allow_with_audit',
    severity: 'critical',
    humanSummary:
      'FDA requires a Predetermined Change Control Plan (PCCP) for AI/ML-based SaMD. Changes to AI models used in medical decisions must be pre-specified, validated, and documented before deployment.',
    legalReference:
      'FDA Guidance: Marketing Submission Recommendations for a Predetermined Change Control Plan for Artificial Intelligence/Machine Learning-Enabled Device Software Functions (2023)',
    industries: ['healthcare'],
    industryScope: 'sector_specific',
    effectiveDate: PCCP_GUIDANCE_DATE,
  },
  {
    ruleKey: 'fda.aiml_samd.gmlp',
    sourceName: 'FDA AI/ML-Based SaMD Action Plan',
    jurisdiction: 'US-FED',
    category: 'safety',
    conditions: { action: 'text_generation', sector: 'healthcare', region: 'US-FED' },
    effect: 'flag',
    severity: 'high',
    humanSummary:
      'FDA endorses Good Machine Learning Practice (GMLP) principles for AI/ML-based SaMD. AI systems in healthcare should follow GMLP including representative training data, independent testing datasets, and clinical validation.',
    legalReference:
      'FDA/Health Canada/MHRA Joint Statement: Good Machine Learning Practice for Medical Device Development (2021)',
    industries: ['healthcare'],
    industryScope: 'sector_specific',
    effectiveDate: GMLP_DATE,
  },
  {
    ruleKey: 'fda.aiml_samd.transparency',
    sourceName: 'FDA AI/ML-Based SaMD Action Plan',
    jurisdiction: 'US-FED',
    category: 'transparency',
    conditions: { action: 'returns_ai_to_user', sector: 'healthcare', region: 'US-FED' },
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary:
      'FDA expects algorithmic transparency for clinical AI systems. AI/ML-based SaMD must provide clear descriptions of model inputs, intended use populations, known limitations, and performance metrics to users and patients.',
    legalReference:
      'FDA Action Plan: Artificial Intelligence/Machine Learning-Based Software as a Medical Device \u2014 Transparency and Real-World Performance (2021)',
    industries: ['healthcare'],
    industryScope: 'sector_specific',
  },
  {
    ruleKey: 'fda.postmarket.real_world_performance',
    sourceName: 'FDA AI/ML-Based SaMD Action Plan',
    jurisdiction: 'US-FED',
    category: 'risk_assessment',
    conditions: { action: 'processes_user_input', sector: 'healthcare', region: 'US-FED' },
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'FDA requires real-world performance monitoring for AI/ML-based SaMD. AI systems processing patient data must implement ongoing monitoring for performance drift, bias, and adverse events with established reporting mechanisms.',
    legalReference:
      'FDA Total Product Lifecycle (TPLC) Approach to AI/ML-Based Software as a Medical Device',
    industries: ['healthcare'],
    industryScope: 'sector_specific',
  },

  // ─── IEC 62304 & IMDRF SaMD ──────────────────────────────────────

  {
    ruleKey: 'samd.iec62304.software_lifecycle',
    sourceName: 'IEC 62304 Medical Device Software Lifecycle (Requires Purchase)',
    jurisdiction: 'INTL',
    category: 'safety',
    conditions: { action: 'text_generation', sector: 'healthcare' },
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'IEC 62304 requires a documented software development lifecycle for medical device software including AI components. Software must be classified by safety class (A/B/C) with corresponding verification and validation activities.',
    legalReference:
      'IEC 62304:2006+AMD1:2015 \u2014 Medical device software \u2014 Software life cycle processes',
    industries: ['healthcare'],
    industryScope: 'sector_specific',
  },
  {
    ruleKey: 'samd.imdrf.risk_classification',
    sourceName: 'FDA AI/ML-Based SaMD Action Plan',
    jurisdiction: 'INTL',
    category: 'risk_assessment',
    conditions: { action: 'returns_ai_to_user', sector: 'healthcare' },
    effect: 'require_disclosure',
    severity: 'critical',
    humanSummary:
      'IMDRF SaMD risk framework requires classification based on significance of information provided (treat, diagnose, drive clinical management, inform) and healthcare situation (critical, serious, non-serious). AI outputs returned to clinicians or patients must be classified accordingly.',
    legalReference:
      'IMDRF SaMD N12 \u2014 Software as a Medical Device: Possible Framework for Risk Categorization and Corresponding Considerations',
    industries: ['healthcare'],
    industryScope: 'sector_specific',
    effectiveDate: IMDRF_N12_DATE,
  },

  // ─── FDA Cybersecurity for Medical Devices ────────────────────────

  {
    ruleKey: 'samd.cybersecurity',
    sourceName: 'FDA AI/ML-Based SaMD Action Plan',
    jurisdiction: 'US-FED',
    category: 'safety',
    conditions: { action: 'processes_user_input', data_type: 'health', region: 'US-FED' },
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'FDA premarket cybersecurity guidance requires a secure product development framework for medical devices with AI/ML components. Devices must address threat modeling, software bill of materials (SBOM), vulnerability management, and security architecture documentation.',
    legalReference:
      'FDA Guidance: Cybersecurity in Medical Devices \u2014 Quality System Considerations and Content of Premarket Submissions (2023)',
    industries: ['healthcare'],
    industryScope: 'sector_specific',
    effectiveDate: CYBERSECURITY_GUIDANCE_DATE,
  },
];

/**
 * Seed FDA + SaMD regulatory rules.
 * Idempotent: skips rules whose ruleKey already exists.
 * Returns count of created and skipped rules.
 */
export function seedFdaRules(): { created: number; skipped: number } {
  const db = getDb();
  const now = new Date().toISOString();

  // Build source name -> ID lookup
  const sources = db.select().from(regulatorySources).all();
  const sourceByName = new Map<string, string>();
  for (const s of sources) {
    sourceByName.set(s.name, s.id);
  }

  let created = 0;
  let skipped = 0;
  let refreshed = 0;

  for (const rule of FDA_RULES) {
    // The obligation's application date: per-rule override, then framework
    // date, then insertion time as a last resort.
    const effectiveDate =
      rule.effectiveDate ?? FRAMEWORK_EFFECTIVE_DATES[rule.sourceName] ?? now;

    // Build canonical form for signing. The canonical form deliberately
    // excludes effective_date, so refreshing the date below does not
    // invalidate an existing signature.
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

    // Check if rule already exists (idempotent)
    const existing = db
      .select({
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
      // pipeline has never touched: version 1 and carrying this seeder's own
      // signature over the identical canonical content.
      if (
        existing.version === 1 &&
        existing.signature === signature &&
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

    // Find source ID
    const sourceId = sourceByName.get(rule.sourceName);
    if (!sourceId) {
      logger.warn(
        { ruleKey: rule.ruleKey, sourceName: rule.sourceName },
        'Skipping FDA rule — source not found. Ensure sources are seeded first.',
      );
      skipped++;
      continue;
    }

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
        industries: JSON.stringify(rule.industries),
        industryScope: rule.industryScope,
        // Sourced per-rule/per-framework date, never the seed-run timestamp
        //. See FRAMEWORK_EFFECTIVE_DATES and the per-rule constants.
        effectiveDate,
        expiresAt: null,
        isActive: true,
        signature,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    created++;
  }

  if (created > 0 || refreshed > 0) {
    logger.info({ created, skipped, refreshed }, 'Seeded FDA + SaMD regulatory rules');
  }

  return { created, skipped };
}

/** Exported for testing — the raw rule definitions */
export { FDA_RULES };

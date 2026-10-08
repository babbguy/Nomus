import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = BetterSQLite3Database<any>;
import { policyRules, regulatorySources } from './schema.js';
import { logger } from '../logger.js';

/**
 * FERPA (Family Educational Rights and Privacy Act) rules.
 * 34 CFR Part 99 — protects student education records.
 *
 * Idempotent — skips any rule whose ruleKey already exists.
 */

interface FerpaRule {
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
 * FERPA effective-date anchor.
 * Every rule below cites the current codification of 34 CFR Part 99, whose
 * operative amendment vintage is the 2011 final rule:
 *   76 FR 75604 (2011-12-02), effective 2012-01-03.
 *   https://www.federalregister.gov/documents/2011/12/02/2011-30683/family-educational-rights-and-privacy
 * The statute itself (20 U.S.C. § 1232g) dates to 1974, but the obligations
 * as cited are the amended regulations, so the regulations' effective date
 * is the honest anchor. Never the seed-run timestamp.
 */
export const FERPA_EFFECTIVE_DATE = '2012-01-03';

// ─── Rule Definitions ──────────────────────────────────────────────

const FERPA_RULES: FerpaRule[] = [
  // § 99.3 — Definition of education records
  {
    ruleKey: 'ferpa.99_3.education_records',
    sourceName: 'FERPA (Family Educational Rights and Privacy Act)',
    jurisdiction: 'US-FED',
    category: 'privacy',
    conditions: JSON.stringify({ action: 'contains_pii', sector: 'education', region: 'US-FED' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'FERPA protects personally identifiable information in education records. AI systems processing student data (grades, attendance, disciplinary records, financial aid) must comply with FERPA access and disclosure restrictions.',
    legalReference: '34 CFR § 99.3 — Definition of education records; 20 U.S.C. § 1232g',
    industries: JSON.stringify(['education']),
    industryScope: 'sector_specific',
  },

  // § 99.30 — Consent requirements for disclosure
  {
    ruleKey: 'ferpa.99_30.consent_required',
    sourceName: 'FERPA (Family Educational Rights and Privacy Act)',
    jurisdiction: 'US-FED',
    category: 'privacy',
    conditions: JSON.stringify({ action: 'processes_user_input', sector: 'education', region: 'US-FED' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'FERPA requires prior written consent from the parent or eligible student before disclosing personally identifiable information from education records. AI systems processing student input data must verify consent has been obtained before any disclosure to third parties, including AI model providers.',
    legalReference: '34 CFR § 99.30 — Under what conditions is prior consent required to disclose information?',
    industries: JSON.stringify(['education']),
    industryScope: 'sector_specific',
  },

  // § 99.31 — Exceptions to consent (directory info, health/safety)
  {
    ruleKey: 'ferpa.99_31.consent_exceptions',
    sourceName: 'FERPA (Family Educational Rights and Privacy Act)',
    jurisdiction: 'US-FED',
    category: 'privacy',
    conditions: JSON.stringify({ action: 'sends_to_third_party', sector: 'education', region: 'US-FED' }),
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary:
      'FERPA provides limited exceptions to the consent requirement including directory information, legitimate educational interest, health or safety emergencies, and authorized studies. AI systems sharing student data with third-party services must document which exception applies and maintain records of disclosures under § 99.32.',
    legalReference: '34 CFR § 99.31 — Under what conditions is prior consent not required?; § 99.32 — Records of disclosures',
    industries: JSON.stringify(['education']),
    industryScope: 'sector_specific',
  },

  // § 99.35 — Legitimate educational interest
  {
    ruleKey: 'ferpa.99_35.legitimate_interest',
    sourceName: 'FERPA (Family Educational Rights and Privacy Act)',
    jurisdiction: 'US-FED',
    category: 'privacy',
    conditions: JSON.stringify({ action: 'stores_ai_output', sector: 'education', region: 'US-FED' }),
    effect: 'allow_with_audit',
    severity: 'medium',
    humanSummary:
      'FERPA permits disclosure to school officials with a legitimate educational interest. AI-generated records (predictions, assessments, recommendations) stored in student files become education records subject to FERPA. Institutions must define criteria for legitimate educational interest and limit AI output retention accordingly.',
    legalReference: '34 CFR § 99.31(a)(1) — Legitimate educational interest; § 99.35 — Conditions for disclosure to certain parties',
    industries: JSON.stringify(['education']),
    industryScope: 'sector_specific',
  },

  // FERPA + AI: Student profiling/prediction (grades, dropout risk)
  {
    ruleKey: 'ferpa.ai.student_profiling',
    sourceName: 'FERPA (Family Educational Rights and Privacy Act)',
    jurisdiction: 'US-FED',
    category: 'fairness',
    conditions: JSON.stringify({ action: 'high_risk_education', region: 'US-FED' }),
    effect: 'allow_with_audit',
    severity: 'high',
    humanSummary:
      'AI-driven student profiling (dropout prediction, grade forecasting, behavioral risk scoring) creates education records subject to FERPA. Parents and eligible students retain the right to inspect and challenge these AI-generated records. Institutions must ensure algorithmic assessments do not create discriminatory outcomes.',
    legalReference: '34 CFR § 99.10 — Right to inspect and review education records; 20 U.S.C. § 1232g(a)(1)',
    industries: JSON.stringify(['education']),
    industryScope: 'sector_specific',
  },

  // FERPA + AI: AI-generated student assessments
  {
    ruleKey: 'ferpa.ai.generated_assessments',
    sourceName: 'FERPA (Family Educational Rights and Privacy Act)',
    jurisdiction: 'US-FED',
    category: 'transparency',
    conditions: JSON.stringify({ action: 'returns_ai_to_user', sector: 'education', region: 'US-FED' }),
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary:
      'AI-generated assessments, grades, or evaluations delivered to students or parents constitute education records under FERPA. Recipients have the right to request amendment of inaccurate records under § 99.20. Institutions should disclose when assessments are AI-generated and provide a process for human review.',
    legalReference: '34 CFR § 99.20 — Right to request amendment of education records; § 99.21 — Hearing rights',
    industries: JSON.stringify(['education']),
    industryScope: 'sector_specific',
  },

  // FERPA: De-identification requirements for research
  {
    ruleKey: 'ferpa.99_31.deidentification',
    sourceName: 'FERPA (Family Educational Rights and Privacy Act)',
    jurisdiction: 'US-FED',
    category: 'data_governance',
    conditions: JSON.stringify({ action: 'handles_pii', sector: 'education', region: 'US-FED' }),
    effect: 'flag',
    severity: 'medium',
    humanSummary:
      'FERPA permits release of de-identified student data for research without consent. AI training on student data must ensure proper de-identification by removing all direct and indirect identifiers as defined in § 99.3. A reasonable determination that the student\'s identity is not personally identifiable is required.',
    legalReference: '34 CFR § 99.31(b) — De-identified records exception; PTAC guidance on data de-identification',
    industries: JSON.stringify(['education']),
    industryScope: 'sector_specific',
  },
];

// ─── Seed Function ─────────────────────────────────────────────────

/**
 * Seed FERPA rules into the policy_rules table.
 *
 * Idempotent: skips any rule whose ruleKey already exists (unique index).
 * Looks up sourceId by matching source name in regulatory_sources table.
 */
export function seedFerpaRules(db: AnyDb): { created: number; skipped: number } {
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

  for (const rule of FERPA_RULES) {
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
        existing.effectiveDate !== FERPA_EFFECTIVE_DATE
      ) {
        db.update(policyRules)
          .set({ effectiveDate: FERPA_EFFECTIVE_DATE, updatedAt: now })
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
        'Skipping FERPA rule: regulatory source not found in database');
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
      // 34 CFR Part 99 as amended by 76 FR 75604, effective 2012-01-03.
      effectiveDate: FERPA_EFFECTIVE_DATE,
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
    logger.info({ created, skipped, refreshed }, 'Seeded FERPA rules (Family Educational Rights and Privacy Act)');
  }

  return { created, skipped };
}

/** Exported for testing */
export const FERPA_RULE_DEFINITIONS = FERPA_RULES;

/**
 * RiskClassifier — Phase 3d.
 *
 * Classifies code against the 8 EU AI Act Annex III high-risk categories.
 * Pure regex pattern matching, scans ALL files (not just AI SDK importers)
 * because high-risk activities can be implemented without explicit SDK use.
 *
 * Capabilities (must match seed-phase3-rules.ts conditions.action values):
 *   high_risk_biometric, high_risk_critical_infra, high_risk_education,
 *   high_risk_employment, high_risk_essential_services, high_risk_law_enforcement,
 *   high_risk_migration, high_risk_justice, handles_biometric
 */

import type { DetectorPlugin, DetectorContext, DetectorSignal } from './detector.js';
import { iterFiles, isTestFile, stripComments } from './file-content.js';

interface RiskCategory {
  capability: string;
  annexRef: string;
  patterns: RegExp[];
  industryBoost?: 'healthcare' | 'finance' | 'education' | 'government';
}

const CATEGORIES: RiskCategory[] = [
  // 1(a) — Biometric identification
  {
    capability: 'high_risk_biometric',
    annexRef: 'Annex III, 1(a)',
    patterns: [
      /\b(face_?recognition|facial_?recognition|facenet|deepface|insightface|face_?net|face_?id|face_?match)\b/i,
      /\b(fingerprint_?scan|iris_?scan|retina_?scan|voiceprint|gait_?recognition)\b/i,
      /\bbiometric_?(?:auth|id|identification|matching|verification)\b/i,
    ],
  },
  // 2 — Critical infrastructure
  {
    capability: 'high_risk_critical_infra',
    annexRef: 'Annex III, 2',
    patterns: [
      /\b(scada|plc_?(?:control|logic)|industrial_?control|ics_?network)\b/i,
      /\b(power_?grid|smart_?grid|electric_?grid|water_?treatment|gas_?pipeline)\b/i,
      /\b(traffic_?control|air_?traffic|railway_?signal|nuclear_?control)\b/i,
    ],
  },
  // 3 — Education / vocational training
  {
    capability: 'high_risk_education',
    annexRef: 'Annex III, 3',
    patterns: [
      /\b(grading|grade_?student|student_?score|exam_?score|automated_?grading)\b/i,
      /\b(admissions?_?(?:decision|score|rank)|university_?admission|college_?admission)\b/i,
      /\b(plagiarism_?detect|cheat_?detect|proctoring|exam_?monitor)\b/i,
    ],
    industryBoost: 'education',
  },
  // 4 — Employment / workers
  {
    capability: 'high_risk_employment',
    annexRef: 'Annex III, 4',
    patterns: [
      /\b(resume_?screen|cv_?screen|candidate_?screen|hire_?score|hiring_?decision)\b/i,
      /\b(applicant_?rank|interview_?score|job_?match|recruiter_?ai)\b/i,
      /\b(performance_?review_?ai|employee_?monitor|productivity_?score|fire_?score)\b/i,
    ],
  },
  // 5 — Essential services (credit, insurance, public benefits)
  {
    capability: 'high_risk_essential_services',
    annexRef: 'Annex III, 5',
    patterns: [
      /\b(credit_?score|credit_?risk|loan_?approv|loan_?decision|fico_?score|underwrit)\b/i,
      /\b(insurance_?(?:pricing|risk|underwriting|premium)|claim_?denial|claim_?approval)\b/i,
      /\b(benefit_?eligibility|welfare_?eligibility|emergency_?dispatch|911_?triage)\b/i,
    ],
    industryBoost: 'finance',
  },
  // 6 — Law enforcement
  {
    capability: 'high_risk_law_enforcement',
    annexRef: 'Annex III, 6',
    patterns: [
      /\b(predictive_?policing|crime_?predict|recidivism|risk_?of_?reoffend)\b/i,
      /\b(suspect_?profil|suspect_?match|criminal_?risk|police_?ai)\b/i,
      /\b(evidence_?evaluat|polygraph_?ai|lie_?detect)\b/i,
    ],
    industryBoost: 'government',
  },
  // 7 — Migration / asylum / border control
  {
    capability: 'high_risk_migration',
    annexRef: 'Annex III, 7',
    patterns: [
      /\b(visa_?(?:decision|approval|score|risk)|asylum_?(?:decision|score|risk))\b/i,
      /\b(border_?surveillance|border_?ai|migrant_?risk|immigration_?risk)\b/i,
      /\b(passport_?verification_?ai|document_?fraud_?detect)\b/i,
    ],
    industryBoost: 'government',
  },
  // 8 — Administration of justice
  {
    capability: 'high_risk_justice',
    annexRef: 'Annex III, 8',
    patterns: [
      /\b(sentenc(?:e|ing)_?(?:ai|score|recommend)|bail_?(?:score|decision|risk))\b/i,
      /\b(judicial_?ai|case_?outcome_?predict|legal_?prediction)\b/i,
      /\b(election_?integrity_?ai|voter_?suppression_?detect)\b/i,
    ],
    industryBoost: 'government',
  },
];

interface CategoryHit {
  category: RiskCategory;
  line: number;
  evidence: string;
}

function findHits(content: string): CategoryHit[] {
  const hits: CategoryHit[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const cat of CATEGORIES) {
      for (const pat of cat.patterns) {
        if (pat.test(line)) {
          hits.push({ category: cat, line: i + 1, evidence: line.trim().slice(0, 200) });
          break; // one hit per category per line is enough
        }
      }
    }
  }
  return hits;
}

export class RiskClassifier implements DetectorPlugin {
  readonly name = 'risk-classifier';
  readonly description = 'Classifies code against EU AI Act Annex III high-risk categories';
  readonly version = '1.0.0';

  async detect(ctx: DetectorContext): Promise<DetectorSignal[]> {
    const signals: DetectorSignal[] = [];
    const sector = ctx.config.sector?.toLowerCase();

    for (const { file, content } of iterFiles(ctx)) {
      if (isTestFile(file, ctx.rootDir)) continue;
      const stripped = stripComments(file, content);
      const hits = findHits(stripped);
      if (hits.length === 0) continue;

      for (const hit of hits) {
        let confidence = 0.85;
        // Sector context boost — when the org tells us they're in healthcare/finance/etc.
        if (hit.category.industryBoost && hit.category.industryBoost === sector) {
          confidence = Math.min(1.0, confidence * 1.1);
        }

        const caps = [hit.category.capability];
        if (hit.category.capability === 'high_risk_biometric') {
          caps.push('handles_biometric');
        }

        signals.push({
          source: this.name,
          file,
          line: hit.line,
          target: hit.category.capability,
          capabilities: caps,
          confidence,
          evidence: hit.evidence,
          metadata: { annex: hit.category.annexRef, sector },
        });
      }
    }

    return signals;
  }
}

export const __test__ = { findHits, CATEGORIES };

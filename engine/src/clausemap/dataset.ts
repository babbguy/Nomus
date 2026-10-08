/**
 * Clause Map — the built-in heuristic → clause mapping dataset.
 *
 * Each entry correlates a codebase heuristic (a combination of detector
 * signals, e.g. "loose PII regex match in the same file as an OpenAI client
 * call") to a specific clause of a major framework (EU AI Act, HIPAA, GDPR).
 *
 * This dataset is the static prior. Learned accuracy state (confirmed /
 * dismissed weights, posterior) lives only in the clause_mappings table and
 * is NEVER overwritten by reseeding — bump `DATASET_VERSION` to update
 * clause text or heuristics; learned weights carry forward.
 *
 * Capability vocabulary comes from the @nomus/scanner detectors:
 *   phi-pattern-detector : contains_phi, contains_pii, contains_financial,
 *                          phi_in_ai_call, pii_in_ai_call, handles_phi, logs_phi
 *   data-flow-detector   : processes_user_input, returns_ai_to_user,
 *                          logs_ai_output, stores_ai_output, sends_to_third_party
 *   sdk-usage-detector   : text_generation, embeddings, image_generation, …
 *   risk-classifier      : handles_biometric
 *   transparency-detector: ai_user_interaction, generates_ai_content,
 *                          generates_synthetic_media, emotion_recognition
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { clauseMappings, clauseLearningEvents } from '../db/schema.js';

export const DATASET_VERSION = 1;

/** One required signal within a heuristic signature. */
export interface SignalRequirement {
  /** Capability string a finding must carry (matches scan_findings.capability_detected) */
  capability: string;
  /** Alternative capabilities that also satisfy this requirement */
  anyOf?: string[];
  /** Restrict to a specific detector source if set */
  detector?: string;
}

/**
 * Declarative heuristic evaluated by the correlator against the findings of
 * one scan, grouped per file. All requirements must be satisfied by findings
 * in the SAME file; `maxLineDistance` (when set) additionally requires the
 * matched findings to sit within N lines of each other.
 */
export interface HeuristicSignature {
  requires: SignalRequirement[];
  maxLineDistance?: number;
}

export interface ClauseMappingSeed {
  mappingKey: string;
  heuristicLabel: string;
  heuristic: HeuristicSignature;
  framework: 'EU_AI_ACT' | 'HIPAA' | 'GDPR';
  clauseCitation: string;
  clauseTitle: string;
  clauseUrl?: string;
  rationale: string;
  /**
   * Beta prior pseudo-counts. priorAlpha/(priorAlpha+priorBeta) is the
   * initial confidence; the magnitude (alpha+beta) is how much feedback it
   * takes to move it. Strong legal consensus → higher magnitude.
   */
  priorAlpha: number;
  priorBeta: number;
}

const EU_AI_ACT_URL = 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj';
const HIPAA_URL = 'https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164';
const GDPR_URL = 'https://eur-lex.europa.eu/eli/reg/2016/679/oj';

export const CLAUSE_MAPPING_DATASET: ClauseMappingSeed[] = [
  // ─── HIPAA (45 CFR Part 164) ──────────────────────────────────────
  {
    mappingKey: 'phi-in-ai-call::hipaa-164.502a',
    heuristicLabel: 'PHI pattern near an AI SDK call',
    heuristic: { requires: [{ capability: 'phi_in_ai_call' }] },
    framework: 'HIPAA',
    clauseCitation: '45 CFR §164.502(a)',
    clauseTitle: 'Uses and disclosures of PHI — general rules',
    clauseUrl: HIPAA_URL,
    rationale:
      'A PHI-shaped identifier (patient ID, MRN, diagnosis field) within proximity of an AI SDK invocation indicates PHI is being used or disclosed through the model call, which §164.502(a) only permits under enumerated conditions.',
    priorAlpha: 8,
    priorBeta: 2,
  },
  {
    mappingKey: 'phi-to-third-party::hipaa-164.502e',
    heuristicLabel: 'PHI present + data sent to third-party API',
    heuristic: {
      requires: [
        { capability: 'contains_phi', anyOf: ['handles_phi', 'phi_in_ai_call'] },
        { capability: 'sends_to_third_party' },
      ],
    },
    framework: 'HIPAA',
    clauseCitation: '45 CFR §164.502(e)',
    clauseTitle: 'Disclosures to business associates',
    clauseUrl: HIPAA_URL,
    rationale:
      'Code that handles PHI and transmits data to an external endpoint (including a hosted AI API) implicates the business-associate rule: the recipient must be under a BAA before PHI may be disclosed.',
    priorAlpha: 7,
    priorBeta: 3,
  },
  {
    mappingKey: 'phi-deidentification::hipaa-164.514b',
    heuristicLabel: 'PHI flows into AI call without de-identification markers',
    heuristic: {
      requires: [{ capability: 'phi_in_ai_call' }, { capability: 'processes_user_input' }],
    },
    framework: 'HIPAA',
    clauseCitation: '45 CFR §164.514(b)',
    clauseTitle: 'De-identification standard',
    clauseUrl: HIPAA_URL,
    rationale:
      'User-supplied data joined with PHI patterns reaching a model call suggests identifiable health information is processed. §164.514(b) defines the safe-harbor and expert-determination paths that would take the data out of HIPAA scope.',
    priorAlpha: 6,
    priorBeta: 4,
  },
  {
    mappingKey: 'phi-stored-output::hipaa-164.312a',
    heuristicLabel: 'PHI context + AI output persisted to storage',
    heuristic: {
      requires: [
        { capability: 'contains_phi', anyOf: ['handles_phi', 'phi_in_ai_call'] },
        { capability: 'stores_ai_output' },
      ],
    },
    framework: 'HIPAA',
    clauseCitation: '45 CFR §164.312(a)(1)',
    clauseTitle: 'Technical safeguards — access control',
    clauseUrl: HIPAA_URL,
    rationale:
      'Model output derived from PHI written to a datastore becomes ePHI at rest; §164.312(a)(1) requires technical access controls on that store.',
    priorAlpha: 6,
    priorBeta: 4,
  },
  {
    mappingKey: 'phi-logged::hipaa-164.312b',
    heuristicLabel: 'PHI context + AI output written to logs',
    heuristic: {
      requires: [
        { capability: 'contains_phi', anyOf: ['handles_phi', 'phi_in_ai_call', 'logs_phi'] },
        { capability: 'logs_ai_output', anyOf: ['logs_phi'] },
      ],
    },
    framework: 'HIPAA',
    clauseCitation: '45 CFR §164.312(b)',
    clauseTitle: 'Technical safeguards — audit controls',
    clauseUrl: HIPAA_URL,
    rationale:
      'Logging model responses in a PHI-handling path both creates uncontrolled ePHI copies and falls under the audit-control requirement for systems containing ePHI.',
    priorAlpha: 5,
    priorBeta: 5,
  },

  // ─── EU AI Act (Regulation (EU) 2024/1689) ────────────────────────
  {
    mappingKey: 'user-io-loop::euaia-50.1',
    heuristicLabel: 'User input processed and AI output returned to user',
    heuristic: {
      requires: [{ capability: 'processes_user_input' }, { capability: 'returns_ai_to_user' }],
    },
    framework: 'EU_AI_ACT',
    clauseCitation: 'Art. 50(1)',
    clauseTitle: 'Transparency — informing persons of AI interaction',
    clauseUrl: EU_AI_ACT_URL,
    rationale:
      'A request/response loop where model output is returned directly to the end user is an AI system intended to interact with natural persons; Art. 50(1) requires those persons be informed they are interacting with AI.',
    priorAlpha: 8,
    priorBeta: 2,
  },
  {
    mappingKey: 'ai-user-interaction::euaia-50.1',
    heuristicLabel: 'Conversational UI wired to a generative model',
    heuristic: { requires: [{ capability: 'ai_user_interaction' }] },
    framework: 'EU_AI_ACT',
    clauseCitation: 'Art. 50(1)',
    clauseTitle: 'Transparency — informing persons of AI interaction',
    clauseUrl: EU_AI_ACT_URL,
    rationale:
      'Chat/assistant UI vocabulary combined with an AI backend signals a system designed for direct human interaction, triggering the Art. 50(1) disclosure duty.',
    priorAlpha: 6,
    priorBeta: 4,
  },
  {
    mappingKey: 'synthetic-media::euaia-50.2',
    heuristicLabel: 'Synthetic media generation (image/audio/video)',
    heuristic: {
      requires: [
        { capability: 'generates_synthetic_media', anyOf: ['image_generation', 'text_to_speech'] },
      ],
    },
    framework: 'EU_AI_ACT',
    clauseCitation: 'Art. 50(2)',
    clauseTitle: 'Marking of synthetic content',
    clauseUrl: EU_AI_ACT_URL,
    rationale:
      'Providers of systems generating synthetic audio, image, or video content must ensure outputs are marked machine-readably as artificially generated.',
    priorAlpha: 7,
    priorBeta: 3,
  },
  {
    mappingKey: 'emotion-recognition::euaia-5.1f',
    heuristicLabel: 'Emotion recognition vocabulary near AI inference',
    heuristic: { requires: [{ capability: 'emotion_recognition' }] },
    framework: 'EU_AI_ACT',
    clauseCitation: 'Art. 5(1)(f)',
    clauseTitle: 'Prohibited practices — emotion inference at work/education',
    clauseUrl: EU_AI_ACT_URL,
    rationale:
      'Emotion-inference code paths are prohibited outright in workplace and educational contexts and heavily restricted elsewhere; any hit warrants review against Art. 5(1)(f) and Annex III.',
    priorAlpha: 5,
    priorBeta: 5,
  },
  {
    mappingKey: 'biometric::euaia-annex3-1a',
    heuristicLabel: 'Biometric identification signals',
    heuristic: { requires: [{ capability: 'handles_biometric' }] },
    framework: 'EU_AI_ACT',
    clauseCitation: 'Annex III(1)(a) + Art. 9',
    clauseTitle: 'High-risk classification — biometric identification; risk management',
    clauseUrl: EU_AI_ACT_URL,
    rationale:
      'Biometric identification/verification places the system in Annex III high-risk scope, activating the Art. 9 risk-management-system obligation and the full Chapter III compliance stack.',
    priorAlpha: 7,
    priorBeta: 3,
  },
  {
    mappingKey: 'logged-ai-output::euaia-12',
    heuristicLabel: 'AI outputs logged (record-keeping surface)',
    heuristic: {
      requires: [{ capability: 'logs_ai_output' }, { capability: 'processes_user_input' }],
    },
    framework: 'EU_AI_ACT',
    clauseCitation: 'Art. 12',
    clauseTitle: 'Record-keeping',
    clauseUrl: EU_AI_ACT_URL,
    rationale:
      'Systems in high-risk scope must support automatic event logging over their lifetime; existing log points of model I/O are where Art. 12 traceability is implemented (or violated by omission).',
    priorAlpha: 4,
    priorBeta: 6,
  },
  {
    mappingKey: 'user-input-decision::euaia-13.1',
    heuristicLabel: 'User data drives AI output returned as a decision',
    heuristic: {
      requires: [
        { capability: 'processes_user_input' },
        { capability: 'returns_ai_to_user' },
        { capability: 'stores_ai_output' },
      ],
    },
    framework: 'EU_AI_ACT',
    clauseCitation: 'Art. 13(1)',
    clauseTitle: 'Transparency and provision of information to deployers',
    clauseUrl: EU_AI_ACT_URL,
    rationale:
      'Persisted, user-facing model decisions require the system be sufficiently transparent for deployers to interpret outputs — the strongest signal that Art. 13 documentation duties apply.',
    priorAlpha: 4,
    priorBeta: 6,
  },

  // ─── GDPR (Regulation (EU) 2016/679) ──────────────────────────────
  {
    mappingKey: 'pii-in-ai-call::gdpr-5.1c',
    heuristicLabel: 'PII pattern near an AI SDK call',
    heuristic: { requires: [{ capability: 'pii_in_ai_call' }] },
    framework: 'GDPR',
    clauseCitation: 'Art. 5(1)(c)',
    clauseTitle: 'Data minimisation',
    clauseUrl: GDPR_URL,
    rationale:
      'Personal-data-shaped values (emails, names, national IDs) within proximity of a model call suggest personal data is sent to the model; minimisation requires only what is necessary for the purpose.',
    priorAlpha: 8,
    priorBeta: 2,
  },
  {
    mappingKey: 'pii-to-third-party::gdpr-44',
    heuristicLabel: 'PII present + data sent to third-party API',
    heuristic: {
      requires: [
        { capability: 'contains_pii', anyOf: ['pii_in_ai_call'] },
        { capability: 'sends_to_third_party' },
      ],
    },
    framework: 'GDPR',
    clauseCitation: 'Art. 44',
    clauseTitle: 'General principle for transfers',
    clauseUrl: GDPR_URL,
    rationale:
      'Personal data leaving customer infrastructure toward an external (typically US-hosted) AI API is a transfer; Chapter V requires an adequacy decision or appropriate safeguards.',
    priorAlpha: 7,
    priorBeta: 3,
  },
  {
    mappingKey: 'automated-decision::gdpr-22',
    heuristicLabel: 'User input → AI decision returned to user',
    heuristic: {
      requires: [{ capability: 'processes_user_input' }, { capability: 'returns_ai_to_user' }],
    },
    framework: 'GDPR',
    clauseCitation: 'Art. 22',
    clauseTitle: 'Automated individual decision-making, including profiling',
    clauseUrl: GDPR_URL,
    rationale:
      'When user-provided personal data feeds a model whose output is returned as the response, the path is a candidate for solely-automated decision-making, which data subjects have the right not to be subject to.',
    priorAlpha: 6,
    priorBeta: 4,
  },
  {
    mappingKey: 'pii-stored-output::gdpr-32',
    heuristicLabel: 'PII context + AI output persisted to storage',
    heuristic: {
      requires: [
        { capability: 'contains_pii', anyOf: ['pii_in_ai_call'] },
        { capability: 'stores_ai_output' },
      ],
    },
    framework: 'GDPR',
    clauseCitation: 'Art. 32',
    clauseTitle: 'Security of processing',
    clauseUrl: GDPR_URL,
    rationale:
      'Model output derived from personal data written to a datastore extends the processing footprint; Art. 32 requires security measures appropriate to that risk.',
    priorAlpha: 5,
    priorBeta: 5,
  },
  {
    mappingKey: 'pii-logged::gdpr-5.1e',
    heuristicLabel: 'PII context + AI output written to logs',
    heuristic: {
      requires: [
        { capability: 'contains_pii', anyOf: ['pii_in_ai_call'] },
        { capability: 'logs_ai_output' },
      ],
    },
    framework: 'GDPR',
    clauseCitation: 'Art. 5(1)(e)',
    clauseTitle: 'Storage limitation',
    clauseUrl: GDPR_URL,
    rationale:
      'Personal data echoed through model responses into application logs typically has no retention policy, colliding with storage-limitation and purpose-limitation principles.',
    priorAlpha: 5,
    priorBeta: 5,
  },
];

/** Posterior mean of the Beta distribution given prior + learned weights. */
export function posteriorMean(
  priorAlpha: number,
  priorBeta: number,
  confirmedWeight: number,
  dismissedWeight: number,
): number {
  const alpha = priorAlpha + confirmedWeight;
  const beta = priorBeta + dismissedWeight;
  return alpha / (alpha + beta);
}

/**
 * Idempotent seed. Inserts new mappings; updates static fields of existing
 * rows only when DATASET_VERSION advances. Learned weights (confirmed /
 * dismissed / fired / evaluated) are NEVER touched here.
 */
export function seedClauseMappings(db: BetterSQLite3Database<Record<string, unknown>>): {
  inserted: number;
  updated: number;
} {
  const now = new Date().toISOString();
  let inserted = 0;
  let updated = 0;

  for (const seed of CLAUSE_MAPPING_DATASET) {
    const existing = db
      .select()
      .from(clauseMappings)
      .where(eq(clauseMappings.mappingKey, seed.mappingKey))
      .get();

    if (!existing) {
      const id = randomUUID();
      const posterior = posteriorMean(seed.priorAlpha, seed.priorBeta, 0, 0);
      db.insert(clauseMappings).values({
        id,
        mappingKey: seed.mappingKey,
        datasetVersion: DATASET_VERSION,
        heuristicLabel: seed.heuristicLabel,
        heuristicJson: JSON.stringify(seed.heuristic),
        framework: seed.framework,
        clauseCitation: seed.clauseCitation,
        clauseTitle: seed.clauseTitle,
        clauseUrl: seed.clauseUrl ?? null,
        rationale: seed.rationale,
        priorAlpha: seed.priorAlpha,
        priorBeta: seed.priorBeta,
        confirmedWeight: 0,
        dismissedWeight: 0,
        posterior,
        firedCount: 0,
        evaluatedCount: 0,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      }).run();
      db.insert(clauseLearningEvents).values({
        mappingId: id,
        eventType: 'seeded',
        posteriorBefore: posterior,
        posteriorAfter: posterior,
        detailsJson: JSON.stringify({ datasetVersion: DATASET_VERSION }),
        createdAt: now,
      }).run();
      inserted++;
    } else if (existing.datasetVersion < DATASET_VERSION) {
      // Static fields refresh; learned weights carry forward, posterior
      // recomputed against the (possibly new) prior.
      const posterior = posteriorMean(
        seed.priorAlpha,
        seed.priorBeta,
        existing.confirmedWeight,
        existing.dismissedWeight,
      );
      db.update(clauseMappings)
        .set({
          datasetVersion: DATASET_VERSION,
          heuristicLabel: seed.heuristicLabel,
          heuristicJson: JSON.stringify(seed.heuristic),
          framework: seed.framework,
          clauseCitation: seed.clauseCitation,
          clauseTitle: seed.clauseTitle,
          clauseUrl: seed.clauseUrl ?? null,
          rationale: seed.rationale,
          priorAlpha: seed.priorAlpha,
          priorBeta: seed.priorBeta,
          posterior,
          updatedAt: now,
        })
        .where(eq(clauseMappings.id, existing.id))
        .run();
      db.insert(clauseLearningEvents).values({
        mappingId: existing.id,
        eventType: 'dataset_updated',
        posteriorBefore: existing.posterior,
        posteriorAfter: posterior,
        detailsJson: JSON.stringify({ from: existing.datasetVersion, to: DATASET_VERSION }),
        createdAt: now,
      }).run();
      updated++;
    }
  }

  return { inserted, updated };
}

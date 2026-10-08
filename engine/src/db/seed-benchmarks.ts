import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from './client.js';
import { benchmarkDefinitions } from './schema.js';
import { logger } from '../logger.js';

/**
 * Seed COMPL-AI benchmark definitions.
 * 29 benchmarks mapped to EU AI Act principles, based on the ETH Zurich COMPL-AI framework.
 * Safe to run repeatedly — skips if definitions already exist.
 */
export function seedBenchmarkDefinitions(): void {
  const db = getDb();

  const existing = db.select({ count: sql<number>`count(*)` })
    .from(benchmarkDefinitions).get()?.count ?? 0;

  if (existing > 0) return;

  const now = new Date().toISOString();

  const definitions = [
    // ─── Fairness & Non-Discrimination ──────────────────────
    {
      name: 'BBQ (Bias Benchmark for QA)',
      principle: 'fairness',
      description: 'Measures social biases in question-answering across 9 categories (age, disability, gender, nationality, physical appearance, race/ethnicity, religion, socioeconomic status, sexual orientation)',
      methodology: 'Disambiguated QA pairs testing for stereotypical bias. Measures accuracy delta between groups.',
      metrics: JSON.stringify(['bias_score', 'accuracy_delta', 'category_breakdown']),
      euAiActArticle: 'Article 10 — Data and data governance',
    },
    {
      name: 'BOLD (Bias in Open-Ended Language Generation)',
      principle: 'fairness',
      description: 'Evaluates bias in text generation prompts across demographic groups',
      methodology: 'Generates text continuations from demographic-related prompts. Analyzes sentiment and regard across groups.',
      metrics: JSON.stringify(['sentiment_disparity', 'regard_score', 'toxicity_rate']),
      euAiActArticle: 'Article 10 — Data and data governance',
    },
    {
      name: 'WinoBias',
      principle: 'fairness',
      description: 'Tests gender bias in coreference resolution tasks',
      methodology: 'Coreference resolution on sentences with gendered pronouns linked to professions.',
      metrics: JSON.stringify(['type1_accuracy', 'type2_accuracy', 'gender_gap']),
      euAiActArticle: 'Article 10 — Data and data governance',
    },
    {
      name: 'Adult Dataset Fairness',
      principle: 'fairness',
      description: 'Income prediction fairness across protected attributes (race, sex, age)',
      methodology: 'Classification task with demographic parity, equalized odds metrics.',
      metrics: JSON.stringify(['demographic_parity', 'equalized_odds', 'disparate_impact']),
      euAiActArticle: 'Article 10 — Data and data governance',
    },

    // ─── Transparency & Explainability ──────────────────────
    {
      name: 'TruthfulQA',
      principle: 'transparency',
      description: 'Tests whether models generate truthful answers rather than common misconceptions',
      methodology: 'QA benchmark with adversarial questions designed to elicit false but popular answers.',
      metrics: JSON.stringify(['truthful_rate', 'informative_rate', 'truthful_and_informative']),
      euAiActArticle: 'Article 13 — Transparency and provision of information',
    },
    {
      name: 'HaluEval',
      principle: 'transparency',
      description: 'Evaluates hallucination detection and prevention in language models',
      methodology: 'Tests model ability to identify and avoid generating hallucinated content.',
      metrics: JSON.stringify(['hallucination_rate', 'detection_accuracy', 'abstention_rate']),
      euAiActArticle: 'Article 13 — Transparency and provision of information',
    },
    {
      name: 'SHAP Explainability',
      principle: 'transparency',
      description: 'Tests model capability to provide meaningful explanations for predictions',
      methodology: 'SHAP value computation and explanation coherence assessment.',
      metrics: JSON.stringify(['explanation_fidelity', 'human_agreement', 'consistency_score']),
      euAiActArticle: 'Article 13 — Transparency and provision of information',
    },
    {
      name: 'Calibration Test',
      principle: 'transparency',
      description: 'Measures how well model confidence aligns with actual accuracy',
      methodology: 'Expected calibration error across confidence bins.',
      metrics: JSON.stringify(['expected_calibration_error', 'brier_score', 'reliability_diagram']),
      euAiActArticle: 'Article 14 — Human oversight',
    },

    // ─── Technical Robustness & Safety ──────────────────────
    {
      name: 'AdvGLUE',
      principle: 'robustness',
      description: 'Adversarial robustness on NLU tasks (GLUE benchmark with adversarial perturbations)',
      methodology: 'Standard NLU benchmarks with adversarial text manipulations (character swap, word substitution, paraphrase).',
      metrics: JSON.stringify(['clean_accuracy', 'adversarial_accuracy', 'robustness_gap']),
      euAiActArticle: 'Article 15 — Accuracy, robustness and cybersecurity',
    },
    {
      name: 'TextFooler Robustness',
      principle: 'robustness',
      description: 'Tests resilience against TextFooler adversarial attacks',
      methodology: 'Synonym substitution attacks targeting model predictions.',
      metrics: JSON.stringify(['attack_success_rate', 'perturbed_accuracy', 'semantic_similarity']),
      euAiActArticle: 'Article 15 — Accuracy, robustness and cybersecurity',
    },
    {
      name: 'CheckList Behavioral',
      principle: 'robustness',
      description: 'Systematic behavioral testing across linguistic capabilities',
      methodology: 'Minimum functionality tests, invariance tests, and directional expectation tests.',
      metrics: JSON.stringify(['mft_pass_rate', 'invariance_pass_rate', 'directional_pass_rate']),
      euAiActArticle: 'Article 15 — Accuracy, robustness and cybersecurity',
    },
    {
      name: 'Safety Benchmark (Do-Not-Answer)',
      principle: 'robustness',
      description: 'Tests model safety by measuring refusal rates on harmful prompts',
      methodology: 'Evaluates model responses to harmful requests across categories (violence, illegal, harmful advice).',
      metrics: JSON.stringify(['refusal_rate', 'harmful_response_rate', 'category_breakdown']),
      euAiActArticle: 'Article 9 — Risk management system',
    },

    // ─── Privacy & Data Governance ──────────────────────────
    {
      name: 'PII Leakage Test',
      principle: 'privacy',
      description: 'Tests whether models memorize and leak personally identifiable information from training data',
      methodology: 'Probing for memorized PII (emails, phone numbers, addresses) using targeted prompts.',
      metrics: JSON.stringify(['pii_leak_rate', 'memorization_score', 'extraction_success']),
      euAiActArticle: 'Article 10 — Data and data governance',
    },
    {
      name: 'Membership Inference',
      principle: 'privacy',
      description: 'Tests model vulnerability to membership inference attacks',
      methodology: 'Shadow model training to determine if specific data points were in training set.',
      metrics: JSON.stringify(['auc_score', 'true_positive_rate', 'false_positive_rate']),
      euAiActArticle: 'Article 10 — Data and data governance',
    },
    {
      name: 'Differential Privacy Assessment',
      principle: 'privacy',
      description: 'Evaluates the privacy guarantees of model training and inference',
      methodology: 'Epsilon-delta differential privacy budget analysis.',
      metrics: JSON.stringify(['epsilon', 'delta', 'utility_loss']),
      euAiActArticle: 'Article 10 — Data and data governance',
    },

    // ─── Accountability & Governance ────────────────────────
    {
      name: 'Audit Trail Completeness',
      principle: 'accountability',
      description: 'Tests whether model decisions can be fully traced and reproduced',
      methodology: 'Input-output logging completeness, decision tracing, and reproducibility checks.',
      metrics: JSON.stringify(['logging_completeness', 'reproducibility_rate', 'trace_depth']),
      euAiActArticle: 'Article 12 — Record-keeping',
    },
    {
      name: 'Model Card Completeness',
      principle: 'accountability',
      description: 'Evaluates documentation completeness against EU AI Act requirements',
      methodology: 'Checks presence and quality of: intended use, limitations, training data, evaluation metrics, ethical considerations.',
      metrics: JSON.stringify(['section_coverage', 'quality_score', 'missing_sections']),
      euAiActArticle: 'Article 11 — Technical documentation',
    },
    {
      name: 'Version Control Assessment',
      principle: 'accountability',
      description: 'Tests model versioning, rollback capability, and change tracking',
      methodology: 'Verifies version history, change logs, and rollback procedures exist.',
      metrics: JSON.stringify(['version_tracked', 'rollback_capable', 'changelog_quality']),
      euAiActArticle: 'Article 12 — Record-keeping',
    },

    // ─── Human Oversight ────────────────────────────────────
    {
      name: 'Human-AI Delegation',
      principle: 'human_oversight',
      description: 'Tests model ability to defer to human judgment on uncertain predictions',
      methodology: 'Selective prediction: measures model ability to abstain when uncertain.',
      metrics: JSON.stringify(['coverage_at_95_accuracy', 'abstention_quality', 'human_escalation_rate']),
      euAiActArticle: 'Article 14 — Human oversight',
    },
    {
      name: 'Override Capability',
      principle: 'human_oversight',
      description: 'Tests whether model outputs can be effectively overridden by human operators',
      methodology: 'Verifies API/interface supports override, correction, and feedback mechanisms.',
      metrics: JSON.stringify(['override_supported', 'correction_latency', 'feedback_loop_quality']),
      euAiActArticle: 'Article 14 — Human oversight',
    },
    {
      name: 'Interpretability Score',
      principle: 'human_oversight',
      description: 'Measures how well humans can understand and predict model behavior',
      methodology: 'Human evaluation of model explanations, prediction of model behavior on new inputs.',
      metrics: JSON.stringify(['human_simulatability', 'explanation_satisfaction', 'prediction_accuracy']),
      euAiActArticle: 'Article 14 — Human oversight',
    },

    // ─── Accuracy & Performance ─────────────────────────────
    {
      name: 'MMLU (Massive Multitask Language Understanding)',
      principle: 'accuracy',
      description: 'Comprehensive knowledge and reasoning evaluation across 57 subjects',
      methodology: 'Multiple-choice QA spanning STEM, humanities, social sciences, and professional domains.',
      metrics: JSON.stringify(['overall_accuracy', 'stem_accuracy', 'humanities_accuracy', 'social_science_accuracy']),
      euAiActArticle: 'Article 15 — Accuracy, robustness and cybersecurity',
    },
    {
      name: 'HellaSwag',
      principle: 'accuracy',
      description: 'Tests commonsense reasoning and natural language inference',
      methodology: 'Sentence completion requiring real-world physical and social reasoning.',
      metrics: JSON.stringify(['accuracy', 'confidence_correlation']),
      euAiActArticle: 'Article 15 — Accuracy, robustness and cybersecurity',
    },
    {
      name: 'ARC (AI2 Reasoning Challenge)',
      principle: 'accuracy',
      description: 'Grade-school science reasoning benchmark',
      methodology: 'Multiple-choice science questions requiring multi-step reasoning.',
      metrics: JSON.stringify(['easy_accuracy', 'challenge_accuracy', 'reasoning_depth']),
      euAiActArticle: 'Article 15 — Accuracy, robustness and cybersecurity',
    },

    // ─── Societal & Environmental Impact ────────────────────
    {
      name: 'Toxicity Detection (RealToxicityPrompts)',
      principle: 'societal_impact',
      description: 'Measures propensity to generate toxic, harmful, or offensive content',
      methodology: 'Continuation generation from prompts with varying toxicity levels.',
      metrics: JSON.stringify(['avg_toxicity', 'max_toxicity', 'toxic_continuation_rate']),
      euAiActArticle: 'Article 9 — Risk management system',
    },
    {
      name: 'Carbon Footprint Assessment',
      principle: 'societal_impact',
      description: 'Evaluates environmental impact of model training and inference',
      methodology: 'CO2 emission estimation from compute usage, energy source analysis.',
      metrics: JSON.stringify(['training_co2_kg', 'inference_co2_per_1k_tokens', 'energy_source']),
      euAiActArticle: 'Recital 27 — Environmental considerations',
    },
    {
      name: 'CrowS-Pairs',
      principle: 'societal_impact',
      description: 'Tests for stereotypical biases across 9 social categories',
      methodology: 'Masked token prediction comparing stereotypical vs anti-stereotypical sentences.',
      metrics: JSON.stringify(['stereotype_score', 'category_scores', 'overall_bias_direction']),
      euAiActArticle: 'Article 10 — Data and data governance',
    },
    {
      name: 'WinoGender',
      principle: 'societal_impact',
      description: 'Measures occupational gender bias in coreference resolution',
      methodology: 'Coreference resolution on occupation-gender pairs, comparing with labor statistics.',
      metrics: JSON.stringify(['gotcha_accuracy', 'gender_gap', 'correlation_with_stats']),
      euAiActArticle: 'Article 10 — Data and data governance',
    },
  ];

  for (const def of definitions) {
    db.insert(benchmarkDefinitions).values({
      id: randomUUID(),
      ...def,
      isActive: true,
      version: '1.0',
      createdAt: now,
    }).run();
  }

  logger.info(`Seeded ${definitions.length} COMPL-AI benchmark definitions`);
}

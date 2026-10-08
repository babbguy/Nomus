import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { policyRules, shadowTestResults } from '../db/schema.js';
import { logger } from '../logger.js';

interface ShadowTestFixture {
  name: string;
  jurisdiction: string;
  context: Record<string, string>;
  expectedEffect: string;
}

/**
 * Built-in test fixtures that validate policy rules are firing correctly.
 * These are the "known good" test cases — Nomus audits itself.
 */
const TEST_FIXTURES: ShadowTestFixture[] = [
  // ─── EU AI Act ─────────────────────────────────────────────────
  {
    name: 'EU AI Act Annex III 1(a): remote biometric identification is denied without conformity',
    jurisdiction: 'EU',
    context: { action: 'high_risk_biometric', region: 'EU' },
    expectedEffect: 'deny',
  },
  {
    name: 'EU AI Act Annex III 6: law-enforcement AI is denied without conformity',
    jurisdiction: 'EU',
    context: { action: 'high_risk_law_enforcement', region: 'EU' },
    expectedEffect: 'deny',
  },
  {
    name: 'EU AI Act Annex III 4: employment AI requires an audit trail',
    jurisdiction: 'EU',
    context: { action: 'high_risk_employment', region: 'EU' },
    expectedEffect: 'allow_with_audit',
  },
  {
    name: 'EU AI Act Art. 50(1): chatbot interaction requires disclosure',
    jurisdiction: 'EU',
    context: { action: 'ai_user_interaction', region: 'EU' },
    expectedEffect: 'require_disclosure',
  },
  {
    name: 'EU AI Act Art. 50(2): synthetic media must be marked',
    jurisdiction: 'EU',
    context: { action: 'generates_synthetic_media', region: 'EU' },
    expectedEffect: 'require_disclosure',
  },
  {
    name: 'EU AI Act Art. 50(3): emotion recognition requires disclosure',
    jurisdiction: 'EU',
    context: { action: 'emotion_recognition', region: 'EU' },
    expectedEffect: 'require_disclosure',
  },
  // ─── GDPR ──────────────────────────────────────────────────────
  {
    name: 'GDPR Art. 5: writing personal data to logs is denied',
    jurisdiction: 'EU',
    context: { action: 'logs_pii', region: 'EU' },
    expectedEffect: 'deny',
  },
  // ─── US federal ────────────────────────────────────────────────
  {
    name: 'HIPAA 164.502: PHI sent in an AI call is denied',
    jurisdiction: 'US-FED',
    context: { action: 'phi_in_ai_call', data_type: 'health', region: 'US-FED' },
    expectedEffect: 'deny',
  },
  {
    name: 'GLBA Safeguards Rule: financial data sent to a third party is denied without safeguards',
    jurisdiction: 'US-FED',
    context: { action: 'sends_to_third_party', sector: 'finance', region: 'US-FED' },
    expectedEffect: 'deny',
  },
  {
    name: 'FDA AI/ML SaMD: AI output returned to patients requires transparency',
    jurisdiction: 'US-FED',
    context: { action: 'returns_ai_to_user', sector: 'healthcare', region: 'US-FED' },
    expectedEffect: 'require_disclosure',
  },
  {
    name: 'NIST AI RMF MANAGE 3.1: critical-infrastructure AI requires pre-deployment testing',
    jurisdiction: 'US-FED',
    context: { action: 'high_risk_critical_infra', region: 'US-FED' },
    expectedEffect: 'require_disclosure',
  },
  // ─── NIST CSF ──────────────────────────────────────────────────
  {
    name: 'NIST CSF PR.DS: secrets in code are denied',
    jurisdiction: 'NIST',
    context: { action: 'contains_secret' },
    expectedEffect: 'deny',
  },
  // ─── California ────────────────────────────────────────────────
  {
    name: 'CCPA 1798.140: handling biometric information is denied without safeguards',
    jurisdiction: 'US-CA',
    context: { action: 'handles_biometric', region: 'US-CA' },
    expectedEffect: 'deny',
  },
  {
    name: 'CCPA 1798.185: automated decision-making requires disclosure',
    jurisdiction: 'US-CA',
    context: { action: 'returns_ai_to_user', region: 'US-CA' },
    expectedEffect: 'require_disclosure',
  },
];

/**
 * Run all shadow tests against the current policy database.
 * Returns pass/fail results for each fixture.
 */
export interface ShadowTestResult {
  name: string;
  jurisdiction: string;
  status: 'passed' | 'failed' | 'skipped';
  passed: boolean;
  expected: string;
  actual: string;
  reason?: string;
}

export function runShadowTests(): {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  results: ShadowTestResult[];
} {
  const db = getDb();
  const results: ShadowTestResult[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const fixture of TEST_FIXTURES) {
    const start = performance.now();

    // Find matching rules
    const rules = db.select().from(policyRules)
      .where(and(
        eq(policyRules.isActive, true),
        eq(policyRules.jurisdiction, fixture.jurisdiction),
      ))
      .all();

    // Nothing to test until the jurisdiction has active rules (for example
    // when an admin has deactivated its sources). Report it, don't fail it.
    if (rules.length === 0) {
      skipped++;
      results.push({
        name: fixture.name,
        jurisdiction: fixture.jurisdiction,
        status: 'skipped',
        passed: false,
        expected: fixture.expectedEffect,
        actual: 'none',
        reason: `No active rules for ${fixture.jurisdiction}`,
      });
      continue;
    }

    let matchedEffect = 'none';
    const effectRank: Record<string, number> = {
      'deny': 4, 'require_disclosure': 3, 'allow_with_audit': 2, 'flag': 1,
    };

    for (const rule of rules) {
      const conditions = JSON.parse(rule.conditions) as Record<string, string>;
      let matched = true;

      for (const [key, value] of Object.entries(conditions)) {
        if (value && fixture.context[key] !== value) {
          matched = false;
          break;
        }
      }

      if (matched && (effectRank[rule.effect] ?? 0) > (effectRank[matchedEffect] ?? 0)) {
        matchedEffect = rule.effect;
      }
    }

    const testPassed = matchedEffect === fixture.expectedEffect;
    const duration = Math.round(performance.now() - start);

    if (testPassed) passed++;
    else failed++;

    results.push({
      name: fixture.name,
      jurisdiction: fixture.jurisdiction,
      status: testPassed ? 'passed' : 'failed',
      passed: testPassed,
      expected: fixture.expectedEffect,
      actual: matchedEffect,
    });

    // Record result
    db.insert(shadowTestResults).values({
      id: randomUUID(),
      testName: fixture.name,
      inputContext: JSON.stringify(fixture.context),
      expectedEffect: fixture.expectedEffect,
      actualEffect: matchedEffect,
      passed: testPassed,
      durationMs: duration,
      runAt: new Date().toISOString(),
    }).run();
  }

  logger.info({ total: TEST_FIXTURES.length, passed, failed, skipped }, 'Shadow tests completed');

  return { total: TEST_FIXTURES.length, passed, failed, skipped, results };
}

import { randomUUID, createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { policyRules, attestationReceipts } from '../db/schema.js';
import { signData } from './signing.js';
import { canonicalJSON } from './policy-compiler.js';
import { ATTESTATION_SCHEMA_VERSION } from './attestation-lifecycle.js';
import type { PolicyConditions } from '@nomus/shared';

export interface EvaluationResult {
  id: string;
  result: 'compliant' | 'non_compliant' | 'requires_review';
  rulesEvaluated: Array<{
    ruleKey: string;
    version: number;
    effect: string;
    matched: boolean;
  }>;
  policyStateHash: string;
  signature: string;
  evaluatedAt: string;
  schemaVersion: number;
  expiresAt: string | null;
}

/**
 * Evaluate an action context against all active policies for a jurisdiction.
 * Returns a signed attestation receipt.
 *
 * options.expiresAt (UTC ISO-8601 Z, validated at the route boundary) sets a
 * lifecycle expiry on the receipt. Lifecycle fields are NOT part of the
 * signed payload — the signature covers the immutable attested facts only
 * (see core/attestation-lifecycle.ts), keeping every historical receipt
 * verifiable under schemaVersion 1.
 */
export function evaluateCompliance(
  orgId: string,
  actionContext: PolicyConditions,
  jurisdiction: string,
  options?: { expiresAt?: string | null },
): EvaluationResult {
  const db = getDb();

  // Get all active rules for the jurisdiction
  const rules = db.select().from(policyRules)
    .where(and(
      eq(policyRules.isActive, true),
      eq(policyRules.jurisdiction, jurisdiction),
    ))
    .all();

  const evaluated: EvaluationResult['rulesEvaluated'] = [];
  let worstEffect: string = 'compliant';
  const effectRank: Record<string, number> = {
    'deny': 4,
    'require_disclosure': 3,
    'allow_with_audit': 2,
    'flag': 1,
  };

  for (const rule of rules) {
    const conditions = JSON.parse(rule.conditions) as Record<string, string>;
    let matched = true;

    // Check if the action context matches the rule conditions
    for (const [key, value] of Object.entries(conditions)) {
      if (value && actionContext[key] !== value) {
        matched = false;
        break;
      }
    }

    evaluated.push({
      ruleKey: rule.ruleKey,
      version: rule.version,
      effect: rule.effect,
      matched,
    });

    if (matched && (effectRank[rule.effect] ?? 0) > (effectRank[worstEffect] ?? 0)) {
      worstEffect = rule.effect;
    }
  }

  // Determine overall result
  let result: 'compliant' | 'non_compliant' | 'requires_review';
  if (worstEffect === 'deny') {
    result = 'non_compliant';
  } else if (worstEffect === 'require_disclosure' || worstEffect === 'allow_with_audit') {
    result = 'requires_review';
  } else {
    result = 'compliant';
  }

  // Compute state hash
  const stateHash = createHash('sha256')
    .update(rules.map((r) => r.signature).sort().join('|'))
    .digest('hex');

  const now = new Date().toISOString();
  const receiptId = randomUUID();

  // Sign the receipt
  const receiptData = canonicalJSON({
    id: receiptId,
    orgId,
    actionContext,
    result,
    jurisdiction,
    policyStateHash: stateHash,
    evaluatedAt: now,
  });
  const signature = signData(receiptData);

  const expiresAt = options?.expiresAt ?? null;

  // Store attestation receipt
  db.insert(attestationReceipts).values({
    id: receiptId,
    orgId,
    actionContext: JSON.stringify(actionContext),
    rulesEvaluated: JSON.stringify(evaluated),
    result,
    jurisdiction,
    policyStateHash: stateHash,
    signature,
    evaluatedAt: now,
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    expiresAt,
  }).run();

  return {
    id: receiptId,
    result,
    rulesEvaluated: evaluated,
    policyStateHash: stateHash,
    signature,
    evaluatedAt: now,
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    expiresAt,
  };
}

// Test helpers: a signed org bundle built the way the engine signs it, and
// corporate findings as the scanner reports them.
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  bundleHashOf, bundleSignedText, canonicalJson, corporateRuleSchema, policyActivationPayload, ruleHashOf,
  type BundlePolicy, type CorporateBundle,
} from '@nomus/scanner/corporate';
import type { CorporateFinding } from '@nomus/scanner';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
export const SPKI = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const signText = (t: string) => sign(null, Buffer.from(t, 'utf8'), privateKey).toString('base64');
export const ORG = '6f1c2a4e-9b7d-4c3e-8a21-0d5e6f7a8b9c';

export function signedPolicy(policyKey = 'corp.no-direct-openai', over: Partial<BundlePolicy> = {}): BundlePolicy {
  const rule = corporateRuleSchema.parse({
    schemaVersion: 1, match: { all: [{ kind: 'line_regex', pattern: { source: 'gpt-4-32k', flags: '' } }] },
    files: { include: ['**/*'] }, message: 'The gpt-4-32k model is retired for new code.',
  });
  const p = {
    policyId: '0b8f5d2c-3e4a-4f6b-9c1d-2e3f4a5b6c7d', policyKey, version: 1, title: 'Do not use gpt-4-32k', tier: 'prohibited' as const,
    owningBoards: [{ id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'AI Review Board' }],
    enforceFrom: '2026-10-01T09:00:00.000Z', activatedAt: '2026-10-01T09:00:00.000Z', rule, ruleHash: ruleHashOf(rule), ...over,
  };
  return { ...p, activationSignature: signText(canonicalJson(policyActivationPayload(ORG, p))) };
}

export function signedBundle(policies: BundlePolicy[] = [signedPolicy()], enabled = true, generatedAt = '2026-10-09T10:00:00.000Z'): CorporateBundle {
  const ps = enabled ? policies : [];
  const b = { kind: 'nomus.cpg-bundle.v1' as const, enabled, orgId: ORG, generatedAt, bundleHash: bundleHashOf(ps), policies: ps, minScannerVersion: '1.2.0' as const };
  return { ...b, signature: signText(bundleSignedText(b)) };
}

export function corporateFinding(over: Partial<CorporateFinding> = {}): CorporateFinding {
  const base: CorporateFinding = {
    source: 'corporate', file: '/project/src/chat.ts', filePath: 'src/chat.ts', language: 'typescript',
    startLine: 7, endLine: 10, anchorLine: 7, matchedBy: 'sdk_call',
    policyKey: 'corp.no-direct-openai', policyVersion: 2, tier: 'prohibited', status: 'needs_review', blocking: true,
    enforceFrom: '2026-10-01T09:00:00.000Z', fingerprint: `${'a'.repeat(64)}:corp.no-direct-openai:2`, snippetHash: 'a'.repeat(64),
    snippet: 'const r = await client.chat.completions.create({', truncated: false,
    rule: {
      policyId: '0b8f5d2c-3e4a-4f6b-9c1d-2e3f4a5b6c7d', policyKey: 'corp.no-direct-openai', version: 2, title: 'No direct OpenAI calls', tier: 'prohibited',
      message: 'Call OpenAI only through the approved LLM gateway.',
      owningBoards: [{ id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'AI Review Board' }, { id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', name: 'Legal' }],
      enforceFrom: '2026-10-01T09:00:00.000Z', activatedAt: '2026-10-01T09:00:00.000Z', policyReference: 'Corporate policy corp.no-direct-openai v2: No direct OpenAI calls',
    },
  };
  return { ...base, ...over };
}

/**
 * Fail-closed LLM-gate tests:
 *   - structural-verifier: the LLM spot-check may ADD concerns but can NEVER
 *     downgrade a genuine completeness error (truncation/gap/too_short) from
 *     error→warning to flip FAIL→PASS.
 *   - gatekeeper: when the contamination classifier cannot run it must report
 *     'skipped' (gate did not run) — never 'verified'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable LLM layer. structural-verifier uses generateWithFallback;
// gatekeeper uses resolveProvider. Both live in ../llm/provider.js.
const generateWithFallback = vi.fn();
const resolveProvider = vi.fn();

vi.mock('../llm/provider.js', () => ({
  generateWithFallback: (...args: unknown[]) => generateWithFallback(...args),
  resolveProvider: (...args: unknown[]) => resolveProvider(...args),
}));

vi.mock('../llm/pricing.js', () => ({
  calculateCostCents: vi.fn().mockReturnValue(0),
}));

vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { verifyStructure } from './structural-verifier.js';
import { runGatekeeper } from './gatekeeper.js';

beforeEach(() => {
  generateWithFallback.mockReset();
  resolveProvider.mockReset();
});

function truncatedDoc(): string {
  const parts = [
    'REGULATION (EU) 2024/1689 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL',
    'THE EUROPEAN PARLIAMENT AND THE COUNCIL OF THE EUROPEAN UNION,',
    'HAVE ADOPTED THIS REGULATION:',
  ];
  for (let i = 1; i <= 15; i++) {
    parts.push(`Article ${i}`);
    parts.push('This article sets out obligations of providers and users with respect to compliance, monitoring, transparency, and enforcement. Member States shall ensure adequate measures are in place.');
  }
  // Ends mid-sentence, long final line, NO terminal punctuation → truncation.
  parts.push('This final provision continues at length describing the obligations of providers and users and Member States and the Commission across the entire lifecycle of high risk artificial intelligence systems without any closing punctuation because the document was cut off mid');
  return parts.join('\n\n');
}

describe('structural-verifier truncation is terminal', () => {
  it('detects a mid-paragraph cutoff with a LONG final line as an error', async () => {
    // LLM disabled — pure deterministic detection.
    generateWithFallback.mockRejectedValue(new Error('LLM off'));
    const result = await verifyStructure(truncatedDoc(), 'EU AI Act', 'EU');
    const trunc = result.issues.find((i) => i.type === 'truncation');
    expect(trunc).toBeDefined();
    expect(trunc!.severity).toBe('error');
    expect(result.passed).toBe(false);
  });

  it('does NOT let the LLM dismiss a truncation error (FAIL stays FAIL)', async () => {
    generateWithFallback.mockResolvedValue({
      content: JSON.stringify({
        is_real_regulation: true,
        issues_confirmed: [],
        issues_dismissed: ['Document appears truncated'],
        explanation: 'I think it is fine actually',
      }),
      tokensIn: 10,
      tokensOut: 5,
      model: 'test',
      provider: 'test',
    });

    const result = await verifyStructure(truncatedDoc(), 'EU AI Act', 'EU');
    const trunc = result.issues.find((i) => i.type === 'truncation');
    expect(trunc).toBeDefined();
    // Terminal — must remain an error despite the LLM's dismissal.
    expect(trunc!.severity).toBe('error');
    expect(result.passed).toBe(false);
  });

  it('lets the LLM ADD a not-real-regulation error but never clear completeness', async () => {
    generateWithFallback.mockResolvedValue({
      content: JSON.stringify({
        is_real_regulation: false,
        issues_confirmed: [],
        issues_dismissed: [],
        explanation: 'this is a cookie banner',
      }),
      tokensIn: 10,
      tokensOut: 5,
      model: 'test',
      provider: 'test',
    });
    const result = await verifyStructure(truncatedDoc(), 'EU AI Act', 'EU');
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.type === 'suspicious_content' && i.severity === 'error')).toBe(true);
  });
});

describe('gatekeeper fail-closed labelling', () => {
  const longContent = 'Article 1\n'.repeat(80) + 'The provider shall maintain records. '.repeat(40);

  it('reports skipped (not verified) when the classifier LLM throws', async () => {
    resolveProvider.mockRejectedValue(new Error('provider down'));
    const r = await runGatekeeper(longContent, 'Test Source', 'EU');
    expect(r.status).toBe('skipped');
  });

  it('reports skipped for content too short to inspect', async () => {
    const r = await runGatekeeper('too short', 'Test Source', 'EU');
    expect(r.status).toBe('skipped');
    // Did not even call the provider.
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it('reports verified when the classifier runs and finds clean legal text', async () => {
    resolveProvider.mockResolvedValue({
      provider: {
        generate: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            issues: [],
            structure: { starts_with_title: true, has_legal_structure: true, proper_ending: true },
          }),
          tokensIn: 10,
          tokensOut: 5,
        }),
      },
      model: 'test-model',
    });
    const r = await runGatekeeper(longContent, 'Test Source', 'EU');
    expect(r.status).toBe('verified');
  });
});

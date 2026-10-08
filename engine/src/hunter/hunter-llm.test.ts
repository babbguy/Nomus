/**
 * Hunter LLM-driven function tests — covers gatekeeper, bulk-extractor,
 * rule-scorer, and translator with a stubbed LLMProvider.
 *
 * Closes the rest of the UNTESTED-but-probably-works gap from the
 * 2026-04-07 end-to-end audit. Each function is exercised end-to-end
 * with deterministic mocked responses so we can prove parsing, error
 * handling, and result aggregation all work.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Stub the LLM provider before any module-under-test imports ──────
//
// resolveProvider returns a fake provider whose `generate` method is a
// vi.fn() — each test installs the response payload it wants to test
// against. vi.hoisted() lets us share the stub between the (hoisted)
// vi.mock factory and our describe blocks below.

const { stubGenerate } = vi.hoisted(() => ({
  stubGenerate: vi.fn(),
}));

vi.mock('../llm/provider.js', () => ({
  resolveProvider: vi.fn().mockResolvedValue({
    provider: { generate: stubGenerate },
    providerName: 'anthropic',
    model: 'claude-haiku-test',
  }),
}));

// SSE manager broadcasts progress events — neutralize so tests don't
// touch the real SSE manager singleton.
vi.mock('../sse/manager.js', () => ({
  broadcastEvent: vi.fn(),
}));

import { runGatekeeper } from './gatekeeper.js';
import { bulkExtract, type ChunkInput } from './bulk-extractor.js';
import { scoreRules } from './rule-scorer.js';
import { translateToRules } from './translator.js';

beforeEach(() => {
  stubGenerate.mockReset();
});

function llmReply(content: string, tokensIn = 100, tokensOut = 50) {
  return {
    content,
    tokensIn,
    tokensOut,
    model: 'claude-haiku-test',
    provider: 'anthropic' as const,
  };
}

// ════════════════════════════════════════════════════════════════════
// runGatekeeper
// ════════════════════════════════════════════════════════════════════

describe('runGatekeeper', () => {
  it('reports skipped (gate did not run) for content shorter than the inspection threshold', async () => {
    const result = await runGatekeeper('short content', 'TestSource', 'EU');
    // Fail-closed labelling: the gate never inspected it, so it is NOT 'verified'.
    expect(result.status).toBe('skipped');
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
    expect(stubGenerate).not.toHaveBeenCalled();
  });

  it('marks content verified when LLM returns no issues and valid structure', async () => {
    stubGenerate.mockResolvedValueOnce(llmReply(JSON.stringify({
      issues: [],
      structure: { starts_with_title: true, has_legal_structure: true, proper_ending: true },
    })));

    const longContent = 'Article 1. ' + 'Lorem ipsum dolor sit amet '.repeat(200);
    const result = await runGatekeeper(longContent, 'EU AI Act', 'EU');
    expect(result.status).toBe('verified');
    expect(result.issues).toEqual([]);
    expect(result.tokensIn).toBe(100);
    expect(stubGenerate).toHaveBeenCalledOnce();
  });

  it('reports skipped (not verified) when the LLM throws — still does not block the pipeline', async () => {
    stubGenerate.mockRejectedValueOnce(new Error('rate limited'));

    const longContent = 'Article 1. ' + 'Lorem ipsum dolor sit amet '.repeat(200);
    const result = await runGatekeeper(longContent, 'EU AI Act', 'EU');
    // Gatekeeper failures must NOT block the pipeline, but must NOT be labelled
    // 'verified' when the gate never actually ran.
    expect(result.status).toBe('skipped');
    expect(result.issues).toEqual([]);
  });

  it('reports skipped (not verified) when the LLM returns unparseable JSON', async () => {
    stubGenerate.mockResolvedValueOnce(llmReply('this is not json'));
    const longContent = 'Article 1. ' + 'Lorem ipsum dolor sit amet '.repeat(200);
    const result = await runGatekeeper(longContent, 'EU AI Act', 'EU');
    expect(result.status).toBe('skipped');
    // Token counts still credited even on parse failure
    expect(result.tokensIn).toBe(100);
  });

  it('returns a defensible status (cleaned/failed/verified) when LLM flags issues', async () => {
    stubGenerate.mockResolvedValueOnce(llmReply(JSON.stringify({
      issues: [
        { type: 'boilerplate_intro', description: 'Cookie banner', location: 'start' },
        { type: 'boilerplate_outro', description: 'Footer text', location: 'end' },
      ],
      structure: { starts_with_title: false, has_legal_structure: true, proper_ending: false },
    })));

    const longContent = 'Article 1.\n' + 'Real legal content goes here. '.repeat(200);
    const result = await runGatekeeper(longContent, 'TestSource', 'EU');
    // Possible outcomes when issues are flagged:
    //   - 'cleaned': stripping succeeded and kept >50% of content
    //   - 'failed': stripping removed >50% — content is mostly junk
    //   - 'verified': structurally OK, no real stripping happened
    // All three are documented gatekeeper outputs. The bug we're guarding
    // against is the function silently returning a malformed result.
    expect(['cleaned', 'failed', 'verified']).toContain(result.status);
    expect(result.tokensIn).toBe(100);
  });
});

// ════════════════════════════════════════════════════════════════════
// bulkExtract
// ════════════════════════════════════════════════════════════════════

describe('bulkExtract', () => {
  function makeChunks(n: number): ChunkInput[] {
    return Array.from({ length: n }, (_, i) => ({
      content: `Article ${i + 1}\nProviders shall implement risk management measures.`,
      breadcrumb: `Chapter 1 > Article ${i + 1}`,
      index: i,
      totalChunks: n,
      articleRef: `Article ${i + 1}`,
    }));
  }

  it('extracts requirements from each chunk in parallel batches', async () => {
    stubGenerate.mockResolvedValue(llmReply(JSON.stringify([
      {
        ref: 'Article 1',
        type: 'obligation',
        who: 'providers of high-risk AI systems',
        what: 'implement a risk management system',
        conditions: 'before placing on market',
        severity: 'high',
        effective_date: null,
        industries: ['all'],
        industry_scope: 'global',
        industry_notes: '',
      },
    ])));

    const chunks = makeChunks(3);
    const results = await bulkExtract(chunks);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.success).toBe(true);
      expect(r.requirements).toHaveLength(1);
      expect(r.requirements[0].ref).toBe('Article 1');
      expect(r.requirements[0].who).toContain('providers');
    }
    expect(stubGenerate).toHaveBeenCalledTimes(3);
  });

  it('strips ```json fences from LLM output', async () => {
    stubGenerate.mockResolvedValue(llmReply('```json\n[{"ref":"Art 5","what":"do thing","type":"obligation","who":"x","conditions":"y","severity":"low","effective_date":null,"industries":["all"],"industry_scope":"global","industry_notes":""}]\n```'));
    const results = await bulkExtract(makeChunks(1));
    expect(results[0].requirements).toHaveLength(1);
    expect(results[0].requirements[0].ref).toBe('Art 5');
  });

  it('records failure (success: false) when LLM keeps throwing past max retries', async () => {
    stubGenerate.mockRejectedValue(new Error('502 bad gateway'));
    const results = await bulkExtract(makeChunks(1));
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].requirements).toEqual([]);
    expect(results[0].error).toMatch(/502/);
  }, 30_000);

  it('filters out malformed requirements (missing required fields)', async () => {
    stubGenerate.mockResolvedValue(llmReply(JSON.stringify([
      { ref: 'Art 1', what: 'valid one', type: 'obligation' },
      { foo: 'bar' }, // missing ref and what
      { ref: 'Art 2', what: 'another valid one' },
      null,
      'not an object',
    ])));
    const results = await bulkExtract(makeChunks(1));
    expect(results[0].requirements).toHaveLength(2);
    expect(results[0].requirements.map((r) => r.ref)).toEqual(['Art 1', 'Art 2']);
  });

  it('treats a well-formed empty array as a successful chunk with no requirements', async () => {
    // A short-title or definitions-only section has nothing to extract; it is
    // not a failed chunk (failed chunks count toward the 80% abort threshold).
    stubGenerate.mockResolvedValue(llmReply('[]'));
    const results = await bulkExtract(makeChunks(1));
    expect(results[0].success).toBe(true);
    expect(results[0].requirements).toEqual([]);
    expect(results[0].error).toBeUndefined();
  });

  it('fails a chunk whose response is not an array or has no usable items', async () => {
    stubGenerate.mockResolvedValueOnce(llmReply('{"requirements": "none"}'));
    stubGenerate.mockResolvedValueOnce(llmReply('[{"foo":"bar"}]'));
    stubGenerate.mockResolvedValueOnce(llmReply('not json'));
    const results = await bulkExtract(makeChunks(3));
    expect(results.map((r) => r.success)).toEqual([false, false, false]);
    expect(results[0].error).toMatch(/not a JSON array/);
    expect(results[1].error).toMatch(/none with a ref/);
    expect(results[2].error).toMatch(/not a JSON array/);
  });
});

// ════════════════════════════════════════════════════════════════════
// scoreRules
// ════════════════════════════════════════════════════════════════════

describe('scoreRules', () => {
  function makeCandidate(over: Partial<Parameters<typeof scoreRules>[0][0]> = {}) {
    return {
      ruleKey: 'eu_ai_act.art_5.prohibited_practices',
      jurisdiction: 'EU',
      category: 'risk_assessment',
      conditions: { action: 'biometric_id' },
      effect: 'deny',
      severity: 'critical',
      humanSummary: 'Real-time remote biometric identification in public spaces is prohibited.',
      legalReference: 'Article 5(1)(d) of Regulation (EU) 2024/1689',
      effectiveDate: '2024-08-01',
      expiresAt: null as string | null,
      industries: ['all'] as string[],
      industryScope: 'global',
      industryNotes: '',
      ...over,
    };
  }

  it('returns empty result for empty candidate list without calling LLM', async () => {
    const result = await scoreRules([], 'EU AI Act', 'EU');
    expect(result.rules).toEqual([]);
    expect(result.overallScore).toBe(0);
    expect(stubGenerate).not.toHaveBeenCalled();
  });

  it('keeps rules the LLM says are good', async () => {
    stubGenerate.mockResolvedValueOnce(llmReply(JSON.stringify({
      overallScore: 9,
      reject: [],
      adjustments: [],
    })));

    const result = await scoreRules([makeCandidate()], 'EU AI Act', 'EU');
    expect(result.rules).toHaveLength(1);
    expect(result.rejected).toEqual([]);
    expect(result.overallScore).toBeCloseTo(9, 1);
  });

  it('removes rules the LLM rejects', async () => {
    stubGenerate.mockResolvedValueOnce(llmReply(JSON.stringify({
      overallScore: 7,
      reject: ['eu_ai_act.bad_rule'],
      adjustments: [],
    })));

    const candidates = [
      makeCandidate({ ruleKey: 'eu_ai_act.good_rule' }),
      makeCandidate({ ruleKey: 'eu_ai_act.bad_rule' }),
    ];
    const result = await scoreRules(candidates, 'EU AI Act', 'EU');
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].ruleKey).toBe('eu_ai_act.good_rule');
    expect(result.rejected).toContain('eu_ai_act.bad_rule');
  });

  it('applies severity adjustments from the LLM', async () => {
    stubGenerate.mockResolvedValueOnce(llmReply(JSON.stringify({
      overallScore: 8,
      reject: [],
      adjustments: [
        { ruleKey: 'eu_ai_act.art_5.prohibited_practices', field: 'severity', from: 'critical', to: 'high' },
      ],
    })));

    const result = await scoreRules([makeCandidate()], 'EU AI Act', 'EU');
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].severity).toBe('high');
  });

  it('keeps all rules when LLM returns malformed JSON (fail-open)', async () => {
    // scoreRules retries up to 3 times with exponential backoff. Use
    // mockResolvedValue (not Once) so every retry gets the same garbage,
    // and bump test timeout to clear the backoff window.
    stubGenerate.mockResolvedValue(llmReply('not json at all'));

    const result = await scoreRules([makeCandidate(), makeCandidate({ ruleKey: 'b' })], 'EU AI Act', 'EU');
    expect(result.rules).toHaveLength(2);
  }, 60_000);

  it('survives the LLM throwing repeatedly and still produces a result', async () => {
    stubGenerate.mockRejectedValue(new Error('upstream timeout'));
    const result = await scoreRules([makeCandidate()], 'EU AI Act', 'EU');
    // Fail-open: candidate should be kept even though scoring failed
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].ruleKey).toBe('eu_ai_act.art_5.prohibited_practices');
  }, 30_000);
});

// ════════════════════════════════════════════════════════════════════
// translateToRules
// ════════════════════════════════════════════════════════════════════

describe('translateToRules', () => {
  const validRule = {
    ruleKey: 'eu_ai_act.art_5.prohibited_practices',
    jurisdiction: 'EU',
    category: 'risk_assessment',
    conditions: { action: 'biometric_id' },
    effect: 'deny',
    severity: 'critical',
    humanSummary: 'Real-time remote biometric identification is prohibited in public spaces.',
    legalReference: 'Article 5(1)(d) of Regulation (EU) 2024/1689',
    effectiveDate: '2024-08-01',
    expiresAt: null,
  };

  it('returns the parsed and schema-validated rules from a single chunk', async () => {
    stubGenerate.mockResolvedValueOnce(llmReply(JSON.stringify([validRule])));

    const result = await translateToRules('EU AI Act', 'EU', 'short text', []);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].ruleKey).toBe('eu_ai_act.art_5.prohibited_practices');
    expect(result.chunksProcessed).toBe(1);
  });

  it('strips ```json fences from translator output', async () => {
    stubGenerate.mockResolvedValueOnce(llmReply('```json\n' + JSON.stringify([validRule]) + '\n```'));
    const result = await translateToRules('EU AI Act', 'EU', 'short text', []);
    expect(result.rules).toHaveLength(1);
  });

  it('deduplicates rules against existingRuleKeys', async () => {
    stubGenerate.mockResolvedValueOnce(llmReply(JSON.stringify([
      validRule,
      { ...validRule, ruleKey: 'eu_ai_act.art_6' },
    ])));

    const result = await translateToRules('EU AI Act', 'EU', 'text', [validRule.ruleKey]);
    // The first rule should be filtered out because it's already known
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].ruleKey).toBe('eu_ai_act.art_6');
  });

  it('throws when the LLM never returns valid JSON', async () => {
    stubGenerate.mockResolvedValue(llmReply('not json'));
    await expect(translateToRules('EU AI Act', 'EU', 'short text', [])).rejects.toThrow();
  });

  it('throws when the LLM output fails schema validation', async () => {
    // Missing required fields like jurisdiction, category, etc.
    stubGenerate.mockResolvedValue(llmReply(JSON.stringify([{ ruleKey: 'bad' }])));
    await expect(translateToRules('EU AI Act', 'EU', 'short text', [])).rejects.toThrow();
  });
});

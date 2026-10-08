/**
 * rule-matcher tests.
 *
 * Fail closed: the matcher must THROW NomusApiError when the
 * Nomus API is unreachable, returns non-2xx (axios rejects), or returns
 * an unexpected shape. It must never return [] on failure — that would let
 * CI compliance gates go green during a backend outage.
 *
 * Capability parsing: the engine emits matched conditions as
 * `capability: ${cap}` WITH a space after the colon
 * (engine/src/server/routes/simulate.ts). The matcher must parse that exact
 * format so per-rule confidence is computed from real matches instead of
 * collapsing to 0 / 0.5.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import {
  matchRulesToSignals,
  NomusApiError,
  isNomusApiError,
  type MatchedRule,
} from './rule-matcher.js';
import { generateSuggestions } from '../fix/suggestions.js';
import type { DetectorSignal } from '../detect/detector.js';
import type { NomusConfig } from '../config/schema.js';

vi.mock('axios', () => ({
  default: { post: vi.fn() },
}));

const mockedPost = vi.mocked(axios.post);

function makeConfig(): NomusConfig {
  return {
    nomus: {
      api_key: 'ul_nomus_test',
      api_url: 'http://nomus.test',
      jurisdictions: ['EU'],
      sector: 'healthcare',
      data_types: [],
      ignore: [],
      detectors: {
        import: true,
        sdk_usage: true,
        phi_pattern: true,
        risk_classifier: true,
        data_flow: true,
        transparency: true,
      },
      max_taint_depth: 3,
    },
  };
}

function makeSignal(overrides: Partial<DetectorSignal> = {}): DetectorSignal {
  return {
    source: 'import-detector',
    file: 'src/ai.ts',
    line: 3,
    target: 'openai',
    capabilities: ['text_generation'],
    confidence: 1.0,
    evidence: "import OpenAI from 'openai'",
    metadata: {},
    ...overrides,
  };
}

function makeRule(overrides: Partial<MatchedRule> = {}): MatchedRule {
  return {
    ruleKey: 'eu.ai_act.transparency',
    effect: 'require_disclosure',
    severity: 'high',
    humanSummary: 'AI-generated content must be disclosed',
    legalReference: 'EU AI Act Art. 50',
    matchedOn: ['capability: text_generation'],
    confidence: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockedPost.mockReset();
});

describe('fail-closed behaviour', () => {
  it('throws NomusApiError when the API is unreachable (network error)', async () => {
    mockedPost.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:443'));

    const promise = matchRulesToSignals([makeSignal()], ['text_generation'], makeConfig());
    await expect(promise).rejects.toBeInstanceOf(NomusApiError);

    mockedPost.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:443'));
    await expect(
      matchRulesToSignals([makeSignal()], ['text_generation'], makeConfig()),
    ).rejects.toThrow(/Nomus API request failed/);
  });

  it('throws NomusApiError when axios rejects for a non-2xx status', async () => {
    // axios rejects on non-2xx by default; simulate its error shape
    const httpError = Object.assign(new Error('Request failed with status code 503'), {
      isAxiosError: true,
      response: { status: 503 },
    });
    mockedPost.mockRejectedValue(httpError);

    await expect(
      matchRulesToSignals([makeSignal()], ['text_generation'], makeConfig()),
    ).rejects.toBeInstanceOf(NomusApiError);
  });

  it('throws NomusApiError on a malformed response (missing markets)', async () => {
    mockedPost.mockResolvedValue({ data: { unexpected: 'shape' } });

    await expect(
      matchRulesToSignals([makeSignal()], ['text_generation'], makeConfig()),
    ).rejects.toThrow(/unexpected response shape/);
  });

  it('throws NomusApiError when the response body is not an object', async () => {
    mockedPost.mockResolvedValue({ data: 'Bad Gateway' });

    await expect(
      matchRulesToSignals([makeSignal()], ['text_generation'], makeConfig()),
    ).rejects.toBeInstanceOf(NomusApiError);
  });

  it('preserves the underlying error as detail/cause for diagnostics', async () => {
    const underlying = new Error('socket hang up');
    mockedPost.mockRejectedValue(underlying);

    try {
      await matchRulesToSignals([makeSignal()], ['text_generation'], makeConfig());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isNomusApiError(err)).toBe(true);
      expect((err as NomusApiError).detail).toBe(underlying);
    }
  });

  it('isNomusApiError distinguishes NomusApiError from generic errors', () => {
    expect(isNomusApiError(new NomusApiError('down'))).toBe(true);
    expect(isNomusApiError(new Error('down'))).toBe(false);
    expect(isNomusApiError('down')).toBe(false);
  });
});

describe('capability-string parsing', () => {
  it("parses the exact engine format 'capability: text_generation' and computes full confidence", async () => {
    // EXACT engine emission: `capability: ${cap}` with a space after the colon
    mockedPost.mockResolvedValue({
      data: {
        markets: {
          EU: { rules: [makeRule({ matchedOn: ['capability: text_generation'] })] },
        },
      },
    });

    const findings = await matchRulesToSignals(
      [makeSignal({ capabilities: ['text_generation'] })],
      ['text_generation'],
      makeConfig(),
    );

    // One capability condition, one detected capability match → 1/1 = 1.0,
    // combined with signal confidence 1.0 → 1.0 (NOT the 0 / 0.5 collapse
    // caused by the leading-space parsing bug).
    expect(findings).toHaveLength(1);
    expect(findings[0].rule.confidence).toBe(1);
  });

  it('computes partial confidence when only some capability conditions match', async () => {
    mockedPost.mockResolvedValue({
      data: {
        markets: {
          EU: {
            rules: [makeRule({
              matchedOn: ['capability: text_generation', 'capability: image_generation'],
            })],
          },
        },
      },
    });

    const findings = await matchRulesToSignals(
      [makeSignal({ capabilities: ['text_generation'] })],
      ['text_generation'],
      makeConfig(),
    );

    // 1 of 2 capability conditions matched → 0.5, signal confidence 1.0 → 0.5
    expect(findings).toHaveLength(1);
    expect(findings[0].rule.confidence).toBe(0.5);
  });

  it('still parses the space-free format capability:text_generation', async () => {
    mockedPost.mockResolvedValue({
      data: {
        markets: {
          EU: { rules: [makeRule({ matchedOn: ['capability:text_generation'] })] },
        },
      },
    });

    const findings = await matchRulesToSignals(
      [makeSignal({ capabilities: ['text_generation'] })],
      ['text_generation'],
      makeConfig(),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].rule.confidence).toBe(1);
  });
});

describe('matchRulesToSignals — end-to-end audit regressions', () => {
  beforeEach(() => mockedPost.mockReset());

  it('reports an INTL rule once per file even though every market returns it', async () => {
    const intl = makeRule({ ruleKey: 'iso27001.annex_a.5_1', matchedOn: ['capability: text_generation'] });
    mockedPost.mockResolvedValueOnce({
      data: { markets: { EU: { rules: [intl] }, 'US-FED': { rules: [intl] } } },
    });
    const findings = await matchRulesToSignals([makeSignal()], ['text_generation'], makeConfig());
    expect(findings).toHaveLength(1);
  });

  it('attributes data-pattern findings to the SDK used in the file, not the pattern name', async () => {
    mockedPost.mockResolvedValueOnce({
      data: { markets: { EU: { rules: [makeRule({ ruleKey: 'gdpr.pii', matchedOn: ['capability: pii_in_ai_call'] })] } } },
    });
    const findings = await matchRulesToSignals([
      makeSignal({ source: 'sdk-usage-detector', target: 'openai.chat.completions.create', metadata: { sdk: 'openai' } }),
      makeSignal({ source: 'phi-pattern-detector', target: 'pii_var', line: 9, capabilities: ['pii_in_ai_call'] }),
    ], ['text_generation', 'pii_in_ai_call'], makeConfig());
    expect(findings).toHaveLength(1);
    expect(findings[0].sdk).toBe('openai');
    expect(findings[0].line).toBe(9);
  });

  it('maps a generic ai_operation rule onto the AI signals', async () => {
    mockedPost.mockResolvedValueOnce({
      data: { markets: { INTL: { rules: [makeRule({ ruleKey: 'trism.inventory', matchedOn: ['capability: ai_operation'] })] } } },
    });
    const findings = await matchRulesToSignals([makeSignal()], ['text_generation'], makeConfig());
    expect(findings).toHaveLength(1);
  });

  it('names an auth failure instead of calling it unreachable', async () => {
    mockedPost.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } }));
    await expect(matchRulesToSignals([makeSignal()], ['text_generation'], makeConfig()))
      .rejects.toThrow(/API key was rejected \(401\)/);
  });
});

describe('matchRulesToSignals — SDK attribution in multi-SDK files', () => {
  beforeEach(() => mockedPost.mockReset());

  const FILE = 'src/api/chat.ts';
  const sdkSignals = (): DetectorSignal[] => [
    makeSignal({ source: 'import-detector', file: FILE, line: 1, target: 'openai', capabilities: [] }),
    makeSignal({ source: 'import-detector', file: FILE, line: 2, target: '@anthropic-ai/sdk', capabilities: [] }),
    makeSignal({
      source: 'sdk-usage-detector', file: FILE, line: 11, target: 'openai.chat.completions.create',
      capabilities: ['text_generation'], metadata: { sdk: 'openai' },
    }),
    makeSignal({
      source: 'sdk-usage-detector', file: FILE, line: 19, target: 'anthropic.messages.create',
      capabilities: ['text_generation'], metadata: { sdk: 'anthropic' },
    }),
  ];

  const rules = () => ({
    data: {
      markets: {
        EU: {
          rules: [
            makeRule({ ruleKey: 'eu_ai_act.art50.2.synthetic_content_marking', matchedOn: ['capability: synthetic_content'] }),
            makeRule({ ruleKey: 'hipaa.phi_in_ai_call', effect: 'deny', matchedOn: ['capability: phi_in_ai_call'] }),
          ],
        },
      },
    },
  });

  it('names the SDK of the nearest call, not the last SDK call in the file', async () => {
    mockedPost.mockResolvedValueOnce(rules());
    const findings = await matchRulesToSignals([
      ...sdkSignals(),
      makeSignal({ source: 'transparency-detector', file: FILE, line: 11, target: 'unmarked_output', capabilities: ['synthetic_content'] }),
      makeSignal({ source: 'phi-pattern-detector', file: FILE, line: 10, target: 'phi_var', capabilities: ['phi_in_ai_call'] }),
    ], ['text_generation', 'synthetic_content', 'phi_in_ai_call'], makeConfig());

    expect(findings.find((f) => f.rule.ruleKey.includes('art50'))?.sdk).toBe('openai');
    expect(findings.find((f) => f.rule.ruleKey.startsWith('hipaa'))?.sdk).toBe('openai');

    const art50 = generateSuggestions(findings).find((f) => f.rule.ruleKey.includes('art50'));
    expect(art50?.suggestion).toContain('responses from this openai call');
    expect(art50?.suggestion).not.toContain('anthropic');
  });

  it('attributes a signal on the second call to the second SDK', async () => {
    mockedPost.mockResolvedValueOnce(rules());
    const findings = await matchRulesToSignals([
      ...sdkSignals(),
      makeSignal({ source: 'transparency-detector', file: FILE, line: 19, target: 'unmarked_output', capabilities: ['synthetic_content'] }),
    ], ['text_generation', 'synthetic_content'], makeConfig());
    expect(findings.find((f) => f.rule.ruleKey.includes('art50'))?.sdk).toBe('anthropic');
  });

  it('breaks distance ties toward the earlier line', async () => {
    mockedPost.mockResolvedValueOnce(rules());
    const tie = await matchRulesToSignals([
      ...sdkSignals(),
      makeSignal({ source: 'transparency-detector', file: FILE, line: 15, target: 'x', capabilities: ['synthetic_content'] }),
    ], ['synthetic_content'], makeConfig());
    expect(tie.find((f) => f.rule.ruleKey.includes('art50'))?.sdk).toBe('openai'); // 4 lines from both calls
  });

  it('falls back to imports only when the file has no SDK-usage signal, then to unknown', async () => {
    mockedPost.mockResolvedValueOnce(rules());
    const importsOnly = await matchRulesToSignals([
      makeSignal({ source: 'import-detector', file: FILE, line: 1, target: 'openai', capabilities: [] }),
      makeSignal({ source: 'import-detector', file: FILE, line: 30, target: 'cohere', capabilities: [] }),
      makeSignal({ source: 'transparency-detector', file: FILE, line: 25, target: 'x', capabilities: ['synthetic_content'] }),
    ], ['synthetic_content'], makeConfig());
    expect(importsOnly.find((f) => f.rule.ruleKey.includes('art50'))?.sdk).toBe('cohere');

    mockedPost.mockResolvedValueOnce(rules());
    const none = await matchRulesToSignals([
      makeSignal({ source: 'transparency-detector', file: FILE, line: 25, target: 'x', capabilities: ['synthetic_content'] }),
    ], ['synthetic_content'], makeConfig());
    expect(none.find((f) => f.rule.ruleKey.includes('art50'))?.sdk).toBe('unknown');
  });
});

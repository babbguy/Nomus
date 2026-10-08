import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies
const mockSource = {
  id: 'source-1',
  name: 'Test Source',
  jurisdiction: 'EU',
  url: 'https://example.com',
  parserType: 'html',
  selectorConfig: '{}',
  lastContentHash: null,
  lastScrapedAt: null,
  pendingUploadHash: null,
  pendingUploadFile: null,
  pendingUploadAt: null,
  scrapeFrequencyHours: 24,
  isActive: true,
};

let mockSourceOverride: any = null;

vi.mock('../db/client.js', () => ({
  getDb: () => ({
    select: () => ({
      from: (table: any) => ({
        where: () => ({
          get: () => mockSourceOverride ?? mockSource,
          all: () => [],
          orderBy: () => ({
            limit: () => ({
              get: () => null,
              all: () => [],
            }),
          }),
        }),
        all: () => [],
      }),
    }),
    insert: () => ({
      values: () => ({
        run: () => ({ changes: 1 }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          run: () => ({ changes: 1 }),
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        run: () => ({ changes: 0 }),
      }),
    }),
    run: () => ({ changes: 1 }),
    all: () => [],
    transaction: (fn: Function) => fn({
      select: () => ({
        from: () => ({
          where: () => ({ get: () => null }),
          orderBy: () => ({
            limit: () => ({ get: () => null }),
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          run: () => ({ changes: 1 }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            run: () => ({ changes: 1 }),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock('../db/schema.js', () => ({
  regulatorySources: { id: 'id', isActive: 'is_active' },
  rawSnapshots: { id: 'id', sourceId: 'source_id', scrapedAt: 'scraped_at' },
  policyRules: { id: 'id', ruleKey: 'rule_key' },
  pipelineRuns: {},
  policyEvents: { sequence: 'sequence' },
  regulatorySignals: {},
  stagedContent: { sourceId: 'source_id' },
  gatekeeperLogs: {},
}));

vi.mock('./gatekeeper.js', () => ({
  runGatekeeper: vi.fn().mockResolvedValue({
    status: 'verified',
    issues: [],
    strippedContent: null,
    strippedBytes: 0,
    structureValid: true,
    tokensIn: 0,
    tokensOut: 0,
  }),
}));

vi.mock('./scraper.js', () => ({
  scrapeSource: vi.fn().mockResolvedValue({
    content: 'Test content for regulatory source processing',
    contentHash: 'hash-new',
    contentQuality: 'valid',
    fetchedAt: new Date().toISOString(),
    wordCount: 100,
    source: 'live',
  }),
  // The pipeline does `err instanceof ManualUploadRequiredError` in its catch —
  // the mock must re-export the class so that check resolves (ACCESS-ESCALATION).
  ManualUploadRequiredError: class ManualUploadRequiredError extends Error {
    code = 'needs_manual_upload';
    reason: string;
    attempts: string;
    constructor(reason: string, attempts = '') {
      super(reason);
      this.name = 'ManualUploadRequiredError';
      this.reason = reason;
      this.attempts = attempts;
    }
  },
}));

vi.mock('./differ.js', () => ({
  hasContentChanged: vi.fn().mockReturnValue(true),
  extractChangedSections: vi.fn().mockReturnValue({
    hasChanges: true,
    changedSections: ['Section 1 changed text'],
    summary: 'Test changes',
  }),
}));

vi.mock('./classifier.js', () => ({
  classifyChange: vi.fn().mockResolvedValue({
    classification: 'material',
    confidence: 0.9,
    llmResponse: { provider: 'openai', model: 'gpt-4', tokensIn: 100, tokensOut: 50 },
  }),
}));

vi.mock('./translator.js', () => ({
  translateToRules: vi.fn().mockResolvedValue({ rules: [], llmResponse: { tokensIn: 0, tokensOut: 0 } }),
}));

vi.mock('../core/signing.js', () => ({
  signData: vi.fn().mockReturnValue('mock-signature'),
}));

vi.mock('../db/ontology.js', () => ({
  getOntologyForPrompt: vi.fn().mockReturnValue(''),
}));

vi.mock('../feedback/refiner.js', () => ({
  buildFeedbackContext: vi.fn().mockReturnValue(''),
}));

vi.mock('../sse/manager.js', () => ({
  broadcastEvent: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
  env: () => ({
    NOMUS_REQUIRE_RULE_APPROVAL: 'false',
  }),
}));

vi.mock('../core/policy-compiler.js', () => ({
  canonicalJSON: vi.fn().mockReturnValue('{}'),
}));

vi.mock('../core/policy-cache.js', () => ({
  policyBundleCache: { invalidate: vi.fn() },
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

vi.mock('./quality-scorer.js', () => ({
  scoreDocumentQuality: vi.fn().mockReturnValue({ overallGrade: 'A' }),
}));

vi.mock('./article-chunker.js', () => ({
  articleChunk: vi.fn().mockReturnValue([{
    content: 'Test article content',
    breadcrumb: 'Art. 1',
    index: 0,
    totalChunks: 1,
    articleRef: 'Article 1',
    strategy: 'article',
  }]),
}));

vi.mock('./bulk-extractor.js', () => ({
  bulkExtract: vi.fn().mockResolvedValue([{
    requirements: [{
      ref: 'Art. 1',
      what: 'Test requirement for AI systems',
      type: 'obligation',
      who: 'providers',
      severity: 'high',
      conditions: '',
      effective_date: '2025-01-01',
      industries: ['all'],
      industry_scope: 'global',
      industry_notes: '',
    }],
    tokensIn: 50,
    tokensOut: 30,
  }]),
}));

vi.mock('./rule-scorer.js', () => ({
  scoreRules: vi.fn().mockResolvedValue({
    rules: [{
      ruleKey: 'eu.art_1.test_requirement_for_ai_system',
      jurisdiction: 'EU',
      category: 'accountability',
      conditions: { action: 'ai_operation', region: 'EU' },
      effect: 'allow_with_audit',
      severity: 'high',
      humanSummary: 'Test requirement for AI systems',
      legalReference: 'Art. 1',
      effectiveDate: '2025-01-01',
      expiresAt: null,
      industries: ['all'],
      industryScope: 'global',
      industryNotes: '',
    }],
    overallScore: 8,
    tokensIn: 40,
    tokensOut: 20,
  }),
}));

vi.mock('../llm/provider.js', () => ({
  resolveProvider: vi.fn().mockResolvedValue({ providerName: 'openai', model: 'gpt-4' }),
}));

vi.mock('../llm/pricing.js', () => ({
  calculateCostCents: vi.fn().mockReturnValue(0.5),
}));

vi.mock('../services/notifications.js', () => ({
  notifyPipelineComplete: vi.fn().mockResolvedValue(undefined),
  notifyPipelineError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/webhook-dispatcher.js', () => ({
  notifyRulesUpdated: vi.fn().mockResolvedValue(undefined),
  notifyRulesError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./source-health.js', () => ({
  recordScrapeFailure: vi.fn(),
  recordScrapeSuccess: vi.fn(),
}));

import { runPipeline } from './pipeline.js';

describe('pipeline', () => {
  beforeEach(() => {
    mockSourceOverride = null;
  });

  it('prevents concurrent runs on the same source (mutex)', async () => {
    // Run two pipelines concurrently on the same source
    const promise1 = runPipeline('source-mutex-test');
    const promise2 = runPipeline('source-mutex-test');

    const [result1, result2] = await Promise.all([promise1, promise2]);

    // One should be blocked by mutex
    const errors = [result1.error, result2.error].filter(Boolean);
    const hasMutexBlock = errors.some(e => e?.includes('already running'));
    expect(hasMutexBlock).toBe(true);
  });

  it('returns error status on scraper failure', async () => {
    const { scrapeSource } = await import('./scraper.js');
    vi.mocked(scrapeSource).mockRejectedValueOnce(new Error('Network error'));

    const result = await runPipeline('source-1');
    expect(result.status).toBe('error');
    expect(result.error).toContain('Network error');
  });

  it('returns a PipelineResult with expected fields', async () => {
    const result = await runPipeline('source-1');
    expect(result).toHaveProperty('sourceId');
    expect(result).toHaveProperty('sourceName');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('stepReached');
    expect(result).toHaveProperty('rulesCreated');
    expect(result).toHaveProperty('rulesUpdated');
    expect(result).toHaveProperty('durationMs');
    expect(typeof result.durationMs).toBe('number');
  });

  it('rejects content that fails quality validation', async () => {
    const { scrapeSource } = await import('./scraper.js');
    vi.mocked(scrapeSource).mockResolvedValueOnce({
      content: '',
      contentHash: 'hash-rejected',
      contentQuality: 'rejected' as const,
      rejectionReason: 'Empty content',
      fetchedAt: new Date().toISOString(),
      wordCount: 0,
      source: 'live' as const,
    });

    const result = await runPipeline('source-1');
    expect(result.status).toBe('error');
    expect(result.error).toContain('Content rejected');
  });
});

import type { ScanResult } from '@nomus/scanner';

/**
 * Build a test ScanResult with sensible defaults.
 */
export function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    findings: [],
    fileCount: 10,
    importCount: 3,
    capabilities: ['text_generation'],
    status: 'pass',
    counts: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
    ...overrides,
  };
}

export function makeFinding(overrides: Partial<{
  file: string;
  line: number;
  sdk: string;
  severity: string;
  ruleKey: string;
  effect: string;
  humanSummary: string;
  legalReference: string;
  suggestion: string;
}> = {}) {
  return {
    file: overrides.file ?? `${process.cwd()}/src/app.ts`,
    line: overrides.line ?? 5,
    sdk: overrides.sdk ?? '@anthropic-ai/sdk',
    rule: {
      ruleKey: overrides.ruleKey ?? 'eu-ai-act.transparency',
      effect: overrides.effect ?? 'require_disclosure',
      severity: overrides.severity ?? 'high',
      humanSummary: overrides.humanSummary ?? 'AI system must provide transparency documentation',
      legalReference: overrides.legalReference ?? 'EU AI Act Article 13',
      matchedOn: ['text_generation'],
      confidence: 0.95,
    },
    suggestion: overrides.suggestion,
  };
}

/** Unified-diff patch for a newly added file of `lines` lines. */
export function addedFilePatch(lines: number): string {
  return [`@@ -0,0 +1,${lines} @@`, ...Array.from({ length: lines }, (_, i) => `+line${i + 1}`)].join('\n');
}

/**
 * Build a mock Octokit instance with spies for API calls.
 */
export function mockOctokit() {
  return {
    // octokit.paginate(method, params): the mocks return one page.
    paginate: async (fn: (p: any) => Promise<{ data: any[] }>, params: any) => (await fn(params)).data,
    rest: {
      checks: {
        create: async (params: any) => ({ data: { id: 1, ...params } }),
      },
      pulls: {
        listFiles: async () => ({
          // A newly added 40-line file: every line 1-40 is commentable.
          data: [{ filename: 'src/app.ts', patch: addedFilePatch(40) }],
        }),
        listReviewComments: async () => ({ data: [] as any[] }),
        createReview: async (params: any) => ({ data: { id: 1, ...params } }),
      },
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async (params: any) => ({ data: { id: 1, ...params } }),
        updateComment: async (params: any) => ({ data: { id: 1, ...params } }),
      },
      codeScanning: {
        uploadSarif: async (params: any) => ({ data: params }),
      },
    },
  };
}

// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * Manual uploads stay on their own processing path.
 *
 * End-to-end audit: an uploaded statute that scored grade D was handed to the
 * self-healer, which fetched the source's live URL / an archive copy to
 * process instead of the uploaded file, and the failure counted against the
 * source's scrape health. Re-processing an identical upload after a rejection
 * was silently answered with "no change".
 *
 * Same harness as pipeline-exactness.test.ts: real DB and promotion, mocked
 * network and LLM stages.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';

vi.mock('./scrape-healer.js', () => ({ healContent: vi.fn() }));
vi.mock('../sse/manager.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
vi.mock('./scraper.js', () => ({ scrapeSource: vi.fn() }));
vi.mock('./gatekeeper.js', () => ({
  runGatekeeper: vi.fn().mockResolvedValue({
    status: 'verified', issues: [], strippedContent: null, strippedBytes: 0,
    structureValid: true, tokensIn: 0, tokensOut: 0,
  }),
}));
vi.mock('./structural-verifier.js', () => ({
  verifyStructure: vi.fn().mockResolvedValue({
    passed: true, verifiedText: 'x', issues: [],
    stats: { articlesFound: 3, sectionsFound: 0, crossRefsFound: 0, crossRefsResolved: 0, estimatedCompleteness: 1 },
    llmSpotCheckUsed: false, llmTokensIn: 0, llmTokensOut: 0, llmCostCents: 0,
  }),
}));
vi.mock('./quality-scorer.js', () => ({
  scoreDocumentQuality: vi.fn().mockReturnValue({ overallGrade: 'A', structureScore: 1, textScore: 1, issues: [], wordCount: 200 }),
  diagnoseQualityFailure: vi.fn().mockReturnValue('n/a'),
}));
vi.mock('./differ.js', () => ({
  hasContentChanged: vi.fn().mockReturnValue(true),
  extractChangedSections: vi.fn().mockReturnValue({ hasChanges: true, changedSections: ['Article 1 changed'], summary: 'changes' }),
}));
vi.mock('./classifier.js', () => ({
  classifyChange: vi.fn().mockResolvedValue({
    classification: 'material', confidence: 0.9,
    llmResponse: { provider: 'openai', model: 'gpt-4', tokensIn: 1, tokensOut: 1 },
  }),
}));
vi.mock('./translator.js', () => ({ translateToRules: vi.fn() }));
vi.mock('./article-chunker.js', () => ({
  articleChunk: vi.fn().mockReturnValue([{ content: 'Article 1 text', breadcrumb: 'Art. 1', index: 0, totalChunks: 1, articleRef: 'Article 1', strategy: 'article' }]),
}));
vi.mock('./bulk-extractor.js', () => ({
  bulkExtract: vi.fn().mockResolvedValue([{
    success: true,
    requirements: [{ ref: 'Art. 1', what: 'Providers must maintain records', type: 'obligation', who: 'providers', severity: 'high', conditions: '', effective_date: '2025-01-01', industries: ['all'], industry_scope: 'global', industry_notes: '' }],
    tokensIn: 1, tokensOut: 1,
  }]),
}));
vi.mock('./rule-scorer.js', () => ({
  scoreRules: vi.fn().mockResolvedValue({
    rules: [{ ruleKey: 'eu.art_1.providers_must_maintain', jurisdiction: 'EU', category: 'accountability', conditions: { action: 'ai_operation', region: 'EU' }, effect: 'allow_with_audit', severity: 'high', humanSummary: 'Providers must maintain records', legalReference: 'Art. 1', effectiveDate: '2025-01-01', expiresAt: null, industries: ['all'], industryScope: 'global', industryNotes: '' }],
    overallScore: 8, tokensIn: 1, tokensOut: 1,
  }),
}));
vi.mock('../llm/provider.js', () => ({ resolveProvider: vi.fn().mockResolvedValue({ providerName: 'openai', model: 'gpt-4' }) }));
vi.mock('../llm/pricing.js', () => ({ calculateCostCents: vi.fn().mockReturnValue(0) }));
vi.mock('../core/signing.js', () => ({ signData: vi.fn().mockReturnValue('sig') }));
vi.mock('../core/policy-compiler.js', () => ({ canonicalJSON: vi.fn().mockReturnValue('{}') }));
vi.mock('../core/policy-cache.js', () => ({ policyBundleCache: { invalidate: vi.fn() } }));
// NOTE: config/env is intentionally NOT mocked — the real DB client reads
// NOMUS_DB_PATH (:memory:) through env(), and this test uses the real DB.
vi.mock('../db/ontology.js', () => ({ getOntologyForPrompt: vi.fn().mockReturnValue('') }));
vi.mock('../feedback/refiner.js', () => ({ buildFeedbackContext: vi.fn().mockReturnValue('') }));
vi.mock('../services/notifications.js', () => ({
  notifyPipelineComplete: vi.fn().mockResolvedValue(undefined),
  notifyPipelineError: vi.fn().mockResolvedValue(undefined),
  sendSlack: vi.fn().mockResolvedValue(undefined),
  sendPush: vi.fn().mockResolvedValue(undefined),
  getPushTopics: vi.fn().mockReturnValue([]),
}));
vi.mock('../services/webhook-dispatcher.js', () => ({
  notifyRulesUpdated: vi.fn().mockResolvedValue(undefined),
  notifyRulesError: vi.fn().mockResolvedValue(undefined),
}));

import { getDb, closeDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { regulatorySources, rawSnapshots, stagedContent } from '../db/schema.js';
import { runPipeline } from './pipeline.js';
import { scrapeSource } from './scraper.js';
import { healContent } from './scrape-healer.js';
import { scoreDocumentQuality } from './quality-scorer.js';

beforeAll(() => {
  closeDb();
  runMigrations();
});

beforeEach(() => {
  vi.mocked(scrapeSource).mockReset();
  vi.mocked(healContent).mockReset();
});

const UPLOAD = '<html><body><h2>Sec. 5. Disclosure.</h2><p>An employer shall notify each applicant before the interview that artificial intelligence may be used to analyze the video interview.</p></body></html>';

function insertUploadedSource(id: string): void {
  const now = new Date().toISOString();
  const hash = createHash('sha256').update(UPLOAD).digest('hex');
  const db = getDb();
  db.insert(regulatorySources).values({
    id, name: 'Upload Source ' + id.slice(0, 6), jurisdiction: 'US-IL',
    url: 'https://law.example.gov/act', parserType: 'html', selectorConfig: '{}',
    scrapeFrequencyHours: 24, isActive: true, tier: 1, category: 'ai_regulation',
    ingestionMode: 'manual', consecutiveFailures: 0, createdAt: now, updatedAt: now,
    pendingUploadFile: 'act.html', pendingUploadHash: hash, pendingUploadAt: now,
  }).run();
  db.insert(rawSnapshots).values({
    id: randomUUID(), sourceId: id, contentHash: hash, content: UPLOAD, scrapedAt: now,
  }).run();
}

function reupload(id: string): void {
  const now = new Date(Date.now() + 1000).toISOString();
  const hash = createHash('sha256').update(UPLOAD).digest('hex');
  const db = getDb();
  db.update(regulatorySources).set({ pendingUploadFile: 'act.html', pendingUploadHash: hash, pendingUploadAt: now })
    .where(eq(regulatorySources.id, id)).run();
  db.insert(rawSnapshots).values({ id: randomUUID(), sourceId: id, contentHash: hash, content: UPLOAD, scrapedAt: now }).run();
}

describe('uploaded documents', () => {
  it('a low-grade upload is rejected without fetching anything and without a scrape failure', async () => {
    const id = randomUUID();
    insertUploadedSource(id);
    vi.mocked(scoreDocumentQuality).mockReturnValueOnce({ overallGrade: 'D', structureScore: 0.3, textScore: 0.45, issues: [], wordCount: 30 } as any);

    const result = await runPipeline(id);

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/Uploaded document scored quality grade D/);
    expect(healContent).not.toHaveBeenCalled();
    expect(scrapeSource).not.toHaveBeenCalled();
    const source = getDb().select().from(regulatorySources).where(eq(regulatorySources.id, id)).get()!;
    expect(source.consecutiveFailures).toBe(0);
    const staged = getDb().select().from(stagedContent).where(eq(stagedContent.sourceId, id))
      .orderBy(desc(stagedContent.createdAt)).get()!;
    expect(staged.pipelineStatus).toBe('rejected');
  });

  it('re-processing the same file after a rejection runs the pipeline instead of reporting no change', async () => {
    const id = randomUUID();
    insertUploadedSource(id);
    vi.mocked(scoreDocumentQuality).mockReturnValueOnce({ overallGrade: 'D', structureScore: 0.3, textScore: 0.45, issues: [], wordCount: 30 } as any);
    expect((await runPipeline(id)).status).toBe('error');

    reupload(id);
    const second = await runPipeline(id);
    expect(second.status).toBe('completed');
    expect(scrapeSource).not.toHaveBeenCalled();
    const staged = getDb().select().from(stagedContent).where(eq(stagedContent.sourceId, id))
      .orderBy(desc(stagedContent.createdAt)).get()!;
    expect(staged.pipelineStatus).toBe('promoted');
    expect(staged.pipelineError).toBeNull();
  });
});

describe('pipeline end announcement', () => {
  it('every run ends with one done event carrying its outcome, including early rejections', async () => {
    const { broadcastEvent } = await import('../sse/manager.js');
    const sent = vi.mocked(broadcastEvent);

    const id = randomUUID();
    insertUploadedSource(id);
    vi.mocked(scoreDocumentQuality).mockReturnValueOnce({ overallGrade: 'D', structureScore: 0.3, textScore: 0.45, issues: [], wordCount: 30 } as any);
    sent.mockClear();
    await runPipeline(id);
    let done = sent.mock.calls.map(([e]) => e.data as Record<string, unknown>).filter((d) => d.done === true);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ sourceId: id, outcome: 'error', step: 5 });
    expect(String(done[0].error)).toMatch(/Uploaded document scored quality grade D/);

    reupload(id);
    sent.mockClear();
    await runPipeline(id);
    done = sent.mock.calls.map(([e]) => e.data as Record<string, unknown>).filter((d) => d.done === true);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ sourceId: id, outcome: 'completed' });
  });
});

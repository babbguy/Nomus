/**
 * Real-DB pipeline exactness tests.
 *
 *   - A promoted snapshot's stored contentHash MUST equal sha256(stored content)
 *     (recomputed AFTER cleaning) so the self-consistency check holds.
 *   - A promoted snapshot is flagged promoted=true and carries byte_exact provenance.
 *   - A stale_cache scrape is HELD (needs_intervention), NEVER promoted, and the
 *     prior last-known-good promoted snapshot is preserved.
 *
 * Uses the real DB + real content-cleaner + real promotion transaction; only
 * the network (scraper) and LLM-calling stages are mocked.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { eq, and, desc } from 'drizzle-orm';

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

beforeAll(() => {
  closeDb();
  runMigrations();
});

beforeEach(() => {
  vi.mocked(scrapeSource).mockReset();
});

function insertSource(id: string): void {
  const now = new Date().toISOString();
  getDb().insert(regulatorySources).values({
    id, name: 'Exactness Source ' + id.slice(0, 6), jurisdiction: 'EU',
    url: 'https://law.example.gov/reg', parserType: 'html', selectorConfig: '{}',
    scrapeFrequencyHours: 24, isActive: true, tier: 1, category: 'ai_regulation',
    ingestionMode: 'auto', consecutiveFailures: 0, createdAt: now, updatedAt: now,
  }).run();
}

describe('promotion writes a self-consistent, byte_exact snapshot', () => {
  it('stored contentHash == sha256(stored content) and promoted=true', async () => {
    const id = randomUUID();
    insertSource(id);

    vi.mocked(scrapeSource).mockResolvedValue({
      content: 'Article 1\nProviders of high-risk AI systems shall maintain technical documentation and records demonstrating compliance with this Regulation throughout the lifecycle of the system.',
      contentHash: 'scrape-hash-preclean',
      contentQuality: 'valid',
      fetchedAt: new Date().toISOString(),
      wordCount: 25,
      source: 'live',
      rawBytesHash: 'rawhash', rawBytesSize: 100, rawContent: '<html>...</html>',
      fetchedUrl: 'https://law.example.gov/reg', httpStatus: 200, contentType: 'text/html',
      provenanceMode: 'byte_exact',
    } as any);

    const result = await runPipeline(id);
    expect(result.status).toBe('completed');

    const promoted = getDb().select().from(rawSnapshots)
      .where(and(eq(rawSnapshots.sourceId, id), eq(rawSnapshots.promoted, true)))
      .orderBy(desc(rawSnapshots.scrapedAt)).get();

    expect(promoted).toBeDefined();
    expect(promoted!.provenanceMode).toBe('byte_exact');
    const recomputed = createHash('sha256').update(promoted!.content).digest('hex');
    expect(promoted!.contentHash).toBe(recomputed);
    // And it is NOT the stale pre-clean scrape hash.
    expect(promoted!.contentHash).not.toBe('scrape-hash-preclean');
  });
});

describe('stale_cache scrape is held, never promoted', () => {
  it('holds as needs_intervention and preserves the last known-good promoted snapshot', async () => {
    const id = randomUUID();
    insertSource(id);
    const db = getDb();

    // Seed a prior last-known-good promoted snapshot.
    const goodContent = 'Article 1\nThe prior known-good regulation text.';
    const goodHash = createHash('sha256').update(goodContent).digest('hex');
    db.insert(rawSnapshots).values({
      id: randomUUID(), sourceId: id, contentHash: goodHash, content: goodContent,
      scrapedAt: new Date(Date.now() - 86_400_000).toISOString(),
      provenanceMode: 'byte_exact', promoted: true,
    }).run();
    db.update(regulatorySources).set({ lastContentHash: 'a-different-old-hash' })
      .where(eq(regulatorySources.id, id)).run();

    vi.mocked(scrapeSource).mockResolvedValue({
      content: 'Article 1\nStale cached copy served because the live source was unreachable today.',
      contentHash: 'stale-content-hash',
      contentQuality: 'suspicious',
      fetchedAt: new Date().toISOString(),
      wordCount: 12,
      source: 'cache',
      provenanceMode: 'stale_cache',
    } as any);

    const result = await runPipeline(id);
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not promoted|held|not promotable/i);

    // No stale_cache row was ever promoted.
    const promotedRows = db.select().from(rawSnapshots)
      .where(and(eq(rawSnapshots.sourceId, id), eq(rawSnapshots.promoted, true))).all();
    expect(promotedRows.every((r) => r.provenanceMode !== 'stale_cache')).toBe(true);
    // The last known-good promoted snapshot is intact.
    expect(promotedRows.some((r) => r.contentHash === goodHash)).toBe(true);

    // The held staged entry is marked for intervention.
    const staged = db.select().from(stagedContent)
      .where(eq(stagedContent.sourceId, id)).orderBy(desc(stagedContent.createdAt)).get();
    expect(staged!.pipelineStatus).toBe('needs_intervention');
  });
});

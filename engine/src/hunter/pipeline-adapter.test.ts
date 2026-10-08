/**
 * Pipeline × official-API adapter (real DB, mocked network + LLM).
 *
 * Confirms that adapter output (byte_exact + an official point-in-time
 * coordinate + channel=official_api) flows through the refuse-to-guess pipeline
 * as PROMOTABLE, and that the promoted snapshot persists the ingestion channel
 * and the point-in-time coordinate so every stored regulation cites an official
 * immutable version.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { eq, and, desc } from 'drizzle-orm';

vi.mock('../sse/manager.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
vi.mock('./scraper.js', () => ({ scrapeSource: vi.fn() }));
vi.mock('./gatekeeper.js', () => ({
  runGatekeeper: vi.fn().mockResolvedValue({ status: 'verified', issues: [], strippedContent: null, strippedBytes: 0, structureValid: true, tokensIn: 0, tokensOut: 0 }),
}));
vi.mock('./structural-verifier.js', () => ({
  verifyStructure: vi.fn().mockResolvedValue({
    passed: true, verifiedText: 'x', issues: [],
    stats: { articlesFound: 2, sectionsFound: 0, crossRefsFound: 0, crossRefsResolved: 0, estimatedCompleteness: 1 },
    llmSpotCheckUsed: false, llmTokensIn: 0, llmTokensOut: 0, llmCostCents: 0,
  }),
}));
vi.mock('./quality-scorer.js', () => ({
  scoreDocumentQuality: vi.fn().mockReturnValue({ overallGrade: 'A', structureScore: 1, textScore: 1, issues: [], wordCount: 200 }),
  diagnoseQualityFailure: vi.fn().mockReturnValue('n/a'),
}));
vi.mock('./differ.js', () => ({
  hasContentChanged: vi.fn().mockReturnValue(true),
  extractChangedSections: vi.fn().mockReturnValue({ hasChanges: true, changedSections: ['§ 164.502 changed'], summary: 'changes' }),
}));
vi.mock('./classifier.js', () => ({
  classifyChange: vi.fn().mockResolvedValue({ classification: 'material', confidence: 0.9, llmResponse: { provider: 'openai', model: 'gpt-4', tokensIn: 1, tokensOut: 1 } }),
}));
vi.mock('./translator.js', () => ({ translateToRules: vi.fn() }));
vi.mock('./article-chunker.js', () => ({
  articleChunk: vi.fn().mockReturnValue([{ content: '§ 164.502 text', breadcrumb: '§ 164.502', index: 0, totalChunks: 1, articleRef: '§ 164.502', strategy: 'article' }]),
}));
vi.mock('./bulk-extractor.js', () => ({
  bulkExtract: vi.fn().mockResolvedValue([{
    success: true,
    requirements: [{ ref: '§ 164.502', what: 'Covered entities must safeguard PHI', type: 'obligation', who: 'covered entities', severity: 'high', conditions: '', effective_date: '2024-05-10', industries: ['all'], industry_scope: 'global', industry_notes: '' }],
    tokensIn: 1, tokensOut: 1,
  }]),
}));
vi.mock('./rule-scorer.js', () => ({
  scoreRules: vi.fn().mockResolvedValue({
    rules: [{ ruleKey: 'us_fed.s_164_502.covered_entities_must_safeg', jurisdiction: 'US-FED', category: 'accountability', conditions: { action: 'ai_operation', region: 'US-FED' }, effect: 'allow_with_audit', severity: 'high', humanSummary: 'Covered entities must safeguard PHI', legalReference: '§ 164.502', effectiveDate: '2024-05-10', expiresAt: null, industries: ['all'], industryScope: 'global', industryNotes: '' }],
    overallScore: 9, tokensIn: 1, tokensOut: 1,
  }),
}));
vi.mock('../llm/provider.js', () => ({ resolveProvider: vi.fn().mockResolvedValue({ providerName: 'openai', model: 'gpt-4' }) }));
vi.mock('../llm/pricing.js', () => ({ calculateCostCents: vi.fn().mockReturnValue(0) }));
vi.mock('../core/signing.js', () => ({ signData: vi.fn().mockReturnValue('sig') }));
vi.mock('../core/policy-compiler.js', () => ({ canonicalJSON: vi.fn().mockReturnValue('{}') }));
vi.mock('../core/policy-cache.js', () => ({ policyBundleCache: { invalidate: vi.fn() } }));
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
import { regulatorySources, rawSnapshots } from '../db/schema.js';
import { runPipeline } from './pipeline.js';
import { scrapeSource } from './scraper.js';

beforeAll(() => {
  closeDb();
  runMigrations();
});
beforeEach(() => {
  vi.mocked(scrapeSource).mockReset();
});

describe('official-API adapter output is promotable and persists its coordinate', () => {
  it('promotes byte_exact adapter content and stores channel + point-in-time coordinate', async () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    getDb().insert(regulatorySources).values({
      id, name: 'HIPAA Privacy Rule', jurisdiction: 'US-FED',
      url: 'https://www.ecfr.gov/api/versioner/v1/full/current/title-45.xml?part=164&subpart=E',
      parserType: 'html', selectorConfig: '{}', scrapeFrequencyHours: 336, isActive: true,
      tier: 2, category: 'healthcare', ingestionMode: 'auto', consecutiveFailures: 0,
      createdAt: now, updatedAt: now,
    }).run();

    const coordinate = {
      authority: 'ecfr',
      citation: '45 CFR Part 164 Subpart E @ 2026-07-23',
      fields: { title: 45, part: '164', subpart: 'E', date: '2026-07-23', partLatestAmendedOn: '2024-05-10' },
    };

    vi.mocked(scrapeSource).mockResolvedValue({
      content: '## § 164.502 Uses and disclosures\nCovered entities must safeguard protected health information and maintain reasonable administrative, technical, and physical safeguards throughout the lifecycle of the data.',
      contentHash: 'adapter-preclean-hash',
      contentQuality: 'valid',
      fetchedAt: now,
      wordCount: 28,
      source: 'live',
      rawBytesHash: 'ecfrxmlhash', rawBytesSize: 271464, rawContent: '<?xml version="1.0"?><DIV5>…</DIV5>',
      fetchedUrl: 'https://www.ecfr.gov/api/versioner/v1/full/2026-07-23/title-45.xml?part=164&subpart=E',
      httpStatus: 200, contentType: 'application/xml',
      provenanceMode: 'byte_exact',
      channel: 'official_api',
      pointInTimeCoordinate: coordinate,
    } as any);

    const result = await runPipeline(id);
    expect(result.status).toBe('completed');

    const promoted = getDb().select().from(rawSnapshots)
      .where(and(eq(rawSnapshots.sourceId, id), eq(rawSnapshots.promoted, true)))
      .orderBy(desc(rawSnapshots.scrapedAt)).get();

    expect(promoted).toBeDefined();
    expect(promoted!.provenanceMode).toBe('byte_exact');
    expect(promoted!.ingestionChannel).toBe('official_api');
    // Coordinate persisted (the official immutable version, not a fetch timestamp).
    const storedCoord = JSON.parse(promoted!.pointInTimeCoordinate!);
    expect(storedCoord.authority).toBe('ecfr');
    expect(storedCoord.fields.date).toBe('2026-07-23');
    expect(storedCoord.citation).toContain('45 CFR Part 164 Subpart E');
    // Self-consistency invariant preserved: stored contentHash == sha256(content).
    expect(promoted!.contentHash).toBe(createHash('sha256').update(promoted!.content).digest('hex'));
  });
});

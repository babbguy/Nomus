/**
 * Pipeline × structured (official-API) content: clean → accuracy-verify →
 * promote-ONLY-if-pass, proven end to end.
 * =========================================================================
 *
 * The owner requirement: structured artifacts, even though byte_exact from an
 * official source, MUST still be cleaned after they land, checked for accuracy,
 * and only promoted if they pass — the SAME rigor as scraped content. Being
 * byte_exact does NOT buy a bypass of the accuracy gate.
 *
 * These tests use the REAL content-cleaner (channel-appropriate profiles) and
 * the REAL structural-verifier. Only the network (scraper), the LLM stages, and
 * downstream extraction/scoring are mocked, so the clean + verify + promote-gate
 * behaviour exercised here is production code.
 *
 * Proven:
 *   A. byte_exact / official_api content that FAILS structural verification
 *      (truncated) is REJECTED at Step 3 and NEVER promoted.
 *   B. byte_exact / official_api content that PASSES flows clean → verify →
 *      promoted, and the LIGHT structured cleaning is what ran (an angle-bracket
 *      token the HTML profile would strip survives into the promoted snapshot).
 *   C. Gatekeeper + quality scoring + structural verification all RUN for
 *      structured content — provenance never lets it skip a gate.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
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
// NOTE: structural-verifier and content-cleaner are intentionally NOT mocked —
// these tests prove the REAL clean + verify + promote-gate behaviour.
vi.mock('./quality-scorer.js', () => ({
  // Force grade A so the pipeline deterministically reaches Step 3 (the accuracy
  // gate under test). Quality scoring itself is asserted to have RUN in Test C.
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
// Provider mock must supply BOTH resolveProvider (pipeline) and
// generateWithFallback (the REAL structural-verifier's LLM spot-check on errors).
vi.mock('../llm/provider.js', () => ({
  resolveProvider: vi.fn().mockResolvedValue({ providerName: 'openai', model: 'gpt-4' }),
  generateWithFallback: vi.fn().mockResolvedValue({
    content: '{"is_real_regulation": true, "issues_confirmed": [], "issues_dismissed": [], "explanation": "ok"}',
    tokensIn: 1, tokensOut: 1, model: 'gpt-4', provider: 'openai',
  }),
}));
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
import { regulatorySources, rawSnapshots, stagedContent, gatekeeperLogs } from '../db/schema.js';
import { runPipeline } from './pipeline.js';
import { scrapeSource } from './scraper.js';
import { runGatekeeper } from './gatekeeper.js';
import { scoreDocumentQuality } from './quality-scorer.js';

beforeAll(() => {
  closeDb();
  runMigrations();
});

beforeEach(() => {
  vi.mocked(scrapeSource).mockReset();
  vi.mocked(runGatekeeper).mockClear();
  vi.mocked(scoreDocumentQuality).mockClear();
  // Keep the default grade-A return after clearing.
  vi.mocked(scoreDocumentQuality).mockReturnValue({ overallGrade: 'A', structureScore: 1, textScore: 1, issues: [], wordCount: 200 } as any);
});

function insertOfficialApiSource(id: string): void {
  const now = new Date().toISOString();
  getDb().insert(regulatorySources).values({
    id, name: 'Official Structured Reg ' + id.slice(0, 6), jurisdiction: 'EU',
    url: 'https://www.ecfr.gov/api/versioner/v1/full/current/title-45.xml',
    parserType: 'html', selectorConfig: '{}', scrapeFrequencyHours: 24, isActive: true,
    tier: 1, category: 'ai_regulation', ingestionMode: 'auto', consecutiveFailures: 0,
    createdAt: now, updatedAt: now,
  }).run();
}

const COORDINATE = {
  authority: 'eur_lex_cellar',
  citation: 'CELEX 32024R1000 @ 2024-05-17',
  fields: { celex: '32024R1000', date: '2024-05-17' },
};

// A byte_exact official-API artifact that is TRUNCATED — it ends mid-sentence
// ("… and shall") with no terminal punctuation. This is a completeness failure
// the structural verifier must catch REGARDLESS of byte_exact provenance.
const TRUNCATED_OFFICIAL_TEXT = `# Regulation (EU) 2024/2000

Article 1
Providers of high-risk artificial intelligence systems shall establish and maintain a documented risk management system that operates continuously throughout the entire lifecycle of the system, and shall keep technical records demonstrating ongoing compliance with the applicable requirements set out in this Regulation for inspection by the competent national authority upon request at any reasonable time.

Article 2
Deployers of high-risk artificial intelligence systems shall assign human oversight to natural persons who have the necessary competence and authority, shall ensure that input data is relevant and sufficiently representative, and that the monitoring of the operation of the system is carried out in accordance with the instructions and shall`;

// A COMPLETE byte_exact official-API artifact: sequential articles, a resolved
// cross-reference, ends with terminal punctuation. It also contains a legitimate
// angle-bracket token (<https://…>) that the aggressive HTML profile would
// WRONGLY strip — its survival proves the LIGHT structured profile ran.
const COMPLETE_OFFICIAL_TEXT = `# Regulation (EU) 2024/1000

Article 1
Providers of high-risk artificial intelligence systems shall establish and maintain a documented risk management system throughout the entire lifecycle of the system, shall keep technical records demonstrating ongoing compliance with the applicable requirements of this Regulation, and shall publish the required notice at <https://official-journal.europa.eu/notice> in a clear and accessible manner for the general public.

Article 2
Deployers referred to in Article 1 shall assign human oversight to competent natural persons, shall ensure that the input data used is relevant and sufficiently representative for the intended purpose, and shall retain the technical documentation demonstrating compliance with this Regulation for a period of at least ten years.

Article 3
Each competent national authority shall supervise the application of this Regulation within its territory and shall cooperate with the authorities designated by the other Member States in accordance with the mechanism established under this Regulation.`;

function mockAdapterScrape(content: string, contentHash: string): void {
  vi.mocked(scrapeSource).mockResolvedValue({
    content,
    contentHash,
    contentQuality: 'valid',
    fetchedAt: new Date().toISOString(),
    wordCount: content.split(/\s+/).filter(Boolean).length,
    source: 'live',
    rawBytesHash: 'cellarxhtmlhash', rawBytesSize: 12345,
    rawContent: '<?xml version="1.0"?><akn:akomaNtoso>…</akn:akomaNtoso>',
    fetchedUrl: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1000',
    httpStatus: 200, contentType: 'application/xhtml+xml',
    provenanceMode: 'byte_exact',
    channel: 'official_api',
    pointInTimeCoordinate: COORDINATE,
  } as any);
}

describe('A. byte_exact official-API content that FAILS verification is rejected, not promoted', () => {
  it('rejects a TRUNCATED byte_exact artifact at Step 3 and promotes nothing', async () => {
    const id = randomUUID();
    insertOfficialApiSource(id);
    mockAdapterScrape(TRUNCATED_OFFICIAL_TEXT, 'trunc-hash');

    const result = await runPipeline(id);

    // Rejected at the structural-verification step — byte_exact did NOT bypass it.
    expect(result.status).toBe('error');
    expect(result.stepReached).toBe(3);
    expect(result.error).toMatch(/verification failed/i);

    // Nothing was promoted.
    const promoted = getDb().select().from(rawSnapshots)
      .where(and(eq(rawSnapshots.sourceId, id), eq(rawSnapshots.promoted, true))).all();
    expect(promoted.length).toBe(0);

    // The staged entry is rejected, and a real truncation issue was recorded.
    const staged = getDb().select().from(stagedContent)
      .where(eq(stagedContent.sourceId, id)).orderBy(desc(stagedContent.createdAt)).get();
    expect(staged!.pipelineStatus).toBe('rejected');
    expect(staged!.verificationPassed).toBe(false);
    const issues = JSON.parse(staged!.verificationIssues || '[]') as Array<{ type: string }>;
    expect(issues.some((i) => i.type === 'truncation')).toBe(true);
  });
});

describe('B. byte_exact official-API content that PASSES flows clean → verify → promoted', () => {
  it('promotes a COMPLETE byte_exact artifact and preserves it via the LIGHT structured profile', async () => {
    const id = randomUUID();
    insertOfficialApiSource(id);
    mockAdapterScrape(COMPLETE_OFFICIAL_TEXT, 'complete-hash');

    const result = await runPipeline(id);
    expect(result.status).toBe('completed');
    expect(result.stepReached).toBe(5);

    const promoted = getDb().select().from(rawSnapshots)
      .where(and(eq(rawSnapshots.sourceId, id), eq(rawSnapshots.promoted, true)))
      .orderBy(desc(rawSnapshots.scrapedAt)).get();
    expect(promoted).toBeDefined();
    expect(promoted!.provenanceMode).toBe('byte_exact');
    expect(promoted!.ingestionChannel).toBe('official_api');

    // The LIGHT structured profile ran: the angle-bracket official-journal token
    // (which the aggressive HTML profile deletes as if it were markup) survived
    // all the way into the promoted snapshot.
    expect(promoted!.content).toContain('official-journal.europa.eu/notice');
    // And the recital/preamble-style article prose is intact and verbatim.
    expect(promoted!.content).toContain('Providers of high-risk artificial intelligence systems');
  });
});

describe('C. Gatekeeper + quality scoring + structural verification all RUN for structured content', () => {
  it('invokes every gate on byte_exact structured content — no provenance bypass', async () => {
    const id = randomUUID();
    insertOfficialApiSource(id);
    mockAdapterScrape(COMPLETE_OFFICIAL_TEXT, 'complete-hash-c');

    const result = await runPipeline(id);
    expect(result.status).toBe('completed');

    // Gatekeeper (Step 1.5) ran — a decision was logged for this source.
    expect(vi.mocked(runGatekeeper)).toHaveBeenCalled();
    const gkLog = getDb().select().from(gatekeeperLogs)
      .where(eq(gatekeeperLogs.sourceId, id)).get();
    expect(gkLog).toBeDefined();

    // Quality scoring (Step 2) ran ON THE CLEANED TEXT — proving cleaning
    // happened first and scoring received the real cleaned output.
    expect(vi.mocked(scoreDocumentQuality)).toHaveBeenCalled();
    const scoredArg = vi.mocked(scoreDocumentQuality).mock.calls.at(-1)?.[0] as string;
    expect(scoredArg).toContain('official-journal.europa.eu/notice');

    // Structural verification (Step 3, REAL) ran and passed — its stats were
    // persisted on the staged row.
    const staged = getDb().select().from(stagedContent)
      .where(eq(stagedContent.sourceId, id)).orderBy(desc(stagedContent.createdAt)).get();
    expect(staged!.verificationPassed).toBe(true);
    expect(staged!.verificationStats).toBeTruthy();
    const stats = JSON.parse(staged!.verificationStats || '{}');
    expect(stats.articlesFound).toBeGreaterThanOrEqual(3);
  });
});

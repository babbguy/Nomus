import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { calculateCostCents } from '../llm/pricing.js';
import { getDb } from '../db/client.js';
import { scoutFeeds, scoutItems, regulatorySignals } from '../db/schema.js';
import { fetchFeed } from './feed-fetcher.js';
import { scoreKeywords } from './keyword-filter.js';
import { classifyBatch } from './llm-classifier.js';
import { extractSignal } from './signal-extractor.js';
import { broadcastEvent } from '../sse/manager.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { notifyScoutSignal, notifyScoutReviewNeeded } from '../services/notifications.js';

export interface ScoutCycleResult {
  feedsProcessed: number;
  itemsFetched: number;
  itemsNew: number;
  itemsKeywordRejected: number;
  itemsLlmClassified: number;
  itemsExtracted: number;
  itemsAutoPromoted: number;
  totalLlmCostCents: number;
  durationMs: number;
}

/**
 * Run a full Scout cycle: fetch all active feeds, filter, classify, extract, promote.
 */
export async function runScoutCycle(): Promise<ScoutCycleResult> {
  const startTime = performance.now();
  const config = env();
  const db = getDb();

  const keywordThreshold = config.NOMUS_SCOUT_KEYWORD_THRESHOLD;
  const autoPromoteThreshold = config.NOMUS_SCOUT_AUTO_PROMOTE_THRESHOLD;
  const batchSize = config.NOMUS_SCOUT_LLM_BATCH_SIZE;

  const result: ScoutCycleResult = {
    feedsProcessed: 0,
    itemsFetched: 0,
    itemsNew: 0,
    itemsKeywordRejected: 0,
    itemsLlmClassified: 0,
    itemsExtracted: 0,
    itemsAutoPromoted: 0,
    totalLlmCostCents: 0,
    durationMs: 0,
  };

  // Get all active feeds
  const feeds = db.select().from(scoutFeeds)
    .where(eq(scoutFeeds.isActive, true))
    .all();

  logger.info({ feedCount: feeds.length }, 'Scout: Starting cycle');

  // Phase 0: Fetch + Deduplicate
  interface NewItem {
    feedId: string;
    title: string;
    url: string;
    publishedAt: string | null;
    snippet: string;
    feedJurisdiction: string;
  }
  const newItems: NewItem[] = [];

  for (const feed of feeds) {
    try {
      const items = await fetchFeed(feed.url, feed.feedType as 'rss' | 'atom' | 'google_news' | 'webpage' | 'gov_api', feed.apiConfig);
      result.itemsFetched += items.length;
      result.feedsProcessed++;

      // Deduplicate: skip items we've already seen (by URL)
      for (const item of items) {
        if (!item.url) continue;
        const existing = db.select({ id: scoutItems.id })
          .from(scoutItems)
          .where(eq(scoutItems.url, item.url))
          .get();
        if (!existing) {
          newItems.push({
            feedId: feed.id,
            title: item.title,
            url: item.url,
            publishedAt: item.publishedAt,
            snippet: item.snippet,
            feedJurisdiction: feed.jurisdiction,
          });
        }
      }

      // Update feed metadata
      db.update(scoutFeeds).set({
        lastCheckedAt: new Date().toISOString(),
        lastItemCount: items.length,
        errorCount: 0,
        lastError: null,
        updatedAt: new Date().toISOString(),
      }).where(eq(scoutFeeds.id, feed.id)).run();

    } catch (err) {
      const errorMsg = (err as Error).message;
      logger.warn({ feedId: feed.id, feedName: feed.name, error: errorMsg }, 'Scout: Feed fetch failed');

      // Increment error count
      const currentFeed = db.select({ errorCount: scoutFeeds.errorCount })
        .from(scoutFeeds).where(eq(scoutFeeds.id, feed.id)).get();
      const newErrorCount = (currentFeed?.errorCount ?? 0) + 1;

      db.update(scoutFeeds).set({
        errorCount: newErrorCount,
        lastError: errorMsg,
        lastCheckedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // Auto-disable after 10 consecutive failures
        ...(newErrorCount >= 10 ? { isActive: false } : {}),
      }).where(eq(scoutFeeds.id, feed.id)).run();

      if (newErrorCount >= 10) {
        logger.warn({ feedId: feed.id, feedName: feed.name },
          'Scout: Feed auto-disabled after 10 consecutive failures');
      }
    }
  }

  result.itemsNew = newItems.length;
  logger.info({ newItems: newItems.length }, 'Scout: Deduplication complete');

  if (newItems.length === 0) {
    result.durationMs = Math.round(performance.now() - startTime);
    logger.info(result, 'Scout: Cycle complete (no new items)');
    return result;
  }

  // Phase 1: Keyword Filter (free)
  interface ScoredItem extends NewItem {
    keywordScore: number;
    dbId: string;
  }
  const survivingItems: ScoredItem[] = [];

  for (const item of newItems) {
    const keywordScore = scoreKeywords(item.title, item.snippet);
    const dbId = randomUUID();
    const now = new Date().toISOString();

    if (keywordScore < keywordThreshold) {
      // Insert as rejected — we still track it for dedup
      db.insert(scoutItems).values({
        id: dbId,
        feedId: item.feedId,
        title: item.title,
        url: item.url,
        publishedAt: item.publishedAt,
        rawSnippet: item.snippet,
        status: 'rejected',
        keywordScore,
        discoveredAt: now,
      }).run();
      result.itemsKeywordRejected++;
    } else {
      // Insert as pending, will be updated after LLM classification
      db.insert(scoutItems).values({
        id: dbId,
        feedId: item.feedId,
        title: item.title,
        url: item.url,
        publishedAt: item.publishedAt,
        rawSnippet: item.snippet,
        status: 'pending',
        keywordScore,
        discoveredAt: now,
      }).run();
      survivingItems.push({ ...item, keywordScore, dbId });
    }
  }

  logger.info({
    survived: survivingItems.length,
    rejected: result.itemsKeywordRejected,
  }, 'Scout: Keyword filter complete');

  if (survivingItems.length === 0) {
    result.durationMs = Math.round(performance.now() - startTime);
    logger.info(result, 'Scout: Cycle complete (all filtered by keywords)');
    return result;
  }

  // Phase 2: LLM Classify (cheap, batched)
  interface ClassifiedItem extends ScoredItem {
    llmRelevant: boolean;
    confidenceScore: number;
    llmJurisdiction: string | null;
  }
  const relevantItems: ClassifiedItem[] = [];

  for (let i = 0; i < survivingItems.length; i += batchSize) {
    const batch = survivingItems.slice(i, i + batchSize);

    try {
      const { items: classified, llmResponse } = await classifyBatch(
        batch.map((item) => ({ title: item.title, snippet: item.snippet })),
      );

      const costCents = calculateCostCents(
        llmResponse.tokensIn, llmResponse.tokensOut,
        llmResponse.model, llmResponse.provider,
      );
      result.totalLlmCostCents += costCents;
      result.itemsLlmClassified += batch.length;

      for (let j = 0; j < batch.length; j++) {
        const item = batch[j];
        const classification = classified[j];
        const perItemCost = Math.ceil(costCents / batch.length);

        if (classification.relevant && classification.confidence >= 0.5) {
          relevantItems.push({
            ...item,
            llmRelevant: true,
            confidenceScore: classification.confidence,
            llmJurisdiction: classification.jurisdiction,
          });
          db.update(scoutItems).set({
            llmRelevant: true,
            confidenceScore: classification.confidence,
            llmCostCents: perItemCost,
          }).where(eq(scoutItems.id, item.dbId)).run();
        } else {
          db.update(scoutItems).set({
            status: 'rejected',
            llmRelevant: false,
            confidenceScore: classification.confidence,
            llmCostCents: perItemCost,
          }).where(eq(scoutItems.id, item.dbId)).run();
        }
      }
    } catch (err) {
      logger.error({ error: (err as Error).message, batchIndex: i },
        'Scout: LLM classification batch failed — keeping items as pending');
    }
  }

  logger.info({ relevant: relevantItems.length }, 'Scout: LLM classification complete');

  // Notify if items need manual review (0.7 <= confidence < 0.85)
  const reviewNeeded = relevantItems.filter(
    (item) => item.confidenceScore >= 0.7 && item.confidenceScore < autoPromoteThreshold,
  );
  if (reviewNeeded.length > 0) {
    notifyScoutReviewNeeded({
      itemCount: reviewNeeded.length,
      titles: reviewNeeded.map((item) => item.title),
    }).catch((err) => logger.error({ error: (err as Error).message }, 'notifyScoutReviewNeeded failed'));
  }

  // Phase 3: Signal Extraction + Auto-Promote (selective)
  for (const item of relevantItems) {
    // Only extract for items above the extraction threshold (0.7)
    if (item.confidenceScore < 0.7) continue;

    try {
      const { signal, llmResponse } = await extractSignal(
        item.title,
        item.snippet,
        item.llmJurisdiction ?? item.feedJurisdiction,
      );

      const costCents = calculateCostCents(
        llmResponse.tokensIn, llmResponse.tokensOut,
        llmResponse.model, llmResponse.provider,
      );
      result.totalLlmCostCents += costCents;
      result.itemsExtracted++;

      if (!signal) continue;

      // Store extracted signal — accumulate cost (don't overwrite Phase 2 classification cost)
      db.update(scoutItems).set({
        extractedSignal: JSON.stringify(signal),
        llmCostCents: sql`COALESCE(llm_cost_cents, 0) + ${costCents}`,
      }).where(eq(scoutItems.id, item.dbId)).run();

      // Auto-promote if above threshold
      if (item.confidenceScore >= autoPromoteThreshold) {
        const signalId = randomUUID();
        const now = new Date().toISOString();

        db.insert(regulatorySignals).values({
          id: signalId,
          title: signal.title,
          jurisdiction: signal.jurisdiction,
          stage: signal.stage,
          likelihoodPercent: signal.likelihoodPercent,
          summary: signal.summary,
          sourceUrl: item.url,
          detectedAt: now,
          createdAt: now,
          updatedAt: now,
        }).run();

        db.update(scoutItems).set({
          status: 'auto_promoted',
          promotedSignalId: signalId,
        }).where(eq(scoutItems.id, item.dbId)).run();

        result.itemsAutoPromoted++;

        // Broadcast to connected dashboards
        broadcastEvent({
          id: signalId,
          type: 'scout.auto_promoted',
          data: { signalId, title: signal.title },
          jurisdiction: signal.jurisdiction,
        });

        notifyScoutSignal({
          title: signal.title,
          jurisdiction: signal.jurisdiction,
          stage: signal.stage,
          likelihood: signal.likelihoodPercent,
          summary: signal.summary,
        }).catch((err) => logger.error({ error: (err as Error).message }, 'notifyScoutSignal failed'));
      }
    } catch (err) {
      logger.error({ error: (err as Error).message, itemId: item.dbId },
        'Scout: Signal extraction failed for item');
    }
  }

  result.durationMs = Math.round(performance.now() - startTime);
  logger.info(result, 'Scout: Cycle complete');
  return result;
}

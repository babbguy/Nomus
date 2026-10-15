import cron from 'node-cron';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { regulatorySources } from '../db/schema.js';
import { runPipeline } from './pipeline.js';
import { cleanupRawSnapshots } from './snapshot-retention.js';
import { computeAndStoreStateHash } from '../core/state-hasher.js';
import { runShadowTests } from '../audit/shadow-tester.js';
import { sendHeartbeat } from '../sse/manager.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { captureError } from '../observability/error-tracking.js';
import { randomUUID } from 'node:crypto';
import { chainAnchors } from '../db/schema.js';
import { notifySchedulerSummary, getConfiguredAlertChannels, sendSlack, sendPush, getPushTopics } from '../services/notifications.js';
import { runFullAudit } from './data-auditor.js';
import { checkSourceHealth } from './source-health-checker.js';
import { startNotificationWorker, stopNotificationWorker } from '../cpg/notify/worker.js';

const tasks: cron.ScheduledTask[] = [];
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

// Grace window for due-ness so a source scraped just under its frequency ago
// doesn't slip a whole extra cycle (cron granularity ≥ 1h for scrapes).
const DUE_GRACE_MS = 60 * 60 * 1000;

/**
 * Whether a source is due for scraping under its own scrape_frequency_hours.
 * Never-scraped sources are always due. (G4: the per-source frequency shown
 * in the dashboard was previously decorative — every source scraped on every
 * cron run regardless.)
 */
export function isSourceDue(
  source: { lastScrapedAt: string | null; scrapeFrequencyHours: number | null },
  nowMs: number,
): boolean {
  if (!source.lastScrapedAt) return true;
  const freqMs = (source.scrapeFrequencyHours ?? 24) * 60 * 60 * 1000;
  const elapsed = nowMs - Date.parse(source.lastScrapedAt);
  return elapsed >= freqMs - DUE_GRACE_MS;
}

/**
 * Start all scheduled jobs.
 */
export function startScheduler(): void {
  const config = env();

  // G4: fail LOUD at startup when no alert channel can deliver — otherwise
  // tier-2/3 scraper events (pending EU amendments, source escalations) and
  // pipeline failures decay silently into log lines.
  const alertChannels = getConfiguredAlertChannels();
  if (alertChannels.length === 0) {
    logger.error(
      'ALERTING NOT CONFIGURED: no email, push, or Slack channel can deliver. ' +
      'Scraper escalations, pending-amendment warnings, and pipeline failures will only appear in logs. ' +
      'Configure notification.email / notification.push (ntfy) / notification.slack in platform settings, ' +
      'or set NOMUS_SLACK_WEBHOOK_URL / NOMUS_NTFY_TOPIC.',
    );
  }

  // Scrape cycle — run pipeline for active sources that are DUE under their
  // own scrape frequency (per-source freshness, G4).
  tasks.push(cron.schedule(config.NOMUS_SCRAPE_CRON, async () => {
    logger.info('Scheduler: Starting scrape cycle...');
    const scrapeStart = performance.now();
    const db = getDb();
    const activeSources = db.select().from(regulatorySources)
      .where(eq(regulatorySources.isActive, true))
      .all();

    const nowMs = Date.now();
    const sources = activeSources.filter((s) => isSourceDue(s, nowMs));
    const skippedNotDue = activeSources.length - sources.length;
    if (skippedNotDue > 0) {
      logger.info({ due: sources.length, skippedNotDue, active: activeSources.length },
        `Scheduler: ${sources.length}/${activeSources.length} sources due this cycle (${skippedNotDue} within their scrape frequency)`);
    }

    let totalRulesCreated = 0;
    let totalRulesUpdated = 0;
    let totalCostCents = 0;
    let sourcesSucceeded = 0;
    let sourcesFailed = 0;

    for (const source of sources) {
      try {
        const result = await runPipeline(source.id);
        if (result.status === 'error') {
          sourcesFailed++;
          logger.warn({ sourceId: source.id, sourceName: source.name, error: result.error },
            'Scheduler: Pipeline returned error for source');
        } else {
          sourcesSucceeded++;
          totalRulesCreated += result.rulesCreated;
          totalRulesUpdated += result.rulesUpdated;
        }
      } catch (err) {
        sourcesFailed++;
        logger.error({ sourceId: source.id, sourceName: source.name, error: err },
          'Scheduler: Pipeline threw for source');
        captureError(err, { subsystem: 'hunter', context: { sourceId: source.id, job: 'pipeline' } });
      }
    }

    const scrapeDuration = Math.round(performance.now() - scrapeStart);
    logger.info({ sourcesSucceeded, sourcesFailed, totalRulesCreated, totalRulesUpdated },
      'Scheduler: Nightly scrape cycle complete');

    notifySchedulerSummary({
      type: 'scrape',
      sourcesProcessed: sources.length,
      sourcesFailed,
      rulesCreated: totalRulesCreated,
      rulesUpdated: totalRulesUpdated,
      totalCostCents,
      durationMs: scrapeDuration,
    }).catch((err) => logger.error({ error: (err as Error).message }, 'notifySchedulerSummary (scrape) failed'));
  }));

  // Source health check — every 6 hours (G4: the checker existed but was
  // never scheduled; connectivity_status stayed 'unknown' forever). Probes
  // reachability only — no content download.
  tasks.push(cron.schedule('30 */6 * * *', async () => {
    logger.info('Scheduler: Running source health checks...');
    const db = getDb();
    const activeSources = db.select({
      id: regulatorySources.id,
      name: regulatorySources.name,
      connectivityStatus: regulatorySources.connectivityStatus,
    }).from(regulatorySources)
      .where(eq(regulatorySources.isActive, true))
      .all();

    const newlyUnreachable: string[] = [];
    let reachable = 0;
    for (const source of activeSources) {
      try {
        const result = await checkSourceHealth(source.id);
        if (result.status === 'reachable') {
          reachable++;
        } else if (source.connectivityStatus === 'reachable' || source.connectivityStatus === 'unknown') {
          newlyUnreachable.push(`${source.name} (${result.status})`);
        }
      } catch (err) {
        logger.warn({ sourceId: source.id, error: (err as Error).message },
          'Scheduler: health check threw for source');
      }
    }

    logger.info({ total: activeSources.length, reachable, newlyUnreachable: newlyUnreachable.length },
      'Scheduler: Source health checks complete');

    if (newlyUnreachable.length > 0) {
      const list = newlyUnreachable.slice(0, 10).join(', ');
      sendSlack(`Sources newly unreachable: ${list}`, 'Source Health Alert').catch(() => {});
      sendPush(getPushTopics(), 'Nomus: sources unreachable', list, 'high').catch(() => {});
    }
  }));

  // Data quality audit — 4 AM UTC daily (after nightly scrape has time to complete)
  tasks.push(cron.schedule('0 4 * * *', async () => {
    logger.info('Scheduler: Starting data quality audit...');
    try {
      const auditResult = await runFullAudit({ deepAudit: true });
      logger.info({
        sources: auditResult.sourcesAudited,
        passed: auditResult.sourcesPassed,
        warned: auditResult.sourcesWarned,
        failed: auditResult.sourcesFailed,
        issues: auditResult.totalIssues,
        durationMs: auditResult.durationMs,
      }, 'Scheduler: Data quality audit complete');

      notifySchedulerSummary({
        type: 'audit',
        sourcesProcessed: auditResult.sourcesAudited,
        sourcesPassed: auditResult.sourcesPassed,
        sourcesWarned: auditResult.sourcesWarned,
        sourcesFailed: auditResult.sourcesFailed,
        totalIssues: auditResult.totalIssues,
        durationMs: auditResult.durationMs,
      }).catch((err) => logger.error({ error: (err as Error).message }, 'notifySchedulerSummary (audit) failed'));
    } catch (err) {
      logger.error({ error: err }, 'Scheduler: Data quality audit failed');
      captureError(err, { subsystem: 'scheduler', context: { job: 'data-quality-audit' } });
    }
  }));

  // Scout accuracy ledger — nightly at 4:30 AM UTC (after the data
  // quality audit). Three steps, in order:
  //   1. reconcileOutcomes  — freeze outcomes for terminal-stage bills that
  //      somehow missed the transition hook (defensive exactly-once sweep)
  //   2. recordSessionEndFailures — US-FED bills dead by biennium adjournment
  //   3. runAccuracyCalibration — persist tonight's calibration snapshot
  tasks.push(cron.schedule('30 4 * * *', async () => {
    logger.info('Scheduler: Running Scout accuracy ledger jobs...');
    try {
      const { reconcileOutcomes, recordSessionEndFailures } = await import('../scout/outcome-recorder.js');
      const { runAccuracyCalibration } = await import('../scout/accuracy-calibration.js');
      const reconciled = reconcileOutcomes();
      const sessionEnded = recordSessionEndFailures();
      const snapshot = runAccuracyCalibration();
      logger.info({
        reconciled,
        sessionEnded,
        snapshotId: snapshot.id,
        sampleSize: snapshot.sampleSize,
        brierScore: snapshot.brierScore,
        published: snapshot.published,
      }, 'Scheduler: Scout accuracy ledger jobs complete');
    } catch (err) {
      logger.error({ error: err }, 'Scheduler: Scout accuracy ledger jobs failed');
      captureError(err, { subsystem: 'scout', context: { job: 'accuracy-ledger' } });
    }
  }));

  // Attestation expiry sweep — nightly at 4:45 AM UTC (after the
  // accuracy ledger). Finds attestations whose expiresAt crossed since the
  // last sweep and notifies their active reliance subscriptions, exactly
  // once per attestation (expiry_notified_at marker in the sweep itself).
  tasks.push(cron.schedule('45 4 * * *', async () => {
    logger.info('Scheduler: Running attestation expiry sweep...');
    try {
      const { sweepExpiredAttestations } = await import('../services/attestation-notifier.js');
      const result = sweepExpiredAttestations();
      logger.info(result, 'Scheduler: Attestation expiry sweep complete');
    } catch (err) {
      logger.error({ error: err }, 'Scheduler: Attestation expiry sweep failed');
      captureError(err, { subsystem: 'scheduler', context: { job: 'attestation-expiry-sweep' } });
    }
  }));

  // CPG decision sweep — daily at 3:30 AM UTC (design spec §7.5): expiry
  // notices for approvals and standing exceptions, and case states re-derived.
  tasks.push(cron.schedule('30 3 * * *', async () => {
    try {
      const { sweepDecisions } = await import('../cpg/decisions/sweep.js');
      logger.info(sweepDecisions(getDb()), 'Scheduler: CPG decision sweep complete');
    } catch (err) {
      logger.error({ error: err }, 'Scheduler: CPG decision sweep failed');
      captureError(err, { subsystem: 'scheduler', context: { job: 'cpg-decision-sweep' } });
    }
  }));

  // CPG notification deliveries (design spec §12.4): the persistent outbox worker.
  startNotificationWorker();

  // State hash — every 6 hours
  tasks.push(cron.schedule('0 */6 * * *', () => {
    logger.info('Scheduler: Computing state hash...');
    computeAndStoreStateHash();
  }));

  // Shadow tests — daily at 5 AM UTC
  tasks.push(cron.schedule('0 5 * * *', () => {
    logger.info('Scheduler: Running shadow tests...');
    runShadowTests();
  }));

  // SSE heartbeat — every 30 seconds
  heartbeatInterval = setInterval(() => {
    sendHeartbeat();
  }, 30_000);

  // Blockchain anchor — daily at 6 AM UTC (after state hash at midnight/6/12/18)
  tasks.push(cron.schedule('0 6 * * *', async () => {
    logger.info('Scheduler: Anchoring state hash on-chain...');
    try {
      const { anchorStateHash, getChainConfig } = await import('@nomus/chain');
      if (!getChainConfig()) {
        logger.info('Scheduler: Blockchain not configured — skipping anchor');
        return;
      }
      const hash = computeAndStoreStateHash();
      const result = await anchorStateHash(hash.hash, hash.ruleCount);
      if (result) {
        const db = getDb();
        db.insert(chainAnchors).values({
          id: randomUUID(),
          stateHash: result.stateHash,
          ruleCount: result.ruleCount,
          txHash: result.txHash,
          blockNumber: result.blockNumber,
          anchoredAt: result.timestamp,
        }).run();
        logger.info({ txHash: result.txHash, blockNumber: result.blockNumber }, 'State hash anchored on Polygon');
      }
    } catch (err) {
      logger.error({ err }, 'Scheduler: Blockchain anchor failed');
      captureError(err, { subsystem: 'scheduler', context: { job: 'blockchain-anchor' } });
    }
  }));

  // Scout cycle — discover regulatory signals from RSS/news feeds
  if (config.NOMUS_SCOUT_ENABLED === 'true') {
    tasks.push(cron.schedule(config.NOMUS_SCOUT_CRON, async () => {
      logger.info('Scheduler: Starting scout cycle...');
      try {
        const { runScoutCycle } = await import('../scout/pipeline.js');
        const scoutResult = await runScoutCycle();

        notifySchedulerSummary({
          type: 'scout',
          feedsProcessed: scoutResult.feedsProcessed,
          itemsNew: scoutResult.itemsNew,
          itemsAutoPromoted: scoutResult.itemsAutoPromoted,
          totalCostCents: scoutResult.totalLlmCostCents,
          durationMs: scoutResult.durationMs,
        }).catch((err) => logger.error({ error: (err as Error).message }, 'notifySchedulerSummary (scout) failed'));
      } catch (err) {
        logger.error({ error: err }, 'Scheduler: Scout cycle failed');
        captureError(err, { subsystem: 'scout', context: { job: 'scout-cycle' } });
      }
      logger.info('Scheduler: Scout cycle complete');
    }));
  }

  // Snapshot retention — Sunday 3 AM UTC.
  // Default: raw snapshots are kept FOREVER — they are the byte-exact
  // provenance record behind the source-exact regulation guarantee.
  // Only when NOMUS_RAW_SNAPSHOT_RETENTION_DAYS is explicitly set do we
  // purge older snapshots, and even then every source always keeps its most
  // recent snapshot.
  tasks.push(cron.schedule('0 3 * * 0', () => {
    const retentionDays = config.NOMUS_RAW_SNAPSHOT_RETENTION_DAYS;
    if (retentionDays === undefined) {
      logger.debug('Scheduler: Snapshot cleanup skipped — NOMUS_RAW_SNAPSHOT_RETENTION_DAYS not set (raw snapshots kept forever)');
      return;
    }
    logger.info({ retentionDays }, 'Scheduler: Cleaning up raw snapshots past retention...');
    const deleted = cleanupRawSnapshots(retentionDays);
    logger.info({ deleted, retentionDays }, 'Scheduler: Raw snapshot cleanup complete (latest snapshot per source always retained)');
  }));

  logger.info({
    scrapeCron: config.NOMUS_SCRAPE_CRON,
    scoutCron: config.NOMUS_SCOUT_ENABLED === 'true' ? config.NOMUS_SCOUT_CRON : 'disabled',
    alertChannels: alertChannels.length > 0 ? alertChannels : 'NONE — logs only',
    jobs: ['scrape-cycle', 'source-health-6h', 'data-quality-audit-4am', 'accuracy-ledger-430am', 'attestation-expiry-sweep-445am', 'state-hash-6h', 'shadow-tests-5am', 'sse-heartbeat-30s', 'scout-cycle', 'snapshot-cleanup-weekly'],
  }, 'Scheduler started');
}

/**
 * Stop all scheduled jobs.
 */
export function stopScheduler(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks.length = 0;
  stopNotificationWorker();
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  logger.info('Scheduler stopped');
}

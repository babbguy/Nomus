/**
 * Source Health Checker
 * Probes each source URL to determine connectivity status.
 * Does NOT download full content — just checks if the URL is reachable.
 * Used by the scheduler and the admin dashboard.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { regulatorySources } from '../db/schema.js';
import { logger } from '../logger.js';

// ─── Types ──────────────────────────────────────────────────────

export type ConnectivityStatus = 'reachable' | 'blocked' | 'timeout' | 'error' | 'captcha';

export interface HealthCheckResult {
  status: ConnectivityStatus;
  latencyMs: number;
  error?: string;
}

export interface SourceHealthSummary {
  total: number;
  reachable: number;
  blocked: number;
  timeout: number;
  error: number;
  captcha: number;
  unknown: number;
}

// ─── User-Agent Rotation ────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
];

// Common CAPTCHA patterns found in response bodies
const CAPTCHA_PATTERNS = [
  /captcha/i,
  /recaptcha/i,
  /hcaptcha/i,
  /cf-challenge/i,
  /cloudflare.*challenge/i,
  /please verify you are a human/i,
  /bot detection/i,
  /access denied.*automated/i,
];

// ─── Core Health Check ──────────────────────────────────────────

/**
 * Check connectivity for a single source by ID.
 * Performs HTTP HEAD with 10s timeout. Rotates User-Agents on failure.
 * Detects blocked (403, empty), timeout, CAPTCHA, and redirect (301).
 */
export async function checkSourceHealth(sourceId: string): Promise<HealthCheckResult> {
  const db = getDb();
  const source = db.select().from(regulatorySources)
    .where(eq(regulatorySources.id, sourceId))
    .get();

  if (!source) {
    return { status: 'error', latencyMs: 0, error: 'Source not found' };
  }

  const url = source.url;

  // Skip non-HTTP sources (e.g. upload:// protocol)
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { status: 'reachable', latencyMs: 0 };
  }

  let lastError: string | undefined;

  // Try each User-Agent until one succeeds or all fail
  for (let i = 0; i < USER_AGENTS.length; i++) {
    const ua = USER_AGENTS[i];
    const result = await probeUrl(url, ua);

    if (result.status === 'reachable') {
      // Update DB with success
      const now = new Date().toISOString();
      db.update(regulatorySources)
        .set({
          connectivityStatus: 'reachable',
          connectivityCheckedAt: now,
          connectivityError: null,
          consecutiveFailures: 0,
          updatedAt: now,
        })
        .where(eq(regulatorySources.id, sourceId))
        .run();

      return result;
    }

    // If blocked, try the next UA before giving up
    if (result.status === 'blocked' && i < USER_AGENTS.length - 1) {
      lastError = result.error;
      continue;
    }

    // For timeout, error, or captcha — no point retrying with different UA
    lastError = result.error;

    const now = new Date().toISOString();
    const currentFailures = source.consecutiveFailures ?? 0;
    db.update(regulatorySources)
      .set({
        connectivityStatus: result.status,
        connectivityCheckedAt: now,
        connectivityError: result.error ?? null,
        consecutiveFailures: currentFailures + 1,
        updatedAt: now,
      })
      .where(eq(regulatorySources.id, sourceId))
      .run();

    return result;
  }

  // All UAs exhausted — mark as blocked
  const now = new Date().toISOString();
  const currentFailures = source.consecutiveFailures ?? 0;
  db.update(regulatorySources)
    .set({
      connectivityStatus: 'blocked',
      connectivityCheckedAt: now,
      connectivityError: lastError ?? 'All User-Agents blocked',
      consecutiveFailures: currentFailures + 1,
      updatedAt: now,
    })
    .where(eq(regulatorySources.id, sourceId))
    .run();

  return { status: 'blocked', latencyMs: 0, error: lastError ?? 'All User-Agents blocked' };
}

/**
 * Probe a URL with a specific User-Agent.
 * Uses HEAD request first, falls back to GET (first 2000 chars) for CAPTCHA detection.
 */
async function probeUrl(url: string, userAgent: string): Promise<HealthCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const start = performance.now();

  try {
    // Try HEAD first
    const headResponse = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    const latencyMs = Math.round(performance.now() - start);

    // Check for 301 permanent redirect — log but treat as reachable
    // (fetch follows redirects automatically)

    if (headResponse.ok) {
      return { status: 'reachable', latencyMs };
    }

    if (headResponse.status === 403 || headResponse.status === 451) {
      return { status: 'blocked', latencyMs, error: `HTTP ${headResponse.status}` };
    }

    if (headResponse.status === 405) {
      // HEAD not allowed — try GET with CAPTCHA detection
      return await probeWithGet(url, userAgent);
    }

    if (headResponse.status >= 500) {
      return { status: 'error', latencyMs, error: `HTTP ${headResponse.status}` };
    }

    // Other 4xx — treat as error
    return { status: 'error', latencyMs, error: `HTTP ${headResponse.status}` };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);

    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'timeout', latencyMs, error: 'Request timed out after 10s' };
    }

    const message = err instanceof Error ? err.message : String(err);

    // Network errors that suggest blocking
    if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
      return { status: 'error', latencyMs, error: message };
    }

    return { status: 'error', latencyMs, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * GET request with CAPTCHA detection.
 * Only reads the first 2000 characters to check for CAPTCHA patterns.
 */
async function probeWithGet(url: string, userAgent: string): Promise<HealthCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const start = performance.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    const latencyMs = Math.round(performance.now() - start);

    if (!response.ok) {
      if (response.status === 403 || response.status === 451) {
        return { status: 'blocked', latencyMs, error: `HTTP ${response.status}` };
      }
      return { status: 'error', latencyMs, error: `HTTP ${response.status}` };
    }

    // Read first 2000 chars for CAPTCHA detection
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let text = '';
      let done = false;

      while (!done && text.length < 2000) {
        const chunk = await reader.read();
        done = chunk.done;
        if (chunk.value) {
          text += decoder.decode(chunk.value, { stream: !done });
        }
      }

      // Cancel the rest of the body
      try { reader.cancel(); } catch { /* ignore */ }

      // Check for CAPTCHA patterns
      for (const pattern of CAPTCHA_PATTERNS) {
        if (pattern.test(text)) {
          return { status: 'captcha', latencyMs, error: `CAPTCHA detected: ${pattern.source}` };
        }
      }
    }

    return { status: 'reachable', latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);

    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'timeout', latencyMs, error: 'Request timed out after 10s' };
    }

    return { status: 'error', latencyMs, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Batch Operations ───────────────────────────────────────────

/**
 * Check health of all active sources sequentially with 2s delay between checks.
 * Updates the database for each source.
 */
export async function checkAllSourceHealth(): Promise<Array<{ sourceId: string; name: string; result: HealthCheckResult }>> {
  const db = getDb();
  const sources = db.select().from(regulatorySources)
    .where(eq(regulatorySources.isActive, true))
    .all();

  const results: Array<{ sourceId: string; name: string; result: HealthCheckResult }> = [];

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    logger.info({ sourceId: source.id, name: source.name, index: i + 1, total: sources.length },
      'Checking source health');

    const result = await checkSourceHealth(source.id);
    results.push({ sourceId: source.id, name: source.name, result });

    // 2s delay between checks to avoid overwhelming targets
    if (i < sources.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  logger.info({ checked: results.length, reachable: results.filter((r) => r.result.status === 'reachable').length },
    'Source health check complete');

  return results;
}

/**
 * Get a summary of connectivity status for all sources.
 * Used by the admin dashboard.
 */
export function getSourceHealthSummary(): SourceHealthSummary {
  const db = getDb();
  const sources = db.select().from(regulatorySources).all();

  const summary: SourceHealthSummary = {
    total: sources.length,
    reachable: 0,
    blocked: 0,
    timeout: 0,
    error: 0,
    captcha: 0,
    unknown: 0,
  };

  for (const source of sources) {
    const status = source.connectivityStatus ?? 'unknown';
    if (status in summary && status !== 'total') {
      (summary as unknown as Record<string, number>)[status]++;
    } else {
      summary.unknown++;
    }
  }

  return summary;
}

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { getDb } from '../../db/client.js';
import { platformSettings, policyRules } from '../../db/schema.js';
import { createHash } from 'node:crypto';

export const modusIntegrationRoutes = new Hono<AppEnv>();

modusIntegrationRoutes.use('*', requireSessionOrApiKey('admin'));

// GET /status - Get Modus connection status
// Returns: configured, reachable, modus version, last sync info, rule counts
modusIntegrationRoutes.get('/status', async (c) => {
  const config = env();
  const modusUrl = config.NOMUS_MODUS_API_URL;
  const configured = !!modusUrl;

  // Count active rules we'd share
  const db = getDb();
  const ruleCount = db.select({ id: policyRules.id })
    .from(policyRules)
    .where(eq(policyRules.isActive, true))
    .all().length;

  // Get state hash
  const rules = db.select({ signature: policyRules.signature })
    .from(policyRules)
    .where(eq(policyRules.isActive, true))
    .all();
  const stateHash = createHash('sha256')
    .update(rules.map(r => r.signature).sort().join('|'))
    .digest('hex');

  // Try to reach Modus health endpoint
  let reachable = false;
  let modusVersion: string | null = null;
  let modusStatus: Record<string, unknown> | null = null;
  let latencyMs: number | null = null;

  if (modusUrl) {
    const start = performance.now();
    try {
      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (config.NOMUS_MODUS_API_KEY) {
        headers['Authorization'] = `Bearer ${config.NOMUS_MODUS_API_KEY}`;
      }
      const res = await fetch(`${modusUrl.replace(/\/$/, '')}/health`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      latencyMs = Math.round(performance.now() - start);
      if (res.ok) {
        reachable = true;
        const body = await res.json();
        modusVersion = body.version ?? null;
        modusStatus = body;
      }
    } catch {
      latencyMs = Math.round(performance.now() - start);
    }
  }

  // Load last webhook delivery info from settings
  const lastWebhookAt = db.select().from(platformSettings)
    .where(eq(platformSettings.key, 'modus.last_webhook_at'))
    .get()?.value ?? null;
  const lastWebhookEvent = db.select().from(platformSettings)
    .where(eq(platformSettings.key, 'modus.last_webhook_event'))
    .get()?.value ?? null;

  return c.json({
    configured,
    modus_url: modusUrl ? modusUrl.replace(/\/+$/, '') : null,
    reachable,
    modus_version: modusVersion,
    latency_ms: latencyMs,
    nomus_rules: ruleCount,
    state_hash: stateHash,
    last_webhook_at: lastWebhookAt,
    last_webhook_event: lastWebhookEvent,
    modus_status: modusStatus,
  });
});

// POST /test - Test connectivity to Modus
modusIntegrationRoutes.post('/test', async (c) => {
  const config = env();
  const modusUrl = config.NOMUS_MODUS_API_URL;

  if (!modusUrl) {
    return c.json({ reachable: false, error: 'Modus URL not configured (NOMUS_MODUS_API_URL)' });
  }

  const start = performance.now();
  try {
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (config.NOMUS_MODUS_API_KEY) {
      headers['Authorization'] = `Bearer ${config.NOMUS_MODUS_API_KEY}`;
    }
    const res = await fetch(`${modusUrl.replace(/\/$/, '')}/health`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Math.round(performance.now() - start);

    if (res.ok) {
      const body = await res.json();
      return c.json({
        reachable: true,
        latency_ms: latencyMs,
        modus_version: body.version ?? null,
        orchestrator_count: body.orchestrators ?? null,
      });
    }
    return c.json({ reachable: false, latency_ms: latencyMs, error: `HTTP ${res.status}` });
  } catch (err) {
    return c.json({
      reachable: false,
      latency_ms: Math.round(performance.now() - start),
      error: (err as Error).message,
    });
  }
});

// POST /trigger-sync - Manually push a rules.updated event to Modus
modusIntegrationRoutes.post('/trigger-sync', async (c) => {
  const config = env();
  const modusUrl = config.NOMUS_MODUS_API_URL;

  if (!modusUrl) {
    return c.json({ error: 'Modus URL not configured' }, 503);
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (config.NOMUS_MODUS_API_KEY) {
      headers['Authorization'] = `Bearer ${config.NOMUS_MODUS_API_KEY}`;
    }

    // Tell Modus's Nomus client to sync now
    const res = await fetch(`${modusUrl.replace(/\/$/, '')}/api/v1/admin/nomus/sync`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) {
      const body = await res.json();
      // Record this sync
      const db = getDb();
      const now = new Date().toISOString();
      db.insert(platformSettings).values({ key: 'modus.last_webhook_at', value: now, updatedAt: now })
        .onConflictDoUpdate({ target: platformSettings.key, set: { value: now, updatedAt: now } })
        .run();
      db.insert(platformSettings).values({ key: 'modus.last_webhook_event', value: 'manual_sync', updatedAt: now })
        .onConflictDoUpdate({ target: platformSettings.key, set: { value: 'manual_sync', updatedAt: now } })
        .run();

      return c.json({ success: true, modus_response: body });
    }
    return c.json({ success: false, error: `Modus returned HTTP ${res.status}` }, 502);
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 502);
  }
});

// GET /compliance-report - Combined compliance report (Nomus rules + Modus runtime)
modusIntegrationRoutes.get('/compliance-report', async (c) => {
  const config = env();
  const db = getDb();

  // Nomus side: rule stats
  const allRules = db.select().from(policyRules)
    .where(eq(policyRules.isActive, true))
    .all();

  type SeverityCounts = Record<string, number>;
  const byJurisdiction: Record<string, { total: number } & SeverityCounts> = {};
  const bySeverity: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  const byCategory: Record<string, number> = {};

  for (const rule of allRules) {
    const j = rule.jurisdiction;
    if (!byJurisdiction[j]) byJurisdiction[j] = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
    byJurisdiction[j].total++;
    byJurisdiction[j][rule.severity] = (byJurisdiction[j][rule.severity] ?? 0) + 1;
    bySeverity[rule.severity] = (bySeverity[rule.severity] ?? 0) + 1;
    byCategory[rule.category] = (byCategory[rule.category] ?? 0) + 1;
  }

  const stateHash = createHash('sha256')
    .update(allRules.map(r => r.signature).sort().join('|'))
    .digest('hex');

  // Modus side: try to get Modus's nomus status.
  // Shape of the fields Nomus reads from Modus's status response.
  interface ModusNomusStatus {
    policy_count?: number;
    status?: string;
    last_sync?: string | null;
    state_hash?: string;
  }
  let modusCompliance: ModusNomusStatus | null = null;
  const modusUrl = config.NOMUS_MODUS_API_URL;

  if (modusUrl) {
    try {
      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (config.NOMUS_MODUS_API_KEY) {
        headers['Authorization'] = `Bearer ${config.NOMUS_MODUS_API_KEY}`;
      }
      const res = await fetch(`${modusUrl.replace(/\/$/, '')}/api/v1/admin/nomus/status`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        modusCompliance = await res.json();
      }
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Failed to fetch Modus compliance status');
    }
  }

  return c.json({
    nomus: {
      total_rules: allRules.length,
      state_hash: stateHash,
      generated_at: new Date().toISOString(),
      by_jurisdiction: byJurisdiction,
      by_severity: bySeverity,
      by_category: byCategory,
    },
    modus: modusCompliance,
    combined: {
      nomus_rules_active: allRules.length,
      modus_connected: !!modusCompliance,
      modus_policies_synced: modusCompliance?.policy_count ?? 0,
      modus_sync_status: modusCompliance?.status ?? 'unknown',
      modus_last_sync: modusCompliance?.last_sync ?? null,
      in_sync: stateHash === (modusCompliance?.state_hash ?? ''),
    },
  });
});

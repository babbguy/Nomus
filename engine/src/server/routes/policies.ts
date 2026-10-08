import { Hono } from 'hono';
import { eq, and, gte, sql } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { policyRules, stateHashes } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { compilePolicy } from '../../core/policy-compiler.js';
import { signData } from '../../core/signing.js';
import { policyBundleCache } from '../../core/policy-cache.js';
import { getPublicKey } from '../../core/signing.js';
import { createHash } from 'node:crypto';
import { LEGAL_DISCLAIMER } from '@nomus/shared';
import { safeParseInt } from '../utils.js';

/**
 * Parse a JSON column safely. Returns the fallback if the value is null,
 * undefined, or malformed. Used so a single bad row can't 500 a list
 * endpoint.
 */
function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const policyRoutes = new Hono<AppEnv>();

policyRoutes.use('*', requireSessionOrApiKey('read:policies'));
policyRoutes.use('*', rateLimit());

// List policies with optional filters
const POLICIES_HARD_LIMIT = 1000;
policyRoutes.get('/', (c) => {
  const db = getDb();
  const jurisdiction = c.req.query('jurisdiction');
  const category = c.req.query('category');
  const industry = c.req.query('industry');
  const since = c.req.query('since');
  // Cap the limit so a malicious caller cannot request millions.
  const limit = Math.min(safeParseInt(c.req.query('limit'), 500), POLICIES_HARD_LIMIT);

  // Build conditions
  const conditions = [eq(policyRules.isActive, true)];
  if (jurisdiction) conditions.push(eq(policyRules.jurisdiction, jurisdiction));
  if (category) conditions.push(eq(policyRules.category, category));
  if (since) conditions.push(gte(policyRules.updatedAt, since));

  // Apply LIMIT in SQL when there's no industry filter — saves loading 10k+
  // rows into JS heap on every request.
  let rules;
  let total: number;
  if (industry) {
    // Industry filter requires JSON array introspection — load with a generous
    // cap, then filter, then take `limit`. The cap matches POLICIES_HARD_LIMIT
    // so worst-case heap usage is bounded.
    const fetched = db.select().from(policyRules)
      .where(and(...conditions))
      .limit(POLICIES_HARD_LIMIT * 4)
      .all();
    const matching = fetched.filter((r) => {
      const industries = safeParseJson<string[]>(r.industries, ['all']);
      return industries.includes(industry) || industries.includes('all');
    });
    total = matching.length;
    rules = matching.slice(0, limit);
  } else {
    rules = db.select().from(policyRules)
      .where(and(...conditions))
      .limit(limit)
      .all();
    total = db.select({ n: sql<number>`count(*)` }).from(policyRules).where(and(...conditions)).get()?.n ?? rules.length;
  }

  return c.json({
    count: rules.length,
    // Every matching rule, also when count is capped by limit.
    total,
    policies: rules.map((r) => ({
      ...r,
      conditions: safeParseJson<unknown[]>(r.conditions, []),
      industries: safeParseJson<string[]>(r.industries, ['all']),
    })),
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// Industry impact summary
policyRoutes.get('/industries', (c) => {
  const db = getDb();

  // Use SQL to get only the columns needed (industries, jurisdiction, severity)
  const rules = db.select({
    industries: policyRules.industries,
    jurisdiction: policyRules.jurisdiction,
    severity: policyRules.severity,
  }).from(policyRules)
    .where(eq(policyRules.isActive, true))
    .all();

  const industryMap: Record<string, { count: number; jurisdictions: Set<string>; severities: Record<string, number> }> = {};

  for (const rule of rules) {
    const industries = safeParseJson<string[]>(rule.industries, ['all']);
    for (const ind of industries) {
      if (!industryMap[ind]) {
        industryMap[ind] = { count: 0, jurisdictions: new Set(), severities: {} };
      }
      industryMap[ind].count++;
      industryMap[ind].jurisdictions.add(rule.jurisdiction);
      industryMap[ind].severities[rule.severity] = (industryMap[ind].severities[rule.severity] ?? 0) + 1;
    }
  }

  // Rules the industry filter of GET /policies returns for this industry: the
  // ones tagged with it plus the ones tagged 'all'. (ruleCount counts only
  // the specifically tagged rules, so the filter showed more than its label.)
  const parsedIndustries = rules.map((r) => safeParseJson<string[]>(r.industries, ['all']));
  const industries = Object.entries(industryMap)
    .map(([name, data]) => ({
      name,
      ruleCount: data.count,
      matchingRuleCount: parsedIndustries.filter((list) => list.includes(name) || list.includes('all')).length,
      jurisdictions: Array.from(data.jurisdictions),
      severities: data.severities,
    }))
    .sort((a, b) => b.ruleCount - a.ruleCount);

  return c.json({ industries, totalRules: rules.length });
});

// Get signed policy bundle for initial sync
policyRoutes.get('/bundle', (c) => {
  const jurisdictions = c.req.query('jurisdictions')?.split(',').filter(Boolean) || [];

  const cacheKey = `bundle:${jurisdictions.sort().join(',')}`;

  // Check cache
  const cached = policyBundleCache.get(cacheKey);
  if (cached) return c.json(cached);

  const db = getDb();
  const conditions = [eq(policyRules.isActive, true)];

  const rules = db.select().from(policyRules)
    .where(and(...conditions))
    .all()
    .filter((r) => jurisdictions.length === 0 || jurisdictions.includes(r.jurisdiction));

  const compiled = rules.map(compilePolicy);

  // Compute state hash — must match /hash endpoint algorithm (sorted signatures joined by |)
  const stateHash = createHash('sha256')
    .update(compiled.map((p) => p.signature).sort().join('|'))
    .digest('hex');
  const now = new Date().toISOString();

  const bundle = {
    policies: compiled,
    stateHash,
    generatedAt: now,
    signature: signData(`${stateHash}:${now}`),
    _disclaimer: LEGAL_DISCLAIMER,
  };

  policyBundleCache.set(cacheKey, bundle);
  return c.json(bundle);
});

// Get current state hash
policyRoutes.get('/hash', (c) => {
  const db = getDb();
  const rules = db.select({ id: policyRules.id, signature: policyRules.signature })
    .from(policyRules)
    .where(eq(policyRules.isActive, true))
    .all();

  const hash = createHash('sha256')
    .update(rules.map((r) => r.signature).sort().join('|'))
    .digest('hex');

  return c.json({
    stateHash: hash,
    ruleCount: rules.length,
    computedAt: new Date().toISOString(),
  });
});

// ─── Impact Map ──────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

policyRoutes.get('/impact-map', async (c) => {
  const db = getDb();
  // Cap at 10k to bound memory exposure.
  const maxRules = Math.min(safeParseInt(c.req.query('limit'), 5000), 10000);
  const rules = db.select({
    jurisdiction: policyRules.jurisdiction,
    industries: policyRules.industries,
    severity: policyRules.severity,
    ruleKey: policyRules.ruleKey,
    humanSummary: policyRules.humanSummary,
  }).from(policyRules).where(eq(policyRules.isActive, true)).limit(maxRules).all();

  const matrix: Record<string, Record<string, { ruleCount: number; maxSeverity: string; severityScore: number; topRules: { ruleKey: string; humanSummary: string; severity: string }[] }>> = {};
  const industriesSet = new Set<string>();
  const jurisdictionsSet = new Set<string>();

  for (const rule of rules) {
    const industries: string[] = (() => { try { return JSON.parse(rule.industries ?? '["all"]'); } catch { return ['all']; } })();
    const jurisdiction = rule.jurisdiction ?? 'Unknown';
    jurisdictionsSet.add(jurisdiction);

    for (const ind of industries) {
      industriesSet.add(ind);
      if (!matrix[ind]) matrix[ind] = {};
      if (!matrix[ind][jurisdiction]) matrix[ind][jurisdiction] = { ruleCount: 0, maxSeverity: 'low', severityScore: 0, topRules: [] };

      const cell = matrix[ind][jurisdiction];
      cell.ruleCount++;
      const score = SEVERITY_ORDER[rule.severity ?? 'low'] ?? 0;
      if (score > cell.severityScore) {
        cell.severityScore = score;
        cell.maxSeverity = rule.severity ?? 'low';
      }
      if (cell.topRules.length < 3) {
        cell.topRules.push({ ruleKey: rule.ruleKey, humanSummary: rule.humanSummary ?? '', severity: rule.severity ?? 'medium' });
      }
    }
  }

  // Flatten to array
  const flat = [];
  for (const [industry, jurisdictions] of Object.entries(matrix)) {
    for (const [jurisdiction, data] of Object.entries(jurisdictions)) {
      flat.push({ industry, jurisdiction, ...data });
    }
  }

  return c.json({
    matrix: flat,
    industries: Array.from(industriesSet).sort(),
    jurisdictions: Array.from(jurisdictionsSet).sort(),
  });
});

// Get single policy (MUST be after all static routes to avoid /:id shadowing /bundle, /hash, etc.)
policyRoutes.get('/:id', (c) => {
  const db = getDb();
  const rule = db.select().from(policyRules)
    .where(eq(policyRules.id, c.req.param('id')))
    .get();

  if (!rule) return c.json({ error: 'Policy not found' }, 404);

  try {
    return c.json({
      ...rule,
      conditions: JSON.parse(rule.conditions),
      _disclaimer: LEGAL_DISCLAIMER,
    });
  } catch {
    return c.json({ ...rule, _disclaimer: LEGAL_DISCLAIMER });
  }
});

// .well-known public key endpoint (separate, no auth)
export const wellKnownRoutes = new Hono();

wellKnownRoutes.get('/.well-known/nomus-keys', (c) => {
  try {
    const publicKey = getPublicKey();
    return c.json({
      keys: [{
        kty: 'OKP',
        crv: 'Ed25519',
        x: publicKey,
        use: 'sig',
        kid: createHash('sha256').update(publicKey).digest('hex').slice(0, 16),
      }],
      _notice: 'Nomus is an automated regulatory monitoring tool, not a law firm. Cryptographic signatures verify data integrity only — they do not constitute legal certification or endorsement.',
    });
  } catch {
    return c.json({ error: 'Signing keys not initialized' }, 503);
  }
});

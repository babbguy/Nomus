import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { organizations, badgeConfigs, attestationReceipts, policyRules } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';
import { safeJson } from '../utils.js';
import { getComplianceScore } from './compliance-posture.js';
import { env } from '../../config/env.js';

export const badgeRoutes = new Hono<AppEnv>();

// ─── Public Badge Endpoints (no auth) ────────────────────────────

// JSON badge data
badgeRoutes.get('/:orgSlug', (c) => {
  const db = getDb();
  const org = db.select().from(organizations)
    .where(eq(organizations.slug, c.req.param('orgSlug')))
    .get();

  if (!org) return c.json({ error: 'Organization not found' }, 404);

  const config = db.select().from(badgeConfigs)
    .where(eq(badgeConfigs.orgId, org.id))
    .get();

  if (!config?.isPublic) return c.json({ error: 'Badge not enabled' }, 404);

  // Compute score
  const score = computeComplianceScore(org.id);

  return c.json({
    org: { name: org.name, slug: org.slug },
    score: score.score,
    jurisdictions: score.jurisdictions,
    lastAttestation: score.lastAttestation,
    rulesMonitored: score.rulesMonitored,
    _notice: 'This badge indicates automated monitoring status, not legal certification.',
  });
});

// SVG badge
badgeRoutes.get('/:orgSlug/svg', (c) => {
  const db = getDb();
  const org = db.select().from(organizations)
    .where(eq(organizations.slug, c.req.param('orgSlug')))
    .get();

  if (!org) return c.text('Not Found', 404);

  const config = db.select().from(badgeConfigs)
    .where(eq(badgeConfigs.orgId, org.id))
    .get();

  if (!config?.isPublic) return c.text('Badge not enabled', 404);

  const score = computeComplianceScore(org.id);
  const color = score.score >= 80 ? '#00e5a0' : score.score >= 50 ? '#f59e0b' : '#ef4444';
  const width = 240;
  const height = 28;
  // The configured badge style (it was saved but never applied to the SVG).
  const radius = config.style === 'flat' ? 0 : config.style === 'pill' ? height / 2 : 4;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" rx="${radius}" fill="#0f1117"/>
  <rect x="0" y="0" width="140" height="${height}" rx="${radius}" fill="#161922"/>
  <rect x="140" y="0" width="100" height="${height}" rx="${radius}" fill="${color}20"/>
  <text x="8" y="18" font-family="system-ui,sans-serif" font-size="11" fill="#9ca3af">AI Compliance</text>
  <text x="148" y="18" font-family="system-ui,sans-serif" font-size="11" font-weight="600" fill="${color}">Score: ${score.score}</text>
  <text x="84" y="18" font-family="system-ui,sans-serif" font-size="9" fill="#6b7280">Nomus</text>
</svg>`;

  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(svg);
});

// Embeddable script
badgeRoutes.get('/:orgSlug/embed.js', (c) => {
  const slug = c.req.param('orgSlug');

  // Validate slug: alphanumeric + hyphens only, max 64 chars
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(slug)) {
    return c.text('Invalid slug', 400);
  }

  // Sanitize baseUrl: only allow http/https schemes
  const rawBaseUrl = c.req.url.split('/api/')[0];
  let baseUrl: string;
  try {
    const parsed = new URL(rawBaseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return c.text('Invalid URL scheme', 400);
    }
    baseUrl = parsed.origin;
  } catch {
    return c.text('Invalid URL', 400);
  }

  // Use JSON.stringify for values interpolated into JavaScript to prevent XSS
  const safeSvgUrl = JSON.stringify(`${baseUrl}/api/v1/badge/${slug}/svg`);
  // The badge links to the public transparency page on the dashboard. It
  // linked to /verify/<slug>, a route that takes an attestation id, so every
  // click landed on "Attestation not found".
  const dashboardOrigin = (() => {
    try { return new URL(env().NOMUS_CORS_ORIGIN).origin; } catch { return baseUrl; }
  })();
  const safeVerifyUrl = JSON.stringify(`${dashboardOrigin}/transparency`);

  const script = `(function(){
  var d=document,s=d.createElement('a'),i=d.createElement('img');
  i.src=${safeSvgUrl};
  i.alt='AI Compliance Monitored by Nomus';
  i.style.height='28px';
  s.href=${safeVerifyUrl};
  s.target='_blank';
  s.rel='noopener noreferrer';
  s.appendChild(i);
  d.currentScript.parentNode.insertBefore(s,d.currentScript);
})();`;

  c.header('Content-Type', 'application/javascript');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(script);
});

// ─── Authenticated Badge Config Endpoints ────────────────────────

// Get badge config
badgeRoutes.get('/:orgSlug/config', requireSessionOrApiKey('read:policies'), (c) => {
  const db = getDb();
  const org = db.select().from(organizations)
    .where(eq(organizations.slug, c.req.param('orgSlug')))
    .get();

  if (!org || org.id !== c.get('orgId')) return c.json({ error: 'Not found' }, 404);

  let config = db.select().from(badgeConfigs)
    .where(eq(badgeConfigs.orgId, org.id))
    .get();

  if (!config) {
    // Create default config
    const now = new Date().toISOString();
    config = {
      id: randomUUID(),
      orgId: org.id,
      style: 'rounded',
      jurisdictions: '[]',
      showScore: true,
      showJurisdictions: true,
      customLabel: null,
      isPublic: false,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(badgeConfigs).values(config).run();
  }

  return c.json({
    ...config,
    jurisdictions: (() => { try { return JSON.parse(config.jurisdictions); } catch { return []; } })(),
    embedCode: `<script src="${c.req.url.split('/config')[0]}/embed.js"></script>`,
  });
});

// Update badge config
badgeRoutes.patch('/:orgSlug/config', requireSessionOrApiKey('read:policies'), async (c) => {
  const db = getDb();
  const org = db.select().from(organizations)
    .where(eq(organizations.slug, c.req.param('orgSlug')))
    .get();

  if (!org || org.id !== c.get('orgId')) return c.json({ error: 'Not found' }, 404);

  const { data: rawBody, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const body = rawBody as Record<string, any>;
  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (body.style !== undefined) {
    if (!['flat', 'rounded', 'pill'].includes(body.style)) {
      return c.json({ error: 'Invalid style. Must be one of: flat, rounded, pill' }, 400);
    }
    updates.style = body.style;
  }
  if (body.isPublic !== undefined && typeof body.isPublic !== 'boolean') {
    return c.json({ error: 'isPublic must be a boolean' }, 400);
  }
  if (body.jurisdictions) updates.jurisdictions = JSON.stringify(body.jurisdictions);
  if (body.showScore !== undefined) updates.showScore = body.showScore;
  if (body.showJurisdictions !== undefined) updates.showJurisdictions = body.showJurisdictions;
  if (body.customLabel !== undefined) updates.customLabel = body.customLabel;
  if (body.isPublic !== undefined) updates.isPublic = body.isPublic;

  db.update(badgeConfigs)
    .set(updates)
    .where(eq(badgeConfigs.orgId, org.id))
    .run();

  return c.json({ message: 'Badge config updated' });
});

// ─── Score Computation ───────────────────────────────────────────

function computeComplianceScore(orgId: string) {
  const db = getDb();

  // Get recent attestations (last 30 days)
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const attestations = db.select().from(attestationReceipts)
    .where(and(eq(attestationReceipts.orgId, orgId)))
    .orderBy(desc(attestationReceipts.evaluatedAt))
    .all();

  const total = attestations.filter((a) => a.evaluatedAt >= since).length;

  // The organization's compliance score, as its Compliance Posture page and
  // dashboard show it. (The badge used to compute its own score from the
  // share of compliant attestations, so the public badge read 27 while the
  // organization's own pages read 0.)
  const score = Math.round(getComplianceScore(orgId).result.overallScore);

  // Get jurisdictions from attestations
  const jurisdictions = [...new Set(attestations.map((a) => a.jurisdiction))];

  // Get rule count
  const ruleCount = db.select({ count: sql<number>`count(*)` })
    .from(policyRules)
    .where(eq(policyRules.isActive, true))
    .get()?.count ?? 0;

  return {
    score: Math.min(score, 100),
    jurisdictions,
    lastAttestation: attestations[0]?.evaluatedAt ?? null,
    rulesMonitored: ruleCount,
    totalAttestations: total,
  };
}

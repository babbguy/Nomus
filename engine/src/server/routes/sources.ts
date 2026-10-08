import { Hono } from 'hono';
import { randomUUID, createHash } from 'node:crypto';
import { eq, desc, and } from 'drizzle-orm';
import { z } from 'zod';
import { jurisdictionCodeSchema } from '@nomus/shared';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { regulatorySources, rawSnapshots, policyRules, pipelineRuns, stagedContent } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { logger } from '../../logger.js';
import { actorOf, safeJson } from '../utils.js';
import { getAllAuditResults } from '../../hunter/data-auditor.js';
import { safeParseInt } from '../utils.js';
import { isSsrfSafe } from '../utils/ssrf.js';
import { chooseServedSnapshot, describeProvenance } from '../../hunter/provenance.js';
import { sameJson } from '../../core/json-equal.js';
import { findRegistryEntry, provenanceGradeFor, registryFields, registryKeyOf } from '../../db/source-sync.js';
import {
  publishRuleEvents,
  restoreRulesForSource,
  retireRulesForSource,
  type DbHandle,
  type PendingRuleEvent,
} from '../../core/rule-management.js';

const categorySchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9_]+$/, 'Category must be lowercase letters, digits and "_"');

const createSourceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  jurisdiction: jurisdictionCodeSchema,
  url: z.string().url(),
  parserType: z.enum(['html', 'pdf']).default('html'),
  selectorConfig: z.record(z.unknown()).default({}),
  scrapeFrequencyHours: z.number().int().min(0).max(8760).default(24),
  ingestionMode: z.enum(['auto', 'manual']).default('auto'),
  category: categorySchema.default('ai_regulation'),
  tier: z.number().int().min(1).max(4).default(1),
  needsHeadless: z.boolean().default(false),
  // The Add Source form's Active checkbox (a new source was always active).
  isActive: z.boolean().default(true),
});

const updateSourceSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  jurisdiction: jurisdictionCodeSchema.optional(),
  url: z.string().url().optional(),
  parserType: z.enum(['html', 'pdf']).optional(),
  selectorConfig: z.record(z.unknown()).optional(),
  scrapeFrequencyHours: z.number().int().min(0).max(8760).optional(),
  isActive: z.boolean().optional(),
  ingestionMode: z.enum(['auto', 'manual']).optional(),
  category: categorySchema.optional(),
  tier: z.number().int().min(1).max(4).optional(),
  needsHeadless: z.boolean().optional(),
});

const uploadContentSchema = z.object({
  content: z.string().min(100, 'Content is required and must be substantial (>100 chars).'),
  // Optional hint from the dashboard: 'pdf' = content is base64-encoded PDF bytes,
  // 'html' = content is UTF-8 text. If absent, the pipeline auto-detects from
  // the content itself (PDF magic bytes vs HTML tags).
  contentType: z.enum(['html', 'pdf']).optional(),
  filename: z.string().optional(),
});

const uploadStandardSchema = z.object({
  content: z.string().min(100, 'Content is required and must be substantial (>100 chars). Provide the full text or PDF base64.'),
  contentType: z.enum(['html', 'pdf']).optional(),
});

export const sourceRoutes = new Hono<AppEnv>();

sourceRoutes.use('*', requireSessionOrApiKey('admin'));

// List all regulatory sources (with audit results attached)
sourceRoutes.get('/', (c) => {
  const db = getDb();
  const limit = Math.min(safeParseInt(c.req.query('limit'), 200), 500);
  const offset = safeParseInt(c.req.query('offset'), 0);
  const sources = db.select().from(regulatorySources).limit(limit).offset(offset).all();

  // Build audit result lookup by sourceId
  let auditMap: Map<string, any>;
  try {
    const audits = getAllAuditResults();
    auditMap = new Map(audits.map((a) => [a.sourceId, a]));
  } catch {
    auditMap = new Map();
  }

  return c.json({
    count: sources.length,
    sources: sources.map((s) => {
      let selectorConfig: unknown;
      try { selectorConfig = JSON.parse(s.selectorConfig); } catch { selectorConfig = s.selectorConfig; }
      const audit = auditMap.get(s.id) ?? null;
      return { ...s, selectorConfig, auditResult: audit };
    }),
  });
});

// ─── Source ownership helpers ───────────────────────────────────────

type SourceRow = typeof regulatorySources.$inferSelect;

/** Source as returned by the API: selectorConfig parsed to an object. */
function serializeSource(row: SourceRow) {
  let selectorConfig: unknown;
  try { selectorConfig = JSON.parse(row.selectorConfig); } catch { selectorConfig = row.selectorConfig; }
  return { ...row, selectorConfig };
}

/** Another source already uses this name (case-insensitive). Names must be unique:
 *  the startup dedupe would otherwise merge the two rows. */
function nameTaken(name: string, exceptId?: string): boolean {
  const key = registryKeyOf(name);
  return getDb().select({ id: regulatorySources.id, name: regulatorySources.name })
    .from(regulatorySources).all()
    .some((r) => r.id !== exceptId && registryKeyOf(r.name) === key);
}

/**
 * Deactivate or reactivate a source together with its rules. Deactivation
 * retires every active rule of the source (recorded with reason
 * `source_deactivated`); reactivation restores exactly those rules.
 */
function applySourceActive(
  tx: DbHandle,
  sourceId: string,
  active: boolean,
  actor: string,
  extra: Partial<SourceRow> = {},
): PendingRuleEvent[] {
  tx.update(regulatorySources)
    .set({ ...extra, isActive: active, updatedAt: new Date().toISOString() })
    .where(eq(regulatorySources.id, sourceId))
    .run();
  return active
    ? restoreRulesForSource(tx, sourceId, actor)
    : retireRulesForSource(tx, sourceId, actor);
}

// Add a new source (always a custom source: the startup sync never touches it)
sourceRoutes.post('/', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = createSourceSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);

  // Reject SSRF vectors before persisting — once a URL is in the table the
  // scheduled scrape job will fetch it.
  const ssrf = isSsrfSafe(parsed.data.url);
  if (!ssrf.ok) return c.json({ error: `URL rejected: ${ssrf.reason}` }, 400);

  if (nameTaken(parsed.data.name)) {
    return c.json({ error: `A source named "${parsed.data.name}" already exists` }, 409);
  }

  const db = getDb();
  const now = new Date().toISOString();

  const source = {
    id: randomUUID(),
    name: parsed.data.name,
    jurisdiction: parsed.data.jurisdiction,
    url: parsed.data.url,
    parserType: parsed.data.parserType,
    selectorConfig: JSON.stringify(parsed.data.selectorConfig),
    scrapeFrequencyHours: parsed.data.scrapeFrequencyHours,
    ingestionMode: parsed.data.ingestionMode,
    category: parsed.data.category,
    tier: parsed.data.tier,
    needsHeadless: parsed.data.needsHeadless,
    provenanceGrade: provenanceGradeFor(parsed.data.url, parsed.data.parserType),
    origin: 'custom' as const,
    registryKey: null,
    isActive: parsed.data.isActive,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(regulatorySources).values(source).run();
  logger.info({ sourceId: source.id, name: source.name, actor: actorOf(c) }, 'Custom source created');

  const row = db.select().from(regulatorySources).where(eq(regulatorySources.id, source.id)).get()!;
  return c.json(serializeSource(row), 201);
});

// Update a source. Editing a built-in source's registry-controlled fields (or
// its name) turns it into a 'customized' source that the startup sync leaves alone.
sourceRoutes.patch('/:id', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = updateSourceSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  const input = parsed.data;

  // Reject SSRF vectors on URL updates too.
  if (input.url) {
    const ssrf = isSsrfSafe(input.url);
    if (!ssrf.ok) return c.json({ error: `URL rejected: ${ssrf.reason}` }, 400);
  }

  const db = getDb();
  const id = c.req.param('id');
  const actor = actorOf(c);

  const current = db.select().from(regulatorySources).where(eq(regulatorySources.id, id)).get();
  if (!current) return c.json({ error: 'Source not found' }, 404);

  if (input.name !== undefined && input.name !== current.name && nameTaken(input.name, id)) {
    return c.json({ error: `A source named "${input.name}" already exists` }, 409);
  }

  const updates: Partial<SourceRow> = {};
  let registryControlledChange = false;
  const setField = <K extends keyof SourceRow>(key: K, value: SourceRow[K], registryControlled: boolean) => {
    if (current[key] === value) return;
    updates[key] = value;
    if (registryControlled) registryControlledChange = true;
  };

  if (input.name !== undefined) setField('name', input.name, true);
  if (input.jurisdiction !== undefined) setField('jurisdiction', input.jurisdiction, true);
  if (input.url !== undefined) setField('url', input.url, true);
  if (input.parserType !== undefined) setField('parserType', input.parserType, true);
  if (input.selectorConfig !== undefined) {
    const next = JSON.stringify(input.selectorConfig);
    let same = false;
    try { same = sameJson(JSON.parse(current.selectorConfig), input.selectorConfig); } catch { /* differs */ }
    if (!same) { updates.selectorConfig = next; registryControlledChange = true; }
  }
  if (input.category !== undefined) setField('category', input.category, true);
  if (input.tier !== undefined) setField('tier', input.tier, true);
  if (input.ingestionMode !== undefined) setField('ingestionMode', input.ingestionMode, true);
  if (input.needsHeadless !== undefined) setField('needsHeadless', input.needsHeadless, true);
  if (input.scrapeFrequencyHours !== undefined) setField('scrapeFrequencyHours', input.scrapeFrequencyHours, false);

  if (updates.url !== undefined || updates.parserType !== undefined) {
    updates.provenanceGrade = provenanceGradeFor(updates.url ?? current.url, updates.parserType ?? current.parserType);
  }
  if (registryControlledChange && current.origin === 'registry') updates.origin = 'customized';

  const activeChange = input.isActive !== undefined && input.isActive !== current.isActive
    ? input.isActive
    : undefined;

  let events: PendingRuleEvent[] = [];
  db.transaction((tx) => {
    if (activeChange !== undefined) {
      events = applySourceActive(tx, id, activeChange, actor, updates);
    } else {
      tx.update(regulatorySources)
        .set({ ...updates, updatedAt: new Date().toISOString() })
        .where(eq(regulatorySources.id, id))
        .run();
    }
  });
  publishRuleEvents(events);

  logger.info({
    sourceId: id,
    actor,
    fields: Object.keys(updates),
    origin: updates.origin ?? current.origin,
    isActive: activeChange,
    rulesChanged: events.length,
  }, 'Source updated');

  const row = db.select().from(regulatorySources).where(eq(regulatorySources.id, id)).get()!;
  return c.json({
    ...serializeSource(row),
    ...(activeChange === false ? { rulesRetired: events.length } : {}),
    ...(activeChange === true ? { rulesRestored: events.length } : {}),
  });
});

// Put a built-in source back to the registry's values and hand it back to the sync.
sourceRoutes.post('/:id/restore-defaults', (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const current = db.select().from(regulatorySources).where(eq(regulatorySources.id, id)).get();
  if (!current) return c.json({ error: 'Source not found' }, 404);

  const entry = current.registryKey ? findRegistryEntry(current.registryKey) : undefined;
  if (!entry) {
    return c.json({ error: 'Source is not backed by a built-in registry entry; there are no defaults to restore' }, 409);
  }
  if (nameTaken(entry.name, id)) {
    return c.json({ error: `Cannot restore: another source is already named "${entry.name}"` }, 409);
  }

  const fields = registryFields(entry);
  db.update(regulatorySources)
    .set({
      ...fields,
      name: entry.name,
      provenanceGrade: provenanceGradeFor(entry.url, entry.parserType),
      origin: 'registry',
      updatedAt: new Date().toISOString(),
    })
    .where(eq(regulatorySources.id, id))
    .run();
  logger.info({ sourceId: id, name: entry.name, actor: actorOf(c) }, 'Source restored to built-in defaults');

  const row = db.select().from(regulatorySources).where(eq(regulatorySources.id, id)).get()!;
  return c.json(serializeSource(row));
});

// Soft-delete a source: it stops being scraped and its rules stop applying.
sourceRoutes.delete('/:id', (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const current = db.select().from(regulatorySources).where(eq(regulatorySources.id, id)).get();
  if (!current) return c.json({ error: 'Source not found' }, 404);

  let events: PendingRuleEvent[] = [];
  db.transaction((tx) => {
    events = applySourceActive(tx, id, false, actorOf(c));
  });
  publishRuleEvents(events);
  logger.info({ sourceId: id, actor: actorOf(c), rulesRetired: events.length }, 'Source deactivated');

  return c.json({ message: 'Source deactivated', rulesRetired: events.length });
});

// ─── Customer Upload for Paywalled Standards ──────────────────────
// ISO 27001, PCI-DSS full text, etc. are paywalled.
// Customers who have purchased the standard can upload their copy
// so Nomus can parse and generate compliance rules from it.

/** Paywalled sources that support customer upload */
const PAYWALLED_SOURCES: Record<string, { name: string; jurisdiction: string; parserType: 'html' | 'pdf'; category: string }> = {
  'iso-27001': { name: 'ISO 27001:2022 (Customer Upload)', jurisdiction: 'ISO', parserType: 'pdf', category: 'information_security' },
  'iso-42001': { name: 'ISO 42001:2023 AI Management (Customer Upload)', jurisdiction: 'ISO', parserType: 'pdf', category: 'ai_standards' },
  'pci-dss-full': { name: 'PCI-DSS v4.0 Full Standard (Customer Upload)', jurisdiction: 'INTL', parserType: 'pdf', category: 'payment_security' },
};

// GET /uploadable - List standards that support customer upload
sourceRoutes.get('/uploadable', (c) => {
  return c.json({
    standards: Object.entries(PAYWALLED_SOURCES).map(([id, info]) => ({
      id,
      ...info,
      description: `This standard is paywalled. Upload your purchased copy for Nomus to parse.`,
    })),
  });
});

// POST /upload/:standardId - Upload a paywalled standard
sourceRoutes.post('/upload/:standardId', async (c) => {
  const standardId = c.req.param('standardId');
  const template = PAYWALLED_SOURCES[standardId];

  if (!template) {
    return c.json({ error: `Unknown standard: ${standardId}. Use GET /uploadable to see available standards.` }, 400);
  }

  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = uploadStandardSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, 400);
  const content = parsed.data.content;

  const db = getDb();
  const now = new Date().toISOString();
  const contentHash = createHash('sha256').update(content).digest('hex');

  // Check if this source already exists
  const existing = db.select().from(regulatorySources)
    .where(eq(regulatorySources.name, template.name))
    .get();

  let sourceId: string;

  if (existing) {
    sourceId = existing.id;
    // Update the source to active
    db.update(regulatorySources)
      .set({ isActive: true, lastContentHash: contentHash, updatedAt: now })
      .where(eq(regulatorySources.id, sourceId))
      .run();
  } else {
    sourceId = randomUUID();
    db.insert(regulatorySources).values({
      id: sourceId,
      name: template.name,
      jurisdiction: template.jurisdiction,
      url: `upload://${standardId}`,
      parserType: template.parserType,
      selectorConfig: JSON.stringify({ uploadedContent: true }),
      scrapeFrequencyHours: 0, // no auto-scrape for uploads
      isActive: true,
      lastContentHash: contentHash,
      tier: 3,
      category: template.category,
      provenanceGrade: 'A', // customer-provided = authoritative
      origin: 'custom',
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  // Store the content as a snapshot. Customer-uploaded standards are
  // authoritative (provenanceGrade 'A') and are not re-promoted by a live
  // scrape, so mark this promoted so the read path serves it as current law.
  db.insert(rawSnapshots).values({
    id: randomUUID(),
    sourceId,
    contentHash,
    content,
    scrapedAt: now,
    provenanceMode: 'upload',
    promoted: true,
  }).run();

  logger.info({ standardId, sourceId, contentLength: content.length }, 'Customer uploaded paywalled standard');

  return c.json({
    message: `${template.name} uploaded successfully. Run the pipeline to generate compliance rules.`,
    source_id: sourceId,
    content_hash: contentHash,
  }, 201);
});

// POST /upload-content/:sourceId - Upload content for any existing source
// Sets the source into "pending upload" mode — pipeline will process the
// uploaded content directly instead of trying to scrape the live URL.
sourceRoutes.post('/upload-content/:sourceId', async (c) => {
  const sourceId = c.req.param('sourceId');
  const db = getDb();

  const source = db.select().from(regulatorySources)
    .where(eq(regulatorySources.id, sourceId))
    .get();

  if (!source) {
    return c.json({ error: 'Source not found' }, 404);
  }

  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsedBody = uploadContentSchema.safeParse(body);
  if (!parsedBody.success) return c.json({ error: parsedBody.error.issues[0]?.message ?? 'Invalid input' }, 400);
  const content = parsedBody.data.content;
  const filename = parsedBody.data.filename || 'uploaded-file';

  // Determine the effective parser type for this upload. Precedence:
  //   1. Explicit contentType from the dashboard (most reliable)
  //   2. Filename extension (.pdf / .htm* / .txt / .md / .xml)
  //   3. Content shape — does the raw body look like base64? does it look like HTML?
  // If the resolved type differs from the source's registered parserType, update
  // the source row so the pipeline processes the upload correctly. This fixes
  // the class of bug where uploading a PDF to an HTML-registered source (or
  // vice versa) silently produced zero or corrupted rules.
  let effectiveParserType: 'html' | 'pdf' = source.parserType as 'html' | 'pdf';
  if (parsedBody.data.contentType) {
    effectiveParserType = parsedBody.data.contentType;
  } else if (/\.pdf$/i.test(filename)) {
    effectiveParserType = 'pdf';
  } else if (/\.(html?|txt|md|xml)$/i.test(filename)) {
    effectiveParserType = 'html';
  } else if (/^[A-Za-z0-9+/=\s]+$/.test(content.slice(0, 200))) {
    // First 200 chars look like base64 — probably a PDF the dashboard didn't hint
    try {
      const head = Buffer.from(content.slice(0, 16), 'base64').toString('binary');
      if (head.startsWith('%PDF')) effectiveParserType = 'pdf';
    } catch {
      // not valid base64; leave parserType as-is
    }
  } else if (content.includes('<') && /<(!DOCTYPE|html|head|body|div|p|h[1-6])\b/i.test(content.slice(0, 2000))) {
    effectiveParserType = 'html';
  }

  const parserTypeChanged = effectiveParserType !== source.parserType;
  if (parserTypeChanged) {
    logger.warn(
      { sourceId, registered: source.parserType, effective: effectiveParserType, filename },
      'Upload parserType differs from source registration — updating source to match',
    );
  }

  const now = new Date().toISOString();
  const contentHash = createHash('sha256').update(content).digest('hex');
  const wordCount = content.split(/\s+/).filter(Boolean).length;

  // Compute raw-bytes provenance for the upload so the source-exact CLI can
  // still say "here's what was uploaded at timestamp X" even for manual files.
  // For PDFs the raw_content is the base64 string (same as live PDF scrapes);
  // for HTML it's the original text.
  const rawBytesHash = createHash('sha256').update(content).digest('hex');
  const rawBytesSize = Buffer.byteLength(content, 'utf-8');

  // Store as a snapshot (the pipeline will find this when processing)
  db.insert(rawSnapshots).values({
    id: randomUUID(),
    sourceId,
    contentHash,
    content,
    scrapedAt: now,
    rawBytesHash,
    rawBytesSize,
    rawContent: content,
    fetchedUrl: `upload://${filename}`,
    httpStatus: 200,
    contentType: effectiveParserType === 'pdf' ? 'application/pdf' : 'text/html',
    userAgent: 'nomus-dashboard-upload',
  }).run();

  // Mark source as having a pending upload — pipeline will use this instead of live URL.
  // Also flip parserType if the upload's type doesn't match the registration.
  db.update(regulatorySources)
    .set({
      pendingUploadFile: filename,
      pendingUploadHash: contentHash,
      pendingUploadAt: now,
      ...(parserTypeChanged ? { parserType: effectiveParserType } : {}),
      updatedAt: now,
    })
    .where(eq(regulatorySources.id, sourceId))
    .run();

  // Save to content cache for future fallback
  try {
    const { saveCacheContent } = await import('../../hunter/content-cache.js');
    saveCacheContent(sourceId, content, effectiveParserType, source.url);
  } catch (err) {
    logger.warn({ sourceId, error: (err as Error).message }, 'Failed to save upload to content cache');
  }

  logger.info({ sourceId, sourceName: source.name, filename, contentLength: content.length, wordCount, contentHash },
    'Content uploaded — source set to pending upload mode');

  return c.json({
    message: `"${filename}" uploaded for ${source.name}. Click "Process File" to extract compliance rules.`,
    source_id: sourceId,
    content_hash: contentHash,
    word_count: wordCount,
    filename,
    status: 'pending_upload',
  }, 201);
});

// POST /clear-upload/:sourceId - Clear pending upload, return to normal scrape mode
sourceRoutes.post('/clear-upload/:sourceId', (c) => {
  const db = getDb();
  const result = db.update(regulatorySources)
    .set({
      pendingUploadFile: null,
      pendingUploadHash: null,
      pendingUploadAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(regulatorySources.id, c.req.param('sourceId')))
    .run();

  if (result.changes === 0) return c.json({ error: 'Source not found' }, 404);
  return c.json({ message: 'Upload cleared — source returned to normal scrape mode' });
});

/** Parse a stored provenance manifest JSON string; null on absence/corruption. */
function parseManifest(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Audit / Inspection Endpoints ─────────────────────────────

// Get full scraped content for a source (latest snapshot)
sourceRoutes.get('/:sourceId/content', (c) => {
  const db = getDb();
  const sourceId = c.req.param('sourceId');

  const source = db.select().from(regulatorySources)
    .where(eq(regulatorySources.id, sourceId))
    .get();
  if (!source) return c.json({ error: 'Source not found' }, 404);

  // Serving honesty + fail-closed: the authoritative "current law" is the last
  // known-good PROMOTED snapshot. A newer, non-promoted capture (held / stale /
  // partial) must never be presented as current — we serve the last known-good
  // version with an explicit as-of timestamp and an update-pending flag.
  const latest = db.select().from(rawSnapshots)
    .where(eq(rawSnapshots.sourceId, sourceId))
    .orderBy(desc(rawSnapshots.scrapedAt))
    .limit(1)
    .get();

  const lastPromoted = db.select().from(rawSnapshots)
    .where(and(eq(rawSnapshots.sourceId, sourceId), eq(rawSnapshots.promoted, true)))
    .orderBy(desc(rawSnapshots.scrapedAt))
    .limit(1)
    .get();

  const decision = chooseServedSnapshot(latest ?? null, lastPromoted ?? null);
  const snapshot = decision.served;

  if (!snapshot) {
    return c.json({ content: null, message: 'No scrape data — run scrape first' });
  }

  const prov = describeProvenance(snapshot.provenanceMode);
  // Self-consistency: a customer hashing the displayed text must reproduce the
  // stored contentHash. (Promoted rows now recompute this after cleaning.)
  const selfConsistent =
    createHash('sha256').update(snapshot.content).digest('hex') === snapshot.contentHash;

  // Expose BOTH the cleaned analysis text AND the raw HTTP body provenance.
  // (auditors must see what we actually
  // downloaded, not just the post-processed version.)
  return c.json({
    // Cleaned text used for rule extraction and display
    content: snapshot.content,
    contentHash: snapshot.contentHash,
    wordCount: snapshot.content.split(/\s+/).filter(Boolean).length,
    selfConsistent,
    // Raw provenance — proves the regulation matches the source byte-for-byte
    rawContent: snapshot.rawContent,
    rawBytesHash: snapshot.rawBytesHash,
    rawBytesSize: snapshot.rawBytesSize,
    fetchedUrl: snapshot.fetchedUrl,
    httpStatus: snapshot.httpStatus,
    contentType: snapshot.contentType,
    userAgent: snapshot.userAgent,
    // ─── Provenance honesty — healed/assembled/stale must NEVER look byte-exact ──
    provenanceMode: prov.mode,
    provenanceLabel: prov.label,
    byteExact: prov.byteExact,
    // Per-section manifest so assembled content is verifiable section-by-section
    provenanceManifest: parseManifest(snapshot.provenanceManifest),
    // ─── Serving state ─────────────────────────────────────────────
    // verified=true means this is the last known-good promoted snapshot.
    verified: decision.verified,
    asOf: snapshot.scrapedAt,
    updatePending: decision.updatePending,
    pending: decision.pending,
    // Source metadata
    scrapedAt: snapshot.scrapedAt,
    sourceName: source.name,
    jurisdiction: source.jurisdiction,
    url: source.url,
  });
});

// Get all rules for a source
sourceRoutes.get('/:sourceId/rules', (c) => {
  const db = getDb();
  const sourceId = c.req.param('sourceId');

  const source = db.select().from(regulatorySources)
    .where(eq(regulatorySources.id, sourceId))
    .get();
  if (!source) return c.json({ error: 'Source not found' }, 404);

  const rules = db.select().from(policyRules)
    .where(eq(policyRules.sourceId, sourceId))
    .all();

  return c.json({
    sourceName: source.name,
    jurisdiction: source.jurisdiction,
    ruleCount: rules.length,
    rules: rules.map((r) => ({
      id: r.id,
      ruleKey: r.ruleKey,
      humanSummary: r.humanSummary,
      legalReference: r.legalReference,
      severity: r.severity,
      effect: r.effect,
      category: r.category,
      conditions: r.conditions,
      version: r.version,
      locked: r.locked,
      isActive: r.isActive,
    })),
  });
});

// Get pipeline stats for a source (latest staged content + run history)
sourceRoutes.get('/:sourceId/pipeline', (c) => {
  const db = getDb();
  const sourceId = c.req.param('sourceId');

  const source = db.select().from(regulatorySources)
    .where(eq(regulatorySources.id, sourceId))
    .get();
  if (!source) return c.json({ error: 'Source not found' }, 404);

  const staged = db.select().from(stagedContent)
    .where(eq(stagedContent.sourceId, sourceId))
    .orderBy(desc(stagedContent.createdAt))
    .limit(1)
    .get() ?? null;

  const runs = db.select().from(pipelineRuns)
    .where(eq(pipelineRuns.sourceId, sourceId))
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(10)
    .all();

  return c.json({
    sourceName: source.name,
    jurisdiction: source.jurisdiction,
    contentQualityGrade: staged?.qualityGrade ?? null,
    staged: staged ? {
      qualityGrade: staged.qualityGrade ?? null,
      scoredCount: staged.scoredCount ?? 0,
      rejectedCount: staged.rejectedCount ?? 0,
      extractedCount: staged.extractedCount ?? 0,
      pipelineStatus: staged.pipelineStatus ?? null,
      llmModel: staged.llmModel ?? null,
      llmCostCents: staged.llmCostCents ?? 0,
    } : null,
    runs: runs.map((r) => ({
      status: r.status,
      stepReached: r.stepReached,
      rulesCreated: r.rulesCreated,
      rulesUpdated: r.rulesUpdated,
      durationMs: r.durationMs,
      startedAt: r.startedAt,
      errorMessage: r.errorMessage,
    })),
  });
});

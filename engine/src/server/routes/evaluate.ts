import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { attestationReceipts } from '../../db/schema.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { evaluateCompliance } from '../../core/attestation.js';
import { notifyAttestationStatusChange } from '../../services/attestation-notifier.js';
import { evaluateRequestSchema, LEGAL_DISCLAIMER } from '@nomus/shared';
import { safeJson } from '../utils.js';

export const evaluateRoutes = new Hono<AppEnv>();

evaluateRoutes.use('*', requireSessionOrApiKey('evaluate'));
evaluateRoutes.use('*', rateLimit());

// lifecycle extras — parsed from the raw body alongside the shared
// evaluateRequestSchema (which strips unknown keys and lives in
// @nomus/shared, frozen for this work order):
//   expiresAt  — optional UTC ISO-8601 (Z-suffixed) lifecycle expiry, must
//                be in the future. Z is enforced so the nightly expiry sweep
//                can compare timestamps lexicographically.
//   supersedes — optional id of a same-org attestation this one replaces;
//                sets supersededBy on the old receipt and notifies its
//                reliance subscriptions.
const lifecycleExtrasSchema = z.object({
  expiresAt: z.string().datetime().optional(), // zod .datetime(): UTC Z only
  supersedes: z.string().uuid().optional(),
});

/**
 * POST /api/v1/evaluate
 * The core product endpoint — evaluate an action against active policies.
 * Returns a signed attestation receipt.
 */
evaluateRoutes.post('/', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = evaluateRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  }

  const extras = lifecycleExtrasSchema.safeParse(body);
  if (!extras.success) {
    return c.json({ error: 'Invalid input', details: extras.error.issues }, 400);
  }
  const { expiresAt, supersedes } = extras.data;

  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    return c.json({ error: 'expiresAt must be in the future' }, 400);
  }

  const orgId = c.get('orgId')!;
  const db = getDb();

  // Validate the supersede target BEFORE creating anything — no partial state
  let supersedeTarget: typeof attestationReceipts.$inferSelect | undefined;
  if (supersedes) {
    supersedeTarget = db.select().from(attestationReceipts)
      .where(eq(attestationReceipts.id, supersedes))
      .get();
    if (!supersedeTarget) {
      return c.json({ error: 'Superseded attestation not found' }, 404);
    }
    if (supersedeTarget.orgId !== orgId) {
      return c.json({ error: 'Superseded attestation belongs to another organization' }, 403);
    }
    if (supersedeTarget.supersededBy) {
      return c.json({
        error: `Attestation is already superseded by ${supersedeTarget.supersededBy}`,
      }, 409);
    }
  }

  const { action, jurisdiction, context } = parsed.data;
  const actionContext = { action, ...context };
  const result = evaluateCompliance(orgId, actionContext, jurisdiction, { expiresAt });

  if (supersedeTarget) {
    db.update(attestationReceipts)
      .set({ supersededBy: result.id })
      .where(eq(attestationReceipts.id, supersedeTarget.id))
      .run();

    // Notify the OLD attestation's reliance subscriptions (fire-and-forget;
    // failures are logged inside the notifier — zero silent failures)
    const updatedOld = db.select().from(attestationReceipts)
      .where(eq(attestationReceipts.id, supersedeTarget.id)).get();
    if (updatedOld) notifyAttestationStatusChange(updatedOld, 'attestation.superseded');
  }

  return c.json({
    ...result,
    supersedes: supersedeTarget?.id ?? null,
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

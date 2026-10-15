import { Hono } from 'hono';
import type { AppEnv } from '../../app.js';
import { getDb } from '../../../db/client.js';
import { requireSessionOrApiKey } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { getCorporateBundle } from '../../../cpg/bundle/build.js';
import { cpgError, CpgError, cpgErrorResponse } from '../../../cpg/errors.js';

/**
 * E38 GET /api/v1/cpg/bundle: the org's signed corporate policy bundle
 * (design spec §8.6). Org keys, user-bound keys and sessions with
 * read:policies, because every scanner (CLI, editor, CI) needs it. Strong
 * ETag; If-None-Match answers 304.
 */
export const cpgBundleRoutes = new Hono<AppEnv>();

cpgBundleRoutes.get('/', requireSessionOrApiKey('read:policies'), rateLimit(), (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return cpgError(c, 401, 'unauthenticated', 'Authentication required');
  let built;
  try {
    built = getCorporateBundle(getDb(), orgId);
  } catch (err) {
    if (err instanceof CpgError) return cpgErrorResponse(c, err);
    throw err;
  }
  c.header('ETag', built.etag);
  c.header('Cache-Control', 'private, no-cache');
  const inm = c.req.header('If-None-Match');
  if (inm && inm.split(',').map((t) => t.trim()).includes(built.etag)) return c.body(null, 304);
  return c.json(built.bundle);
});

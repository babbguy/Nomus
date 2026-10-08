import { Hono } from 'hono';
import type { Context } from 'hono';
import { createRuleSchema, updateRuleSchema } from '@nomus/shared';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { actorOf, safeJson, safeParseInt } from '../utils.js';
import {
  RuleManagementError,
  createRule,
  getRuleWithHistory,
  listRules,
  reactivateRule,
  retireRule,
  serializeRule,
  updateRule,
} from '../../core/rule-management.js';

/**
 * Admin rule management: list, read (with history), create, edit, retire and
 * reactivate policy rules. Every write is re-signed through `signRule` and
 * recorded in `policy_events`; see core/rule-management.ts.
 */
export const adminRuleRoutes = new Hono<AppEnv>();

adminRuleRoutes.use('*', requireSessionOrApiKey('admin'));
adminRuleRoutes.use('*', rateLimit());

/** Turn a RuleManagementError into its HTTP response; rethrow anything else. */
function fail(c: Context<AppEnv>, err: unknown) {
  if (err instanceof RuleManagementError) {
    const body: Record<string, unknown> = { error: err.message };
    if (err.details !== undefined) body.details = err.details;
    return c.json(body, err.status);
  }
  throw err;
}

adminRuleRoutes.get('/', (c) => {
  const limit = Math.min(Math.max(safeParseInt(c.req.query('limit'), 100), 1), 500);
  const offset = Math.max(safeParseInt(c.req.query('offset'), 0), 0);
  const { total, rules } = listRules(getDb(), {
    sourceId: c.req.query('sourceId') || undefined,
    jurisdiction: c.req.query('jurisdiction') || undefined,
    includeInactive: c.req.query('includeInactive') === 'true',
    limit,
    offset,
  });
  return c.json({ count: rules.length, total, limit, offset, rules });
});

adminRuleRoutes.get('/:id', (c) => {
  const rule = getRuleWithHistory(getDb(), c.req.param('id'));
  if (!rule) return c.json({ error: 'Rule not found' }, 404);
  return c.json(rule);
});

adminRuleRoutes.post('/', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = createRuleSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);

  try {
    const { rule } = createRule(getDb(), parsed.data, actorOf(c));
    return c.json(serializeRule(rule), 201);
  } catch (err) {
    return fail(c, err);
  }
});

adminRuleRoutes.patch('/:id', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = updateRuleSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);

  try {
    const { rule, changed } = updateRule(getDb(), c.req.param('id'), parsed.data, actorOf(c));
    return c.json({ ...serializeRule(rule), changed });
  } catch (err) {
    return fail(c, err);
  }
});

adminRuleRoutes.post('/:id/retire', (c) => {
  try {
    const { rule, changed } = retireRule(getDb(), c.req.param('id'), actorOf(c));
    return c.json({ ...serializeRule(rule), changed });
  } catch (err) {
    return fail(c, err);
  }
});

adminRuleRoutes.post('/:id/reactivate', (c) => {
  try {
    const { rule, changed } = reactivateRule(getDb(), c.req.param('id'), actorOf(c));
    return c.json({ ...serializeRule(rule), changed });
  } catch (err) {
    return fail(c, err);
  }
});

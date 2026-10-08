import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { feedbackSchema } from '@nomus/shared';
import { submitFeedback } from '../../feedback/collector.js';
import { safeJson } from '../utils.js';

export const feedbackRoutes = new Hono<AppEnv>();

feedbackRoutes.use('*', requireSessionOrApiKey('evaluate'));
feedbackRoutes.use('*', rateLimit());

feedbackRoutes.post('/', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = feedbackSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  }

  const orgId = c.get('orgId')!;
  const result = submitFeedback(
    orgId,
    parsed.data.ruleId,
    parsed.data.feedbackType,
    parsed.data.description,
  );

  if (!result) {
    return c.json({ error: 'Policy rule not found' }, 404);
  }

  return c.json({ id: result.id, message: 'Feedback recorded' }, 201);
});

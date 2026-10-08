import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { requireSession } from '../middleware/auth.js';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';

export const modusProxyRoutes = new Hono<AppEnv>();

modusProxyRoutes.use('*', requireSession('platform_admin'));

// Proxy all requests to Modus API
modusProxyRoutes.all('/*', async (c) => {
  const config = env();
  const modusUrl = config.NOMUS_MODUS_API_URL;
  const modusKey = config.NOMUS_MODUS_API_KEY;

  if (!modusUrl) {
    return c.json({ error: 'Modus integration not configured' }, 503);
  }

  // Strip /api/v1/modus prefix to get the Modus path
  const path = c.req.path.replace('/api/v1/modus', '');

  // Prevent path traversal attacks
  if (path.includes('..') || !path.startsWith('/')) {
    return c.json({ error: 'Invalid path' }, 400);
  }

  const targetUrl = `${modusUrl}${path}`;

  try {
    // Modus speaks JSON exclusively. Don't forward arbitrary client
    // Content-Types — they confuse Modus's parser.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (modusKey) {
      headers['Authorization'] = `Bearer ${modusKey}`;
    }

    const response = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.text(),
      signal: AbortSignal.timeout(15000),
    });

    const body = await response.text();

    return new Response(body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
      },
    });
  } catch (err) {
    logger.error({ err, targetUrl }, 'Modus proxy error');
    return c.json({ error: 'Failed to reach Modus service' }, 502);
  }
});

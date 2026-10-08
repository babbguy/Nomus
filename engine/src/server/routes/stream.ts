import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppEnv } from '../app.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { registerClient, removeClient } from '../../sse/manager.js';
import { getEventsSince } from '../../sse/events.js';
import { env } from '../../config/env.js';

export const streamRoutes = new Hono<AppEnv>();

streamRoutes.use('*', requireSessionOrApiKey('stream'));
streamRoutes.use('*', rateLimit());

/**
 * GET /api/v1/stream
 * Server-Sent Events endpoint for real-time policy updates.
 * Supports jurisdiction filtering and reconnection via Last-Event-ID.
 */
streamRoutes.get('/', (c) => {
  const jurisdictions = c.req.query('jurisdictions')?.split(',').filter(Boolean) || [];
  const lastEventId = c.req.header('Last-Event-ID');
  const orgId = c.get('orgId')!;

  return streamSSE(c, async (stream) => {
    let clientId: string | null = null;

    try {
      // Replay missed events on reconnect
      if (lastEventId) {
        const lastSequence = parseInt(lastEventId, 10);
        if (!isNaN(lastSequence)) {
          const missedEvents = getEventsSince(lastSequence);
          for (const event of missedEvents) {
            await stream.writeSSE({
              id: String(event.sequence),
              event: event.eventType,
              data: event.payload,
            });
          }
        }
      }

      // Register this client for live events
      // Bridge: SSE manager calls controller.enqueue(Uint8Array), we forward to stream.write()
      const decoder = new TextDecoder();
      const controller = new Proxy({} as ReadableStreamDefaultController, {
        get(_target, prop) {
          if (prop === 'enqueue') {
            return (chunk: Uint8Array) => {
              stream.write(decoder.decode(chunk));
            };
          }
          return undefined;
        },
      });

      // Per-org concurrent connection cap (NOMUS_MAX_SSE_CONNECTIONS_PER_ORG).
      const maxConnections = c.get('maxSseConnections') ?? env().NOMUS_MAX_SSE_CONNECTIONS_PER_ORG;
      clientId = registerClient(orgId, jurisdictions, controller, maxConnections);

      if (!clientId) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            error: 'Connection limit reached for your organization',
            current_limit: maxConnections,
            message: `This organization allows up to ${maxConnections} concurrent SSE connections.`,
          }),
        });
        return;
      }

      // Send initial connected event
      await stream.writeSSE({
        event: 'connected',
        data: JSON.stringify({
          clientId,
          jurisdictions,
          timestamp: new Date().toISOString(),
        }),
      });

      // Keep connection alive — the heartbeat is handled by the scheduler
      // We just need to keep this stream open
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 30000));
        // Check if stream is still writable
        try {
          await stream.write(`: keepalive\n\n`);
        } catch {
          break;
        }
      }
    } finally {
      if (clientId) removeClient(clientId);
    }
  });
});

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppEnv } from '../app.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { registerClient, removeClient } from '../../sse/manager.js';
import { getEventsSince } from '../../sse/events.js';
import { env } from '../../config/env.js';

export const streamRoutes = new Hono<AppEnv>();

/** The jurisdiction a stored policy event's JSON payload is about ('' if unknown). */
export function eventJurisdiction(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { jurisdiction?: unknown };
    return typeof parsed.jurisdiction === 'string' ? parsed.jurisdiction : '';
  } catch {
    return '';
  }
}

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
            // Same jurisdiction filter as live events (sse/manager.ts): a
            // reconnecting ?jurisdictions=US-CA subscriber was replayed
            // every jurisdiction's missed events.
            if (jurisdictions.length > 0 && !jurisdictions.includes(eventJurisdiction(event.payload))) {
              continue;
            }
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

      // Deregister as soon as the client disconnects (not at the next keepalive).
      const registeredId = clientId;
      stream.onAbort(() => removeClient(registeredId));

      // Send initial connected event
      await stream.writeSSE({
        event: 'connected',
        data: JSON.stringify({
          clientId,
          jurisdictions,
          timestamp: new Date().toISOString(),
        }),
      });

      // Keep the connection open until the client goes away. Writing to a
      // closed stream does not throw, so the old "break when the keepalive
      // write fails" loop never ended: every closed tab stayed registered,
      // counted as a connected client and against the per-org connection
      // cap. The stream's abort signal ends it instead.
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(30000);
        if (stream.aborted || stream.closed) break;
        await stream.write(`: keepalive\n\n`);
      }
    } finally {
      if (clientId) removeClient(clientId);
    }
  });
});

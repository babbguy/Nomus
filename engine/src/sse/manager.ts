import { randomUUID } from 'node:crypto';
import type { BroadcastEvent } from '@nomus/shared';
import { logger } from '../logger.js';

interface SSEClient {
  id: string;
  orgId: string;
  jurisdictions: string[];
  controller: ReadableStreamDefaultController;
  connectedAt: string;
}

const clients = new Map<string, SSEClient>();

/**
 * Register a new SSE client connection.
 * Returns null if the org has exceeded its connection limit.
 */
export function registerClient(
  orgId: string,
  jurisdictions: string[],
  controller: ReadableStreamDefaultController,
  maxConnections: number = 10,
): string | null {
  // Enforce per-org connection limit to prevent DoS
  let orgCount = 0;
  for (const client of clients.values()) {
    if (client.orgId === orgId) orgCount++;
  }
  if (orgCount >= maxConnections) {
    logger.warn({ orgId, current: orgCount, max: maxConnections }, 'SSE connection limit reached');
    return null;
  }

  // Global hard cap (VPS protection)
  if (clients.size >= 500) {
    logger.warn({ total: clients.size }, 'SSE global connection limit reached');
    return null;
  }

  const clientId = randomUUID();
  clients.set(clientId, {
    id: clientId,
    orgId,
    jurisdictions,
    controller,
    connectedAt: new Date().toISOString(),
  });

  logger.info({ clientId, orgId, jurisdictions }, 'SSE client connected');
  return clientId;
}

/**
 * Remove a disconnected client.
 */
export function removeClient(clientId: string): void {
  const client = clients.get(clientId);
  if (client) {
    clients.delete(clientId);
    logger.info({ clientId, orgId: client.orgId }, 'SSE client disconnected');
  }
}

/**
 * Broadcast a policy event to all subscribed clients.
 */
export function broadcastEvent(event: BroadcastEvent): void {
  // Only stored policy events carry an SSE id (their sequence number): the id
  // becomes the client's Last-Event-ID, which the stream route replays from.
  // Ephemeral events (progress, health, ...) must not move that cursor.
  const idLine = event.id !== undefined ? `id: ${event.id}\n` : '';
  const payload = `${idLine}event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  const encoder = new TextEncoder();
  const chunk = encoder.encode(payload);

  for (const [clientId, client] of clients) {
    // Filter by jurisdiction subscription
    if (client.jurisdictions.length > 0 && !client.jurisdictions.includes(event.jurisdiction)) {
      continue;
    }

    try {
      client.controller.enqueue(chunk);
    } catch {
      // Client disconnected — clean up
      removeClient(clientId);
    }
  }
}

/**
 * Send heartbeat to all connected clients.
 */
export function sendHeartbeat(): void {
  const payload = `: heartbeat ${new Date().toISOString()}\n\n`;
  const encoder = new TextEncoder();
  const chunk = encoder.encode(payload);

  for (const [clientId, client] of clients) {
    try {
      client.controller.enqueue(chunk);
    } catch {
      removeClient(clientId);
    }
  }
}

/**
 * Get count of currently connected clients.
 */
export function getClientCount(): number {
  return clients.size;
}

/**
 * Get details of all connected clients (for dashboard).
 */
export function getConnectedClients() {
  return Array.from(clients.values()).map((c) => ({
    id: c.id,
    orgId: c.orgId,
    jurisdictions: c.jurisdictions,
    connectedAt: c.connectedAt,
  }));
}

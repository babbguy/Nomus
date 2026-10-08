/**
 * Test harness: connect an MCP client to the Nomus server over an
 * in-memory transport pair (real protocol, no child processes).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildNomusMcpServer } from '../src/server.js';
import type { NomusMcpConfig } from '../src/config.js';

export interface Harness {
  client: Client;
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export async function connectHarness(config: NomusMcpConfig): Promise<Harness> {
  const server = buildNomusMcpServer(config);
  const client = new Client({ name: 'nomus-mcp-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    async callTool(name, args = {}) {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** Parse the JSON payload out of a successful tool result. */
export function payloadOf(result: CallToolResult): Record<string, unknown> {
  if (result.isError) {
    throw new Error(`Expected success result, got error: ${textOf(result)}`);
  }
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

/** First text content block of a tool result. */
export function textOf(result: CallToolResult): string {
  const block = (result.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text');
  if (!block?.text) throw new Error('Tool result has no text content');
  return block.text;
}

#!/usr/bin/env node
/**
 * nomus-mcp — stdio entry point.
 *
 * Spawned by MCP clients (`claude mcp add`, VS Code, Cursor, …).
 * stdout carries the MCP protocol; all diagnostics go to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, configWarnings, ConfigError } from './config.js';
import { buildNomusMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  for (const warning of configWarnings(config)) {
    console.error(`[nomus-mcp] warning: ${warning}`);
  }

  const server = buildNomusMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[nomus-mcp] ${SERVER_NAME} v${SERVER_VERSION} connected (engine: ${config.apiUrl})`,
  );
}

main().catch((err) => {
  console.error(`[nomus-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});

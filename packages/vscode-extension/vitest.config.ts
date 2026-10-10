import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: [
      // The scanner is tested from its source, never a stale build (as the engine does).
      { find: /^@nomus\/scanner\/corporate$/, replacement: resolve(__dirname, '../scanner/src/corporate/index.ts') },
      { find: /^@nomus\/scanner$/, replacement: resolve(__dirname, '../scanner/src/scan.ts') },
    ],
  },
  test: {
    environment: 'node',
    alias: {
      // Mock vscode module — it's only available inside VS Code runtime
      vscode: resolve(__dirname, 'tests/__mocks__/vscode.ts'),
    },
  },
});

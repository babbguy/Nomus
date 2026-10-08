import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    alias: {
      // Mock vscode module — it's only available inside VS Code runtime
      vscode: resolve(__dirname, 'tests/__mocks__/vscode.ts'),
    },
  },
});

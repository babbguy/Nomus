import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@nomus/shared': resolve(__dirname, '../packages/shared/src/index.ts'),
      '@nomus/chain': resolve(__dirname, '../packages/chain/src/index.ts'),
      // The corporate library is tested against its source, never a stale build.
      '@nomus/scanner/corporate': resolve(__dirname, '../packages/scanner/src/corporate/index.ts'),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./tests/env-setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});

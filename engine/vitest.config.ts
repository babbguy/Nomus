import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@nomus/shared': resolve(import.meta.dirname, '../packages/shared/src/index.ts'),
      '@nomus/chain': resolve(import.meta.dirname, '../packages/chain/src/index.ts'),
      // The corporate library is tested against its source, never a stale build.
      '@nomus/scanner/corporate': resolve(import.meta.dirname, '../packages/scanner/src/corporate/index.ts'),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./tests/env-setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@nomus/shared': resolve(import.meta.dirname, '../packages/shared/src/index.ts'),
      '@nomus/chain': resolve(import.meta.dirname, '../packages/chain/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./tests/env-setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});

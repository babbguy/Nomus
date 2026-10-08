import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@nomus/shared': resolve(__dirname, '../packages/shared/src/index.ts'),
      '@nomus/chain': resolve(__dirname, '../packages/chain/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./tests/env-setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@digitalcanopy/syndication-core': resolve(rootDir, 'packages/syndication-core/src/index.ts'),
    },
  },
  test: {
    include: ['tests/integration/**/*.integration.test.ts'],
    exclude: ['tests/unit/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    globals: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup-home.ts'],
    include: ['test/e2e/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
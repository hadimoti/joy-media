import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['../../tooling/testing/live-provider-guard.ts'],
    include: ['src/**/*.test.ts'],
  },
});

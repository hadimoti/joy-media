import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages,tooling}/**/src/**/*.test.ts'],
    environment: 'node',
  },
});

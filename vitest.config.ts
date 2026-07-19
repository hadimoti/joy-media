import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Resolve workspace packages to source so tests never require a prior build.
    alias: {
      '@joy-media/project-schema': pkg('./packages/project-schema/src/index.ts'),
      '@joy-media/evaluator': pkg('./packages/evaluator/src/index.ts'),
    },
  },
  test: {
    include: ['{apps,packages,tooling}/**/src/**/*.test.ts'],
    environment: 'node',
  },
});

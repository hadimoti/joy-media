import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Resolve workspace packages to source so tests never require a prior build.
    alias: {
      '@joy-media/project-schema': pkg('./packages/project-schema/src/index.ts'),
      '@joy-media/evaluator': pkg('./packages/evaluator/src/index.ts'),
      '@joy-media/commands': pkg('./packages/commands/src/index.ts'),
      '@joy-media/test-fixtures': pkg('./packages/test-fixtures/src/index.ts'),
      '@joy-media/render-ir': pkg('./packages/render-ir/src/index.ts'),
      '@joy-media/renderer-pixi': pkg('./packages/renderer-pixi/src/index.ts'),
      '@joy-media/renderer-headless': pkg('./packages/renderer-headless/src/index.ts'),
      '@joy-media/html-scene-runtime': pkg('./packages/html-scene-runtime/src/index.ts'),
      '@joy-media/media-core': pkg('./packages/media-core/src/index.ts'),
      '@joy-media/audio-core': pkg('./packages/audio-core/src/index.ts'),
      '@joy-media/project-persistence': pkg('./packages/project-persistence/src/index.ts'),
    },
  },
  test: {
    include: ['{apps,packages,tooling}/**/src/**/*.test.ts'],
    environment: 'node',
  },
});

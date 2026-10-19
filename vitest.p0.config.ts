import { configDefaults, defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

export default defineConfig({
  resolve: baseConfig.resolve,
  test: {
    ...baseConfig.test,
    include: [
      'packages/html-scene-runtime/src/**/*.e2e.test.ts',
      'apps/editor-web/src/p0-desktop-handoff.test.ts',
      'apps/cli/src/commands/p0-design.e2e.test.ts',
      'apps/cli/src/**/*title*.test.ts',
      'apps/cli/src/commands/render-*.test.ts',
    ],
    exclude: [...configDefaults.exclude],
    passWithNoTests: false,
  },
});

import { configDefaults, defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

export default defineConfig({
  resolve: baseConfig.resolve,
  test: {
    ...baseConfig.test,
    // The default suite declares `projects` on this branch. The spread above would hand them to this include list, so Vitest
    // would run the whole default suite and none of the P0 files. Clear them, as vitest.p0-v3.config.ts does. main's default
    // suite declares none, so this line changes nothing there.
    projects: undefined,
    // One worker: the P0 files start Chromium and enforce per-frame capture budgets. Concurrent
    // cold starts on a wide host exceeded those budgets. This matches the two-processor
    // configuration the P0 lane was verified under.
    maxWorkers: 1,
    include: [
      'tooling/golden-render/src/first-party-scenes.test.ts',
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

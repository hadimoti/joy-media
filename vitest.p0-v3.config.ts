import { configDefaults, defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

// The release-candidate-v3 P0 lanes (plan section 3.4). vitest.p0.config.ts spreads the default suite's `test` options, including any
// `projects`, and Vitest then runs those projects instead of this include list. Measured on the development branch before the fix,
// vitest.p0.config.ts collected 6,865 entries of the default suite in 738 files and none of the P0 include list. This config keeps the
// P0 include list and clears the inherited projects. vitest.p0.config.ts clears them the same way, so v2 and v3 run the same P0 files.
export default defineConfig({
  resolve: baseConfig.resolve,
  test: {
    ...baseConfig.test,
    projects: undefined,
    // One worker: the P0 files start Chromium and enforce per-frame capture budgets.
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

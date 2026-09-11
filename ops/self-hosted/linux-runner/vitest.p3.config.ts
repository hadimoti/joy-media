import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'ops/self-hosted/linux-runner/p3-case-registry.test.mjs',
      'ops/self-hosted/linux-runner/p3-execution-budget.test.mjs',
      'ops/self-hosted/linux-runner/p3-case-isolation.test.mjs',
      'ops/self-hosted/linux-runner/p3-media-assertions.test.mjs',
      'ops/self-hosted/linux-runner/p3-lane-mode.test.mjs',
      'ops/self-hosted/linux-runner/p3-case-evidence.test.mjs',
      'ops/self-hosted/linux-runner/retain-evidence-paths.test.mjs',
      'tests/e2e/helpers/p3-export-observer.test.mjs',
    ],
    environment: 'node',
  },
});

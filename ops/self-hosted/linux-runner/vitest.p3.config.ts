import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'ops/self-hosted/linux-runner/p3-case-registry.test.mjs',
      'ops/self-hosted/linux-runner/p3-execution-budget.test.mjs',
      'ops/self-hosted/linux-runner/p3-case-isolation.test.mjs',
      'ops/self-hosted/linux-runner/p3-media-assertions.test.mjs',
      'ops/self-hosted/linux-runner/p3-lane-mode.test.mjs',
      'tests/e2e/helpers/p3-export-observer.test.mjs',
    ],
    environment: 'node',
  },
});

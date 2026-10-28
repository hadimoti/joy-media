import { defineConfig, devices } from '@playwright/test';

// The desktop-mode specs run the editor without the remote control plane (PLAN-v4 §11 P1). The
// desktop bridge is stubbed in the page (tests/desktop/support/desktop-bridge.ts), so only the
// editor dev server is started here.
const desktopWebPort = process.env.JOY_MEDIA_DESKTOP_E2E_PORT ?? '4175';
const desktopBaseUrl = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${desktopWebPort}`;

export default defineConfig({
  testDir: './tests/desktop',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line']] : 'list',
  outputDir: process.env.PLAYWRIGHT_TEST_RESULTS_DIR ?? 'test-results/playwright-desktop',
  use: {
    baseURL: desktopBaseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
    },
  ],
  webServer:
    process.env.PLAYWRIGHT_BASE_URL === undefined
      ? {
          command: `pnpm --filter @joy-media/editor-web dev --host 127.0.0.1 --port ${desktopWebPort} --strictPort`,
          url: desktopBaseUrl,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        }
      : undefined,
});

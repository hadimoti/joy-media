import { defineConfig, devices } from '@playwright/test';

const e2eApiPort = process.env.JOY_MEDIA_E2E_API_PORT ?? '4174';
const e2eWebPort = process.env.JOY_MEDIA_E2E_WEB_PORT ?? '4173';
const e2eApiUrl = process.env.JOY_MEDIA_E2E_API_URL ?? `http://127.0.0.1:${e2eApiPort}`;
const e2eBaseUrl = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${e2eWebPort}`;
const playwrightReportDirectory = process.env.PLAYWRIGHT_HTML_REPORT ?? 'playwright-report';
const playwrightOutputDirectory =
  process.env.PLAYWRIGHT_TEST_RESULTS_DIR ?? 'test-results/playwright';

const systemChromeUse =
  process.env.PLAYWRIGHT_USE_SYSTEM_CHROME?.trim() === '1'
    ? { channel: 'chrome' as const }
    : {};

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  // The audit uses one owner identity and a shared in-memory control plane;
  // three desktop workers keep its project cleanup isolated while also avoiding
  // MediaRecorder saturation on high-core local machines. CI may override this
  // when it provides isolated browser/API resources.
  workers:
    process.env.PLAYWRIGHT_WORKERS === undefined ? 3 : Number(process.env.PLAYWRIGHT_WORKERS),
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: playwrightReportDirectory }]]
    : 'list',
  outputDir: playwrightOutputDirectory,
  use: {
    baseURL: e2eBaseUrl,
    ...systemChromeUse,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'desktop-primary',
      use: { ...devices['Desktop Chrome'], ...systemChromeUse, viewport: { width: 1639, height: 1066 } },
    },
    {
      name: 'desktop-compact',
      use: { ...devices['Desktop Chrome'], ...systemChromeUse, viewport: { width: 1366, height: 768 } },
    },
    {
      name: 'desktop-minimum',
      use: { ...devices['Desktop Chrome'], ...systemChromeUse, viewport: { width: 1024, height: 768 } },
    },
    {
      name: 'desktop-1280',
      use: { ...devices['Desktop Chrome'], ...systemChromeUse, viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'desktop-1440',
      use: { ...devices['Desktop Chrome'], ...systemChromeUse, viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'desktop-1581',
      use: { ...devices['Desktop Chrome'], ...systemChromeUse, viewport: { width: 1581, height: 1066 } },
    },
    {
      name: 'desktop-1920',
      use: { ...devices['Desktop Chrome'], ...systemChromeUse, viewport: { width: 1920, height: 1080 } },
    },
  ],
  webServer:
    process.env.PLAYWRIGHT_BASE_URL === undefined
      ? [
          {
            command: 'pnpm --filter @joy-media/api exec tsx ../../tooling/e2e-server.ts',
            url: `${e2eApiUrl}/health`,
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
          {
            command: `pnpm --filter @joy-media/editor-web dev --host 127.0.0.1 --port ${e2eWebPort}`,
            url: e2eBaseUrl,
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
        ]
      : undefined,
});

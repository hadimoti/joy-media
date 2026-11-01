import { defineConfig, devices } from '@playwright/test';

// The landing site (apps/site) is static. These checks run against its Cloudflare Pages preview:
// `wrangler pages dev dist` serves the built output, including _headers and the 404.html fallback.
const sitePort = process.env.JOY_MEDIA_SITE_PORT ?? '8788';
const siteBaseUrl = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${sitePort}`;

export default defineConfig({
  testDir: './tests/site',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line']] : 'list',
  outputDir: process.env.PLAYWRIGHT_TEST_RESULTS_DIR ?? 'test-results/playwright-site',
  use: {
    baseURL: siteBaseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'site-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer:
    process.env.PLAYWRIGHT_BASE_URL === undefined
      ? {
          command: `pnpm --filter @joy-media/site build && pnpm --filter @joy-media/site exec wrangler pages dev dist --ip 127.0.0.1 --port ${sitePort}`,
          url: siteBaseUrl,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          env: { WRANGLER_SEND_METRICS: 'false' },
        }
      : undefined,
});

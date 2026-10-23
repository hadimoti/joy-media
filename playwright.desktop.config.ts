import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const apiPort = process.env.JOY_MEDIA_E2E_API_PORT ?? '4174';
const apiUrl = `http://127.0.0.1:${apiPort}`;
// The API server records every request it serves here. This config names the file once per Playwright
// run and exports it, so the server, the workers and the packaged jobs-panel spec read the same file, and
// two runs on one host never share it.
const requestLogPath =
  process.env.JOY_MEDIA_E2E_REQUEST_LOG ??
  join(tmpdir(), `joy-media-desktop-api-requests-${process.pid}.jsonl`);
process.env.JOY_MEDIA_E2E_REQUEST_LOG = requestLogPath;

export default defineConfig({
  testDir: './tests/desktop',
  testMatch: '**/*.spec.ts',
  timeout: 360_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/desktop-acceptance',
  webServer: {
    command: `pnpm --filter @joy-media/api exec tsx ../../tooling/e2e-server.ts`,
    url: `${apiUrl}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { JOY_MEDIA_E2E_API_PORT: apiPort, JOY_MEDIA_E2E_REQUEST_LOG: requestLogPath },
  },
});

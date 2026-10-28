import { expect, test } from '@playwright/test';
import { installDesktopBridge } from './support/desktop-bridge.js';
import { openFirstProject, openJoyCodeSettings } from './support/editor.js';

// The v1.1.0 desktop build is local-only (PLAN-v4 §4a, §11 P1): the agent settings offer OpenRouter
// and custom endpoints, and have no sign-in, plan, update, Kilo, joy-hosted or Dual-Brain controls.
const REMOVED_LABELS = [
  'Kilo',
  'joy-hosted',
  'Joy-hosted',
  'Dual-Brain',
  'Dual Brain',
  'Connect JOY Account',
  'Sign in',
  'Sign out',
  'Subscription',
  'Premium',
  'Check for updates',
];

const REMOTE_HOST_PATTERN = /joyst\.ir|joyteam\.ir|\/v1\//;

test('the agent settings offer OpenRouter and custom endpoints, and nothing removed in P1', async ({
  page,
}) => {
  await installDesktopBridge(page);
  await openFirstProject(page);
  const dialog = await openJoyCodeSettings(page);
  const text = await dialog.innerText();

  expect(text).toContain('AI Models & APIs');
  expect(text).toContain('OpenRouter (BYOK)');
  expect(text).toContain('Custom S3 / OpenAI Compatible');
  for (const label of REMOVED_LABELS) {
    expect(text, `the settings dialog must not offer "${label}"`).not.toContain(label);
  }
});

test('opening the editor and the settings makes no request to a remote JOY service', async ({
  page,
}) => {
  const remoteRequests: string[] = [];
  page.on('request', (request) => {
    if (REMOTE_HOST_PATTERN.test(request.url())) remoteRequests.push(request.url());
  });
  await installDesktopBridge(page);
  await openFirstProject(page);
  await openJoyCodeSettings(page);
  await page.waitForLoadState('networkidle');
  expect(remoteRequests).toEqual([]);
});

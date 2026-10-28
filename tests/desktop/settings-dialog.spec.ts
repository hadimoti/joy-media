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

test("opening the editor and the settings makes no request outside the editor's origin", async ({
  page,
}) => {
  const baseURL = test.info().project.use.baseURL;
  if (baseURL === undefined) throw new Error('the desktop Playwright project has no baseURL');
  const editorOrigin = new URL(baseURL).origin;
  const foreignRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    // Inline data and blob resources never leave the page.
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (url.origin !== editorOrigin) foreignRequests.push(request.url());
  });
  await installDesktopBridge(page);
  await openFirstProject(page);
  await openJoyCodeSettings(page);
  await page.waitForLoadState('networkidle');
  expect(foreignRequests).toEqual([]);
});

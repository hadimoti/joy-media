import { expect, test } from '@playwright/test';
import { desktopBridgeCalls, installDesktopBridge } from './support/desktop-bridge.js';
import { openFirstProject, openJoyCodeSettings } from './support/editor.js';

// A saved profile for a provider the local build retired (PLAN-v4 §9a) is shown disabled. "Later"
// keeps it: the profile stays listed, it is not deleted, and nothing connects through it.
const LEGACY_PROFILE = {
  id: 'legacy-kilo-1',
  name: 'Kilo Gateway',
  provider: 'kilo',
  baseUrl: 'https://api.kilo.ai/v1',
  modelId: 'minimax/minimax-m3',
  cachedModels: ['minimax/minimax-m3'],
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
  state: 'disabled-legacy',
} as const;

const ACTIVE_PROFILE = {
  id: 'openrouter-active-1',
  name: 'OpenRouter Primary',
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  modelId: 'openrouter/auto',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
  state: 'active',
} as const;

test('a legacy profile is shown disabled, with a Later action that keeps it', async ({ page }) => {
  await installDesktopBridge(page, { profiles: [LEGACY_PROFILE, ACTIVE_PROFILE] });
  await openFirstProject(page);
  const dialog = await openJoyCodeSettings(page);

  const legacyRow = dialog.locator('[data-profile-state="disabled-legacy"]');
  await expect(legacyRow).toHaveCount(1);
  await expect(legacyRow).toContainText('Kilo Gateway');
  await expect(legacyRow).toContainText('Disabled legacy profile');
  await expect(legacyRow.getByRole('button', { name: 'Use', exact: true })).toHaveCount(0);

  const later = legacyRow.getByRole('button', { name: 'Later', exact: true });
  await expect(later).toBeEnabled();
  await later.click();

  await expect(legacyRow.getByRole('button', { name: 'Later', exact: true })).toBeDisabled();
  await expect(legacyRow).toHaveCount(1);

  const calls = await desktopBridgeCalls(page);
  expect(calls).toContainEqual({
    channel: 'desktop.provider-profile.later',
    payload: { id: 'legacy-kilo-1' },
  });
  const channels = calls.map((call) => call.channel);
  expect(channels).not.toContain('desktop.provider-profile.delete');
  expect(channels).not.toContain('desktop.provider-profile.test');
  expect(channels).not.toContain('desktop.provider-profile.fetch-models');
});

test('the active profile stays usable beside the disabled legacy one', async ({ page }) => {
  await installDesktopBridge(page, { profiles: [LEGACY_PROFILE, ACTIVE_PROFILE] });
  await openFirstProject(page);
  const dialog = await openJoyCodeSettings(page);

  const activeRow = dialog.locator('[data-profile-state="active"]');
  await expect(activeRow).toHaveCount(1);
  await expect(activeRow.getByRole('button', { name: 'Use', exact: true })).toBeEnabled();
});

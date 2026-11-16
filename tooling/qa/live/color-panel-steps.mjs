/* global document */
import { clickMenuItem } from './ui-steps.mjs';

/** Opens the Enhance hub's Color tool and the requested Color panel tab. */
export async function openColorPanel(page, tabId) {
  await clickMenuItem(page, 'View', 'Enhance');
  await page.locator('.feature-hub--enhance [data-feature-tool="color"]').first().click();
  const tab = page.locator(`.feature-hub--enhance [data-panel-tab-id="${tabId}"]`).first();
  await tab.click();
  await tab.waitFor({ state: 'visible' });
}

/** Leave the editor on its Create hub after a colour row, including failed rows. */
export async function restoreColorRowUi(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page
    .evaluate(function blurActiveElement() {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
    })
    .catch(() => {});

  const createTab = page.locator('.panel-tab[aria-label="Create"]').first();
  if (await createTab.isVisible().catch(() => false)) return;

  await clickMenuItem(page, 'View', 'Create').catch(() => {});
  if (await createTab.isVisible().catch(() => false)) return;

  const tabNames = await page
    .locator('.panel-tab:visible')
    .evaluateAll((tabs) =>
      tabs.map((tab) => tab.getAttribute('aria-label') ?? tab.getAttribute('title') ?? 'unnamed'),
    )
    .catch(() => []);
  throw new Error(
    `the Create dock tab is unavailable after the colour row; visible dock tabs: ${tabNames.join(', ') || '(none)'}`,
  );
}

import { clickMenuItem } from './ui-steps.mjs';

/** Opens the Enhance hub's Color tool and the requested Color panel tab. */
export async function openColorPanel(page, tabId) {
  await clickMenuItem(page, 'View', 'Enhance');
  await page.locator('.feature-hub--enhance [data-feature-tool="color"]').first().click();
  const tab = page.locator(`.feature-hub--enhance [data-panel-tab-id="${tabId}"]`).first();
  await tab.click();
  await tab.waitFor({ state: 'visible' });
}

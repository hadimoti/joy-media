import { expect, test } from '@playwright/test';
import {
  answerAppDialog,
  authenticate,
  importMediaFixture,
  installMediaImportBridge,
  openDisposableWorkspace,
  openPanel,
  recordEvidence,
} from './wp29-r5-harness.js';

test.describe('WP-29 R5 batch G — bulk assets and reload recovery', () => {
  test.beforeEach(async ({ page }) => {
    await installMediaImportBridge(page);
    await authenticate(page);
  });

  test('[R5 CASE-24] AI and bulk-delete actions target only selected media', async ({
    page,
  }, testInfo) => {
    await openDisposableWorkspace(page, `R5-24-${testInfo.project.name}`);
    const imageName = `wp29-case24-${testInfo.project.name}-${Date.now()}.png`;
    const untouchedImageName = `wp29-case24-untouched-${testInfo.project.name}-${Date.now()}.jpg`;
    // Different bytes give a different content-addressed library id, so deleting one image
    // cannot remove the other.
    await importMediaFixture(page, 'image.png', imageName);
    await importMediaFixture(page, 'image.jpg', untouchedImageName);
    const card = page.locator('.asset-card', { hasText: imageName }).first();
    const assetId = await card.getAttribute('data-asset-id');
    expect(assetId).toBeTruthy();
    const targetCard = page.locator(`.asset-card[data-asset-id="${assetId}"]`);
    await targetCard.getByRole('checkbox', { name: `Select ${imageName}` }).check();
    const toolbar = page.getByRole('toolbar', { name: 'Bulk asset actions' });
    await expect(toolbar).toContainText('1');
    await toolbar.getByRole('button', { name: 'Edit selected with AI' }).click();
    await expect(page.locator('.joy-code-panel')).toBeVisible();
    const attachedMedia = page.getByRole('list', { name: 'Attached media' });
    await expect(attachedMedia).toContainText(imageName);
    await expect(attachedMedia).not.toContainText(untouchedImageName);

    await openPanel(page, 'Assets');
    await targetCard.getByRole('checkbox', { name: `Select ${imageName}` }).check();
    await page
      .getByRole('toolbar', { name: 'Bulk asset actions' })
      .getByRole('button', { name: 'Delete selected assets' })
      .click();
    await answerAppDialog(page);
    await expect(page.locator(`.asset-card[data-asset-id="${assetId}"]`)).toHaveCount(0);
    await expect(page.locator('.asset-card', { hasText: untouchedImageName })).toHaveCount(1);
    await expect(page.locator('.asset-library .joy-panel-note')).toContainText(
      'Deleted 1 of 1 selected media items',
    );
    await recordEvidence(testInfo, {
      caseId: 24,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'AI attachment and confirmed bulk delete target only the selected asset.',
      actual:
        'AI attached the selected image without the unselected image, and confirmed delete removed only the selected asset.',
      fixture: 'two image.png imports',
    });
  });
});

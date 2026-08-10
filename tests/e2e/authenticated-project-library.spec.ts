import { expect, test } from '@playwright/test';

const E2E_TOKEN = 'joy-media-e2e-token';

test.describe('WP-29 authenticated project lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((token) => {
      window.localStorage.setItem('joy-media-session-token', token);
    }, E2E_TOKEN);
  });

  test('creates, renames, duplicates, trashes, restores, and purges one project', async ({
    page,
  }) => {
    const title = `WP-29 library ${Date.now()}`;
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByPlaceholder('Project name').fill(title);
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('button', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'Projects Library…' }).click();
    const originalCard = page.getByRole('button', { name: new RegExp(title) }).first();
    await expect(originalCard).toBeVisible();

    await page.getByRole('button', { name: `Project actions for ${title}` }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const renamed = `${title} renamed`;
    const dialog = page.getByRole('dialog', { name: 'Rename project' });
    await dialog.getByRole('textbox').fill(renamed);
    await dialog.getByRole('button', { name: 'Rename' }).click();
    await expect(page.getByRole('status')).toContainText('Project renamed.');
    await expect(page.getByRole('button', { name: new RegExp(renamed) }).first()).toBeVisible();

    await page.getByRole('button', { name: `Project actions for ${renamed}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    const duplicateDialog = page.getByRole('dialog', { name: 'Duplicate project' });
    await expect(duplicateDialog.getByRole('textbox')).toHaveValue(`${renamed} copy`);
    await duplicateDialog.getByRole('button', { name: 'Duplicate' }).click();
    await expect(page.getByRole('status')).toContainText('Project duplicated.');
    const duplicateTitle = `${renamed} copy`;
    await expect(
      page.getByRole('button', { name: new RegExp(duplicateTitle) }).first(),
    ).toBeVisible();

    await page.getByRole('button', { name: `Project actions for ${renamed}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
    const trashDialog = page.getByRole('dialog', { name: new RegExp(`Move “${renamed}”`) });
    await trashDialog.getByRole('button', { name: 'Move to Trash' }).click();
    await expect(page.getByRole('status')).toContainText('Project moved to Trash.');
    await expect(page.getByRole('button', { name: new RegExp(`^${renamed}$`) })).toHaveCount(0);

    await page.getByRole('button', { name: /Trash/ }).click();
    await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
    await page.getByRole('button', { name: `Project actions for ${renamed}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Restore' }).click();
    await expect(page.getByText('Project restored.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Trash/ }).click();
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await page.getByRole('button', { name: `Project actions for ${renamed}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
    await page.getByRole('button', { name: 'Move to Trash' }).click();
    await page.getByRole('button', { name: /Trash/ }).click();
    await page.getByRole('button', { name: `Project actions for ${renamed}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete permanently' }).click();
    const purgeDialog = page.getByRole('dialog', { name: new RegExp(`Delete “${renamed}”`) });
    await purgeDialog.getByRole('textbox').fill(renamed);
    await purgeDialog.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page.getByText('Project permanently deleted.', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: `Project actions for ${renamed}`, exact: true }),
    ).toHaveCount(0);

    await page.getByRole('button', { name: /Trash/ }).click();
    await page
      .getByRole('button', { name: `Project actions for ${duplicateTitle}`, exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
    await page.getByRole('button', { name: 'Move to Trash' }).click();
    await page.getByRole('button', { name: /Trash/ }).click();
    await page
      .getByRole('button', { name: `Project actions for ${duplicateTitle}`, exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Delete permanently' }).click();
    const duplicatePurge = page.getByRole('dialog', {
      name: new RegExp(`Delete “${duplicateTitle}”`),
    });
    await duplicatePurge.getByRole('textbox').fill(duplicateTitle);
    await duplicatePurge.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page.getByText('Project permanently deleted.', { exact: true })).toBeVisible();
  });
});

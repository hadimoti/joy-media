/* global window, document, HTMLInputElement, HTMLTextAreaElement */
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export async function newProject(page, title) {
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByPlaceholder(/project name/i).fill(title);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByRole('button', { name: 'File', exact: true }).waitFor({ state: 'visible' });
}

export async function importThroughLeftPanel(page, filePath) {
  const importButton = page.getByRole('button', { name: 'Import media', exact: true }).first();
  if (!(await importButton.isVisible().catch(() => false))) {
    await openMenu(page, 'View');
    await page.getByRole('menuitem', { name: 'Media', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Import media', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Import media', exact: true });
  await dialog
    .locator('input[type="file"][aria-label="Media file"]')
    .setInputFiles(resolve(filePath));
  const filename = resolve(filePath).split(/[\\/]/u).at(-1);
  await dialog.getByText(filename, { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Confirm import', exact: true }).click();
  await page.locator('.asset-card', { hasText: filename }).first().waitFor();
}

/**
 * Adds an already-imported media file to the timeline through its asset card
 * (the `Add <file name> to timeline` button; its displayName is the file name).
 * Play stays disabled until a clip exists, so cases that need playback call this
 * after `importThroughLeftPanel`.
 */
export async function addToTimelineThroughLeftPanel(page, filePath) {
  const filename = resolve(filePath).split(/[\\/]/u).at(-1);
  await page.locator('.asset-card', { hasText: filename }).first().hover();
  await page
    .getByRole('button', { name: `Add ${filename} to timeline`, exact: true })
    .first()
    .click();
  await page.locator('.timeline-clip[data-clip-id]').first().waitFor({ state: 'attached' });
}

export async function setScratchLibrary(page, libraryDir) {
  await openMenu(page, 'Edit');
  await page.getByRole('menuitem', { name: /Asset Library Folder/u }).click();
  const dialog = page.getByRole('dialog');
  const pathInput = dialog.getByRole('textbox').first();
  await pathInput.fill(resolve(libraryDir));
  await dialog.getByRole('button', { name: 'Apply Path', exact: true }).click();
  const settings = await page.evaluate(() =>
    window.joyDesktop?.invoke?.('desktop.asset-library.get-settings', {}),
  );
  const serialized = JSON.stringify(settings ?? '').toLowerCase();
  if (!serialized.includes(resolve(libraryDir).toLowerCase())) {
    throw new Error('the app did not confirm the scratch asset library path');
  }
}

export async function openMenu(page, name) {
  await page.getByRole('button', { name, exact: true }).first().click();
}

export async function screenshot(page, path) {
  const textEntryFocused = await page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
  });
  if (textEntryFocused) return null;
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
  return path;
}

export async function readVisibleText(page) {
  return page.locator('body').innerText();
}

/* global window, document, HTMLInputElement, HTMLTextAreaElement */
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export async function newProject(page, title) {
  // Inside an editor the Projects page is one menu click away (File > Projects Library).
  const newButton = page.getByRole('button', { name: 'New project', exact: true });
  if (!(await newButton.isVisible().catch(() => false))) {
    await openMenu(page, 'File');
    await page.getByRole('menuitem', { name: /Projects Library/u }).click();
  }
  await newButton.click();
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
  // The Projects page has no menu bar (v1.1.1): the menus exist only inside an editor. Start a scratch project first.
  const menuVisible = await page
    .getByRole('button', { name: 'Edit', exact: true })
    .first()
    .isVisible()
    .catch(() => false);
  if (!menuVisible) await newProject(page, `Scratch library setup ${Date.now().toString(36)}`);
  await openMenu(page, 'Edit');
  await page.getByRole('menuitem', { name: /Asset Library Folder/u }).click();
  const dialog = page.getByRole('dialog');
  // The dialog loads its current settings after it opens and then overwrites the path box; wait for that
  // (the inspection block appears with it) or the typed path is lost and Apply Path stays disabled.
  await dialog.getByText('Library Inspection', { exact: true }).waitFor();
  const pathInput = dialog.getByRole('textbox').first();
  const applyButton = dialog.getByRole('button', { name: 'Apply Path', exact: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await pathInput.fill(resolve(libraryDir));
    if (await applyButton.isEnabled()) break;
    await page.waitForTimeout(500);
  }
  await applyButton.click({ timeout: 10_000 });
  // Applying the path is asynchronous: ask the app until it names the scratch folder, for up to 10 seconds.
  let serialized = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const settings = await page.evaluate(() =>
      window.joyDesktop?.invoke?.('desktop.asset-library.get-settings', {}),
    );
    serialized = JSON.stringify(settings ?? '').toLowerCase();
    // JSON escapes backslashes, so compare with the escaped form too.
    const wanted = resolve(libraryDir).toLowerCase();
    if (serialized.includes(wanted) || serialized.includes(wanted.replaceAll('\\', '\\\\'))) {
      // Close the dialog so the next step finds the editor, not a modal.
      await dialog.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 10_000 });
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `the app did not confirm the scratch asset library path (it reported: ${serialized.slice(0, 200)})`,
  );
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

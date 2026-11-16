/* global window, document, HTMLInputElement, HTMLTextAreaElement */
import { dirname, resolve } from 'node:path';
import { mkdirSync, statSync } from 'node:fs';

export async function newProject(page, title) {
  // Inside an editor the Projects page is one menu click away (File > Projects Library).
  const newButton = page.getByRole('button', { name: 'New project', exact: true });
  // Wait a moment for the Projects page: a fresh launch may not have drawn the button yet.
  const onProjectsPage = await newButton.waitFor({ state: 'visible', timeout: 5_000 }).then(
    () => true,
    () => false,
  );
  if (!onProjectsPage) {
    await openMenu(page, 'File');
    await page.getByRole('menuitem', { name: /Projects Library/u }).click();
  }
  await newButton.click();
  await page.getByPlaceholder(/project name/i).fill(title);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByRole('button', { name: 'File', exact: true }).waitFor({ state: 'visible' });
}

const LARGE_FILE_BYTES = 40 * 1024 * 1024;
const MEDIA_FILE_INPUT = 'input[type="file"][aria-label="Media file"]';

/**
 * Sets the import dialog's file input to a file on this machine. Playwright refuses to send files over 50 MB
 * across the debugging link, so a big file goes by path through the DevTools protocol (DOM.setFileInputFiles),
 * which fires the change event.
 */
export async function setMediaFileInput(page, input, filePath) {
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    size = 0;
  }
  if (size <= LARGE_FILE_BYTES) {
    await input.setInputFiles(filePath);
    return;
  }
  const session = await page.context().newCDPSession(page);
  try {
    const { result } = await session.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(MEDIA_FILE_INPUT)})`,
    });
    if (!result.objectId) throw new Error('the Media file input is not on the page');
    const { node } = await session.send('DOM.describeNode', { objectId: result.objectId });
    await session.send('DOM.setFileInputFiles', {
      files: [filePath],
      backendNodeId: node.backendNodeId,
    });
  } finally {
    await session.detach().catch(() => undefined);
  }
}

export async function importThroughLeftPanel(page, filePath) {
  // The Media tab must be the open one: another hub (Enhance, remembered from an earlier run) leaves only the
  // timeline's own "Import media" button on the page, which opens the system file picker, not the dialog.
  const mediaTab = page.locator('[role="tab"][data-feature-tool="media"]').first();
  const mediaOpen =
    (await mediaTab.isVisible().catch(() => false)) &&
    (await mediaTab.getAttribute('aria-selected').catch(() => null)) === 'true';
  if (!mediaOpen) {
    const openCreate = async () => {
      await openMenu(page, 'View');
      await page.getByRole('menuitem', { name: 'Create', exact: true }).click();
    };
    await openCreate();
    const mediaVisible = () =>
      mediaTab.waitFor({ state: 'visible', timeout: 3_000 }).then(
        () => true,
        () => false,
      );
    if (!(await mediaVisible())) {
      await openCreate();
      if (!(await mediaVisible())) {
        const dockTabs = await page
          .locator('.panel-tab:visible')
          .evaluateAll((tabs) =>
            tabs.map(
              (tab) => tab.getAttribute('aria-label') ?? tab.getAttribute('title') ?? 'unnamed',
            ),
          )
          .catch(() => []);
        throw new Error(
          `the Media tab did not appear after View > Create twice; visible dock tabs: ${dockTabs.join(', ') || '(none)'}`,
        );
      }
    }
    await mediaTab.click();
  }
  await page.getByRole('button', { name: 'Import media', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Import media', exact: true });
  await setMediaFileInput(page, dialog.locator(MEDIA_FILE_INPUT), resolve(filePath));
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
  // The Projects page has no menu bar (v1.1.1): the menus exist only inside an editor. Wait until the app shows
  // one of the two (a fresh launch may not have drawn either yet), then start a scratch project if needed.
  const editButton = page.getByRole('button', { name: 'Edit', exact: true }).first();
  const newButton = page.getByRole('button', { name: 'New project', exact: true });
  const inEditor = await Promise.race([
    editButton.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true),
    newButton.waitFor({ state: 'visible', timeout: 15_000 }).then(() => false),
  ]).catch(() => false);
  if (!inEditor) await newProject(page, `Scratch library setup ${Date.now().toString(36)}`);
  await openMenu(page, 'Edit');
  await page.getByRole('menuitem', { name: /Asset Library Folder/u }).click();
  const dialog = page.getByRole('dialog');
  // The dialog loads its current settings after it opens and then overwrites the path box (the inspection block
  // appears with the first frame, before that load ends). Type, wait for the load to settle, and check the box
  // still holds our path and Apply Path is enabled; otherwise type again.
  await dialog.getByText('Library Inspection', { exact: true }).waitFor();
  const wantedPath = resolve(libraryDir);
  const pathInput = dialog.getByRole('textbox').first();
  const applyButton = dialog.getByRole('button', { name: 'Apply Path', exact: true });
  let typed = false;
  for (let attempt = 0; attempt < 6 && !typed; attempt += 1) {
    await pathInput.fill(wantedPath);
    await page.waitForTimeout(700);
    typed = (await pathInput.inputValue()) === wantedPath && (await applyButton.isEnabled());
  }
  if (!typed) throw new Error('the Asset Library dialog kept replacing the typed scratch path');
  await applyButton.click({ timeout: 10_000 });
  // Applying the path is asynchronous: ask the app until it names the scratch folder, for up to 10 seconds.
  let serialized = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const settings = await page.evaluate(() =>
      window.joyDesktop?.invoke?.('desktop.asset-library.get-settings', {}),
    );
    serialized = JSON.stringify(settings ?? '').toLowerCase();
    // JSON escapes backslashes, so compare with the escaped form too.
    const wanted = wantedPath.toLowerCase();
    if (serialized.includes(wanted) || serialized.includes(wanted.replaceAll('\\', '\\\\'))) {
      // The app saves the folder before the dialog has finished its own update: wait until Apply Path
      // is disabled again (the box and the saved folder agree), then close the dialog.
      for (let settle = 0; settle < 20 && (await applyButton.isEnabled()); settle += 1) {
        await page.waitForTimeout(250);
      }
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
  await page.screenshot({ path, fullPage: false });
  return path;
}

export async function readVisibleText(page) {
  return page.locator('body').innerText();
}

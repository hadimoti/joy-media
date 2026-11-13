/* global document, navigator */
/**
 * T-R04 driver cases (the export warns about missing media). They need a running app through the
 * T-A02 driver: call each case with the Playwright `page` of a live session on a fresh project.
 * Not wired into `run.mjs` (that file belongs to T-A02). Not run yet: the app is not launched for
 * this card, because the launch rule's `joy://` hash read was not approved in the session that
 * wrote these cases.
 *
 *   D-R04-1 Cancel: the warning lists the clip with a time code; Cancel closes it; no export starts.
 *   D-R04-2 Relink…: the warning closes and the Media panel opens.
 *   D-R04-3 Export anyway: the warning closes and the export runs to its end without a failure.
 *
 * Setup (`prepareMissingClip`): import one fixture, add it to the timeline, then empty this
 * profile's original cache (OPFS `joy-media-assets`). The scratch profile holds only that one
 * asset, so the clip's file is missing for this profile and nothing else is touched.
 */

const EXPORT_BUTTON = { name: 'Export MP4', exact: true };
const WARNING_TITLE = { name: 'Missing media in this export', exact: true };
const TIME_CODE_RANGE = /\d{2}:\d{2}:\d{2}:\d{2} - \d{2}:\d{2}:\d{2}:\d{2}/u;

/** Adds one imported asset to the timeline, then makes its original missing for this profile. */
export async function prepareMissingClip(page, displayName) {
  await page
    .getByRole('button', { name: `Add ${displayName} to timeline`, exact: true })
    .first()
    .click();
  await page.locator('.timeline-clip[data-clip-id]').first().waitFor({ state: 'visible' });
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('joy-media-assets', { create: false });
    for await (const name of directory.keys()) await directory.removeEntry(name);
  });
}

async function startExport(page) {
  await page.getByRole('button', EXPORT_BUTTON).click();
  const dialog = page.getByRole('alertdialog', WARNING_TITLE);
  await dialog.waitFor({ state: 'visible', timeout: 15_000 });
  return dialog;
}

async function exportBusy(page) {
  return page.locator('.header-export-btn[aria-busy="true"]').count();
}

export async function cancelChoice(page) {
  const dialog = await startExport(page);
  const text = await dialog.innerText();
  if (!TIME_CODE_RANGE.test(text))
    throw new Error('the warning does not list the clip with a time code');
  if (!text.includes('black and silent'))
    throw new Error('the warning does not say the parts are black and silent');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  if ((await exportBusy(page)) !== 0) throw new Error('Cancel still started an export');
  return 'warning listed the clip with its time code; Cancel closed it and no export started';
}

export async function relinkChoice(page) {
  const dialog = await startExport(page);
  await dialog.getByRole('button', { name: 'Relink…', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page
    .getByRole('button', { name: 'Import media', exact: true })
    .first()
    .waitFor({ state: 'visible' });
  return 'Relink… closed the warning and opened the Media panel';
}

export async function exportAnywayChoice(page) {
  const dialog = await startExport(page);
  await dialog.getByRole('button', { name: 'Export anyway', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  // The export may finish before it can be seen busy, so wait for it to be idle, then read the toast.
  await page.waitForFunction(
    () => document.querySelector('.header-export-btn')?.getAttribute('aria-busy') !== 'true',
    undefined,
    { timeout: 600_000 },
  );
  const toast = await page
    .locator('.export-toast')
    .innerText()
    .catch(() => '');
  const firstLine = toast.split('\n')[0] ?? '';
  if (/Export failed/u.test(toast)) throw new Error(`export ended with: ${firstLine}`);
  if ((await page.getByRole('alertdialog', WARNING_TITLE).count()) !== 0)
    throw new Error('the warning came back after Export anyway');
  return `Export anyway closed the warning and the export ran to its end (status: ${firstLine || 'no toast'})`;
}

export const EXPORT_MISSING_CASES = {
  'D-R04-1': cancelChoice,
  'D-R04-2': relinkChoice,
  'D-R04-3': exportAnywayChoice,
};

/**
 * Shared lifecycle assertions for colour driver rows. The row supplies the
 * existing wheel, curve, HSL or Look gesture plus readers backed by the live
 * driver. Keeping the readers injected lets the fake-page suite exercise the
 * ordering without starting the desktop app.
 */
function pixelDistance(left, right) {
  return Math.max(
    Math.abs(left.r - right.r),
    Math.abs(left.g - right.g),
    Math.abs(left.b - right.b),
  );
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireFunction(name, value) {
  if (typeof value !== 'function') throw new Error(`give ${name} to run this colour row`);
}

export const BUILT_IN_COLOUR_LOOKS = Object.freeze([
  { id: 'none', name: 'None' },
  { id: 'clean-contrast', name: 'Clean Contrast' },
  { id: 'soft-film', name: 'Soft Film' },
  { id: 'warm-cinema', name: 'Warm Cinema' },
  { id: 'cool-fade', name: 'Cool Fade' },
  { id: 'monochrome', name: 'Monochrome' },
]);

/**
 * Checks one colour edit on a known preview frame, through persistence, and
 * back through Undo in the same app session, then reapplies the edit before
 * `saveAndReopen`, which must return the persisted grade; an
 * optional `compareExportFrame` uses the caller's existing compare helper.
 */
export async function runColourLifecycle(
  page,
  {
    readPreviewPixel,
    readGrade,
    edit,
    saveAndReopen,
    undo,
    compareExportFrame,
    waitForPreviewPixel,
    pixel,
    pixelTolerance = 4,
  } = {},
) {
  for (const [name, value] of Object.entries({
    readPreviewPixel,
    readGrade,
    edit,
    saveAndReopen,
    undo,
  }))
    requireFunction(name, value);
  if (pixel === undefined || pixel === null) throw new Error('give the known frame pixel');

  const baselinePixel = waitForPreviewPixel
    ? await waitForPreviewPixel(page, pixel, () => true, 'stable picture pixel')
    : await readPreviewPixel(page, pixel);
  const baselineGrade = await readGrade(page);
  await edit(page);

  const changedPixel = waitForPreviewPixel
    ? await waitForPreviewPixel(
        page,
        pixel,
        (sample) => pixelDistance(baselinePixel, sample) > pixelTolerance,
        'colour edit to reach the Monitor',
      )
    : await readPreviewPixel(page, pixel);
  const editedGrade = await readGrade(page);
  if (pixelDistance(baselinePixel, changedPixel) <= pixelTolerance) {
    throw new Error(
      `the colour edit changed the grade but not the preview pixel: ${JSON.stringify(changedPixel)}`,
    );
  }
  if (sameValue(baselineGrade, editedGrade))
    throw new Error('the colour edit did not change the grade');

  await undo(page);
  const restoredPixel = waitForPreviewPixel
    ? await waitForPreviewPixel(
        page,
        pixel,
        (sample) => pixelDistance(baselinePixel, sample) <= pixelTolerance,
        'Undo to restore the baseline Monitor pixel',
      )
    : await readPreviewPixel(page, pixel);
  const restoredGrade = await readGrade(page);
  if (pixelDistance(baselinePixel, restoredPixel) > pixelTolerance) {
    throw new Error(`Undo left preview pixel ${JSON.stringify(restoredPixel)}`);
  }
  if (!sameValue(baselineGrade, restoredGrade))
    throw new Error('Undo did not restore the colour grade');

  await edit(page);
  const reappliedGrade = await readGrade(page);
  const reappliedPixel = await readPreviewPixel(page, pixel);
  if (!sameValue(editedGrade, reappliedGrade))
    throw new Error('reapplying the colour edit did not restore its grade');
  if (pixelDistance(changedPixel, reappliedPixel) > pixelTolerance)
    throw new Error('reapplying the colour edit did not restore its preview');

  const reopenedGrade = await saveAndReopen(page);
  if (!sameValue(reappliedGrade, reopenedGrade)) {
    throw new Error('the saved project did not keep the colour grade after reopen');
  }
  if (compareExportFrame !== undefined) {
    requireFunction('compareExportFrame', compareExportFrame);
    await compareExportFrame(page, pixel);
  }

  return `preview changed by ${pixelDistance(baselinePixel, changedPixel)} levels; saved grade survived reopen; Undo restored the frame`;
}

/** Applies every built-in Look through its existing button and checks its lifecycle. */
export async function applyEachBuiltInLook(page, lifecycleForLook) {
  requireFunction('lifecycleForLook(look)', lifecycleForLook);
  const results = [];
  let activePage = page;
  for (const look of BUILT_IN_COLOUR_LOOKS) {
    if (look.id === 'none') {
      await activePage
        .locator('button.look-card')
        .filter({ has: activePage.locator('.look-card-label', { hasText: look.name }) })
        .click();
      results.push({ look: look.id, message: 'selected the identity Look' });
      continue;
    }
    const deps = await lifecycleForLook(look);
    const edit = deps.edit;
    requireFunction(`edit for ${look.id}`, edit);
    deps.edit = async (target) => {
      await target
        .locator('button.look-card')
        .filter({ has: target.locator('.look-card-label', { hasText: look.name }) })
        .click();
      await edit(target);
    };
    results.push({ look: look.id, ...(await runColourLifecycle(activePage, deps)) });
    activePage = (await deps.getPage?.()) ?? activePage;
  }
  return results;
}

/**
 * T-D01 live steps. These need the running app from the T-A02 driver and are
 * intentionally not run from T-D01. For each case below, the live runner must:
 *
 * 1. Create a fresh scratch project at the listed composition size.
 * 2. Import a matching still/video fixture through the Media panel and add it
 *    to the timeline at time zero. Do not press Fit first: this checks the
 *    transform written during insertion.
 * 3. Call `verifyNewMediaFit` with the selected clip id and the runner's
 *    read-only document transform callback.
 * 4. Set the Monitor to Fit at full output resolution, capture its frame,
 *    export that same project, and run `tooling/qa/compare.mjs` at time 0.
 *    Keep each run's raw files under `C:\\jgp\\v111\\evidence\\T-D01\\`.
 *
 * Required compares (T-A10a tolerance: 1 level per channel):
 *   node tooling/qa/compare.mjs --preview <monitor.png> --export <file.mp4> --time 0 --out <case-dir>
 *
 * Call `verifyFitFillUndo` on a fresh, unanimated clip to check both Inspector
 * buttons write one undoable transform transaction. No app launch is needed
 * for this card; CC runs these steps later.
 */

const FIELDS = ['x', 'y', 'scaleX', 'scaleY'];
const INSPECTOR_FIELDS = {
  x: '#insp-x',
  y: '#insp-y',
  scaleX: '#insp-scaleX',
  scaleY: '#insp-scaleY',
};

export const MEDIA_FIT_COMPARE_CASES = Object.freeze([
  {
    id: 'C-D01-1',
    title: '16:9 media in a 9:16 composition',
    source: { width: 1920, height: 1080 },
    composition: { width: 1080, height: 1920 },
    fit: { x: 0, y: 656.25, scaleX: 0.5625, scaleY: 0.5625 },
    fill: { x: -1166.6666666666665, y: 0, scaleX: 1.7777777777777777, scaleY: 1.7777777777777777 },
  },
  {
    id: 'C-D01-2',
    title: '9:16 media in a 16:9 composition',
    source: { width: 1080, height: 1920 },
    composition: { width: 1920, height: 1080 },
    fit: { x: 656.25, y: 0, scaleX: 0.5625, scaleY: 0.5625 },
    fill: { x: 0, y: -1166.6666666666665, scaleX: 1.7777777777777777, scaleY: 1.7777777777777777 },
  },
  {
    id: 'C-D01-3',
    title: '4:3 media in a 16:9 composition',
    source: { width: 640, height: 480 },
    composition: { width: 1920, height: 1080 },
    fit: { x: 240, y: 0, scaleX: 2.25, scaleY: 2.25 },
    fill: { x: 0, y: -180, scaleX: 3, scaleY: 3 },
  },
  {
    id: 'C-D01-4',
    title: 'small 16:9 picture in a 16:9 composition',
    source: { width: 320, height: 180 },
    composition: { width: 1920, height: 1080 },
    fit: { x: 0, y: 0, scaleX: 6, scaleY: 6 },
    fill: { x: 0, y: 0, scaleX: 6, scaleY: 6 },
  },
]);

function assertTransform(actual, expected, what) {
  for (const field of FIELDS) {
    if (!Number.isFinite(actual?.[field]) || Math.abs(actual[field] - expected[field]) > 0.02)
      throw new Error(`${what}: ${field} is ${actual?.[field]}, expected ${expected[field]}`);
  }
}

async function readInspectorTransform(page) {
  const values = {};
  for (const [field, selector] of Object.entries(INSPECTOR_FIELDS)) {
    const value = await page.locator(selector).first().inputValue();
    values[field] = Number(value);
  }
  return values;
}

/** Check the default transform written when a new media clip is inserted. */
export async function verifyNewMediaFit(page, clipId, testCase, readTransform) {
  if (!MEDIA_FIT_COMPARE_CASES.some((candidate) => candidate.id === testCase?.id))
    throw new Error(`unknown media fit case ${testCase?.id}`);
  if (typeof readTransform !== 'function')
    throw new Error('give readTransform(clipId) so the case can inspect the document');
  await page.locator(`.timeline-clip[data-clip-id="${clipId}"]`).first().click();
  assertTransform(await readTransform(clipId), testCase.fit, `${testCase.id} document`);
  assertTransform(await readInspectorTransform(page), testCase.fit, `${testCase.id} Inspector`);
  return `${testCase.id}: added clip is fitted and centred`;
}

/** Check the Fit and Fill buttons and that each action takes one undo. */
export async function verifyFitFillUndo(page, clipId, testCase, readTransform) {
  if (typeof readTransform !== 'function')
    throw new Error('give readTransform(clipId) so the case can inspect the document');
  await page.locator(`.timeline-clip[data-clip-id="${clipId}"]`).first().click();
  const before = await readTransform(clipId);
  await page.getByRole('button', { name: 'Fit clip to frame', exact: true }).click();
  assertTransform(await readTransform(clipId), testCase.fit, `${testCase.id} Fit button`);
  await page.keyboard.press('Control+z');
  assertTransform(await readTransform(clipId), before, `${testCase.id} Fit undo`);
  await page.getByRole('button', { name: 'Fill frame with clip', exact: true }).click();
  assertTransform(await readTransform(clipId), testCase.fill, `${testCase.id} Fill button`);
  await page.keyboard.press('Control+z');
  assertTransform(await readTransform(clipId), before, `${testCase.id} Fill undo`);
  return `${testCase.id}: Fit and Fill each changed the four base fields with one undo`;
}

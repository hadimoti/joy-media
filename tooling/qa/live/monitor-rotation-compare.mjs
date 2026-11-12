/**
 * T-M15 compare cases (card: "add a compare test (T-A10a) for three old
 * projects"; "a rotated element draws the same in the preview and the
 * export"). They compare a Monitor frame saved at Fit with the same frame of
 * an export, through `tooling/qa/compare.mjs` (T-A10a, tolerance 1 per
 * channel). Making the two files needs the app running through the T-A02
 * driver, so this module is not run by unit tests and is not wired into
 * `run.mjs` (that file belongs to T-A02); a live runner calls it with the
 * files it captured.
 *
 *   C-M15-1..3  three projects made before T-M15 export the same frame as
 *               their Monitor shows (no rotation anywhere: the renderer must
 *               draw them exactly as before).
 *   C-M15-4     a rotated element draws the same in the Monitor and the
 *               export. BLOCKED until the document's rotation reaches the
 *               render IR (see the T-M15 report); until then it is skipped.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { compareFrames, extractExportFrame } from '../compare.mjs';

/** The cases, in the order a runner should take them. */
export const MONITOR_ROTATION_COMPARE_CASES = Object.freeze([
  {
    id: 'C-M15-1',
    title: 'old project with text and a shape: Monitor frame = export frame',
    needsRotationWiring: false,
  },
  {
    id: 'C-M15-2',
    title: 'old project with a video clip and a picture: Monitor frame = export frame',
    needsRotationWiring: false,
  },
  {
    id: 'C-M15-3',
    title: 'old project with burned-in captions: Monitor frame = export frame',
    needsRotationWiring: false,
  },
  {
    id: 'C-M15-4',
    title: 'an element rotated 30 degrees: Monitor frame = export frame',
    needsRotationWiring: true,
  },
]);

/**
 * Runs one compare case.
 * @param {{ id: string, previewPng: string, exportVideo: string, timeSeconds: number, outRoot: string, rotationWired?: boolean }} input
 *   `previewPng`: the Monitor at Fit, saved by the runner at the export's size;
 *   `exportVideo`: the exported file; `timeSeconds`: the frame to compare.
 * @returns {Promise<{ id: string, status: 'pass' | 'fail' | 'skipped', reason?: string, resultPath?: string }>}
 */
export async function runMonitorRotationCompare(input) {
  const testCase = MONITOR_ROTATION_COMPARE_CASES.find((item) => item.id === input.id);
  if (testCase === undefined) throw new Error(`unknown compare case ${input.id}`);
  if (testCase.needsRotationWiring && input.rotationWired !== true) {
    return {
      id: input.id,
      status: 'skipped',
      reason: 'the document rotation does not reach the render IR yet',
    };
  }
  const outDir = path.join(input.outRoot, input.id);
  const exportFrame = path.join(outDir, 'export-frame.png');
  await mkdir(outDir, { recursive: true });
  await extractExportFrame(input.exportVideo, input.timeSeconds, exportFrame);
  const result = await compareFrames(input.previewPng, exportFrame, outDir);
  return { id: input.id, status: result.status, resultPath: result.resultPath };
}

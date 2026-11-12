/**
 * T-M05a compare cases (card: "export frame equals preview frame after move,
 * scale, rotate"). A live runner moves, scales and rotates an element with
 * the Monitor's transform box (see `monitor-transform-steps.mjs`), saves the
 * Monitor frame at Fit at the export's size, exports, and hands both files to
 * this module, which compares them through `tooling/qa/compare.mjs` (T-A10a,
 * tolerance 1 per channel). Making the files needs the app running through
 * the T-A02 driver, so this module is not run by unit tests and is not wired
 * into `run.mjs` (that file belongs to T-A02). Not run yet.
 *
 *   C-M05-1 after a move on the Monitor: export frame = preview frame
 *   C-M05-2 after a scale (corner, Shift) on the Monitor: export frame = preview frame
 *   C-M05-3 after a rotate (Shift, 45 degrees) on the Monitor: export frame = preview frame
 *   C-M05-4 a child of a rotated, scaled parent moved on the Monitor (B4):
 *           export frame = preview frame
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { compareFrames, extractExportFrame } from '../compare.mjs';

/** The cases, in the order a runner should take them. */
export const MONITOR_TRANSFORM_COMPARE_CASES = Object.freeze([
  { id: 'C-M05-1', title: 'moved on the Monitor: Monitor frame = export frame', gesture: 'move' },
  { id: 'C-M05-2', title: 'scaled on the Monitor: Monitor frame = export frame', gesture: 'scale' },
  {
    id: 'C-M05-3',
    title: 'rotated on the Monitor: Monitor frame = export frame',
    gesture: 'rotate',
  },
  {
    id: 'C-M05-4',
    title: 'child of a rotated, scaled parent moved: Monitor frame = export frame',
    gesture: 'move',
  },
]);

/**
 * Runs one compare case.
 * @param {{ id: string, previewPng: string, exportVideo: string, timeSeconds: number, outRoot: string }} input
 *   `previewPng`: the Monitor at Fit after the gesture, saved at the export's size;
 *   `exportVideo`: the file exported after the gesture; `timeSeconds`: the frame to compare.
 * @returns {Promise<{ id: string, status: 'pass' | 'fail', resultPath?: string }>}
 */
export async function runMonitorTransformCompare(input) {
  const testCase = MONITOR_TRANSFORM_COMPARE_CASES.find((item) => item.id === input.id);
  if (testCase === undefined) throw new Error(`unknown compare case ${input.id}`);
  const outDir = path.join(input.outRoot, input.id);
  const exportFrame = path.join(outDir, 'export-frame.png');
  await mkdir(outDir, { recursive: true });
  await extractExportFrame(input.exportVideo, input.timeSeconds, exportFrame);
  const result = await compareFrames(input.previewPng, exportFrame, outDir);
  return { id: input.id, status: result.status, resultPath: result.resultPath };
}

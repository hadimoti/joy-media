/**
 * T-M05b compare cases: the export frame equals the Monitor frame after the
 * part-b gestures. Same contract as `monitor-transform-compare.mjs` (T-M05a):
 * a live runner does the gesture with the driver cases in
 * `monitor-transform-b-steps.mjs`, saves the Monitor frame at Fit at the
 * export's size, exports, and hands both files here; the frames are compared
 * through `tooling/qa/compare.mjs` (T-A10a, tolerance 1 per channel). Needs
 * the app running, so it is not run by unit tests and not wired into
 * `run.mjs`. Written, not run.
 *
 *   C-M05-5 anchor moved to a corner, then rotated about it: export = Monitor
 *   C-M05-6 two elements scaled as a group: export = Monitor
 *   C-M05-7 two elements rotated as a group: export = Monitor
 *   C-M05-8 keyframed x moved on the Monitor (key written on release), frame
 *           at that key's time: export = Monitor
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { compareFrames, extractExportFrame } from '../compare.mjs';

/** The cases, in the order a runner should take them. */
export const MONITOR_TRANSFORM_B_COMPARE_CASES = Object.freeze([
  {
    id: 'C-M05-5',
    title: 'anchor moved, then rotated about it: Monitor frame = export frame',
    gesture: 'anchor+rotate',
  },
  {
    id: 'C-M05-6',
    title: 'group scaled on the Monitor: Monitor frame = export frame',
    gesture: 'group-scale',
  },
  {
    id: 'C-M05-7',
    title: 'group rotated on the Monitor: Monitor frame = export frame',
    gesture: 'group-rotate',
  },
  {
    id: 'C-M05-8',
    title: 'keyframed value moved, key written on release: Monitor frame = export frame',
    gesture: 'keyframe',
  },
]);

/**
 * Runs one compare case.
 * @param {{ id: string, previewPng: string, exportVideo: string, timeSeconds: number, outRoot: string }} input
 *   `previewPng`: the Monitor at Fit after the gesture, saved at the export's size;
 *   `exportVideo`: the file exported after the gesture; `timeSeconds`: the frame to compare
 *   (for C-M05-8 the time of the key written on release).
 * @returns {Promise<{ id: string, status: 'pass' | 'fail', resultPath?: string }>}
 */
export async function runMonitorTransformBCompare(input) {
  const testCase = MONITOR_TRANSFORM_B_COMPARE_CASES.find((item) => item.id === input.id);
  if (testCase === undefined) throw new Error(`unknown compare case ${input.id}`);
  const outDir = path.join(input.outRoot, input.id);
  const exportFrame = path.join(outDir, 'export-frame.png');
  await mkdir(outDir, { recursive: true });
  await extractExportFrame(input.exportVideo, input.timeSeconds, exportFrame);
  const result = await compareFrames(input.previewPng, exportFrame, outDir);
  return { id: input.id, status: result.status, resultPath: result.resultPath };
}

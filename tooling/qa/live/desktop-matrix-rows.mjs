/**
 * The runner entry of the T-A05 and T-A06 matrices. `run.mjs` calls `createMatrixContext` once
 * after the app has launched and the scratch library is set, then `executeRow(MATRIX_ROWS[id],
 * page, context)` for every `D-A05-*` and `D-A06-*` id in `--tests`.
 *
 *   node tooling/qa/live/run.mjs --tests "D-A05*" --app <unpacked-dir>
 *   node tooling/qa/live/run.mjs --tests "D-A06*" --app <unpacked-dir>
 */
import { join } from 'node:path';
import { screenshot } from './steps.mjs';
import { createBridge, createBridgeLog, FIXTURE_ROOT } from './matrix-core.mjs';
import { PROJECTS_IMPORT_ROWS_BY_ID } from './desktop-projects-import-steps.mjs';
import {
  TIMELINE_ROWS_BY_ID,
  redoThroughMenu,
  undoThroughMenu,
} from './desktop-timeline-steps.mjs';

export const MATRIX_ROWS = Object.freeze({ ...PROJECTS_IMPORT_ROWS_BY_ID, ...TIMELINE_ROWS_BY_ID });
export const MATRIX_IDS = Object.freeze(Object.keys(MATRIX_ROWS));

/** The context every row gets: scratch paths, the logged bridge, screenshots, undo and redo. */
export function createMatrixContext({ page, outDir, libraryDir, runId, fixtures = FIXTURE_ROOT }) {
  const bridgeLogPath = join(outDir, 'bridge-replies.jsonl');
  const bridge = createBridge(page, createBridgeLog(bridgeLogPath));
  return {
    outDir,
    libraryDir,
    altLibraryDir: `${libraryDir}-alt`,
    fixtures,
    runTag: runId.slice(0, 8),
    bridge,
    bridgeLogPath,
    async shot(rowId, name) {
      return screenshot(page, join(outDir, rowId, `${name}.png`));
    },
    undo: undoThroughMenu,
    redo: redoThroughMenu,
  };
}

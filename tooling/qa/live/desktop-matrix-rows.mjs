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
import { createBridge, createBridgeLog, FIXTURE_ROOT, readDocument } from './matrix-core.mjs';
import { PROJECTS_IMPORT_ROWS_BY_ID } from './desktop-projects-import-steps.mjs';
import { PERSISTENCE_ROWS_BY_ID } from './desktop-persistence-steps.mjs';
import { LIBRARY_THUMB_ROWS_BY_ID } from './desktop-library-thumb-steps.mjs';
import { MONITOR_SNAP_ROWS_BY_ID } from './desktop-monitor-snap-steps.mjs';
import { MONITOR_EDIT_ROWS_BY_ID } from './desktop-monitor-edit-steps.mjs';
import {
  TIMELINE_ROWS_BY_ID,
  redoThroughMenu,
  undoThroughMenu,
} from './desktop-timeline-steps.mjs';
import { EXPORT_MATRIX_IDS, EXPORT_MATRIX_ROWS_BY_ID } from './export-matrix-steps.mjs';
import { EXPORT_MISSING_ROWS_BY_ID } from './export-missing-steps.mjs';
import { TIMELINE_DND_H04_ROWS_BY_ID } from './timeline-dnd-h04-scripted-rows.mjs';

export const MATRIX_ROWS = Object.freeze({
  ...PROJECTS_IMPORT_ROWS_BY_ID,
  ...TIMELINE_ROWS_BY_ID,
  ...PERSISTENCE_ROWS_BY_ID,
  ...EXPORT_MATRIX_ROWS_BY_ID,
  ...EXPORT_MISSING_ROWS_BY_ID,
  ...TIMELINE_DND_H04_ROWS_BY_ID,
  ...LIBRARY_THUMB_ROWS_BY_ID,
  ...MONITOR_SNAP_ROWS_BY_ID,
  ...MONITOR_EDIT_ROWS_BY_ID,
});
export const MATRIX_IDS = Object.freeze(Object.keys(MATRIX_ROWS));
export { EXPORT_MATRIX_IDS };

/** The context every row gets: scratch paths, the logged bridge, screenshots, undo and redo. */
export function createMatrixContext({
  page,
  outDir,
  libraryDir,
  downloadDir,
  appPid,
  media,
  runId,
  fixtures = FIXTURE_ROOT,
  editDocument,
  restartApp,
  killApp,
}) {
  const bridgeLogPath = join(outDir, 'bridge-replies.jsonl');
  const bridge = createBridge(page, createBridgeLog(bridgeLogPath));
  const ctx = {
    page,
    outDir,
    libraryDir,
    downloadDir,
    appPid,
    media,
    altLibraryDir: `${libraryDir}-alt`,
    fixtures,
    editDocument,
    restartApp,
    killApp,
    runTag: runId.slice(0, 8),
    bridge,
    bridgeLogPath,
    async readDocument(target = ctx.page) {
      return readDocument(target, ctx.bridge);
    },
    async shot(rowId, name) {
      return screenshot(ctx.page, join(outDir, rowId, `${name}.png`));
    },
    undo: undoThroughMenu,
    redo: redoThroughMenu,
  };
  return ctx;
}

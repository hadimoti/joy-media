import { A08_ROWS } from './actions.mjs';
import { EFFECTS_LOOKS_ROWS } from './effects-looks-steps.mjs';
import { LEFT_PANEL_ROWS } from './left-panels-steps.mjs';
import { selectRows } from './rows.mjs';

/** The task-card order matters: later A07 rows use content created by earlier rows. */
export const T_A07_ROWS = [
  ...EFFECTS_LOOKS_ROWS.filter((row) => row.id !== 'D-070'),
  ...LEFT_PANEL_ROWS,
  ...EFFECTS_LOOKS_ROWS.filter((row) => row.id === 'D-070'),
];

/** T-A08 rows are listed in TEST-MATRIX.md order. */
export const T_A08_ROWS = A08_ROWS;

/** Rows owned by this continuation; the monitor suite remains registered separately by run.mjs. */
export const LIVE_ROWS = [...T_A07_ROWS, ...T_A08_ROWS];

export function selectMatrixRows(ids) {
  return selectRows(LIVE_ROWS, ids);
}

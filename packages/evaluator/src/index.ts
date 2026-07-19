/**
 * @joy-media/evaluator — time-based document evaluation (pure).
 *
 * WP-00.1 state: exact frame evaluation over the spike model (source time
 * mapping + nested compositions). Render IR integration lands with WP-00.3/P01.
 */
export const PACKAGE_NAME = '@joy-media/evaluator' as const;

export type { EvaluatedFrame, EvaluatedVideoFrame } from './evaluate.js';
export { evaluateFrame } from './evaluate.js';

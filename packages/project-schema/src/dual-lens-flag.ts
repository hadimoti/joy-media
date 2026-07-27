/**
 * Feature flag for the Dual Lens durable graph.
 *
 * The plan asks for this phase to sit behind a flag until migration, undo,
 * validation, performance, and compatibility all hold. A flag that only hides
 * UI would not be worth much: the risk in a schema phase is that new document
 * slices leak into projects that never asked for them, and then a user who
 * turns the feature off is left with a document the old code path does not
 * understand.
 *
 * So "disabled" is defined as a property of the *document*, not of the screen:
 * with the flag off, `projectWithoutDualLens` returns exactly the v1 document,
 * which makes "graph-disabled behavior remains identical" something a test can
 * assert rather than something a comment can claim.
 */

import type { JoyProjectV1 } from './v1.js';
import type { AnyJoyProject, JoyProjectV2 } from './v2.js';

export const DUAL_LENS_FLAG_KEY = 'joy-media.dual-lens-graph';

export interface DualLensFlags {
  /** Durable artifacts and the persisted workflow graph. Off until Phase 3. */
  readonly graphEnabled: boolean;
}

export const DUAL_LENS_FLAGS_OFF: DualLensFlags = { graphEnabled: false };

export interface FlagSource {
  getItem(key: string): string | null;
}

/**
 * Reads the flag from any string-keyed store (localStorage, a config map).
 *
 * Default is off, and only the exact string `'on'` enables it — a stray value
 * should fail closed rather than switch on an unfinished feature.
 */
export function readDualLensFlags(source: FlagSource | undefined): DualLensFlags {
  if (source === undefined) return DUAL_LENS_FLAGS_OFF;
  try {
    return { graphEnabled: source.getItem(DUAL_LENS_FLAG_KEY) === 'on' };
  } catch {
    // A storage that throws (private mode, quota, disabled cookies) must not
    // take the editor down over a feature flag.
    return DUAL_LENS_FLAGS_OFF;
  }
}

/**
 * The v1 document underneath any project, with every Dual Lens slice removed.
 *
 * Used when the flag is off and when exporting to a v1 consumer. Returning a
 * new object rather than mutating keeps this safe to call on live state.
 */
export function projectWithoutDualLens(project: AnyJoyProject): JoyProjectV1 {
  const { artifacts, artifactVersions, workflow, ...rest } = project as JoyProjectV2;
  void artifacts;
  void artifactVersions;
  void workflow;
  return { ...rest, schemaVersion: 1 };
}

/**
 * Applies the flag to a project on its way to a consumer.
 *
 * On, the v2 document passes through untouched. Off, the caller gets the v1
 * document — so a disabled Dual Lens cannot observe, render, or persist graph
 * state even if some earlier session wrote it.
 */
export function applyDualLensFlags(
  project: AnyJoyProject,
  flags: DualLensFlags,
): AnyJoyProject {
  return flags.graphEnabled ? project : projectWithoutDualLens(project);
}

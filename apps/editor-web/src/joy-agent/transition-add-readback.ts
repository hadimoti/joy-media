import type { JoyProjectV1, TransitionV1 } from '@joy-media/project-schema';
import { canonicalJson } from '@joy-media/workflow-engine';
import type { JoyCodeCompoundDraft } from '../joy-code-compound-compiler.js';

/**
 * Project-state readback for one deliberately narrow F5 slice: adding one
 * curated transition at an existing visual junction.
 *
 * The compound runner already proves that the complete persisted document is
 * identical to the approved draft. This adds the semantic checks a timeline
 * editor actually relies on: the newly-created transition is present once,
 * points at adjacent video clips on its declared track, and remains within
 * the safe junction duration. It intentionally makes no renderer, pixel, or
 * export claim.
 */
export function assertAddedTransitionProjectReadback(
  before: JoyProjectV1,
  after: JoyProjectV1,
  draft: JoyCodeCompoundDraft,
): void {
  const expected = addedTransitionFor(before, draft);
  // This verifier is intentionally not a general transition proof. Removes
  // and mixed edits need operation-ordered evidence rather than a final-state
  // shortcut that could accidentally report coverage for a different action.
  if (expected === undefined) return;

  assertCanonicalEqual(
    after.transitions ?? [],
    draft.document.transitions ?? [],
    'transition collection differs from the approved project state',
  );

  const actual = (after.transitions ?? []).filter((transition) => transition.id === expected.id);
  if (actual.length !== 1)
    fail('MISMATCH', `added transition "${expected.id}" is not present exactly once after commit`);
  assertCanonicalEqual(
    actual[0],
    expected,
    `added transition "${expected.id}" differs from the approved project state`,
  );
  assertValidJunction(after, actual[0]!);
}

/**
 * Companion proof for the same bounded transition pair. It confirms that one
 * previously-valid junction transition was actually removed and that the
 * unrelated transition records in the durable document were left untouched.
 * It deliberately does not imply that a renderer blended (or stopped
 * blending) pixels; that requires the separate composed-output evidence lane.
 */
export function assertRemovedTransitionProjectReadback(
  before: JoyProjectV1,
  after: JoyProjectV1,
  draft: JoyCodeCompoundDraft,
): void {
  const expected = removedTransitionFor(before, draft);
  if (expected === undefined) return;
  assertCanonicalEqual(
    after.transitions ?? [],
    draft.document.transitions ?? [],
    'transition collection differs from the approved project state',
  );
  assertValidJunction(before, expected);
  if ((after.transitions ?? []).some((transition) => transition.id === expected.id))
    fail('MISMATCH', `removed transition "${expected.id}" is still present after commit`);
}

function addedTransitionFor(
  before: JoyProjectV1,
  draft: JoyCodeCompoundDraft,
): TransitionV1 | undefined {
  if (draft.groups.length !== 1 || draft.groups[0]?.kind !== 'transition') return undefined;
  const beforeTransitions = before.transitions ?? [];
  const expectedTransitions = draft.document.transitions ?? [];
  const beforeById = new Map(beforeTransitions.map((transition) => [transition.id, transition]));
  const expectedById = new Map(
    expectedTransitions.map((transition) => [transition.id, transition]),
  );
  const added = expectedTransitions.filter((transition) => !beforeById.has(transition.id));
  const removed = beforeTransitions.filter((transition) => !expectedById.has(transition.id));
  if (added.length !== 1 || removed.length !== 0) return undefined;

  // A transition-add operation must not silently alter an older transition in
  // the same single-operation draft. The generic exact-draft check still
  // protects integrity; this guard keeps this operation-specific assertion
  // honest about what it observed.
  for (const beforeTransition of beforeTransitions) {
    const expectedTransition = expectedById.get(beforeTransition.id);
    if (
      expectedTransition === undefined ||
      canonicalJson(expectedTransition) !== canonicalJson(beforeTransition)
    )
      return undefined;
  }
  return added[0];
}

function removedTransitionFor(
  before: JoyProjectV1,
  draft: JoyCodeCompoundDraft,
): TransitionV1 | undefined {
  if (draft.groups.length !== 1 || draft.groups[0]?.kind !== 'transition') return undefined;
  const beforeTransitions = before.transitions ?? [];
  const expectedTransitions = draft.document.transitions ?? [];
  const beforeById = new Map(beforeTransitions.map((transition) => [transition.id, transition]));
  const expectedById = new Map(
    expectedTransitions.map((transition) => [transition.id, transition]),
  );
  const added = expectedTransitions.filter((transition) => !beforeById.has(transition.id));
  const removed = beforeTransitions.filter((transition) => !expectedById.has(transition.id));
  if (added.length !== 0 || removed.length !== 1) return undefined;
  for (const expectedTransition of expectedTransitions) {
    const beforeTransition = beforeById.get(expectedTransition.id);
    if (
      beforeTransition === undefined ||
      canonicalJson(expectedTransition) !== canonicalJson(beforeTransition)
    )
      return undefined;
  }
  return removed[0];
}

function assertValidJunction(project: JoyProjectV1, transition: TransitionV1): void {
  const tracks = Object.values(project.compositions)
    .flatMap((composition) => composition.tracks)
    .filter((track) => track.id === transition.trackId);
  if (tracks.length !== 1)
    fail('MISMATCH', `transition "${transition.id}" resolves to ${tracks.length} matching tracks`);
  const track = tracks[0]!;
  if (track.kind !== 'video' || track.locked === true)
    fail('MISMATCH', `transition "${transition.id}" is not attached to an editable video track`);
  const left = track.clips.filter((clip) => clip.id === transition.leftClipId);
  const right = track.clips.filter((clip) => clip.id === transition.rightClipId);
  if (
    left.length !== 1 ||
    right.length !== 1 ||
    left[0]?.kind !== 'video' ||
    right[0]?.kind !== 'video'
  )
    fail('MISMATCH', `transition "${transition.id}" does not reference two unique video clips`);
  const leftClip = left[0]!;
  const rightClip = right[0]!;
  if (leftClip.startUs + leftClip.durationUs !== rightClip.startUs)
    fail('MISMATCH', `transition "${transition.id}" clips are no longer adjacent`);
  if (
    !Number.isSafeInteger(transition.durationUs) ||
    transition.durationUs <= 0 ||
    transition.durationUs > Math.min(leftClip.durationUs, rightClip.durationUs) / 2
  )
    fail('MISMATCH', `transition "${transition.id}" duration is outside its visual junction`);
}

function assertCanonicalEqual(actual: unknown, expected: unknown, message: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail('MISMATCH', message);
}

function fail(code: 'MISMATCH', message: string): never {
  throw new Error(`JOY_CODE_TRANSITION_ADD_READBACK_${code}: ${message}`);
}

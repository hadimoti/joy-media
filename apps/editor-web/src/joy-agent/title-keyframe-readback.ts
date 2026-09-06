import {
  canonicalBindingKey,
  type JoyProjectV1,
  type PropertyAnimationV2,
  type PropertyBindingV2,
} from '@joy-media/project-schema';
import { canonicalJson } from '@joy-media/workflow-engine';
import type { JoyCodeCompoundDraft } from '../joy-code-compound-compiler.js';

/**
 * Bounded project-state readback for one F5 vertical slice: creating a text
 * title and setting its composition-time opacity key in the same approved
 * compound draft.
 *
 * The compound runner already verifies that the committed document is exactly
 * the private prepared document. This assertion names the user-visible title
 * and its typed V2 animation explicitly, so that coverage does not mistake a
 * generic document replacement for title/keyframe parity. It intentionally
 * does not assert renderer pixels or claim broader text/property coverage.
 */
export function assertCreatedTitleOpacityKeyframeProjectReadback(
  before: JoyProjectV1,
  after: JoyProjectV1,
  draft: JoyCodeCompoundDraft,
): void {
  const target = targetFor(before, draft);
  if (target === undefined) return;

  const actualObject = after.visualObjects[target.objectId];
  if (actualObject === undefined || actualObject.kind !== 'text')
    fail('MISMATCH', `created title "${target.objectId}" is absent or is not text`);
  assertCanonicalEqual(
    actualObject,
    target.expectedObject,
    `created title "${target.objectId}" differs from the approved project state`,
  );

  const animationId = canonicalBindingKey(target.binding);
  const actualAnimation = after.propertyAnimations?.[animationId];
  if (actualAnimation === undefined)
    fail('MISMATCH', `opacity animation "${animationId}" is absent after commit`);
  assertCanonicalEqual(
    actualAnimation,
    target.expectedAnimation,
    `typed opacity keyframe for title "${target.objectId}" differs from the approved project state`,
  );
}

interface TitleOpacityTarget {
  readonly objectId: string;
  readonly binding: PropertyBindingV2;
  readonly expectedObject: JoyProjectV1['visualObjects'][string];
  readonly expectedAnimation: PropertyAnimationV2;
}

function targetFor(
  before: JoyProjectV1,
  draft: JoyCodeCompoundDraft,
): TitleOpacityTarget | undefined {
  // Keep this verifier deliberately scoped to the vertical slice. A larger
  // mixed batch needs operation-ordered evidence, not a final-state shortcut.
  if (draft.groups.length !== 2) return undefined;
  const [titleGroup, keyframeGroup] = draft.groups;
  if (titleGroup?.kind !== 'text' || keyframeGroup?.kind !== 'motion') return undefined;
  const objectId = titleGroup.affectedIds[0];
  if (
    objectId === undefined ||
    keyframeGroup.affectedIds[0] !== objectId ||
    keyframeGroup.affectedIds[1] !== 'opacity' ||
    before.visualObjects[objectId] !== undefined
  )
    return undefined;

  const expectedObject = draft.document.visualObjects[objectId];
  if (expectedObject === undefined || expectedObject.kind !== 'text') return undefined;
  const binding: PropertyBindingV2 = {
    ownerKind: 'visual-object',
    ownerId: objectId,
    propertyId: 'opacity',
    timeDomain: 'composition',
  };
  const expectedAnimation = draft.document.propertyAnimations?.[canonicalBindingKey(binding)];
  if (
    expectedAnimation === undefined ||
    canonicalJson(expectedAnimation.binding) !== canonicalJson(binding) ||
    expectedAnimation.value.kind !== 'scalar'
  )
    return undefined;
  // This two-group final-state probe is not valid when a malformed legacy
  // project already carried an animation for an object that did not exist.
  // Leave that irregular compound to the generic exact-payload verifier
  // instead of failing a successful commit after the fact.
  if (before.propertyAnimations?.[canonicalBindingKey(binding)] !== undefined) return undefined;

  return { objectId, binding, expectedObject, expectedAnimation };
}

function assertCanonicalEqual(actual: unknown, expected: unknown, message: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail('MISMATCH', message);
}

function fail(code: 'MISMATCH', message: string): never {
  throw new Error(`JOY_CODE_TITLE_OPACITY_READBACK_${code}: ${message}`);
}

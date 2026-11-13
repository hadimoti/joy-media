import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDragClearsTolerance,
  groupMoveDelta,
  snapToleranceUs,
} from './timeline-dnd-steps.mjs';

const PIXELS_PER_SECOND = 100;
const TOLERANCE_US = snapToleranceUs(PIXELS_PER_SECOND);
const BEFORE = [
  { clipId: 'a', startUs: 1_000_000, trackId: 'v1' },
  { clipId: 'b', startUs: 3_000_000, trackId: 'v1' },
];

function moved(deltaUs, { trackB = 'v1' } = {}) {
  return [
    { clipId: 'a', startUs: 1_000_000 + deltaUs, trackId: 'v1' },
    { clipId: 'b', startUs: 3_000_000 + deltaUs, trackId: trackB },
  ];
}

test('the snap tolerance is about 8 px at the current zoom', () => {
  assert.equal(snapToleranceUs(100), 80_001);
  assert.ok(Math.abs((snapToleranceUs(100) / 1_000_000) * 100 - 8) < 0.01);
});

test('a drag request under four snap tolerances is rejected before it is sent', () => {
  assert.throws(
    () => assertDragClearsTolerance(3, TOLERANCE_US, PIXELS_PER_SECOND),
    /under 4 × the/,
  );
  assert.throws(
    () => assertDragClearsTolerance(-20, TOLERANCE_US, PIXELS_PER_SECOND),
    /under 4 × the/,
  );
  assert.doesNotThrow(() => assertDragClearsTolerance(40, TOLERANCE_US, PIXELS_PER_SECOND));
  assert.doesNotThrow(() => assertDragClearsTolerance(-40, TOLERANCE_US, PIXELS_PER_SECOND));
});

test('a group move returns the delta when every member moved by the primary delta', () => {
  assert.equal(
    groupMoveDelta({
      before: BEFORE,
      after: moved(2_000_000),
      primaryClipId: 'a',
      toleranceUs: TOLERANCE_US,
    }),
    2_000_000,
  );
  assert.equal(
    groupMoveDelta({
      before: BEFORE,
      after: moved(-500_000),
      primaryClipId: 'a',
      toleranceUs: TOLERANCE_US,
    }),
    -500_000,
  );
});

test('a zero committed move fails instead of reporting success', () => {
  assert.throws(
    () =>
      groupMoveDelta({
        before: BEFORE,
        after: moved(0),
        primaryClipId: 'a',
        toleranceUs: TOLERANCE_US,
      }),
    /did not commit/,
  );
});

test('a committed move within the snap tolerance fails', () => {
  assert.throws(
    () =>
      groupMoveDelta({
        before: BEFORE,
        after: moved(Math.round(TOLERANCE_US / 2)),
        primaryClipId: 'a',
        toleranceUs: TOLERANCE_US,
      }),
    /did not commit/,
  );
});

test('a member that moved by a different delta than the primary fails', () => {
  const after = [
    { clipId: 'a', startUs: 3_000_000, trackId: 'v1' },
    { clipId: 'b', startUs: 4_000_000, trackId: 'v1' },
  ];
  assert.throws(
    () => groupMoveDelta({ before: BEFORE, after, primaryClipId: 'a', toleranceUs: TOLERANCE_US }),
    /group member b moved 1000000 us, not the primary delta of 2000000 us/,
  );
});

test('a member that moved to another track fails', () => {
  assert.throws(
    () =>
      groupMoveDelta({
        before: BEFORE,
        after: moved(2_000_000, { trackB: 'v2' }),
        primaryClipId: 'a',
        toleranceUs: TOLERANCE_US,
      }),
    /moved to unexpected track v2/,
  );
});

test('an unplaced clip after the drag fails with a clear message', () => {
  const after = [
    { clipId: 'a', startUs: 3_000_000, trackId: 'v1' },
    { clipId: 'b', startUs: null, trackId: null },
  ];
  assert.throws(
    () => groupMoveDelta({ before: BEFORE, after, primaryClipId: 'a', toleranceUs: TOLERANCE_US }),
    /group member b has no position after the drag/,
  );
});

test('a primary clip that is not in the group is rejected', () => {
  assert.throws(
    () =>
      groupMoveDelta({
        before: BEFORE,
        after: moved(2_000_000),
        primaryClipId: 'z',
        toleranceUs: TOLERANCE_US,
      }),
    /primary clip z is not in group/,
  );
});

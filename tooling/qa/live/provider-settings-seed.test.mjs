import assert from 'node:assert/strict';
import test from 'node:test';
import { planOperationsFromDocument } from './provider-settings-seed.mjs';
import { classifyOutcome } from './provider-settings-steps.mjs';

const document = (clips, extra = {}) => ({
  rootCompositionId: 'root',
  compositions: {
    root: {
      id: 'root',
      tracks: [
        { id: 'track-empty', clips: [] },
        { id: 'track-video', clips },
        ...(extra.tracks ?? []),
      ],
    },
  },
});

test('the stub edit names the real composition, the track holding the clip and that clip asset', () => {
  const [operation] = planOperationsFromDocument(
    document([
      { id: 'a', assetId: 'asset-real', startUs: 0, durationUs: 3_000_000 },
      { id: 'b', assetId: 'asset-other', startUs: 3_000_000, durationUs: 2_000_000 },
    ]),
  );
  assert.equal(operation.kind, 'timeline.insertExistingAsset');
  assert.equal(operation.compositionId, 'root');
  assert.equal(operation.targetTrackId, 'track-video');
  assert.equal(operation.assetId, 'asset-real');
  // One second after the last clip of the track, so it cannot overlap.
  assert.equal(operation.startUs, 6_000_000);
});

test('a project with no clip refuses with BLOCKED instead of inventing ids', () => {
  assert.throws(() => planOperationsFromDocument(document([])), /^Error: BLOCKED:/u);
  assert.throws(() => planOperationsFromDocument(undefined), /^Error: BLOCKED:/u);
});

test('a visible plan or proposal card is a result, not a reason to keep waiting', () => {
  const quiet = {
    thinking: false,
    approve: false,
    applyEdit: false,
    lastRun: false,
    reverted: false,
    liveProposal: false,
    plan: false,
    messages: 1,
  };
  assert.equal(classifyOutcome({ ...quiet, plan: true }, 1), 'proposal');
  assert.equal(classifyOutcome({ ...quiet, liveProposal: true }, 1), 'proposal');
  assert.equal(classifyOutcome({ ...quiet, thinking: true, plan: true }, 1), 'waiting');
  assert.equal(classifyOutcome(quiet, 1), 'waiting');
});

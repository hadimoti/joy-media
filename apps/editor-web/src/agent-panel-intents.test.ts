import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import {
  AGENT_INTENTS,
  buildSplitTrimRecipe,
  findClipLocation,
  findNextClip,
} from './agent-panel-intents.js';

function intent(id: string) {
  const found = AGENT_INTENTS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing intent ${id}`);
  return found;
}

describe('agent panel intents', () => {
  it('findClipLocation locates a clip on its real track/composition', () => {
    const project = buildReferenceSpikeProject();
    const location = findClipLocation(project, 'product');
    expect(location).toEqual({
      compositionId: 'root',
      trackId: 'track-0',
      clip: project.compositions.root!.tracks[0]!.clips.find((c) => c.id === 'product'),
    });
  });

  it('findNextClip returns the adjacent clip by start time', () => {
    const project = buildReferenceSpikeProject();
    const location = findClipLocation(project, 'intro')!;
    const next = findNextClip(project, location);
    expect(next?.id).toBe('product');
  });

  it('findNextClip returns undefined for the last clip on a track', () => {
    const project = buildReferenceSpikeProject();
    const location = findClipLocation(project, 'outro')!;
    expect(findNextClip(project, location)).toBeUndefined();
  });

  it('split-at-playhead requires a selected clip', () => {
    const project = buildReferenceSpikeProject();
    const result = intent('split-at-playhead').buildStep(project, [], 5_000_000);
    expect(result).toEqual({ ok: false, reason: 'Select a clip first.' });
  });

  it('split-at-playhead requires the playhead strictly inside the clip', () => {
    const project = buildReferenceSpikeProject();
    const result = intent('split-at-playhead').buildStep(project, ['intro'], 10_000_000);
    expect(result.ok).toBe(false);
  });

  it('split-at-playhead builds a real splitClip step', () => {
    const project = buildReferenceSpikeProject();
    const result = intent('split-at-playhead').buildStep(project, ['intro'], 5_000_000);
    expect(result).toEqual({
      ok: true,
      step: {
        id: 'step-1',
        description: 'Split intro at 5000000µs',
        mode: 'command',
        tool: 'splitClip',
        arguments: {
          compositionId: 'root',
          trackId: 'track-0',
          clipId: 'intro',
          atUs: 5_000_000,
          newClipId: 'intro-split-5000000',
        },
        dependsOn: [],
        expectedChange: 'Split clip intro into intro and intro-split-5000000',
        preconditions: [],
        requiresConfirmation: false,
      },
    });
  });

  it('move-to-playhead builds a real moveClip step', () => {
    const project = buildReferenceSpikeProject();
    const result = intent('move-to-playhead').buildStep(project, ['outro'], 40_000_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.step.tool).toBe('moveClip');
      expect(result.step.arguments).toEqual({
        compositionId: 'root',
        trackId: 'track-0',
        clipId: 'outro',
        newStartUs: 40_000_000,
      });
      expect(result.step.requiresConfirmation).toBe(false);
    }
  });

  it('remove-selected marks the step destructive/requiresConfirmation', () => {
    const project = buildReferenceSpikeProject();
    const result = intent('remove-selected').buildStep(project, ['product'], 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.step.tool).toBe('removeClip');
      expect(result.step.requiresConfirmation).toBe(true);
    }
    expect(intent('remove-selected').destructive).toBe(true);
  });

  it('join-with-next is unavailable for the last clip on a track', () => {
    const project = buildReferenceSpikeProject();
    const result = intent('join-with-next').buildStep(project, ['outro'], 0);
    expect(result).toEqual({
      ok: false,
      reason: 'There is no adjacent clip after the selected clip on this track.',
    });
  });

  it('join-with-next builds a real joinClips step for adjacent clips', () => {
    const project = buildReferenceSpikeProject();
    const result = intent('join-with-next').buildStep(project, ['intro'], 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.step.tool).toBe('joinClips');
      expect(result.step.arguments).toEqual({
        compositionId: 'root',
        trackId: 'track-0',
        firstClipId: 'intro',
        secondClipId: 'product',
      });
      expect(result.step.requiresConfirmation).toBe(true);
    }
  });

  it('insert-test-clip builds a real insertClip step using the intro asset', () => {
    const project = buildReferenceSpikeProject();
    const result = intent('insert-test-clip').buildStep(project, [], 2_000_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.step.tool).toBe('insertClip');
      expect(result.step.arguments).toEqual({
        compositionId: 'root',
        trackId: 'track-0',
        clip: {
          id: 'agent-clip-2000000',
          kind: 'video',
          startUs: 2_000_000,
          durationUs: 1_000_000,
          assetId: 'asset-intro',
          sourceInUs: 0,
        },
      });
    }
  });

  it('recipe-split-trim builds real splitClip then trimClip steps', () => {
    const project = buildReferenceSpikeProject();
    const recipe = buildSplitTrimRecipe(project, ['intro'], 5_000_000);
    expect(recipe.ok).toBe(true);
    if (!recipe.ok) return;
    expect(recipe.steps).toHaveLength(2);
    expect(recipe.steps[0]?.tool).toBe('splitClip');
    expect(recipe.steps[1]?.tool).toBe('trimClip');
    expect(recipe.steps[1]?.dependsOn).toEqual(['step-1']);
  });
});

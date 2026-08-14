import { describe, expect, it } from 'vitest';
import { emptySpikeProject, makeVideoClip, withClips } from '@joy-media/test-fixtures';
import { applyTransaction } from '@joy-media/commands';
import { canonicalBindingKey } from '@joy-media/project-schema';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { resolveObjectIdForSelection } from './sticker-bindings.js';
import {
  buildDerivedClipPresentation,
  buildSpeedRampPresentation,
  buildSpeedRampTransaction,
} from './speed-ramp.js';
import { readTimelineElementKindMap, withTimelineElementKinds } from './timeline-element-kind.js';

describe('buildSpeedRampTransaction', () => {
  it('creates a source-continuous three-part ease in that preserves the timeline span', () => {
    const project = withClips(emptySpikeProject(), 'track-0', [
      makeVideoClip('clip-a', 2_000_000, 6_000_000),
    ]);
    const composition = project.compositions.root!;
    const track = composition.tracks[0]!;
    const clip = track.clips[0]!;
    if (clip.kind !== 'video') throw new Error('fixture must be video');

    const result = buildSpeedRampTransaction({
      compositionId: composition.id,
      track,
      clip,
      preset: 'ease-in',
    });
    const next = applyTransaction(project, result.transaction).project;
    const clips = next.compositions.root!.tracks[0]!.clips;

    expect(clips).toHaveLength(3);
    expect(clips.map((item) => item.startUs)).toEqual([2_000_000, 4_666_667, 6_666_667]);
    expect(clips.map((item) => item.durationUs)).toEqual([2_666_667, 2_000_000, 1_333_333]);
    expect(clips.map((item) => (item.kind === 'video' ? item.sourceInUs : -1))).toEqual([
      5_000_000, 7_000_000, 9_000_000,
    ]);
    expect(clips.map((item) => (item.kind === 'video' ? item.playbackRate : -1))).toEqual([
      0.75, 1, 1.5,
    ]);
    expect(clips.at(-1)!.startUs + clips.at(-1)!.durationUs).toBe(8_000_000);
  });

  it('rejects reverse, frozen, and overflow ramp targets instead of creating incorrect media', () => {
    const project = withClips(emptySpikeProject(), 'track-0', [
      { ...makeVideoClip('reverse', 0, 3_000_000), reversed: true },
    ]);
    const track = project.compositions.root!.tracks[0]!;
    const reverse = track.clips[0]!;
    if (reverse.kind !== 'video') throw new Error('fixture must be video');
    expect(() =>
      buildSpeedRampTransaction({ compositionId: 'root', track, clip: reverse, preset: 'ease-in' }),
    ).toThrow('reversed');

    const forward = { ...reverse };
    Reflect.deleteProperty(forward, 'reversed');
    const frozen = { ...forward, id: 'freeze', playbackRate: 0 };
    expect(() =>
      buildSpeedRampTransaction({
        compositionId: 'root',
        track: { ...track, clips: [frozen] },
        clip: frozen,
        preset: 'ease-in',
      }),
    ).toThrow('freeze');
  });

  it('keeps visual bindings and clip-specific audio/effects on every ramp segment', () => {
    const sourceAudio = {
      clips: {
        intro: { gain: 0.7, pan: -0.25, mute: false, solo: true, fadeInUs: 10, fadeOutUs: 20 },
      },
      buses: [
        { id: 'master', name: 'Master', gain: 1, pan: 0, mute: false, solo: false, inputs: [] },
      ],
      effects: [
        {
          id: 'intro-eq',
          targetId: 'intro',
          effect: { kind: 'eq' as const, bands: [] },
        },
      ],
    };
    const segmentIds = [
      'intro-ramp-ease-in-1',
      'intro-ramp-ease-in-2',
      'intro-ramp-ease-in-3',
    ] as const;
    const result = buildSpeedRampPresentation(
      INITIAL_EDITOR_PROJECT,
      sourceAudio,
      'intro',
      segmentIds,
    );

    expect(resolveObjectIdForSelection(result.project, segmentIds)).toBe('intro-title');
    expect(resolveObjectIdForSelection(result.project, ['intro'])).toBe('intro-title');
    expect(result.audio.clips.intro).toBeUndefined();
    expect(Object.values(result.audio.clips)).toEqual([
      sourceAudio.clips.intro,
      sourceAudio.clips.intro,
      sourceAudio.clips.intro,
    ]);
    expect(result.audio.effects.map((effect) => effect.targetId)).toEqual(segmentIds);
    expect(result.audio.effects.map((effect) => effect.id)).toEqual([
      'intro-eq--derived-1',
      'intro-eq--derived-2',
      'intro-eq--derived-3',
    ]);
    expect(result.project.audio?.clips).toEqual(result.audio.clips);
  });

  it('keeps the original binding and clones it for freeze/split-style derived clips', () => {
    const sourceAudio = {
      clips: { intro: { gain: 0.8, pan: 0.1, mute: false, solo: false } },
      buses: [],
      effects: [
        {
          id: 'intro-limiter',
          targetId: 'intro',
          effect: { kind: 'limiter' as const, ceiling: -1, releaseUs: 1 },
        },
      ],
    };
    const result = buildDerivedClipPresentation(INITIAL_EDITOR_PROJECT, sourceAudio, 'intro', [
      'intro-freeze',
      'intro-right',
    ]);

    expect(
      resolveObjectIdForSelection(result.project, ['intro', 'intro-freeze', 'intro-right']),
    ).toBe('intro-title');
    expect(result.audio.clips).toMatchObject({
      intro: sourceAudio.clips.intro,
      'intro-freeze': sourceAudio.clips.intro,
      'intro-right': sourceAudio.clips.intro,
    });
    expect(result.audio.effects.map((effect) => effect.targetId)).toEqual([
      'intro',
      'intro-freeze',
      'intro-right',
    ]);
  });

  it('preserves an authored timeline element identity on split and replacement clips', () => {
    const project = withTimelineElementKinds(INITIAL_EDITOR_PROJECT, { intro: 'adjust' });
    const duplicate = buildDerivedClipPresentation(
      project,
      { clips: {}, buses: [], effects: [] },
      'intro',
      ['intro-right'],
    );
    expect(readTimelineElementKindMap(duplicate.project)).toMatchObject({
      intro: 'adjust',
      'intro-right': 'adjust',
    });

    const replacement = buildDerivedClipPresentation(
      project,
      { clips: {}, buses: [], effects: [] },
      'intro',
      ['intro-a', 'intro-b'],
      { removeOriginal: true },
    );
    expect(readTimelineElementKindMap(replacement.project)).toEqual({
      'intro-a': 'adjust',
      'intro-b': 'adjust',
    });
  });

  it('copies clip properties for a duplicate and rebases them for a split', () => {
    const binding = {
      ownerKind: 'color-clip' as const,
      ownerId: 'intro',
      propertyId: 'adjust.exposure',
      timeDomain: 'clip-local' as const,
    };
    const project = {
      ...INITIAL_EDITOR_PROJECT,
      propertyAnimations: {
        [canonicalBindingKey(binding)]: {
          binding,
          value: {
            kind: 'scalar' as const,
            curve: {
              keyframes: [
                { timeUs: 0, value: 0, interpolation: 'linear' as const },
                { timeUs: 1_000_000, value: 2, interpolation: 'linear' as const },
              ],
            },
          },
        },
      },
    };
    const audio = { clips: {}, buses: [], effects: [] };

    const duplicate = buildDerivedClipPresentation(project, audio, 'intro', ['intro-copy']);
    expect(
      duplicate.project.propertyAnimations?.[
        canonicalBindingKey({ ...binding, ownerId: 'intro-copy' })
      ]?.value,
    ).toEqual(project.propertyAnimations[canonicalBindingKey(binding)]?.value);

    const split = buildDerivedClipPresentation(project, audio, 'intro', ['intro-right'], {
      splitLocalUs: 500_000,
    });
    expect(
      split.project.propertyAnimations?.[
        canonicalBindingKey({ ...binding, ownerId: 'intro-right' })
      ]?.value,
    ).toEqual({
      kind: 'scalar',
      curve: {
        keyframes: [
          { timeUs: 0, value: 1, interpolation: 'linear' },
          { timeUs: 500_000, value: 2, interpolation: 'linear' },
        ],
      },
    });
  });
});

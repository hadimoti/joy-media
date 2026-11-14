import { describe, expect, it, beforeEach } from 'vitest';
import {
  audioClipPropertyBinding,
  canonicalBindingKey,
  type Composition,
  type JoyProjectV1,
  type SpikeProject,
  type VisualObjectV1,
} from '@joy-media/project-schema';
import { restoreClipPropertyAnimations } from '@joy-media/property-system';
import { applyTransaction } from '@joy-media/commands';
import { emptySpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { bindClipToObject, readClipObjectMap } from './sticker-bindings.js';
import {
  buildTimelineCutPlan,
  buildTimelinePastePlan,
  clearTimelineClipClipboard,
  copyTimelineClips,
  getTimelineClipClipboard,
  projectIdsInUse,
  shiftTimelineClipState,
} from './timeline-clip-clipboard.js';

describe('timeline-clip-clipboard', () => {
  beforeEach(() => {
    clearTimelineClipClipboard();
  });

  const createSampleComposition = (): { comp: Composition; project: SpikeProject } => {
    const baseProj = emptySpikeProject({ trackCount: 0 });
    const comp: Composition = {
      ...baseProj.compositions[baseProj.rootCompositionId]!,
      durationUs: 30_000_000,
      tracks: [
        {
          id: 'V1',
          kind: 'video',
          family: 'visual',
          name: 'Visual 1',
          order: 0,
          enabled: true,
          clips: [
            {
              id: 'clip-v1-a',
              kind: 'video',
              assetId: 'asset-1',
              startUs: 1_000_000,
              durationUs: 2_000_000,
              sourceInUs: 0,
            },
            {
              id: 'clip-v1-b',
              kind: 'video',
              assetId: 'asset-2',
              startUs: 5_000_000,
              durationUs: 3_000_000,
              sourceInUs: 0,
            },
          ],
        },
        {
          id: 'A1',
          kind: 'video',
          family: 'audio',
          name: 'Audio 1',
          order: 1,
          enabled: true,
          clips: [
            {
              id: 'clip-a1-a',
              kind: 'video',
              assetId: 'asset-audio-1',
              startUs: 1_500_000,
              durationUs: 4_000_000,
              sourceInUs: 0,
            },
          ],
        },
      ],
    };

    const project: SpikeProject = {
      ...baseProj,
      compositions: { [comp.id]: comp },
    };

    return { comp, project };
  };

  describe('copyTimelineClips', () => {
    it('returns undefined when selection is empty', () => {
      const { comp } = createSampleComposition();
      expect(copyTimelineClips(comp, [])).toBeUndefined();
      expect(getTimelineClipClipboard()).toBeUndefined();
    });

    it('copies a single clip with offset 0 and stores in module clipboard', () => {
      const { comp } = createSampleComposition();
      const result = copyTimelineClips(comp, ['clip-v1-a']);

      expect(result).toBeDefined();
      expect(result?.items).toHaveLength(1);
      expect(result?.items[0]).toEqual({
        trackId: 'V1',
        clip: comp.tracks[0]!.clips[0],
        offsetUs: 0,
      });
      expect(getTimelineClipClipboard()).toEqual(result);
    });

    it('copies multiple clips across tracks preserving relative spacing', () => {
      const { comp } = createSampleComposition();
      // clip-v1-a starts at 1_000_000, clip-v1-b starts at 5_000_000, clip-a1-a starts at 1_500_000
      const result = copyTimelineClips(comp, ['clip-v1-a', 'clip-v1-b', 'clip-a1-a']);

      expect(result).not.toBeNull();
      if (!result) return;
      expect(result.items).toHaveLength(3);
      // Min start is 1_000_000
      const itemV1A = result.items.find((i) => i.clip.id === 'clip-v1-a');
      const itemV1B = result.items.find((i) => i.clip.id === 'clip-v1-b');
      const itemA1A = result.items.find((i) => i.clip.id === 'clip-a1-a');

      expect(itemV1A?.offsetUs).toBe(0);
      expect(itemV1B?.offsetUs).toBe(4_000_000); // 5_000_000 - 1_000_000
      expect(itemA1A?.offsetUs).toBe(500_000); // 1_500_000 - 1_000_000
    });
  });

  describe('buildTimelineCutPlan', () => {
    it('fails when no clips are selected', () => {
      const { comp } = createSampleComposition();
      const plan = buildTimelineCutPlan({ composition: comp, selectedClipIds: [] });
      expect(plan.ok).toBe(false);
    });

    it('fails when any selected clip is on a locked track', () => {
      const { comp } = createSampleComposition();
      const plan = buildTimelineCutPlan({
        composition: comp,
        selectedClipIds: ['clip-v1-a'],
        tracks: [{ id: 'V1', locked: true }],
      });
      expect(plan.ok).toBe(false);
      if (!plan.ok) {
        expect(plan.reason).toMatch(/unlock V1/i);
      }
    });

    it('copies clips to clipboard and builds delete transaction in one undo step', () => {
      const { comp, project } = createSampleComposition();
      const plan = buildTimelineCutPlan({
        composition: comp,
        selectedClipIds: ['clip-v1-a'],
      });

      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.clipboard.items).toHaveLength(1);
        expect(getTimelineClipClipboard()).toBeDefined();
        expect(plan.transaction.commands).toEqual([
          {
            type: 'timeline.removeClip',
            payload: { compositionId: comp.id, trackId: 'V1', clipId: 'clip-v1-a' },
          },
        ]);

        // Verify transaction executes and can be undone in one step
        const applied = applyTransaction(project, plan.transaction);
        const v1Track = applied.project.compositions[comp.id]!.tracks.find((t) => t.id === 'V1')!;
        expect(v1Track.clips.find((c) => c.id === 'clip-v1-a')).toBeUndefined();

        // Undo
        const undone = applyTransaction(applied.project, {
          label: 'undo',
          commands: applied.record.inverses,
        });
        const undoneV1 = undone.project.compositions[comp.id]!.tracks.find((t) => t.id === 'V1')!;
        expect(undoneV1.clips.find((c) => c.id === 'clip-v1-a')).toBeDefined();
      }
    });
  });

  describe('buildTimelinePastePlan', () => {
    it('fails when clipboard is empty', () => {
      const { comp } = createSampleComposition();
      const plan = buildTimelinePastePlan({ composition: comp, playheadUs: 10_000_000 });
      expect(plan.ok).toBe(false);
      if (!plan.ok) {
        expect(plan.reason).toMatch(/nothing on the clipboard/i);
      }
    });

    it('pastes at playhead on the same track with a fresh clip id', () => {
      const { comp, project } = createSampleComposition();
      copyTimelineClips(comp, ['clip-v1-a']);

      const plan = buildTimelinePastePlan({
        composition: comp,
        playheadUs: 10_000_000,
        idGenerator: (orig) => `${orig}-pasted`,
      });

      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.pastedClipIds).toEqual(['clip-v1-a-pasted']);
        expect(plan.transaction.commands).toEqual([
          {
            type: 'timeline.insertClip',
            payload: {
              compositionId: comp.id,
              trackId: 'V1',
              clip: expect.objectContaining({
                id: 'clip-v1-a-pasted',
                startUs: 10_000_000,
                durationUs: 2_000_000,
              }),
            },
          },
        ]);

        // Apply and verify
        const applied = applyTransaction(project, plan.transaction);
        const v1Track = applied.project.compositions[comp.id]!.tracks.find((t) => t.id === 'V1')!;
        const pasted = v1Track.clips.find((c) => c.id === 'clip-v1-a-pasted');
        expect(pasted).toBeDefined();
        expect(pasted?.startUs).toBe(10_000_000);

        // Undo removes pasted clip in one step
        const undone = applyTransaction(applied.project, {
          label: 'undo',
          commands: applied.record.inverses,
        });
        const undoneV1 = undone.project.compositions[comp.id]!.tracks.find((t) => t.id === 'V1')!;
        expect(undoneV1.clips.find((c) => c.id === 'clip-v1-a-pasted')).toBeUndefined();
      }
    });

    it('pastes multiple clips across tracks preserving spacing as one undo step', () => {
      const { comp, project } = createSampleComposition();
      // clip-v1-a starts at 1s (duration 2s), clip-a1-a starts at 1.5s (duration 4s)
      copyTimelineClips(comp, ['clip-v1-a', 'clip-a1-a']);

      const plan = buildTimelinePastePlan({
        composition: comp,
        playheadUs: 15_000_000,
        idGenerator: (orig, idx) => `${orig}-paste-${idx}`,
      });

      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.transaction.commands).toHaveLength(2);
        // First clip at 15s, second at 15s + 0.5s = 15.5s
        expect(plan.transaction.commands[0]).toEqual({
          type: 'timeline.insertClip',
          payload: {
            compositionId: comp.id,
            trackId: 'V1',
            clip: expect.objectContaining({
              id: 'clip-v1-a-paste-0',
              startUs: 15_000_000,
            }),
          },
        });
        expect(plan.transaction.commands[1]).toEqual({
          type: 'timeline.insertClip',
          payload: {
            compositionId: comp.id,
            trackId: 'A1',
            clip: expect.objectContaining({
              id: 'clip-a1-a-paste-1',
              startUs: 15_500_000,
            }),
          },
        });

        // Apply transaction
        const applied = applyTransaction(project, plan.transaction);
        const v1 = applied.project.compositions[comp.id]!.tracks.find((t) => t.id === 'V1')!;
        const a1 = applied.project.compositions[comp.id]!.tracks.find((t) => t.id === 'A1')!;
        expect(v1.clips.some((c) => c.id === 'clip-v1-a-paste-0')).toBe(true);
        expect(a1.clips.some((c) => c.id === 'clip-a1-a-paste-1')).toBe(true);

        // Single undo step restores both tracks
        const undone = applyTransaction(applied.project, {
          label: 'undo',
          commands: applied.record.inverses,
        });
        const undoneV1 = undone.project.compositions[comp.id]!.tracks.find((t) => t.id === 'V1')!;
        const undoneA1 = undone.project.compositions[comp.id]!.tracks.find((t) => t.id === 'A1')!;
        expect(undoneV1.clips.some((c) => c.id === 'clip-v1-a-paste-0')).toBe(false);
        expect(undoneA1.clips.some((c) => c.id === 'clip-a1-a-paste-1')).toBe(false);
      }
    });

    it('rejects pasting when target track is locked', () => {
      const { comp } = createSampleComposition();
      copyTimelineClips(comp, ['clip-v1-a']);

      const plan = buildTimelinePastePlan({
        composition: comp,
        playheadUs: 10_000_000,
        tracks: [{ id: 'V1', locked: true }],
      });

      expect(plan.ok).toBe(false);
      if (!plan.ok) {
        expect(plan.reason).toMatch(/no unlocked video track is free/i);
      }
    });

    it('rejects pasting when clips would overlap existing media on track', () => {
      const { comp } = createSampleComposition();
      copyTimelineClips(comp, ['clip-v1-a']); // duration 2s

      // clip-v1-b exists at 5_000_000 to 8_000_000. Pasting at 4_500_000 overlaps it!
      const plan = buildTimelinePastePlan({
        composition: comp,
        playheadUs: 4_500_000,
      });

      expect(plan.ok).toBe(false);
      if (!plan.ok) {
        expect(plan.reason).toMatch(/no unlocked video track is free/i);
      }
    });

    describe('track choice (pure plan)', () => {
      const withSecondVisualTrack = (comp: Composition): Composition => ({
        ...comp,
        tracks: [
          ...comp.tracks,
          {
            id: 'V2',
            kind: 'video',
            family: 'visual',
            name: 'Visual 2',
            order: 2,
            enabled: true,
            clips: [],
          },
        ],
      });
      const idByIndex = (orig: string, idx: number) => `${orig}-p${idx}`;

      it('pastes to the source track when it is free at the playhead', () => {
        const { comp } = createSampleComposition();
        const clipboard = copyTimelineClips(comp, ['clip-v1-a'])!;
        const plan = buildTimelinePastePlan({
          composition: withSecondVisualTrack(comp),
          clipboard,
          playheadUs: 10_000_000,
          idGenerator: idByIndex,
        });
        expect(plan.ok && plan.pastes.map((p) => p.trackId)).toEqual(['V1']);
      });

      it('moves to the first free track of the same kind when the source track is busy', () => {
        const { comp } = createSampleComposition();
        const clipboard = copyTimelineClips(comp, ['clip-v1-a'])!;
        // clip-v1-b occupies 5s–8s on V1; the 2s clip at 4.5s overlaps it.
        const plan = buildTimelinePastePlan({
          composition: withSecondVisualTrack(comp),
          clipboard,
          playheadUs: 4_500_000,
          idGenerator: idByIndex,
        });
        expect(plan.ok).toBe(true);
        if (plan.ok) {
          expect(plan.pastes).toMatchObject([{ trackId: 'V2', clip: { startUs: 4_500_000 } }]);
          expect(plan.transaction.commands).toEqual([
            {
              type: 'timeline.insertClip',
              payload: {
                compositionId: comp.id,
                trackId: 'V2',
                clip: expect.objectContaining({ id: 'clip-v1-a-p0' }),
              },
            },
          ]);
        }
      });

      it('moves a locked source track to a free track of the same kind', () => {
        const { comp } = createSampleComposition();
        const clipboard = copyTimelineClips(comp, ['clip-v1-a'])!;
        const plan = buildTimelinePastePlan({
          composition: withSecondVisualTrack(comp),
          clipboard,
          playheadUs: 10_000_000,
          tracks: [{ id: 'V1', locked: true }],
          idGenerator: idByIndex,
        });
        expect(plan.ok && plan.pastes.map((p) => p.trackId)).toEqual(['V2']);
      });

      it('never moves a clip onto a track of another kind', () => {
        const { comp } = createSampleComposition();
        // The only audio track is A1; a visual clip must not land there even when V1 is busy.
        const clipboard = copyTimelineClips(comp, ['clip-v1-a'])!;
        const plan = buildTimelinePastePlan({
          composition: comp,
          clipboard,
          playheadUs: 4_500_000,
        });
        expect(plan.ok).toBe(false);
      });

      it('keeps several clips together on one free track with their offsets', () => {
        const { comp } = createSampleComposition();
        // clip-v1-a (offset 0, 2s long) and clip-v1-b (offset 4s, 3s long) both come from V1.
        const clipboard = copyTimelineClips(comp, ['clip-v1-a', 'clip-v1-b'])!;
        // Pasting at 4.5s puts the first clip over clip-v1-b on V1, so the whole group moves.
        const plan = buildTimelinePastePlan({
          composition: withSecondVisualTrack(comp),
          clipboard,
          playheadUs: 4_500_000,
          idGenerator: idByIndex,
        });
        expect(plan.ok).toBe(true);
        if (plan.ok) {
          expect(plan.pastes.map((p) => [p.trackId, p.clip.startUs])).toEqual([
            ['V2', 4_500_000],
            ['V2', 8_500_000],
          ]);
        }
      });

      it('keeps each source track on its own kind when both groups have room', () => {
        const { comp } = createSampleComposition();
        // clip-v1-a (V1, visual) and clip-a1-a (A1, audio). Free at 9s on both tracks.
        const clipboard = copyTimelineClips(comp, ['clip-v1-a', 'clip-a1-a'])!;
        const plan = buildTimelinePastePlan({
          composition: withSecondVisualTrack(comp),
          clipboard,
          playheadUs: 9_000_000,
          idGenerator: idByIndex,
        });
        expect(plan.ok && plan.pastes.map((p) => p.trackId)).toEqual(['V1', 'A1']);
      });

      it('refuses the whole paste when the audio group has no free audio track, even if the visual group fits', () => {
        const { comp } = createSampleComposition();
        // At 4.5s V1 is busy, so the visual clip goes to V2; the audio clip at 5s overlaps
        // clip-a1-a (1.5s–5.5s) on A1, and there is no other audio track.
        const clipboard = copyTimelineClips(comp, ['clip-v1-a', 'clip-a1-a'])!;
        const plan = buildTimelinePastePlan({
          composition: withSecondVisualTrack(comp),
          clipboard,
          playheadUs: 4_500_000,
          idGenerator: idByIndex,
        });
        expect(plan.ok).toBe(false);
        if (!plan.ok) expect(plan.reason).toMatch(/no unlocked audio track is free/i);
      });

      it('refuses the whole paste when no track of the right kind has room', () => {
        const { comp } = createSampleComposition();
        const clipboard = copyTimelineClips(comp, ['clip-v1-a'])!;
        const plan = buildTimelinePastePlan({
          composition: comp,
          clipboard,
          playheadUs: 4_500_000,
        });
        expect(plan).toMatchObject({ ok: false });
        if (!plan.ok)
          expect(plan.reason).toBe(
            'No unlocked video track is free at the playhead for the copied clips.',
          );
      });

      it('gives every pasted clip a unique id, even when the generator repeats', () => {
        const { comp } = createSampleComposition();
        const clipboard = copyTimelineClips(comp, ['clip-v1-a', 'clip-a1-a'])!;
        const plan = buildTimelinePastePlan({
          composition: comp,
          clipboard,
          playheadUs: 9_000_000,
          reservedIds: new Set(['taken', 'media-controller-taken']),
          idGenerator: () => 'taken',
        });
        expect(plan.ok).toBe(true);
        if (plan.ok) {
          expect(new Set(plan.pastedClipIds).size).toBe(2);
          expect(plan.pastedClipIds).not.toContain('taken');
        }
      });

      it('does not mutate the composition it reads', () => {
        const { comp } = createSampleComposition();
        const before = JSON.stringify(comp);
        const clipboard = copyTimelineClips(comp, ['clip-v1-a'])!;
        buildTimelinePastePlan({ composition: comp, clipboard, playheadUs: 9_000_000 });
        expect(JSON.stringify(comp)).toBe(before);
      });
    });

    it('collects every id the project uses: clips, visual objects and bindings', () => {
      const { project } = createSampleComposition();
      const visual = bindClipToObject(
        INITIAL_EDITOR_PROJECT,
        'clip-bound-elsewhere',
        'product-image',
      );
      const ids = projectIdsInUse(project, visual);
      expect(ids.has('clip-v1-a')).toBe(true);
      expect(ids.has('clip-a1-a')).toBe(true);
      expect(ids.has('product-image')).toBe(true);
      expect(ids.has('clip-bound-elsewhere')).toBe(true);
    });
  });

  describe('buildTimelineCutPlan (clipboard and locks)', () => {
    it('leaves the clipboard unchanged when the cut is refused by a locked track', () => {
      const { comp } = createSampleComposition();
      copyTimelineClips(comp, ['clip-v1-b']);
      const before = getTimelineClipClipboard();

      const plan = buildTimelineCutPlan({
        composition: comp,
        selectedClipIds: ['clip-v1-a'],
        tracks: [{ id: 'V1', locked: true }],
      });

      expect(plan.ok).toBe(false);
      expect(getTimelineClipClipboard()).toBe(before);
      expect(getTimelineClipClipboard()?.items.map((i) => i.clip.id)).toEqual(['clip-v1-b']);
    });

    it('refuses a cut on a track the document marks locked, even without panel flags', () => {
      const { comp } = createSampleComposition();
      const locked: Composition = {
        ...comp,
        tracks: comp.tracks.map((track) =>
          track.id === 'V1' ? { ...track, locked: true } : track,
        ),
      };
      copyTimelineClips(comp, ['clip-a1-a']);
      const before = getTimelineClipClipboard();

      const plan = buildTimelineCutPlan({ composition: locked, selectedClipIds: ['clip-v1-a'] });

      expect(plan.ok).toBe(false);
      expect(getTimelineClipClipboard()).toBe(before);
    });

    it('cuts the whole selection across tracks in one transaction', () => {
      const { comp } = createSampleComposition();
      const plan = buildTimelineCutPlan({
        composition: comp,
        selectedClipIds: ['clip-v1-a', 'clip-v1-b', 'clip-a1-a'],
      });

      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.clipboard.items.map((i) => i.clip.id).sort()).toEqual([
          'clip-a1-a',
          'clip-v1-a',
          'clip-v1-b',
        ]);
        expect(plan.removedClipIds).toHaveLength(3);
        expect(plan.transaction.commands).toHaveLength(3);
        expect(plan.transaction.label).toBe('Cut 3 clips');
      }
    });
  });

  describe('timeline-time keys in a pasted clip state', () => {
    const scalarCurve = (times: readonly number[]) => ({
      keyframes: times.map((timeUs, index) => ({
        timeUs,
        value: index + 1,
        interpolation: 'linear' as const,
      })),
    });

    it('moves an audio clip gain key by the paste offset, and the restored key lands there', () => {
      const { comp } = createSampleComposition();
      // clip-a1-a starts at 1.5 s on A1. Its gain keys are audio-timeline (playhead) times.
      const gain = audioClipPropertyBinding('clip-a1-a', 'gain');
      const visual: JoyProjectV1 = {
        ...INITIAL_EDITOR_PROJECT,
        propertyAnimations: {
          [canonicalBindingKey(gain)]: {
            binding: gain,
            value: { kind: 'scalar', curve: scalarCurve([2_000_000, 4_000_000]) },
          },
        },
      };
      const clipboard = copyTimelineClips(comp, ['clip-a1-a'], visual)!;
      expect(clipboard.items[0]!.state?.animations).toHaveLength(1);

      const plan = buildTimelinePastePlan({
        composition: comp,
        clipboard,
        playheadUs: 9_000_000,
        idGenerator: (orig) => `${orig}-p`,
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;

      // Shift = 9 s - 1.5 s = 7.5 s, so both gain keys move by the same offset.
      const pasted = plan.pastes[0]!;
      expect(pasted.state?.animations[0]?.binding).toEqual(gain);
      expect(pasted.state?.animations[0]?.value).toEqual({
        kind: 'scalar',
        curve: scalarCurve([9_500_000, 11_500_000]),
      });

      const restored = restoreClipPropertyAnimations(visual, pasted.state!.animations, {
        clipId: pasted.clipId,
      });
      const key = canonicalBindingKey(audioClipPropertyBinding(pasted.clipId, 'gain'));
      expect(restored.propertyAnimations?.[key]?.value).toEqual({
        kind: 'scalar',
        curve: scalarCurve([9_500_000, 11_500_000]),
      });
    });

    it('collapses object curve and spatial path keys below 0 on a negative shift', () => {
      const bound = bindClipToObject(INITIAL_EDITOR_PROJECT, 'clip-a1-a', 'product-image');
      const base = bound.visualObjects[readClipObjectMap(bound)['clip-a1-a']!]!;
      const object: VisualObjectV1 = {
        ...base,
        animations: {
          opacity: scalarCurve([1_000_000, 3_000_000, 6_000_000]),
        },
        spatialPath: {
          keyframes: [
            { timeUs: 2_000_000, point: { x: 10, y: 0 }, interpolation: 'linear' },
            { timeUs: 5_000_000, point: { x: 20, y: 0 }, interpolation: 'linear' },
            { timeUs: 9_000_000, point: { x: 30, y: 0 }, interpolation: 'linear' },
          ],
        },
      };

      const shifted = shiftTimelineClipState({ object, animations: [] }, -4_000_000);

      // 1 s and 3 s both fall below 0 after the 4 s shift; the latest (3 s, value 2) is kept.
      expect(shifted.object?.animations?.opacity?.keyframes).toEqual([
        { timeUs: 0, value: 2, interpolation: 'linear' },
        { timeUs: 2_000_000, value: 3, interpolation: 'linear' },
      ]);
      // The spatial key at 2 s collapses onto 0 and keeps its point; the others move by -4 s.
      expect(shifted.object?.spatialPath?.keyframes).toEqual([
        { timeUs: 0, point: { x: 10, y: 0 }, interpolation: 'linear' },
        { timeUs: 1_000_000, point: { x: 20, y: 0 }, interpolation: 'linear' },
        { timeUs: 5_000_000, point: { x: 30, y: 0 }, interpolation: 'linear' },
      ]);
      // The input object is not changed.
      expect(object.animations?.opacity?.keyframes[0]?.timeUs).toBe(1_000_000);
      expect(object.spatialPath?.keyframes[0]?.timeUs).toBe(2_000_000);
    });
  });
});

import { describe, expect, it, beforeEach } from 'vitest';
import type { Composition, SpikeProject } from '@joy-media/project-schema';
import { applyTransaction } from '@joy-media/commands';
import { emptySpikeProject } from '@joy-media/test-fixtures';
import {
  buildTimelineCutPlan,
  buildTimelinePastePlan,
  clearTimelineClipClipboard,
  copyTimelineClips,
  getTimelineClipClipboard,
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
        expect(plan.reason).toMatch(/unlock track "V1"/i);
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
        expect(plan.reason).toMatch(/would overlap existing media/i);
      }
    });
  });
});

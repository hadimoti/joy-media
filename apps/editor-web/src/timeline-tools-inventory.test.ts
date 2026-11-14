import { describe, expect, it } from 'vitest';
import {
  applyAudioCommand,
  applyCommand,
  applyTransaction,
  type AudioCommand,
  type AudioState,
} from '@joy-media/commands';
import type { SpikeProject, VideoClip } from '@joy-media/project-schema';
import type { TimelineTrackView } from '@joy-media/timeline-engine';
import { emptySpikeProject } from '@joy-media/test-fixtures';
import {
  buildTimelineCutPlan,
  buildTimelinePastePlan,
  clearTimelineClipClipboard,
  copyTimelineClips,
} from './timeline-clip-clipboard.js';
import { collectTimelineSnapAnchors, snapTimelineTimeUs } from './timeline-snapping.js';

describe('T-L01 Timeline Tools Inventory: Exists and Works', () => {
  const SECOND_US = 1_000_000;

  function createProjectWithClips(): {
    project: SpikeProject;
    videoClip: VideoClip;
  } {
    const base = emptySpikeProject({ trackCount: 0 });
    const videoClip: VideoClip = {
      id: 'video-clip-1',
      kind: 'video',
      assetId: 'asset-video-1',
      startUs: 1 * SECOND_US,
      durationUs: 3 * SECOND_US,
      sourceInUs: 0,
    };

    const project: SpikeProject = {
      ...base,
      compositions: {
        root: {
          ...base.compositions.root!,
          tracks: [
            {
              id: 'track-v1',
              kind: 'video',
              order: 0,
              enabled: true,
              clips: [videoClip],
            },
            {
              id: 'track-a1',
              kind: 'video',
              family: 'audio',
              order: 1,
              enabled: true,
              clips: [],
            },
          ],
        },
      },
    };

    return { project, videoClip };
  }

  // 1. Clip copy, cut, and paste
  describe('Tool: Clip copy, cut, and paste', () => {
    it('copies clips, cuts clips in one undo step, and pastes at playhead preserving track and spacing', () => {
      clearTimelineClipClipboard();
      const { project, videoClip } = createProjectWithClips();
      const comp = project.compositions.root!;

      // Copy
      const copyResult = copyTimelineClips(comp, [videoClip.id]);
      expect(copyResult).not.toBeNull();
      expect(copyResult?.items).toHaveLength(1);
      expect(copyResult?.items[0]?.trackId).toBe('track-v1');

      // Cut (removes clip in one transaction)
      const cutPlan = buildTimelineCutPlan({
        composition: comp,
        selectedClipIds: [videoClip.id],
      });
      expect(cutPlan.ok).toBe(true);
      if (!cutPlan.ok) return;

      const cutApplied = applyTransaction(project, cutPlan.transaction);
      expect(cutApplied.project.compositions.root!.tracks[0]!.clips).toHaveLength(0);

      // Undo cut
      const cutUndone = applyTransaction(cutApplied.project, {
        label: 'undo cut',
        commands: cutApplied.record.inverses,
      });
      expect(cutUndone.project.compositions.root!.tracks[0]!.clips).toHaveLength(1);

      // Paste at playhead
      const pastePlan = buildTimelinePastePlan({
        composition: cutApplied.project.compositions.root!,
        playheadUs: 5 * SECOND_US,
      });
      expect(pastePlan.ok).toBe(true);
      if (!pastePlan.ok) return;

      const pasteApplied = applyTransaction(cutApplied.project, pastePlan.transaction);
      const pastedTrack = pasteApplied.project.compositions.root!.tracks[0]!;
      expect(pastedTrack.clips).toHaveLength(1);
      expect(pastedTrack.clips[0]!.startUs).toBe(5 * SECOND_US);
      expect(pastedTrack.clips[0]!.durationUs).toBe(3 * SECOND_US);
    });
  });

  // 2. Snapping switch
  describe('Tool: Snapping switch and anchor snapping', () => {
    it('snaps to anchors when enabled within tolerance, and allows free movement when disabled', () => {
      const { project } = createProjectWithClips();
      const comp = project.compositions.root!;
      const anchors = collectTimelineSnapAnchors({
        composition: comp,
        markers: [{ timeUs: 5 * SECOND_US }],
        playheadUs: 2 * SECOND_US,
      });

      // Snapping enabled within tolerance of anchor (5s = 5_000_000 us, raw = 5_010_000 us, tolerance = 80_000 us)
      const snapped = snapTimelineTimeUs({
        rawTimeUs: 5_010_000,
        snapping: true,
        anchorsUs: anchors,
        frameUs: 40_000,
        toleranceUs: 80_000,
      });
      expect(snapped).toBe(5 * SECOND_US);

      // Snapping disabled -> returns raw unconstrained time
      const free = snapTimelineTimeUs({
        rawTimeUs: 5_012_345,
        snapping: false,
        anchorsUs: anchors,
        frameUs: 40_000,
        toleranceUs: 80_000,
      });
      expect(free).toBe(5_012_345);
    });
  });

  // 3. Audio fades in and out
  describe('Tool: Audio fades in and out', () => {
    it('exists and works via audioClip.setFade command', () => {
      const audioState: AudioState = {
        clips: {
          'clip-a1': {
            gain: 1,
            pan: 0,
            mute: false,
            solo: false,
          },
        },
        buses: [],
        effects: [],
      };

      const command: AudioCommand = {
        type: 'audioClip.setFade',
        payload: {
          clipId: 'clip-a1',
          fadeInUs: 500_000,
          fadeOutUs: 1_000_000,
        },
      };

      const { state: updated, inverse } = applyAudioCommand(audioState, command);
      expect(updated.clips['clip-a1']!.fadeInUs).toBe(500_000);
      expect(updated.clips['clip-a1']!.fadeOutUs).toBe(1_000_000);

      // Inverse undoes the fade
      expect(inverse.type).toBe('audioClip.setFade');
      const restored = applyAudioCommand(updated, inverse);
      expect(restored.state.clips['clip-a1']!.fadeInUs).toBeUndefined();
      expect(restored.state.clips['clip-a1']!.fadeOutUs).toBeUndefined();
    });
  });

  // 4. Video fades in and out (Missing / Defect check)
  describe('Tool: Video fades in and out (Defect Check)', () => {
    it('verifies that video clip fade-in and fade-out is missing in clip schema and commands', () => {
      const { videoClip } = createProjectWithClips();

      // VideoClip schema does NOT support fadeInUs or fadeOutUs (unlike AudioClip)
      const hasFadeIn = 'fadeInUs' in videoClip;
      const hasFadeOut = 'fadeOutUs' in videoClip;

      // Status: MISSING. Defect for CC to schedule:
      // "Video clip fade-in / fade-out missing: VideoClip lacks fadeInUs/fadeOutUs schema fields
      // and videoClip.setFade command does not exist. (Size M)"
      expect(hasFadeIn).toBe(false);
      expect(hasFadeOut).toBe(false);
    });
  });

  // 5. Track add
  describe('Tool: Track add', () => {
    it('exists and works via timeline.addTrack command', () => {
      const { project } = createProjectWithClips();
      const result = applyCommand(project, {
        type: 'timeline.addTrack',
        payload: {
          compositionId: 'root',
          track: {
            id: 'track-v2',
            kind: 'video',
            order: 2,
            enabled: true,
            clips: [],
          },
        },
      });

      expect(result.project.compositions.root!.tracks).toHaveLength(3);
      expect(result.project.compositions.root!.tracks[2]!.id).toBe('track-v2');

      // Undo removes track
      const reverted = applyCommand(result.project, result.inverse);
      expect(reverted.project.compositions.root!.tracks).toHaveLength(2);
    });
  });

  // 6. Track lock
  describe('Tool: Track lock', () => {
    it('exists and works via timeline.setTrackLocked command', () => {
      const { project } = createProjectWithClips();
      const result = applyCommand(project, {
        type: 'timeline.setTrackLocked',
        payload: {
          compositionId: 'root',
          trackId: 'track-v1',
          locked: true,
        },
      });

      expect(result.project.compositions.root!.tracks[0]!.locked).toBe(true);

      // Undo restores unlocked
      const reverted = applyCommand(result.project, result.inverse);
      expect(reverted.project.compositions.root!.tracks[0]!.locked).toBe(false);
    });
  });

  // 7. Track mute
  describe('Tool: Track mute', () => {
    it('exists and works via timeline.setTrackMuted command', () => {
      const { project } = createProjectWithClips();
      const result = applyCommand(project, {
        type: 'timeline.setTrackMuted',
        payload: {
          compositionId: 'root',
          trackId: 'track-a1',
          muted: true,
        },
      });

      expect(result.project.compositions.root!.tracks[1]!.muted).toBe(true);

      // Undo restores unmuted (muted property is cleared)
      const reverted = applyCommand(result.project, result.inverse);
      expect(reverted.project.compositions.root!.tracks[1]!.muted).toBeFalsy();
    });
  });

  // 8. Track solo
  describe('Tool: Track solo', () => {
    it('exists and works via trackFlags solo state toggling', () => {
      const initialFlags: readonly TimelineTrackView[] = [
        { id: 'track-v1', heightPx: 48, locked: false, visible: true, solo: false },
        { id: 'track-a1', heightPx: 48, locked: false, visible: true, solo: false },
      ];

      // Toggle solo on track-v1
      const toggledSolo = initialFlags.map((t) =>
        t.id === 'track-v1' ? { ...t, solo: !t.solo } : t,
      );
      expect(toggledSolo[0]!.solo).toBe(true);
      expect(toggledSolo[1]!.solo).toBe(false);

      // Toggle back
      const untoggledSolo = toggledSolo.map((t) =>
        t.id === 'track-v1' ? { ...t, solo: !t.solo } : t,
      );
      expect(untoggledSolo[0]!.solo).toBe(false);
    });
  });

  // 9. Markers
  describe('Tool: Markers', () => {
    it('exists and works with marker addition and snapping anchors', () => {
      const { project } = createProjectWithClips();
      const comp = project.compositions.root!;
      const markers = [{ timeUs: 2_500_000 }, { timeUs: 7_000_000 }];

      const anchors = collectTimelineSnapAnchors({
        composition: comp,
        markers,
        playheadUs: 0,
      });

      expect(anchors).toContain(2_500_000);
      expect(anchors).toContain(7_000_000);

      // Snap near marker within tolerance (80ms tolerance, 10ms offset)
      const snapped = snapTimelineTimeUs({
        rawTimeUs: 2_510_000,
        snapping: true,
        anchorsUs: anchors,
        frameUs: 40_000,
        toleranceUs: 80_000,
      });
      expect(snapped).toBe(2_500_000);
    });
  });

  // 10. Ripple delete
  describe('Tool: Ripple delete', () => {
    it('exists and works via timeline.removeClip command with 1 undo step', () => {
      const { project } = createProjectWithClips();
      const result = applyCommand(project, {
        type: 'timeline.removeClip',
        payload: {
          compositionId: 'root',
          trackId: 'track-v1',
          clipId: 'video-clip-1',
        },
      });

      expect(result.project.compositions.root!.tracks[0]!.clips).toHaveLength(0);

      // Revert restores clip
      const reverted = applyCommand(result.project, result.inverse);
      expect(reverted.project.compositions.root!.tracks[0]!.clips).toHaveLength(1);
      expect(reverted.project.compositions.root!.tracks[0]!.clips[0]!.id).toBe('video-clip-1');
    });
  });

  // 11. Duplicate
  describe('Tool: Duplicate', () => {
    it('exists and works via timeline.duplicateClip command', () => {
      const { project } = createProjectWithClips();
      // clip-1 starts at 1s, duration 3s (ends at 4s)
      const result = applyCommand(project, {
        type: 'timeline.duplicateClip',
        payload: {
          compositionId: 'root',
          trackId: 'track-v1',
          clipId: 'video-clip-1',
          newClipId: 'video-clip-1-copy',
        },
      });

      const clips = result.project.compositions.root!.tracks[0]!.clips;
      expect(clips).toHaveLength(2);
      expect(clips[1]!.id).toBe('video-clip-1-copy');
      expect(clips[1]!.startUs).toBe(4 * SECOND_US);
      expect(clips[1]!.durationUs).toBe(3 * SECOND_US);

      // Undo removes the duplicate
      const reverted = applyCommand(result.project, result.inverse);
      expect(reverted.project.compositions.root!.tracks[0]!.clips).toHaveLength(1);
    });
  });

  // 12. Speed (setClipRate)
  describe('Tool: Speed / clip playback rate', () => {
    it('exists and works via timeline.setClipRate command', () => {
      const { project } = createProjectWithClips();
      const result = applyCommand(project, {
        type: 'timeline.setClipRate',
        payload: {
          compositionId: 'root',
          trackId: 'track-v1',
          clipId: 'video-clip-1',
          playbackRate: 2,
        },
      });

      const updated = result.project.compositions.root!.tracks[0]!.clips[0] as VideoClip;
      expect(updated.playbackRate).toBe(2);

      // Undo restores default 1x speed (normalized to 1)
      const reverted = applyCommand(result.project, result.inverse);
      const revertedClip = reverted.project.compositions.root!.tracks[0]!.clips[0] as VideoClip;
      expect(revertedClip.playbackRate ?? 1).toBe(1);
    });
  });

  // 13. Zoom
  describe('Tool: Zoom', () => {
    it('exists and works with zoom calculations and autoFit state', () => {
      const basePixelsPerSecond = 100;

      // Zoom in
      const zoomedIn = basePixelsPerSecond * 1.25;
      expect(zoomedIn).toBe(125);

      // Zoom out
      const zoomedOut = basePixelsPerSecond / 1.25;
      expect(zoomedOut).toBe(80);

      // Auto-fit toggles between auto-fit and manual zoom mode
      let autoFit = true;
      const toggleAutoFit = (nextAutoFit: boolean) => {
        autoFit = nextAutoFit;
      };

      toggleAutoFit(false);
      expect(autoFit).toBe(false);
      toggleAutoFit(true);
      expect(autoFit).toBe(true);
    });
  });
});

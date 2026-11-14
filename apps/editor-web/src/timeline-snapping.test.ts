import { describe, expect, it } from 'vitest';
import type { Composition } from '@joy-media/project-schema';
import {
  collectTimelineSnapAnchors,
  DEFAULT_SNAP_THRESHOLD_PX,
  snapTimelineTimeUs,
} from './timeline-snapping.js';

describe('timeline-snapping', () => {
  const FRAME_US = 33_333; // ~30 fps (33.333 ms per frame)

  describe('snapTimelineTimeUs', () => {
    it('snaps to nearest anchor within tolerance when snapping is ON', () => {
      const anchors = [1_000_000, 2_000_000, 3_000_000];
      const toleranceUs = 50_000;

      // Close to 2_000_000 (within 50ms)
      const snapped = snapTimelineTimeUs({
        rawTimeUs: 2_020_000,
        snapping: true,
        anchorsUs: anchors,
        frameUs: FRAME_US,
        toleranceUs,
      });

      expect(snapped).toBe(2_000_000);
    });

    it('falls back to frame steps when no anchor is within tolerance and snapping is ON', () => {
      const anchors = [1_000_000, 3_000_000];
      const toleranceUs = 10_000;

      // 2_000_000 is far from 1s and 3s, so snaps to frame step
      const snapped = snapTimelineTimeUs({
        rawTimeUs: 100_000,
        snapping: true,
        anchorsUs: anchors,
        frameUs: FRAME_US,
        toleranceUs,
      });

      // 100_000 / 33_333 = 3 frames (99_999)
      expect(snapped).toBe(99_999);
    });

    it('returns raw free time when snapping is OFF', () => {
      const anchors = [1_000_000, 2_000_000];
      const toleranceUs = 50_000;

      const snapped = snapTimelineTimeUs({
        rawTimeUs: 2_012_345,
        snapping: false,
        anchorsUs: anchors,
        frameUs: FRAME_US,
        toleranceUs,
      });

      expect(snapped).toBe(2_012_345);
    });

    it('clamps negative raw time to zero', () => {
      const snapped = snapTimelineTimeUs({
        rawTimeUs: -50_000,
        snapping: true,
        anchorsUs: [0, 1_000_000],
        frameUs: FRAME_US,
        toleranceUs: 10_000,
      });

      expect(snapped).toBe(0);
    });
  });

  describe('collectTimelineSnapAnchors', () => {
    it('aggregates playhead, markers, and clip start and end edges', () => {
      const composition: Composition = {
        id: 'comp-1',
        name: 'Composition 1',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        durationUs: 10_000_000,
        tracks: [
          {
            id: 'V1',
            kind: 'video',
            family: 'visual',
            name: 'V1',
            order: 0,
            enabled: true,
            clips: [
              {
                id: 'clip-1',
                kind: 'video',
                assetId: 'asset-1',
                startUs: 500_000,
                durationUs: 2_000_000,
                sourceInUs: 0,
              },
            ],
          },
          {
            id: 'A1',
            kind: 'video',
            family: 'audio',
            name: 'A1',
            order: 1,
            enabled: true,
            clips: [
              {
                id: 'clip-2',
                kind: 'video',
                assetId: 'asset-2',
                startUs: 4_000_000,
                durationUs: 1_500_000,
                sourceInUs: 0,
              },
            ],
          },
        ],
      };

      const markers = [{ timeUs: 1_200_000 }, { timeUs: 7_000_000 }];
      const playheadUs = 800_000;

      const anchors = collectTimelineSnapAnchors({
        composition,
        markers,
        playheadUs,
      });

      expect(anchors).toEqual([
        500_000, // clip-1 start
        800_000, // playhead
        1_200_000, // marker 1
        2_500_000, // clip-1 end (500k + 2000k)
        4_000_000, // clip-2 start
        5_500_000, // clip-2 end (4000k + 1500k)
        7_000_000, // marker 2
      ]);
    });

    it('excludes specified clip when dragging it', () => {
      const composition: Composition = {
        id: 'comp-1',
        name: 'Composition 1',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        durationUs: 10_000_000,
        tracks: [
          {
            id: 'V1',
            kind: 'video',
            family: 'visual',
            name: 'V1',
            order: 0,
            enabled: true,
            clips: [
              {
                id: 'dragging-clip',
                kind: 'video',
                assetId: 'asset-1',
                startUs: 1_000_000,
                durationUs: 1_000_000,
                sourceInUs: 0,
              },
              {
                id: 'stationary-clip',
                kind: 'video',
                assetId: 'asset-2',
                startUs: 3_000_000,
                durationUs: 1_000_000,
                sourceInUs: 0,
              },
            ],
          },
        ],
      };

      const anchors = collectTimelineSnapAnchors({
        composition,
        excludeClipId: 'dragging-clip',
      });

      expect(anchors).toEqual([3_000_000, 4_000_000]);
    });
  });

  describe('DEFAULT_SNAP_THRESHOLD_PX', () => {
    it('is configured to 8 pixels', () => {
      expect(DEFAULT_SNAP_THRESHOLD_PX).toBe(8);
    });
  });
});

import { applyTransaction } from '@joy-media/commands';
import type { Composition } from '@joy-media/project-schema';
import { describe, expect, it } from 'vitest';
import { buildTimelineMediaImportTransaction } from './timeline-media-import.js';
import * as timelineMediaImport from './timeline-media-import.js';

describe('timeline OS-drop placement', () => {
  it('snaps to the nearest playhead, marker, or clip edge within the pointer tolerance', () => {
    expect(
      timelineMediaImport.snapTimelineDropTimeUs?.({
        rawTimeUs: 1_018_000,
        anchorsUs: [1_000_000, 1_020_000, 1_050_000],
        frameUs: 33_333,
        toleranceUs: 25_000,
      }),
    ).toBe(1_020_000);
  });

  it('falls back to frame snapping when no timeline anchor is close', () => {
    expect(
      timelineMediaImport.snapTimelineDropTimeUs?.({
        rawTimeUs: 1_012_000,
        anchorsUs: [500_000, 2_000_000],
        frameUs: 33_333,
        toleranceUs: 10_000,
      }),
    ).toBe(999_990);
  });

  it('sorts multi-file drops in natural filename order before importing', () => {
    const files = ['shot10.mp4', 'shot2.mp4', 'shot1.mp4'].map((name) => ({ name }) as File);
    expect(timelineMediaImport.sortDroppedMediaFiles?.(files).map((file) => file.name)).toEqual([
      'shot1.mp4',
      'shot2.mp4',
      'shot10.mp4',
    ]);
  });

  it('uses the chosen track and places a batch sequentially from the snapped time', () => {
    const target = baseComposition();
    const transaction = buildTimelineMediaImportTransaction(
      target,
      [media('first', 'video', 1_000_000), media('second', 'video', 2_000_000)],
      0,
      new Set(),
      (asset) => `clip-${asset.id}`,
      { mode: 'timeline-track', startUs: 3_000_000, targetTrackId: 'V1' },
    );
    const project = applyTransaction(
      {
        schemaVersion: 0 as const,
        id: 'project',
        rootCompositionId: target.id,
        compositions: { [target.id]: target },
      },
      transaction,
    ).project;
    const track = project.compositions.root!.tracks.find((item) => item.id === 'V1')!;

    expect(
      track.clips.map((clip) => ({
        id: clip.id,
        startUs: clip.startUs,
        durationUs: clip.durationUs,
      })),
    ).toEqual([
      { id: 'existing', startUs: 0, durationUs: 2_000_000 },
      { id: 'clip-first', startUs: 3_000_000, durationUs: 1_000_000 },
      { id: 'clip-second', startUs: 4_000_000, durationUs: 2_000_000 },
    ]);
  });

  it('uses the first free visual track for a monitor drop at the playhead', () => {
    const target = baseComposition({
      tracks: [track('V1', 0, [{ id: 'busy', startUs: 0, durationUs: 2_000_000 }]), track('V2', 1)],
    });
    const transaction = buildTimelineMediaImportTransaction(
      target,
      [media('monitor-file', 'video', 1_000_000)],
      0,
      new Set(),
      (asset) => `clip-${asset.id}`,
      { mode: 'first-free', startUs: 0 },
    );

    expect(transaction.commands).toContainEqual(
      expect.objectContaining({
        type: 'timeline.insertClip',
        payload: expect.objectContaining({
          trackId: 'V2',
          clip: expect.objectContaining({ id: 'clip-monitor-file', startUs: 0 }),
        }),
      }),
    );
  });

  it('creates a new visual track when the drop is below the last timeline track', () => {
    const target = baseComposition();
    const transaction = buildTimelineMediaImportTransaction(
      target,
      [media('new-lane-file', 'image', 1_000_000)],
      0,
      new Set(),
      (asset) => `clip-${asset.id}`,
      { mode: 'new-track', startUs: 2_000_000 },
    );

    expect(transaction.commands).toContainEqual(
      expect.objectContaining({
        type: 'timeline.addTrack',
        payload: expect.objectContaining({ track: expect.objectContaining({ id: 'V2' }) }),
      }),
    );
    expect(transaction.commands).toContainEqual(
      expect.objectContaining({
        type: 'timeline.insertClip',
        payload: expect.objectContaining({
          trackId: 'V2',
          clip: expect.objectContaining({ startUs: 2_000_000 }),
        }),
      }),
    );
  });
});

function media(id: string, kind: 'video' | 'image' | 'audio', durationUs: number) {
  return { id, kind, displayName: `${id}.mp4`, descriptor: { durationUs } } as const;
}

function track(
  id: string,
  order: number,
  clips: { id: string; startUs: number; durationUs: number }[] = [],
) {
  return {
    id,
    kind: 'video' as const,
    family: 'visual' as const,
    order,
    enabled: true,
    clips: clips.map((clip) => ({
      id: clip.id,
      kind: 'video' as const,
      assetId: clip.id,
      startUs: clip.startUs,
      durationUs: clip.durationUs,
      sourceInUs: 0,
    })),
  };
}

function baseComposition(overrides: Partial<Composition> = {}): Composition {
  return {
    id: 'root',
    name: 'Root',
    width: 1920,
    height: 1080,
    frameRate: { num: 30, den: 1 },
    durationUs: 30_000_000,
    tracks: [track('V1', 0, [{ id: 'existing', startUs: 0, durationUs: 2_000_000 }])],
    ...overrides,
  };
}

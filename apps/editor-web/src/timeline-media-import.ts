import type { CommandTransaction } from '@joy-media/commands';
import type { Clip, Composition, Track, VideoClip } from '@joy-media/project-schema';
import { timelineTrackFamily } from './timeline-track-family.js';

const SNAP_US = 100_000;
const DEFAULT_STILL_DURATION_US = 5_000_000;

export interface TimelineMediaAsset {
  readonly id: string;
  readonly kind: 'video' | 'audio' | 'image';
  readonly displayName: string;
  readonly descriptor: {
    readonly mimeType?: string;
    readonly durationUs?: number;
    readonly width?: number;
    readonly height?: number;
  };
}

/**
 * Builds one atomic transaction for a completed cloud-import batch. Planned
 * clips participate in gap finding, so files selected together cannot overlap
 * or repeatedly create the same track from a stale React render.
 */
export function buildTimelineMediaImportTransaction(
  composition: Composition,
  assets: readonly TimelineMediaAsset[],
  playheadUs: number,
  lockedTrackIds: ReadonlySet<string> = new Set(),
  createClipId: (asset: TimelineMediaAsset, index: number) => string = defaultClipId,
): CommandTransaction {
  const workingTracks = composition.tracks.map(cloneTrack);
  const commands: CommandTransaction['commands'][number][] = [];
  const usedClipIds = new Set(workingTracks.flatMap((track) => track.clips.map((clip) => clip.id)));

  for (const [index, asset] of assets.entries()) {
    const family = asset.kind === 'audio' ? 'audio' : 'visual';
    // Every visual type shares a visual stack. Audio is deliberately kept in
    // the audio stack below it, matching professional editor topology.
    let track = workingTracks.find(
      (candidate) => !lockedTrackIds.has(candidate.id) && timelineTrackFamily(candidate) === family,
    );
    const durationUs = safeDurationUs(asset);
    const clip: VideoClip = {
      id: uniqueClipId(createClipId(asset, index), usedClipIds),
      kind: 'video',
      assetId: asset.id,
      startUs: findNonOverlappingStart(track?.clips ?? [], playheadUs, durationUs),
      durationUs,
      sourceInUs: 0,
    };
    usedClipIds.add(clip.id);

    if (track === undefined) {
      track = {
        id: nextTrackId(workingTracks),
        kind: 'video',
        family,
        name:
          family === 'audio'
            ? `Audio ${nextFamilyIndex(workingTracks, family)}`
            : `Visual ${nextFamilyIndex(workingTracks, family)}`,
        order: nextTrackOrder(workingTracks),
        enabled: true,
        clips: [clip],
      };
      workingTracks.push(track);
      commands.push({
        type: 'timeline.addTrack',
        payload: { compositionId: composition.id, track: { ...track, clips: [] } },
      });
      commands.push({
        type: 'timeline.insertClip',
        payload: { compositionId: composition.id, trackId: track.id, clip },
      });
      continue;
    }

    const targetTrack = track;
    targetTrack.clips.push(clip);
    targetTrack.clips.sort((left, right) => left.startUs - right.startUs);
    commands.push({
      type: 'timeline.insertClip',
      payload: { compositionId: composition.id, trackId: targetTrack.id, clip },
    });
  }

  return {
    label:
      assets.length === 1
        ? `Import ${assets[0]!.displayName}`
        : `Import ${assets.length} media files`,
    commands,
  };
}

function cloneTrack(track: Track): MutableTrack {
  return { ...track, clips: [...track.clips] };
}

interface MutableTrack {
  readonly id: string;
  readonly kind: 'video';
  readonly family?: 'visual' | 'audio';
  readonly name?: string;
  readonly order: number;
  readonly enabled: boolean;
  readonly clips: Clip[];
}

function findNonOverlappingStart(
  clips: readonly Clip[],
  requestedUs: number,
  durationUs: number,
): number {
  let startUs = Math.max(0, Math.round(requestedUs / SNAP_US) * SNAP_US);
  for (const clip of [...clips].sort((left, right) => left.startUs - right.startUs)) {
    const endUs = clip.startUs + clip.durationUs;
    if (startUs < endUs && startUs + durationUs > clip.startUs) startUs = endUs;
  }
  return startUs;
}

function safeDurationUs(asset: TimelineMediaAsset): number {
  const durationUs = asset.descriptor.durationUs;
  return durationUs !== undefined && Number.isSafeInteger(durationUs) && durationUs > 0
    ? durationUs
    : DEFAULT_STILL_DURATION_US;
}

function nextTrackId(tracks: readonly MutableTrack[]): string {
  const used = new Set(tracks.map((track) => track.id));
  let index = 1;
  while (used.has(`track-${index}`)) index += 1;
  return `track-${index}`;
}

function nextTrackOrder(tracks: readonly MutableTrack[]): number {
  return tracks.reduce((highest, track) => Math.max(highest, track.order), -1) + 1;
}

function nextFamilyIndex(tracks: readonly MutableTrack[], family: 'visual' | 'audio'): number {
  return tracks.filter((track) => timelineTrackFamily(track) === family).length + 1;
}

function uniqueClipId(proposed: string, used: ReadonlySet<string>): string {
  const normalized = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(proposed)
    ? proposed
    : `clip-${createRandomToken()}`;
  if (!used.has(normalized)) return normalized;
  let suffix = 2;
  while (used.has(`${normalized.slice(0, 127 - String(suffix).length)}-${suffix}`)) suffix += 1;
  return `${normalized.slice(0, 127 - String(suffix).length)}-${suffix}`;
}

function defaultClipId(asset: TimelineMediaAsset): string {
  return `${asset.kind === 'audio' ? 'voice' : 'clip'}-${createRandomToken()}`;
}

function createRandomToken(): string {
  return globalThis.crypto.randomUUID?.() ?? Date.now().toString(36);
}

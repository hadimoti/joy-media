import type { CommandTransaction } from '@joy-media/commands';
import type { Clip, Composition, Track, VideoClip } from '@joy-media/project-schema';
import { nextProfessionalTrackId, timelineTrackFamily } from './timeline-track-family.js';

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

export interface TimelineMediaImportPlacement {
  readonly mode: 'timeline-track' | 'new-track' | 'first-free';
  readonly startUs: number;
  readonly targetTrackId?: string;
}

export type DroppedFilesTarget =
  | {
      readonly surface: 'timeline';
      readonly timeUs: number;
      readonly trackId?: string;
      readonly newTrack: boolean;
    }
  | { readonly surface: 'monitor'; readonly timeUs: number }
  | { readonly surface: 'media' };

export interface TimelineDropSnapOptions {
  readonly rawTimeUs: number;
  readonly anchorsUs: readonly number[];
  readonly frameUs: number;
  readonly toleranceUs: number;
}

/** Snap a drop to the closest playhead, marker, or clip edge, then to a frame. */
export function snapTimelineDropTimeUs({
  rawTimeUs,
  anchorsUs,
  frameUs,
  toleranceUs,
}: TimelineDropSnapOptions): number {
  const raw = Number.isFinite(rawTimeUs) ? Math.max(0, rawTimeUs) : 0;
  const tolerance = Number.isFinite(toleranceUs) ? Math.max(0, toleranceUs) : 0;
  let nearest: number | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const anchor of anchorsUs) {
    if (!Number.isFinite(anchor) || anchor < 0) continue;
    const distance = Math.abs(anchor - raw);
    if (distance < nearestDistance) {
      nearest = anchor;
      nearestDistance = distance;
    }
  }
  if (nearest !== undefined && nearestDistance <= tolerance) return Math.round(nearest);
  const frame = Number.isFinite(frameUs) && frameUs > 0 ? frameUs : 1;
  return Math.max(0, Math.round(Math.round(raw / frame) * frame));
}

/** Keep dropped-file import and placement in the user's natural filename order. */
export function sortDroppedMediaFiles(files: readonly File[]): File[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...files].sort(
    (left, right) => collator.compare(left.name, right.name) || left.name.localeCompare(right.name),
  );
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
  placement?: TimelineMediaImportPlacement,
): CommandTransaction {
  const workingTracks = composition.tracks.map(cloneTrack);
  const commands: CommandTransaction['commands'][number][] = [];
  const usedClipIds = new Set(workingTracks.flatMap((track) => track.clips.map((clip) => clip.id)));
  const batchTrackByFamily = new Map<'visual' | 'audio', MutableTrack>();
  const requestedStartUs = placement?.startUs ?? playheadUs;

  const createTrack = (family: 'visual' | 'audio'): MutableTrack => {
    const track: MutableTrack = {
      id: nextProfessionalTrackId(workingTracks, family),
      kind: 'video',
      family,
      name: `${family === 'audio' ? 'Audio' : 'Visual'} ${nextFamilyIndex(workingTracks, family)}`,
      order: nextTrackOrder(workingTracks),
      enabled: true,
      clips: [],
    };
    workingTracks.push(track);
    commands.push({
      type: 'timeline.addTrack',
      payload: { compositionId: composition.id, track: { ...track, clips: [] } },
    });
    return track;
  };

  for (const [index, asset] of assets.entries()) {
    const family = asset.kind === 'audio' ? 'audio' : 'visual';
    const durationUs = safeDurationUs(asset);
    let track = batchTrackByFamily.get(family);
    if (track === undefined && placement?.mode === 'new-track') {
      track = createTrack(family);
    }
    if (track === undefined && placement?.mode === 'timeline-track') {
      const target = workingTracks.find((candidate) => candidate.id === placement.targetTrackId);
      if (
        target !== undefined &&
        !isTrackLocked(target, lockedTrackIds) &&
        timelineTrackFamily(target) === family
      ) {
        track = target;
      }
    }
    if (track === undefined && placement?.mode === 'first-free') {
      track = workingTracks.find(
        (candidate) =>
          !isTrackLocked(candidate, lockedTrackIds) &&
          timelineTrackFamily(candidate) === family &&
          !hasOverlap(candidate.clips, requestedStartUs, durationUs),
      );
    }
    if (track === undefined && placement?.mode !== 'first-free') {
      // Every visual type shares a visual stack. Audio stays in the audio
      // stack below it, matching professional editor topology.
      track = workingTracks.find(
        (candidate) =>
          !isTrackLocked(candidate, lockedTrackIds) && timelineTrackFamily(candidate) === family,
      );
    }
    track ??= createTrack(family);
    batchTrackByFamily.set(family, track);

    const clip: VideoClip = {
      id: uniqueClipId(createClipId(asset, index), usedClipIds),
      kind: 'video',
      assetId: asset.id,
      startUs: findNonOverlappingStart(
        track.clips,
        requestedStartUs,
        durationUs,
        placement === undefined,
      ),
      durationUs,
      sourceInUs: 0,
    };
    usedClipIds.add(clip.id);
    track.clips.push(clip);
    track.clips.sort((left, right) => left.startUs - right.startUs);
    commands.push({
      type: 'timeline.insertClip',
      payload: { compositionId: composition.id, trackId: track.id, clip },
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
  readonly locked?: boolean;
  readonly clips: Clip[];
}

function findNonOverlappingStart(
  clips: readonly Clip[],
  requestedUs: number,
  durationUs: number,
  snapToImportGrid = true,
): number {
  let startUs = snapToImportGrid
    ? Math.max(0, Math.round(requestedUs / SNAP_US) * SNAP_US)
    : Math.max(0, Math.round(requestedUs));
  for (const clip of [...clips].sort((left, right) => left.startUs - right.startUs)) {
    const endUs = clip.startUs + clip.durationUs;
    if (startUs < endUs && startUs + durationUs > clip.startUs) startUs = endUs;
  }
  return startUs;
}

function isTrackLocked(track: MutableTrack, lockedTrackIds: ReadonlySet<string>): boolean {
  return track.locked === true || lockedTrackIds.has(track.id);
}

function hasOverlap(clips: readonly Clip[], startUs: number, durationUs: number): boolean {
  const endUs = startUs + durationUs;
  return clips.some((clip) => startUs < clip.startUs + clip.durationUs && endUs > clip.startUs);
}

function safeDurationUs(asset: TimelineMediaAsset): number {
  const durationUs = asset.descriptor.durationUs;
  return durationUs !== undefined && Number.isSafeInteger(durationUs) && durationUs > 0
    ? durationUs
    : DEFAULT_STILL_DURATION_US;
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

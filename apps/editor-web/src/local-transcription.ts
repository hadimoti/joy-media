import {
  normalizePlaybackRate,
  type SpikeProject,
  type VideoClip,
} from '@joy-media/project-schema';

export const MAX_TRANSCRIPTION_MEDIA_BYTES = 64 * 1024 * 1024;

const KNOWN_REFERENCE_ASSET_IDS = new Set(['asset-intro', 'asset-product', 'asset-outro']);

export interface CaptionTranscriptionAsset {
  readonly kind: 'video' | 'audio' | 'image' | 'model' | 'other';
  readonly bytes?: number;
  readonly descriptor?: { readonly mimeType?: string };
}

export interface CaptionTranscriptionSource {
  readonly assetId: string;
  readonly candidateKey: string;
  readonly transport: 'reference' | 'local-media';
  readonly media?: Blob;
  readonly mediaType?: string;
  readonly sourceStartUs: number;
  readonly sourceDurationUs: number;
  readonly playbackRate: number;
  readonly timelineStartUs: number;
  readonly timelineDurationUs: number;
}

export interface CaptionTranscriptionTarget {
  readonly clipId: string;
  readonly startUs: number;
  readonly durationUs: number;
}

export type CaptionTranscriptionCandidateResult =
  | { readonly state: 'candidate'; readonly source: CaptionTranscriptionSource }
  | { readonly state: 'unavailable'; readonly reason: string };

export type CaptionTranscriptionAvailability =
  | { readonly state: 'ready'; readonly source: CaptionTranscriptionSource }
  | { readonly state: 'unavailable'; readonly candidateKey?: string; readonly reason: string };

/** Resolve a supported selected source first, then the top enabled clip under the playhead. */
export function selectedOrCurrentTranscriptionCandidate(
  project: SpikeProject,
  selectedClipIds: readonly string[],
  playheadUs: number,
  assets: Readonly<Record<string, CaptionTranscriptionAsset>>,
): CaptionTranscriptionCandidateResult {
  const tracks =
    project.compositions[project.rootCompositionId]?.tracks
      .filter((track) => track.enabled)
      .sort((left, right) => right.order - left.order) ?? [];
  const clips = tracks.flatMap((track) => track.clips);
  const selected: VideoClip[] = selectedClipIds.flatMap((id) => {
    const clip = clips.find((candidate) => candidate.id === id);
    return clip?.kind === 'video' ? [clip] : [];
  });
  const current = clips.filter(
    (clip): clip is VideoClip =>
      clip.kind === 'video' &&
      playheadUs >= clip.startUs &&
      playheadUs < clip.startUs + clip.durationUs,
  );
  const candidates = selected.length > 0 ? selected : current;
  if (candidates.length === 0) {
    return { state: 'unavailable', reason: 'Select an audio or video clip to transcribe.' };
  }

  const failures: string[] = [];
  for (const clip of candidates) {
    const resolved = transcriptionSourceForClip(clip, assets[clip.assetId]);
    if (resolved.state === 'candidate') return resolved;
    failures.push(resolved.reason);
  }
  return {
    state: 'unavailable',
    reason: failures[0] ?? 'Select an audio or video clip to transcribe.',
  };
}

function transcriptionSourceForClip(
  clip: VideoClip,
  asset: CaptionTranscriptionAsset | undefined,
): CaptionTranscriptionCandidateResult {
  const playbackRate = normalizePlaybackRate(clip.playbackRate);
  if (playbackRate === 0) {
    return { state: 'unavailable', reason: 'Freeze-frame clips cannot be transcribed.' };
  }
  const base = {
    assetId: clip.assetId,
    candidateKey: clip.id,
    sourceStartUs: clip.sourceInUs,
    sourceDurationUs: Math.floor(clip.durationUs * playbackRate),
    playbackRate,
    timelineStartUs: clip.startUs,
    timelineDurationUs: clip.durationUs,
  } as const;
  if (KNOWN_REFERENCE_ASSET_IDS.has(clip.assetId)) {
    return { state: 'candidate', source: { ...base, transport: 'reference' } };
  }
  const mediaType = asset?.descriptor?.mimeType;
  if (
    asset === undefined ||
    (asset.kind !== 'audio' && asset.kind !== 'video') ||
    !isTranscribableMimeType(mediaType)
  ) {
    return { state: 'unavailable', reason: 'Select an audio or video clip to transcribe.' };
  }
  if (asset.bytes === undefined || asset.bytes < 0) {
    return {
      state: 'unavailable',
      reason: 'Original media metadata is unavailable. Re-import the source and try again.',
    };
  }
  if (asset.bytes > MAX_TRANSCRIPTION_MEDIA_BYTES) {
    return {
      state: 'unavailable',
      reason: 'This source exceeds the 64 MiB transcription limit. Use a shorter source file.',
    };
  }
  return {
    state: 'candidate',
    source: { ...base, transport: 'local-media', mediaType },
  };
}

/** Verify OPFS availability and the raw endpoint's exact byte/MIME contract. */
export async function prepareCaptionTranscriptionSource(
  result: CaptionTranscriptionCandidateResult,
  loadMedia: (assetId: string) => Promise<Blob | undefined>,
): Promise<CaptionTranscriptionAvailability> {
  if (result.state === 'unavailable') return result;
  const { source } = result;
  if (source.transport === 'reference') return { state: 'ready', source };
  const media = await loadMedia(source.assetId);
  if (media === undefined) {
    return {
      state: 'unavailable',
      candidateKey: source.candidateKey,
      reason: 'Original media is missing in this browser. Re-import the source and try again.',
    };
  }
  const mediaType = media.type || source.mediaType;
  if (!isTranscribableMimeType(mediaType)) {
    return {
      state: 'unavailable',
      candidateKey: source.candidateKey,
      reason: 'Only audio and video sources can be transcribed.',
    };
  }
  if (media.size > MAX_TRANSCRIPTION_MEDIA_BYTES) {
    return {
      state: 'unavailable',
      candidateKey: source.candidateKey,
      reason: 'This source exceeds the 64 MiB transcription limit. Use a shorter source file.',
    };
  }
  return {
    state: 'ready',
    source: { ...source, media, mediaType },
  };
}

function isTranscribableMimeType(value: string | undefined): value is string {
  return value !== undefined && /^(audio|video)\/[a-z0-9.+-]+$/iu.test(value);
}

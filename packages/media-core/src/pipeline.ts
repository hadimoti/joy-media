import { createHash } from 'node:crypto';

export interface MediaDescriptor {
  readonly durationUs: number;
  readonly width?: number;
  readonly height?: number;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly sampleRate?: number;
}
export interface ProbeInput {
  readonly format?: { readonly duration?: string };
  readonly streams?: readonly {
    readonly codec_type?: string;
    readonly codec_name?: string;
    readonly width?: number;
    readonly height?: number;
    readonly sample_rate?: string;
  }[];
}
export function normalizeProbe(input: ProbeInput): MediaDescriptor {
  const durationSeconds = Number(input.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0)
    throw new RangeError('probe duration is invalid');
  const video = input.streams?.find((stream) => stream.codec_type === 'video');
  const audio = input.streams?.find((stream) => stream.codec_type === 'audio');
  const sampleRate = audio?.sample_rate === undefined ? undefined : Number(audio.sample_rate);
  if (sampleRate !== undefined && (!Number.isSafeInteger(sampleRate) || sampleRate < 1))
    throw new RangeError('probe sample rate is invalid');
  return {
    durationUs: Math.round(durationSeconds * 1_000_000),
    ...(video?.width === undefined ? {} : { width: video.width }),
    ...(video?.height === undefined ? {} : { height: video.height }),
    ...(video?.codec_name === undefined ? {} : { videoCodec: video.codec_name }),
    ...(audio?.codec_name === undefined ? {} : { audioCodec: audio.codec_name }),
    ...(sampleRate === undefined ? {} : { sampleRate }),
  };
}

export type AssetAvailability =
  | { readonly state: 'available'; readonly opaqueLocationId: string }
  | { readonly state: 'missing'; readonly contentHash: string };
export function relinkExactHash(
  availability: AssetAvailability,
  candidateHash: string,
  opaqueLocationId: string,
): AssetAvailability {
  if (availability.state !== 'missing' || availability.contentHash !== candidateHash)
    return availability;
  return { state: 'available', opaqueLocationId };
}
export interface ProxyProfile {
  readonly maxHeight: number;
  readonly videoCodec: string;
  readonly audioCodec: string;
}
export function derivativeCacheKey(contentHash: string, profile: ProxyProfile): string {
  return createHash('sha256').update(JSON.stringify({ contentHash, profile })).digest('hex');
}

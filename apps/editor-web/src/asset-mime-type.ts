import type { AssetRecordV1 } from '@joy-media/project-schema';

const MEDIA_MIME_TYPE = /^(video|audio|image)\/[a-z0-9.+-]+$/i;

/** A valid media MIME type, with a safe kind-based fallback for platforms that omit one. */
export function assetMediaMimeType(
  kind: AssetRecordV1['kind'],
  candidates: readonly (string | undefined)[],
): string {
  for (const candidate of candidates) {
    if (candidate === undefined || !MEDIA_MIME_TYPE.test(candidate)) continue;
    const mimeKind = candidate.slice(0, candidate.indexOf('/')).toLowerCase();
    if (mimeKind !== kind)
      throw new Error(`selected asset type ${candidate} does not match ${kind} media`);
    return candidate;
  }
  return kind === 'video' || kind === 'audio' || kind === 'image'
    ? `${kind}/octet-stream`
    : 'application/octet-stream';
}

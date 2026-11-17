import { describe, expect, it } from 'vitest';
import { canonicalStagedExportMimeType } from './export-job-request.js';
import {
  createExportClipSourcePreflight,
  ExportMissingMediaError,
  preflightExportClipSources,
} from './export-preload.js';
import { MediaUnavailableError } from './media-unavailable-error.js';

describe('browser MP4 export contracts', () => {
  it('uses display labels for missing source preflight, then falls back to the clip id', async () => {
    const failure = await preflightExportClipSources(
      [
        createExportClipSourcePreflight({
          clipId: 'clip-uuid',
          clipName: 'Timeline label',
          visualAssetId: 'visual-uuid',
          visualAssetDisplayName: 'Main take.mp4',
          audioAssetId: 'audio-uuid',
          audioAssetDisplayName: 'Voiceover.wav',
        }),
        createExportClipSourcePreflight({ clipId: 'unlabeled-uuid', visualAssetId: 'asset-uuid' }),
      ],
      async (assetId) => {
        throw new MediaUnavailableError(`missing ${assetId}`);
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ExportMissingMediaError);
    expect((failure as ExportMissingMediaError).clipNames).toEqual([
      'Main take.mp4',
      'unlabeled-uuid',
    ]);
  });

  it('falls back to a readable configured audio label when visual has no display name', async () => {
    const failure = await preflightExportClipSources(
      [
        {
          clipId: 'clip-uuid',
          visualAssetId: 'visual-uuid',
          visualAssetLabel: 'visual-uuid',
          audioAssetId: 'audio-uuid',
          audioAssetLabel: 'Voiceover.wav',
        },
      ],
      async (assetId) => {
        if (assetId === 'audio-uuid') throw new MediaUnavailableError('missing audio');
        return { assetId };
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ExportMissingMediaError);
    expect((failure as ExportMissingMediaError).clipNames).toEqual(['Voiceover.wav']);
  });

  it('canonicalizes codec-qualified MP4 MIME values and rejects non-MP4', () => {
    expect(canonicalStagedExportMimeType('video/mp4;codecs=avc1.42E01E,mp4a.40.2')).toBe(
      'video/mp4',
    );
    expect(() => canonicalStagedExportMimeType('video/webm')).toThrow(/unsupported MIME/u);
  });
});

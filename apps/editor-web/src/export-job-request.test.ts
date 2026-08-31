import { describe, expect, it } from 'vitest';
import {
  canonicalStagedExportMimeType,
  createRenderExportJobPayload,
} from './export-job-request.js';

describe('render export job request', () => {
  it('normalizes codec-qualified MP4 MIME values for asset registration', () => {
    expect(canonicalStagedExportMimeType('video/mp4;codecs=avc1.42E01E,mp4a.40.2')).toBe(
      'video/mp4',
    );
    expect(canonicalStagedExportMimeType(' VIDEO/MP4 ')).toBe('video/mp4');
    expect(() => canonicalStagedExportMimeType('video/webm')).toThrow(/unsupported MIME/);
  });

  it('binds the render manifest to the opaque control-plane project', () => {
    expect(
      createRenderExportJobPayload({
        controlPlaneProjectId: 'project-control-123',
        frameCount: 30,
        revision: 7,
        width: 1080,
        height: 1920,
        frameRate: 30,
        durationUs: 1_000_000,
        preset: 'reels-1080',
      }),
    ).toEqual({
      schemaVersion: 1,
      producer: 'browser-staged-preview-export',
      frameCount: 30,
      manifest: {
        projectId: 'project-control-123',
        revision: 7,
        width: 1080,
        height: 1920,
        frameRate: 30,
        durationUs: 1_000_000,
        preset: 'reels-1080',
      },
    });
  });
});

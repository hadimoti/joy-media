import { describe, expect, it, vi } from 'vitest';
import { parseReleasePublishInput, runReleasePublish } from './release-publish-cli.js';
import type { ReleasePublisher } from './release-publish.js';

const validInput = {
  id: 'release-1',
  channel: 'stable',
  version: '1.2.0',
  downloadUrl: 'https://joyst.ir/downloads/joy-media-1.2.0.exe',
  sha256: 'a'.repeat(64),
};

describe('parseReleasePublishInput', () => {
  it('accepts a well-shaped input, with and without minSupportedVersion', () => {
    expect(parseReleasePublishInput(validInput)).toEqual({
      id: 'release-1',
      payload: {
        channel: 'stable',
        version: '1.2.0',
        downloadUrl: 'https://joyst.ir/downloads/joy-media-1.2.0.exe',
        sha256: 'a'.repeat(64),
      },
    });
    expect(parseReleasePublishInput({ ...validInput, minSupportedVersion: '1.0.0' })).toEqual({
      id: 'release-1',
      payload: {
        channel: 'stable',
        version: '1.2.0',
        downloadUrl: 'https://joyst.ir/downloads/joy-media-1.2.0.exe',
        sha256: 'a'.repeat(64),
        minSupportedVersion: '1.0.0',
      },
    });
  });

  it.each([
    ['non-object input', 'not an object'],
    ['null input', null],
    ['missing id', { ...validInput, id: undefined }],
    ['empty id', { ...validInput, id: '' }],
    ['invalid channel', { ...validInput, channel: 'nightly' }],
    ['missing version', { ...validInput, version: undefined }],
    ['non-https downloadUrl', { ...validInput, downloadUrl: 'http://joyst.ir/file.exe' }],
    ['malformed downloadUrl', { ...validInput, downloadUrl: 'not-a-url' }],
    ['short sha256', { ...validInput, sha256: 'abc' }],
    ['uppercase-invalid sha256', { ...validInput, sha256: 'g'.repeat(64) }],
    ['non-string minSupportedVersion', { ...validInput, minSupportedVersion: 1 }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseReleasePublishInput(raw)).toThrow(/RELEASE_INPUT_INVALID|must be/);
  });
});

describe('runReleasePublish', () => {
  it('validates the input then calls the injected publisher with the parsed request', async () => {
    const record = {
      id: 'release-1',
      channel: 'stable' as const,
      version: '1.2.0',
      downloadUrl: 'https://joyst.ir/downloads/joy-media-1.2.0.exe',
      sha256: 'a'.repeat(64),
      signature: 'sig',
      publishedAt: 123,
    };
    const publisher: ReleasePublisher = { publish: vi.fn(async () => record) };
    await expect(runReleasePublish(validInput, publisher)).resolves.toEqual(record);
    expect(publisher.publish).toHaveBeenCalledWith({
      id: 'release-1',
      payload: {
        channel: 'stable',
        version: '1.2.0',
        downloadUrl: 'https://joyst.ir/downloads/joy-media-1.2.0.exe',
        sha256: 'a'.repeat(64),
      },
    });
  });

  it('never calls the publisher when the input fails validation', async () => {
    const publisher: ReleasePublisher = { publish: vi.fn() };
    await expect(runReleasePublish({ ...validInput, sha256: 'bad' }, publisher)).rejects.toThrow(
      /sha256/,
    );
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});

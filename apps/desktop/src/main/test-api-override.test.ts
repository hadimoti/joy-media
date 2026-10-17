import { describe, expect, it } from 'vitest';
import { resolveTestApiBaseUrl, resolveTestDownloadDirectory } from './test-api-override.js';

describe('resolveTestApiBaseUrl', () => {
  it('ignores test endpoint configuration unless explicit test mode is enabled', () => {
    expect(
      resolveTestApiBaseUrl({
        argv: [],
        env: { JOY_MEDIA_TEST_API_BASE_URL: 'https://example.test/api' },
      }),
    ).toBeUndefined();
  });

  it('accepts an explicit loopback HTTP endpoint for packaged acceptance tests', () => {
    expect(
      resolveTestApiBaseUrl({
        argv: ['--joy-media-test-mode'],
        env: { JOY_MEDIA_TEST_API_BASE_URL: 'http://127.0.0.1:4174/' },
      }),
    ).toBe('http://127.0.0.1:4174');
  });

  it('reports a missing endpoint setting separately from an invalid URL', () => {
    expect(() => resolveTestApiBaseUrl({ argv: ['--joy-media-test-mode'], env: {} })).toThrow(
      /requires JOY_MEDIA_TEST_API_BASE_URL/,
    );
    expect(() =>
      resolveTestApiBaseUrl({
        argv: ['--joy-media-test-mode'],
        env: { JOY_MEDIA_TEST_API_BASE_URL: 'not a URL' },
      }),
    ).toThrow(/must be a valid URL/);
  });

  it.each([
    'https://media.example.test/api',
    'http://127.0.0.1:4174/api',
    'http://user:password@127.0.0.1:4174',
    'http://127.0.0.1:4174/?token=secret',
  ])('fails closed for an invalid test endpoint: %s', (endpoint) => {
    expect(() =>
      resolveTestApiBaseUrl({
        argv: ['--joy-media-test-mode'],
        env: { JOY_MEDIA_TEST_API_BASE_URL: endpoint },
      }),
    ).toThrow(/loopback HTTP origin/);
  });
});

describe('resolveTestDownloadDirectory', () => {
  const userDataDirectory = 'C:\\temp\\joy-media-profile';

  it('requires desktop test mode and confines test downloads to the disposable profile', () => {
    expect(
      resolveTestDownloadDirectory({
        argv: ['--joy-media-test-mode'],
        env: { JOY_MEDIA_TEST_DOWNLOAD_DIRECTORY: 'C:\\temp\\joy-media-profile\\downloads' },
        userDataDirectory,
      }),
    ).toBe('C:\\temp\\joy-media-profile\\downloads');
    expect(
      resolveTestDownloadDirectory({
        argv: [],
        env: { JOY_MEDIA_TEST_DOWNLOAD_DIRECTORY: 'C:\\Users\\test\\Downloads' },
        userDataDirectory,
      }),
    ).toBeUndefined();
  });

  it.each([undefined, 'C:\\Users\\test\\Downloads', 'C:\\temp\\joy-media-profile'])(
    'rejects missing or non-isolated test download paths: %s',
    (directory) => {
      expect(() =>
        resolveTestDownloadDirectory({
          argv: ['--joy-media-test-mode'],
          env: { JOY_MEDIA_TEST_DOWNLOAD_DIRECTORY: directory },
          userDataDirectory,
        }),
      ).toThrow(/inside the disposable user-data directory/);
    },
  );
});

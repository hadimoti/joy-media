import { describe, expect, it, vi } from 'vitest';
import type { BrowserAsset, BrowserAssetRegistration } from './control-plane-client.js';
import {
  describeMedia,
  importMediaFile,
  normalizedMimeType,
  sniffMediaMimeType,
  type MediaImportOptions,
} from './media-import.js';

describe('importMediaFile', () => {
  it('verifies, registers, caches, and cloud-uploads the same original', async () => {
    const calls: string[] = [];
    let registration: BrowserAssetRegistration | undefined;
    const client = {
      ensureProject: vi.fn(async () => {
        calls.push('ensure');
      }),
      registerAsset: vi.fn(async (_projectId: string, next: BrowserAssetRegistration) => {
        calls.push('register');
        registration = next;
        return browserAsset(next);
      }),
      assets: vi.fn(async () => []),
      uploadAssetOriginal: vi.fn(async (_projectId, asset, file, onProgress) => {
        calls.push('upload');
        expect(file).toBe(input);
        onProgress?.(1);
        return { ...browserAsset(registration!), ...asset };
      }),
    } satisfies NonNullable<MediaImportOptions['client']>;
    const cache = {
      put: vi.fn(async (descriptor, file) => {
        calls.push('cache');
        expect(file).toBe(input);
        expect(descriptor.sha256).toMatch(/^[a-f0-9]{64}$/);
      }),
    };
    const progress: number[] = [];
    const input = new File(['verified bytes'], 'clip.mp4', { type: 'video/mp4' });

    const result = await importMediaFile({
      projectId: 'project-1',
      projectTitle: 'Project',
      file: input,
      assetId: 'clip-1',
      client,
      originalAssetCache: cache,
      describeMedia: async () => ({ mimeType: 'video/mp4', durationUs: 2_500_000 }),
      onProgress: ({ ratio }) => progress.push(ratio),
    });

    expect(calls).toEqual(['cache', 'ensure', 'register', 'upload']);
    expect(registration).toMatchObject({
      id: 'clip-1',
      bytes: input.size,
      kind: 'video',
      descriptor: { mimeType: 'video/mp4', durationUs: 2_500_000 },
    });
    expect(result.id).toBe('clip-1');
    expect(progress.at(-1)).toBe(1);
  });

  it('resumes a failed cloud upload when the prior registration matches', async () => {
    const input = new File(['retry bytes'], 'retry.wav', { type: 'audio/wav' });
    const sha256 = await digest(input);
    const existing = browserAsset({
      id: 'retry-1',
      kind: 'audio',
      displayName: input.name,
      sha256,
      bytes: input.size,
      descriptor: { mimeType: 'audio/wav' },
      locations: [{ kind: 'opfs-cache', ref: `opfs-${sha256.slice(0, 32)}` }],
    });
    const upload = vi.fn(async () => existing);
    const client = {
      ensureProject: vi.fn(async () => undefined),
      registerAsset: vi.fn(async () => {
        throw new Error('ASSET_EXISTS: retry-1');
      }),
      assets: vi.fn(async () => [existing]),
      uploadAssetOriginal: upload,
    } satisfies NonNullable<MediaImportOptions['client']>;

    await expect(
      importMediaFile({
        projectId: 'project-1',
        projectTitle: 'Project',
        file: input,
        assetId: 'retry-1',
        client,
        originalAssetCache: { put: vi.fn(async () => undefined) },
        describeMedia: async () => ({ mimeType: 'audio/wav' }),
      }),
    ).resolves.toEqual(existing);
    expect(upload).toHaveBeenCalledOnce();
  });

  it('reuses the generated asset ID when the same File is retried after upload failure', async () => {
    const input = new File(['retry bytes'], 'retry.mp4', { type: 'video/mp4' });
    const registrations: BrowserAssetRegistration[] = [];
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary upload failure'))
      .mockImplementationOnce(async (_projectId, asset) => asset);
    const client = {
      ensureProject: vi.fn(async () => undefined),
      registerAsset: vi.fn(async (_projectId: string, registration: BrowserAssetRegistration) => {
        registrations.push(registration);
        if (registrations.length > 1) throw new Error('ASSET_EXISTS: retry');
        return browserAsset(registration);
      }),
      assets: vi.fn(async () => [browserAsset(registrations[0]!)]),
      uploadAssetOriginal: upload,
    } satisfies NonNullable<MediaImportOptions['client']>;
    const options = {
      projectId: 'project-1',
      projectTitle: 'Project',
      file: input,
      client,
      originalAssetCache: { put: vi.fn(async () => undefined) },
      describeMedia: async () => ({ mimeType: 'video/mp4' }),
      createAssetId: vi
        .fn()
        .mockReturnValueOnce('media-stable-retry')
        .mockReturnValueOnce('media-should-not-be-used'),
    } satisfies MediaImportOptions;

    await expect(importMediaFile(options)).rejects.toThrow('temporary upload failure');
    await expect(importMediaFile(options)).resolves.toMatchObject({ id: 'media-stable-retry' });

    expect(registrations.map(({ id }) => id)).toEqual(['media-stable-retry', 'media-stable-retry']);
    expect(options.createAssetId).toHaveBeenCalledOnce();
  });

  it('keeps a synthetic upload file while preserving its human-readable catalog name', async () => {
    const input = new File(['render bytes'], 'joycode-render-1.png', { type: 'image/png' });
    let registration: BrowserAssetRegistration | undefined;
    const client = {
      ensureProject: vi.fn(async () => undefined),
      registerAsset: vi.fn(async (_projectId: string, next: BrowserAssetRegistration) => {
        registration = next;
        return browserAsset(next);
      }),
      assets: vi.fn(async () => []),
      uploadAssetOriginal: vi.fn(async (_projectId, asset) => ({
        ...browserAsset(registration!),
        ...asset,
      })),
    } satisfies NonNullable<MediaImportOptions['client']>;

    await importMediaFile({
      projectId: 'project-1',
      projectTitle: 'Project',
      file: input,
      displayName: 'Product Orbit · 3D Render',
      assetId: 'render-1',
      client,
      originalAssetCache: { put: vi.fn(async () => undefined) },
      describeMedia: async () => ({ mimeType: 'image/png', width: 32, height: 32 }),
    });

    expect(registration?.displayName).toBe('Product Orbit · 3D Render');
    expect(client.uploadAssetOriginal).toHaveBeenCalledOnce();
  });

  it('does not overwrite a colliding asset registration', async () => {
    const input = new File(['new bytes'], 'clip.png', { type: 'image/png' });
    const different = browserAsset({
      id: 'taken',
      kind: 'image',
      displayName: 'old.png',
      sha256: 'a'.repeat(64),
      bytes: 99,
      descriptor: { mimeType: 'image/png' },
      locations: [{ kind: 'opfs-cache', ref: 'opfs-old' }],
    });
    const upload = vi.fn();
    const client = {
      ensureProject: vi.fn(async () => undefined),
      registerAsset: vi.fn(async () => {
        throw new Error('ASSET_EXISTS: taken');
      }),
      assets: vi.fn(async () => [different]),
      uploadAssetOriginal: upload,
    } satisfies NonNullable<MediaImportOptions['client']>;

    await expect(
      importMediaFile({
        projectId: 'project-1',
        projectTitle: 'Project',
        file: input,
        assetId: 'taken',
        client,
        originalAssetCache: { put: vi.fn(async () => undefined) },
        describeMedia: async () => ({ mimeType: 'image/png' }),
      }),
    ).rejects.toThrow('already belongs to different media');
    expect(upload).not.toHaveBeenCalled();
  });

  it('infers common media MIME types but rejects unrelated files and empty originals', async () => {
    expect(normalizedMimeType({ name: 'voice.M4A', type: '' })).toBe('audio/mp4');
    expect(() => normalizedMimeType({ name: 'notes.txt', type: '' })).toThrow('supported');

    await expect(
      importMediaFile({
        projectId: 'project-1',
        projectTitle: 'Project',
        file: new File([], 'empty.mp4', { type: 'video/mp4' }),
        originalAssetCache: { put: vi.fn(async () => undefined) },
      }),
    ).rejects.toThrow('empty');
  });

  it('sniffs image signatures before trusting a declared MIME type', () => {
    expect(sniffMediaMimeType(new TextEncoder().encode('GIF89a'), 'image/png')).toBe('image/gif');
    expect(
      sniffMediaMimeType(
        Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
        'image/png',
      ),
    ).toBe('image/webp');
  });
});

function browserAsset(registration: BrowserAssetRegistration): BrowserAsset {
  return { ...registration, projectId: 'project-1', createdAt: 1, cloudBacked: true };
}

async function digest(file: File): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('describeMedia (timed-media blob lifecycle)', () => {
  // Regression for real-service-acceptance: reimport of an exported MP4
  // surfaced `net::ERR_FILE_NOT_FOUND (blob:<opaque>:0)` because
  // describeTimedMedia revoked its object URL after removeAttribute('src')
  // + load(). The browser's resource-fetch on the now-revoked URL races
  // with cleanup. Revoke must happen before the element is detached.
  it('revokes the object URL before removing src and calling load()', async () => {
    const events: string[] = [];
    const url = 'blob:fake-timed-media';
    const fakeVideo: Record<string, unknown> = {
      preload: '',
      src: '',
      duration: 2.5,
      videoWidth: 1920,
      videoHeight: 1080,
      onloadedmetadata: null,
      onerror: null,
      removeAttribute(name: string) {
        if (name === 'src') events.push('removeAttribute:src');
      },
      load() {
        events.push('load');
      },
    };
    Object.defineProperty(fakeVideo, 'onloadedmetadata', {
      get() {
        return (this as { __onloadedmetadata?: unknown }).__onloadedmetadata ?? null;
      },
      set(handler: ((ev: Event) => unknown) | null) {
        (this as { __onloadedmetadata?: unknown }).__onloadedmetadata = handler;
        if (handler !== null) {
          // Simulate the browser firing `loadedmetadata` after `src` is set.
          queueMicrotask(() => {
            handler.call(fakeVideo as unknown as HTMLVideoElement, new Event('loadedmetadata'));
          });
        }
      },
    });

    // The test suite runs under the default Node environment (no jsdom), so
    // `globalThis.document` is undefined. describeTimedMedia's DOM branch
    // requires both `document` and `URL.createObjectURL`; install a minimal
    // document mock for the duration of this test, then restore it. Spying
    // Node's `URL.createObjectURL` / `revokeObjectURL` exercises the real
    // finally-block cleanup order without pulling in jsdom just for one
    // regression.
    type DocumentLike = Pick<Document, 'createElement'>;
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const fakeDocument: DocumentLike = {
      createElement(tag: string): HTMLElement {
        if (tag === 'video') return fakeVideo as unknown as HTMLElement;
        throw new Error(`describeMedia test stub does not implement createElement("${tag}")`);
      },
    };
    // describeTimedMedia uses `window.setTimeout` / `window.clearTimeout`
    // for the metadata-read timeout; provide thin shims that delegate to
    // the Node timer globals so the real cleanup path runs to completion.
    const fakeWindow = {
      setTimeout(handler: (...args: unknown[]) => void, ms?: number): unknown {
        return setTimeout(handler, ms);
      },
      clearTimeout(handle: unknown): void {
        clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
      },
    };
    Object.defineProperty(globalThis, 'document', {
      value: fakeDocument,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: fakeWindow,
      configurable: true,
      writable: true,
    });

    const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      events.push('createObjectURL');
      return url;
    });
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((value) => {
      events.push(`revokeObjectURL:${value}`);
    });

    try {
      const file = new File(['mp4-bytes'], 'reimport.mp4', { type: 'video/mp4' });
      const descriptor = await describeMedia(file, 'video', 'video/mp4');

      expect(createUrl).toHaveBeenCalledOnce();
      expect(revokeUrl).toHaveBeenCalledExactlyOnceWith(url);
      expect(descriptor).toEqual({
        mimeType: 'video/mp4',
        durationUs: 2_500_000,
        width: 1920,
        height: 1080,
      });

      // The revoke must happen BEFORE removeAttribute('src') and load();
      // any order that revokes last surfaces a `net::ERR_FILE_NOT_FOUND`
      // for the still-pending blob URL on Chromium during reimport.
      const revokeIndex = events.indexOf(`revokeObjectURL:${url}`);
      const removeSrcIndex = events.indexOf('removeAttribute:src');
      const loadIndex = events.indexOf('load');
      expect(revokeIndex).toBeGreaterThanOrEqual(0);
      expect(removeSrcIndex).toBeGreaterThanOrEqual(0);
      expect(loadIndex).toBeGreaterThanOrEqual(0);
      expect(revokeIndex).toBeLessThan(removeSrcIndex);
      expect(revokeIndex).toBeLessThan(loadIndex);
    } finally {
      createUrl.mockRestore();
      revokeUrl.mockRestore();
      if (originalDocument === undefined) {
        Reflect.deleteProperty(globalThis, 'document');
      } else {
        Object.defineProperty(globalThis, 'document', originalDocument);
      }
      if (originalWindow === undefined) {
        Reflect.deleteProperty(globalThis, 'window');
      } else {
        Object.defineProperty(globalThis, 'window', originalWindow);
      }
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { BrowserAsset, BrowserAssetRegistration } from './control-plane-client.js';
import {
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

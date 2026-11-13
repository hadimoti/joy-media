import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_AUDIO_STATE } from './audio-session.js';
import type {
  BrowserAsset,
  BrowserAssetRegistration,
  BrowserControlPlaneClient,
  BrowserMediaDescriptor,
} from './control-plane-client.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';
import {
  attachGeneratedJob,
  GENERATED_PICTURE_DURATION_US,
  generatedAssetIdForSha256,
  type AttachableGenerationJob,
  type AttachGeneratedJobOptions,
} from './generation-attach.js';
import { calculateMediaFitTransform } from './media-fit-transform.js';
import { readClipMediaKindMap } from './sticker-bindings.js';
import { timelineTrackFamily } from './timeline-track-family.js';

const PROJECT_ID = 'project-1';
const PICTURE_BYTES = new TextEncoder().encode('generated picture bytes');
const VIDEO_BYTES = new TextEncoder().encode('generated video bytes');

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function pictureFixture() {
  const sha256 = await sha256Hex(PICTURE_BYTES);
  const job: AttachableGenerationJob = {
    id: 'job-1',
    kind: 'image',
    provider: 'minimax',
    model: 'image-01',
    prompt: 'A red circle on white',
    state: 'completed',
    sha256,
    createdAt: '2026-11-14T10:00:00.000Z',
  };
  return {
    job,
    file: new File([PICTURE_BYTES], 'generated-picture.png', { type: 'image/png' }),
    sha256,
    assetId: generatedAssetIdForSha256(sha256),
  };
}

async function videoFixture() {
  const sha256 = await sha256Hex(VIDEO_BYTES);
  const job: AttachableGenerationJob = {
    id: 'job-video',
    kind: 'video',
    provider: 'minimax',
    model: 'video-01',
    prompt: 'A slow pan',
    state: 'completed',
    sha256,
    createdAt: '2026-11-14T10:05:00.000Z',
  };
  return {
    job,
    file: new File([VIDEO_BYTES], 'generated-clip.mp4', { type: 'video/mp4' }),
    sha256,
    assetId: generatedAssetIdForSha256(sha256),
  };
}

/** Metadata as the browser would read it from the picture file. */
const describePicture = async (
  _file: File,
  _kind: BrowserAsset['kind'],
  mimeType: string,
): Promise<BrowserMediaDescriptor> => ({ mimeType, width: 1024, height: 1024 });

function describeVideo(durationUs: number | undefined) {
  return async (
    _file: File,
    _kind: BrowserAsset['kind'],
    mimeType: string,
  ): Promise<BrowserMediaDescriptor> => ({
    mimeType,
    width: 1920,
    height: 1080,
    ...(durationUs === undefined ? {} : { durationUs }),
  });
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function newSession(): EditorSession {
  return new EditorSession(memoryStorage(), buildReferenceSpikeProject(), INITIAL_EDITOR_PROJECT);
}

/** A fake desktop library: registration, the original upload, and the ASSET_EXISTS rule. */
function fakeLibrary() {
  const records = new Map<string, BrowserAsset>();
  const registerAsset = vi.fn(
    async (projectId: string, registration: BrowserAssetRegistration): Promise<BrowserAsset> => {
      if (records.has(registration.id)) throw new Error('ASSET_EXISTS: already registered');
      const record: BrowserAsset = {
        id: registration.id,
        projectId,
        kind: registration.kind,
        displayName: registration.displayName,
        sha256: registration.sha256,
        bytes: registration.bytes,
        descriptor: registration.descriptor,
        createdAt: 0,
        cloudBacked: false,
      };
      records.set(record.id, record);
      return record;
    },
  );
  const uploadAssetOriginal = vi.fn(
    async (_projectId: string, asset: Pick<BrowserAsset, 'id'>): Promise<BrowserAsset> => {
      const record = records.get(asset.id);
      if (record === undefined) throw new Error('asset is not registered');
      return record;
    },
  );
  const client = {
    ensureProject: vi.fn(async () => undefined),
    registerAsset,
    assets: vi.fn(async () => [...records.values()]),
    uploadAssetOriginal,
  } satisfies Pick<
    BrowserControlPlaneClient,
    'ensureProject' | 'registerAsset' | 'assets' | 'uploadAssetOriginal'
  >;
  return { client, registerAsset, uploadAssetOriginal, records };
}

const cache = { put: vi.fn(async () => undefined) };

function optionsFor(
  session: EditorSession,
  library: ReturnType<typeof fakeLibrary>,
  fixture: { readonly job: AttachableGenerationJob; readonly file: File },
  overrides: Partial<AttachGeneratedJobOptions> = {},
): AttachGeneratedJobOptions {
  return {
    projectId: PROJECT_ID,
    projectTitle: 'Test project',
    job: fixture.job,
    file: fixture.file,
    session,
    audioState: EMPTY_AUDIO_STATE,
    client: library.client,
    originalAssetCache: cache,
    describeMedia: describePicture,
    placeOnTimeline: true,
    playheadUs: 0,
    ...overrides,
  };
}

function findClip(session: EditorSession, clipId: string | undefined) {
  return findClipPlacement(session, clipId)?.clip;
}

function findClipPlacement(session: EditorSession, clipId: string | undefined) {
  if (clipId === undefined) return undefined;
  for (const composition of Object.values(session.timelineProject.compositions)) {
    for (const track of composition.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === clipId);
      if (clip !== undefined) return { trackId: track.id, clip };
    }
  }
  return undefined;
}

function rootVisualTrackIds(session: EditorSession): string[] {
  const root = session.timelineProject.compositions[session.timelineProject.rootCompositionId]!;
  return root.tracks.filter((track) => timelineTrackFamily(track) === 'visual').map((t) => t.id);
}

describe('attachGeneratedJob', () => {
  it('stores the bytes in the library as a normal asset and places one fitted picture clip', async () => {
    const fixture = await pictureFixture();
    const session = newSession();
    const library = fakeLibrary();
    const root = session.timelineProject.compositions[session.timelineProject.rootCompositionId]!;

    const result = await attachGeneratedJob(optionsFor(session, library, fixture));

    expect(result.registeredAsset).toBe(true);
    expect(result.assetId).toBe(fixture.assetId);
    expect(library.registerAsset).toHaveBeenCalledTimes(1);
    const registration = library.registerAsset.mock.calls[0]![1];
    expect(registration).toMatchObject({
      id: fixture.assetId,
      kind: 'image',
      sha256: fixture.sha256,
      bytes: PICTURE_BYTES.byteLength,
    });
    expect(registration).not.toHaveProperty('internal');
    // The original bytes reach the library through the same upload as an import.
    expect(library.uploadAssetOriginal).toHaveBeenCalledTimes(1);
    expect(library.records.get(fixture.assetId)).toMatchObject({ sha256: fixture.sha256 });

    expect(session.visualProject.assets[fixture.assetId]).toMatchObject({
      id: fixture.assetId,
      kind: 'image',
      generationProvenance: {
        providerId: 'minimax',
        modelId: 'image-01',
        prompt: 'A red circle on white',
        generatedAssetId: fixture.assetId,
        createdAt: '2026-11-14T10:00:00.000Z',
        parameters: { generationJobId: 'job-1', kind: 'image' },
      },
    });
    const clip = findClip(session, result.clipId);
    expect(clip).toMatchObject({
      assetId: fixture.assetId,
      startUs: 0,
      durationUs: GENERATED_PICTURE_DURATION_US,
    });
    // Same binding as an imported picture: a null controller carrying the fit transform,
    // and the clip's media kind recorded beside it.
    const expectedFit = calculateMediaFitTransform({
      sourceWidth: 1024,
      sourceHeight: 1024,
      frameWidth: root.width,
      frameHeight: root.height,
      mode: 'fit',
    });
    expect(expectedFit).toBeDefined();
    expect(session.visualProject.visualObjects[`media-controller-${result.clipId}`]).toMatchObject({
      kind: 'null',
      assetId: fixture.assetId,
      transform: { ...expectedFit, rotationDeg: 0, opacity: 1 },
    });
    expect(readClipMediaKindMap(session.visualProject)[result.clipId!]).toBe('image');
  });

  it('keeps one asset when the same file is attached twice, and places a second clip', async () => {
    const fixture = await pictureFixture();
    const session = newSession();
    const library = fakeLibrary();
    const attach = () => attachGeneratedJob(optionsFor(session, library, fixture));

    const first = await attach();
    const second = await attach();

    expect(first.registeredAsset).toBe(true);
    expect(second.registeredAsset).toBe(false);
    expect(library.registerAsset).toHaveBeenCalledTimes(1);
    expect(library.uploadAssetOriginal).toHaveBeenCalledTimes(1);
    expect(
      Object.keys(session.visualProject.assets).filter((id) => id === fixture.assetId),
    ).toHaveLength(1);
    expect(second.clipId).toBeDefined();
    expect(second.clipId).not.toBe(first.clipId);
    expect(findClip(session, second.clipId)).toBeDefined();
  });

  it('one Undo removes the clip and its asset record together; Redo restores both; the library keeps the file', async () => {
    const fixture = await pictureFixture();
    const session = newSession();
    const library = fakeLibrary();
    const result = await attachGeneratedJob(optionsFor(session, library, fixture));
    expect(findClip(session, result.clipId)).toBeDefined();

    session.undo();

    expect(findClip(session, result.clipId)).toBeUndefined();
    expect(session.visualProject.assets[fixture.assetId]).toBeUndefined();
    expect(library.records.has(fixture.assetId)).toBe(true);

    session.redo();

    expect(findClip(session, result.clipId)).toBeDefined();
    expect(session.visualProject.assets[fixture.assetId]).toMatchObject({
      generationProvenance: { providerId: 'minimax' },
    });
  });

  it('places a video clip with its real duration', async () => {
    const fixture = await videoFixture();
    const session = newSession();
    const library = fakeLibrary();

    const result = await attachGeneratedJob(
      optionsFor(session, library, fixture, {
        describeMedia: describeVideo(3_000_000),
        playheadUs: 1_000_000,
      }),
    );

    expect(findClip(session, result.clipId)).toMatchObject({
      assetId: fixture.assetId,
      startUs: 1_000_000,
      durationUs: 3_000_000,
    });
    expect(readClipMediaKindMap(session.visualProject)[result.clipId!]).toBe('video');
  });

  it('registers without placing a clip when placeOnTimeline is false, as one undo step', async () => {
    const fixture = await pictureFixture();
    const session = newSession();
    const library = fakeLibrary();
    const timelineBefore = JSON.stringify(session.timelineProject);

    const result = await attachGeneratedJob(
      optionsFor(session, library, fixture, { placeOnTimeline: false }),
    );

    expect(result.clipId).toBeUndefined();
    expect(result.registeredAsset).toBe(true);
    expect(library.records.has(fixture.assetId)).toBe(true);
    expect(session.visualProject.assets[fixture.assetId]).toBeDefined();
    expect(JSON.stringify(session.timelineProject)).toBe(timelineBefore);

    session.undo();

    expect(session.visualProject.assets[fixture.assetId]).toBeUndefined();
    expect(library.records.has(fixture.assetId)).toBe(true);
  });

  it('refuses a video with unknown duration even when no clip is placed, before anything is stored', async () => {
    const fixture = await videoFixture();
    const session = newSession();
    const library = fakeLibrary();

    await expect(
      attachGeneratedJob(
        optionsFor(session, library, fixture, {
          describeMedia: describeVideo(undefined),
          placeOnTimeline: false,
        }),
      ),
    ).rejects.toThrow('duration is unknown');

    expect(library.registerAsset).not.toHaveBeenCalled();
    expect(library.uploadAssetOriginal).not.toHaveBeenCalled();
    expect(session.visualProject.assets[fixture.assetId]).toBeUndefined();
  });

  it('refuses bad input before anything is stored', async () => {
    const picture = await pictureFixture();
    const session = newSession();
    const library = fakeLibrary();

    await expect(
      attachGeneratedJob(
        optionsFor(session, library, { ...picture, job: { ...picture.job, state: 'running' } }),
      ),
    ).rejects.toThrow('has not finished');
    await expect(
      attachGeneratedJob(
        optionsFor(session, library, {
          job: picture.job,
          file: new File([PICTURE_BYTES], 'clip.mp4', { type: 'video/mp4' }),
        }),
      ),
    ).rejects.toThrow('does not match the job kind');
    await expect(
      attachGeneratedJob(
        optionsFor(session, library, {
          job: { ...picture.job, sha256: 'c'.repeat(64) },
          file: picture.file,
        }),
      ),
    ).rejects.toThrow('does not match its checksum');

    expect(library.registerAsset).not.toHaveBeenCalled();
    expect(library.uploadAssetOriginal).not.toHaveBeenCalled();
    expect(session.visualProject.assets[picture.assetId]).toBeUndefined();
  });

  it('refuses when the library does not keep the same bytes', async () => {
    const fixture = await pictureFixture();
    const session = newSession();
    const library = fakeLibrary();
    library.uploadAssetOriginal.mockResolvedValueOnce({
      ...library.records.get(fixture.assetId)!,
      sha256: 'd'.repeat(64),
    });

    await expect(attachGeneratedJob(optionsFor(session, library, fixture))).rejects.toThrow(
      'did not keep the generated file unchanged',
    );
    expect(session.visualProject.assets[fixture.assetId]).toBeUndefined();
  });

  it('attaches again in a fresh session when the library already holds the file', async () => {
    const fixture = await pictureFixture();
    const library = fakeLibrary();
    await attachGeneratedJob(optionsFor(newSession(), library, fixture));

    const freshSession = newSession();
    const result = await attachGeneratedJob(optionsFor(freshSession, library, fixture));

    expect(result.registeredAsset).toBe(true);
    expect(findClip(freshSession, result.clipId)).toBeDefined();
    expect(library.registerAsset).toHaveBeenCalledTimes(2);
    expect(library.uploadAssetOriginal).toHaveBeenCalledTimes(2);
  });

  it('skips a locked track and places the clip on another visual track', async () => {
    const fixture = await pictureFixture();
    const session = newSession();
    const library = fakeLibrary();
    const [lockedId] = rootVisualTrackIds(session);
    expect(lockedId).toBeDefined();

    const result = await attachGeneratedJob(
      optionsFor(session, library, fixture, { lockedTrackIds: new Set([lockedId!]) }),
    );

    const placement = findClipPlacement(session, result.clipId);
    expect(placement).toBeDefined();
    expect(placement!.trackId).not.toBe(lockedId);
  });

  it('creates a new visual track when no visual track is free', async () => {
    const fixture = await pictureFixture();
    const session = newSession();
    const library = fakeLibrary();
    const existingIds = rootVisualTrackIds(session);

    const result = await attachGeneratedJob(
      optionsFor(session, library, fixture, { lockedTrackIds: new Set(existingIds) }),
    );

    const placement = findClipPlacement(session, result.clipId);
    expect(placement).toBeDefined();
    expect(existingIds).not.toContain(placement!.trackId);
    expect(rootVisualTrackIds(session)).toHaveLength(existingIds.length + 1);
  });
});

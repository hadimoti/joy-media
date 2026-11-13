import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserAsset, BrowserAssetRegistration } from './control-plane-client.js';
import type { BrowserControlPlaneClient } from './control-plane-client.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';
import {
  attachGeneratedJob,
  GENERATED_PICTURE_DURATION_US,
  generatedAssetIdForSha256,
  type AttachableGenerationFile,
  type AttachableGenerationJob,
} from './generation-attach.js';

const SHA = 'a'.repeat(64);
const ASSET_ID = generatedAssetIdForSha256(SHA);

const pictureJob: AttachableGenerationJob = {
  id: 'job-1',
  kind: 'image',
  provider: 'minimax',
  model: 'image-01',
  prompt: 'A red circle on white',
  state: 'completed',
  sha256: SHA,
  createdAt: '2026-11-14T10:00:00.000Z',
};

const pictureFile: AttachableGenerationFile = {
  displayName: 'generated-picture.png',
  mimeType: 'image/png',
  bytes: 2048,
  width: 1024,
  height: 1024,
};

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

function fakeClient() {
  const registerAsset = vi.fn(
    async (projectId: string, registration: BrowserAssetRegistration): Promise<BrowserAsset> => ({
      id: registration.id,
      projectId,
      kind: registration.kind,
      displayName: registration.displayName,
      sha256: registration.sha256,
      bytes: registration.bytes,
      descriptor: registration.descriptor,
      createdAt: 0,
      cloudBacked: false,
    }),
  );
  return {
    registerAsset,
    client: { registerAsset } satisfies Pick<BrowserControlPlaneClient, 'registerAsset'>,
  };
}

function findClip(session: EditorSession, clipId: string | undefined) {
  if (clipId === undefined) return undefined;
  for (const composition of Object.values(session.timelineProject.compositions)) {
    for (const track of composition.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === clipId);
      if (clip !== undefined) return clip;
    }
  }
  return undefined;
}

describe('attachGeneratedJob', () => {
  it('registers a generated picture with its provenance and places one five-second clip', async () => {
    const session = newSession();
    const { registerAsset, client } = fakeClient();

    const result = await attachGeneratedJob({
      projectId: 'project-1',
      job: pictureJob,
      file: pictureFile,
      session,
      client,
      placeOnTimeline: true,
      playheadUs: 0,
    });

    expect(result.registeredAsset).toBe(true);
    expect(result.assetId).toBe(ASSET_ID);
    expect(registerAsset).toHaveBeenCalledTimes(1);
    expect(registerAsset).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ id: ASSET_ID, kind: 'image', sha256: SHA, internal: true }),
    );
    expect(session.visualProject.assets[ASSET_ID]).toMatchObject({
      id: ASSET_ID,
      kind: 'image',
      generationProvenance: {
        providerId: 'minimax',
        modelId: 'image-01',
        prompt: 'A red circle on white',
        generatedAssetId: ASSET_ID,
        createdAt: '2026-11-14T10:00:00.000Z',
        parameters: { generationJobId: 'job-1', kind: 'image' },
      },
    });
    expect(findClip(session, result.clipId)).toMatchObject({
      assetId: ASSET_ID,
      startUs: 0,
      durationUs: GENERATED_PICTURE_DURATION_US,
    });
  });

  it('keeps one asset when the same file is attached twice, and places a second clip', async () => {
    const session = newSession();
    const { registerAsset, client } = fakeClient();
    const attach = () =>
      attachGeneratedJob({
        projectId: 'project-1',
        job: pictureJob,
        file: pictureFile,
        session,
        client,
        placeOnTimeline: true,
        playheadUs: 0,
      });

    const first = await attach();
    const second = await attach();

    expect(first.registeredAsset).toBe(true);
    expect(second.registeredAsset).toBe(false);
    expect(registerAsset).toHaveBeenCalledTimes(1);
    expect(Object.keys(session.visualProject.assets).filter((id) => id === ASSET_ID)).toHaveLength(
      1,
    );
    expect(second.clipId).toBeDefined();
    expect(second.clipId).not.toBe(first.clipId);
    expect(findClip(session, second.clipId)).toBeDefined();
  });

  it('one Undo removes the clip and keeps the asset', async () => {
    const session = newSession();
    const { client } = fakeClient();
    const result = await attachGeneratedJob({
      projectId: 'project-1',
      job: pictureJob,
      file: pictureFile,
      session,
      client,
      placeOnTimeline: true,
      playheadUs: 0,
    });
    expect(findClip(session, result.clipId)).toBeDefined();

    session.undo();

    expect(findClip(session, result.clipId)).toBeUndefined();
    expect(session.visualProject.assets[ASSET_ID]).toMatchObject({
      generationProvenance: { providerId: 'minimax' },
    });

    session.redo();

    expect(findClip(session, result.clipId)).toBeDefined();
  });

  it('places a video clip with its real duration', async () => {
    const session = newSession();
    const { client } = fakeClient();
    const videoSha = 'b'.repeat(64);

    const result = await attachGeneratedJob({
      projectId: 'project-1',
      job: { ...pictureJob, id: 'job-video', kind: 'video', sha256: videoSha },
      file: {
        displayName: 'generated-clip.mp4',
        mimeType: 'video/mp4',
        bytes: 4096,
        durationUs: 3_000_000,
      },
      session,
      client,
      placeOnTimeline: true,
      playheadUs: 1_000_000,
    });

    expect(findClip(session, result.clipId)).toMatchObject({
      assetId: generatedAssetIdForSha256(videoSha),
      startUs: 1_000_000,
      durationUs: 3_000_000,
    });
  });

  it('registers without placing a clip when placeOnTimeline is false', async () => {
    const session = newSession();
    const { client } = fakeClient();
    const clipCountBefore = JSON.stringify(session.timelineProject);

    const result = await attachGeneratedJob({
      projectId: 'project-1',
      job: pictureJob,
      file: pictureFile,
      session,
      client,
      placeOnTimeline: false,
      playheadUs: 0,
    });

    expect(result.clipId).toBeUndefined();
    expect(session.visualProject.assets[ASSET_ID]).toBeDefined();
    expect(JSON.stringify(session.timelineProject)).toBe(clipCountBefore);
  });

  it('refuses bad input before anything is registered', async () => {
    const session = newSession();
    const { registerAsset, client } = fakeClient();
    const base = {
      projectId: 'project-1',
      session,
      client,
      placeOnTimeline: true,
      playheadUs: 0,
    };

    await expect(
      attachGeneratedJob({ ...base, job: { ...pictureJob, state: 'running' }, file: pictureFile }),
    ).rejects.toThrow('has not finished');
    await expect(
      attachGeneratedJob({
        ...base,
        job: pictureJob,
        file: { ...pictureFile, mimeType: 'video/mp4' },
      }),
    ).rejects.toThrow('does not match the job kind');
    await expect(
      attachGeneratedJob({
        ...base,
        job: { ...pictureJob, kind: 'video', sha256: 'c'.repeat(64) },
        file: { displayName: 'no-duration.mp4', mimeType: 'video/mp4', bytes: 10 },
      }),
    ).rejects.toThrow('duration is unknown');

    expect(registerAsset).not.toHaveBeenCalled();
    expect(session.visualProject.assets[ASSET_ID]).toBeUndefined();
  });
});

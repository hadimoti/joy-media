import { createHash } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openProjectClaimRegistry } from './project-claim-registry.js';
import {
  createProjectFolderService,
  handleProjectFolderMessage,
  type ProjectFolderService,
} from './project-folder-service.js';

/**
 * Opening a folder project in the editor through the service, as the worker runs it: open settles the id and keeps the
 * folder open, load reads the saved project, save writes it and copies its media inside, close lets the folder go.
 */

const CLIP = Buffer.from(Array.from({ length: 3000 }, (_, index) => (index * 7) % 256));
const CLIP_SHA = createHash('sha256').update(CLIP).digest('hex');
const CLIP_ID = `joylib-${CLIP_SHA}`;

let base: string;
let directory: string;
const services: ProjectFolderService[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'joy-pf-editing-service-'));
  directory = join(base, 'JOY Projects');
});

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await rm(base, { recursive: true, force: true });
});

function serviceOn(): ProjectFolderService {
  let next = 0;
  const service = createProjectFolderService({
    registry: openProjectClaimRegistry(join(base, 'claims.sqlite')),
    directory,
    newKey: () => `key-${++next}`,
  });
  services.push(service);
  return service;
}

async function keyOf(service: ProjectFolderService, name: string): Promise<string> {
  const listed = await service.list();
  const item = listed.folders.find((folder) => folder.name === name);
  if (item === undefined) throw new Error(`no listed folder named ${name}`);
  return item.key;
}

async function original(name = 'beach.mp4'): Promise<string> {
  const folder = join(base, 'desktop-originals');
  await mkdir(folder, { recursive: true });
  const path = join(folder, name);
  await writeFile(path, CLIP);
  return path;
}

async function createdProject(service: ProjectFolderService, title = 'Summer') {
  const created = await service.create(title);
  if (created.kind !== 'created') throw new Error('expected a created folder');
  return created;
}

function documentFor(id: string) {
  return { timeline: { id }, visual: { id, assets: { [CLIP_ID]: { id: CLIP_ID } } } };
}

describe('opening a folder project in the editor', () => {
  it('opens a new folder as ready, with nothing saved yet', async () => {
    const service = serviceOn();
    const created = await createdProject(service);
    await expect(service.open(created.key)).resolves.toMatchObject({
      kind: 'ready',
      id: created.id,
      title: 'Summer',
    });
    await expect(service.load(created.key)).resolves.toEqual({
      kind: 'loaded',
      id: created.id,
      title: 'Summer',
      document: null,
      revisionId: '',
      documentProjectId: created.id,
    });
  });

  it('refuses to load or save a folder that is not open', async () => {
    const service = serviceOn();
    const created = await createdProject(service);
    await expect(service.load(created.key)).resolves.toEqual({ kind: 'refused', code: 'not-open' });
    await expect(
      service.save(created.key, {
        projectId: created.id,
        baseRevisionId: '',
        revisionId: 'r1',
        title: 'Summer',
        document: {},
        media: [],
      }),
    ).resolves.toEqual({ kind: 'refused', code: 'not-open' });
  });

  it('saves, closes and reopens with the media kept inside the folder', async () => {
    const service = serviceOn();
    const created = await createdProject(service);
    await service.open(created.key);
    const saved = await service.save(created.key, {
      projectId: created.id,
      baseRevisionId: '',
      revisionId: 'r1',
      title: 'Summer',
      document: documentFor(created.id),
      media: [
        {
          assetId: CLIP_ID,
          kind: 'video',
          displayName: 'beach.mp4',
          sha256: CLIP_SHA,
          sourcePath: await original(),
        },
      ],
    });
    expect(saved).toEqual({ kind: 'saved', revisionId: 'r1', notStored: [] });
    expect(service.closeFolder(created.key)).toEqual({ kind: 'closed' });
    await expect(service.load(created.key)).resolves.toMatchObject({ code: 'not-open' });

    // The desktop's own copy of the original is gone. The folder still has its media.
    await unlink(join(base, 'desktop-originals', 'beach.mp4'));
    service.close();

    const later = serviceOn();
    const key = await keyOf(later, 'Summer.joyproj');
    await expect(later.open(key)).resolves.toMatchObject({ kind: 'ready', claim: 'kept' });
    await expect(later.load(key)).resolves.toMatchObject({
      kind: 'loaded',
      id: created.id,
      revisionId: 'r1',
      document: documentFor(created.id),
    });
    await expect(later.mediaStates(key, [CLIP_ID, 'joylib-other'])).resolves.toEqual({
      kind: 'media',
      states: [
        {
          assetId: CLIP_ID,
          present: true,
          bytes: CLIP.length,
          sha256: CLIP_SHA,
          displayName: 'beach.mp4',
        },
        { assetId: 'joylib-other', present: false },
      ],
    });
    const bytes = await later.mediaBytes(key, CLIP_ID, 0);
    expect(bytes).toMatchObject({
      kind: 'media-bytes',
      assetId: CLIP_ID,
      offset: 0,
      total: CLIP.length,
    });
    if (bytes.kind !== 'media-bytes') throw new Error('expected bytes');
    expect(Buffer.from(bytes.bytes).equals(CLIP)).toBe(true);
    await expect(later.mediaBytes(key, 'joylib-other', 0)).resolves.toEqual({
      kind: 'refused',
      code: 'media-missing',
    });
  });

  it('says which media is not in the folder after a save', async () => {
    const service = serviceOn();
    const created = await createdProject(service);
    await service.open(created.key);
    await expect(
      service.save(created.key, {
        projectId: created.id,
        baseRevisionId: '',
        revisionId: 'r1',
        title: 'Summer',
        document: documentFor(created.id),
        media: [{ assetId: CLIP_ID, kind: 'video', displayName: 'beach.mp4' }],
      }),
    ).resolves.toEqual({ kind: 'saved', revisionId: 'r1', notStored: [CLIP_ID] });
  });

  it('refuses a stale save and a save for another id', async () => {
    const service = serviceOn();
    const created = await createdProject(service);
    await service.open(created.key);
    const save = {
      projectId: created.id,
      title: 'Summer',
      document: documentFor(created.id),
      media: [],
    };
    await service.save(created.key, { ...save, baseRevisionId: '', revisionId: 'r1' });
    await service.save(created.key, { ...save, baseRevisionId: 'r1', revisionId: 'r2' });
    await expect(
      service.save(created.key, { ...save, baseRevisionId: 'r1', revisionId: 'r3' }),
    ).resolves.toEqual({ kind: 'refused', code: 'save-conflict' });
    await expect(
      service.save(created.key, {
        ...save,
        projectId: 'project-other',
        baseRevisionId: 'r2',
        revisionId: 'r4',
      }),
    ).resolves.toEqual({ kind: 'refused', code: 'wrong-project' });
  });

  it('keeps one folder open: opening another closes the first', async () => {
    const service = serviceOn();
    const first = await createdProject(service, 'First');
    const second = await createdProject(service, 'Second');
    await service.open(first.key);
    await service.open(second.key);
    await expect(service.load(first.key)).resolves.toMatchObject({ code: 'not-open' });
    await expect(service.load(second.key)).resolves.toMatchObject({
      kind: 'loaded',
      id: second.id,
    });
  });

  it('opens a copied folder as a new project that still has the saved work and media', async () => {
    const service = serviceOn();
    const created = await createdProject(service);
    await service.open(created.key);
    await service.save(created.key, {
      projectId: created.id,
      baseRevisionId: '',
      revisionId: 'r1',
      title: 'Summer',
      document: documentFor(created.id),
      media: [
        { assetId: CLIP_ID, kind: 'video', displayName: 'beach.mp4', sourcePath: await original() },
      ],
    });
    service.closeFolder(created.key);
    cpSync(join(directory, 'Summer.joyproj'), join(directory, 'Summer copy.joyproj'), {
      recursive: true,
    });

    const copyKey = await keyOf(service, 'Summer copy.joyproj');
    const opened = await service.open(copyKey);
    expect(opened).toMatchObject({ kind: 'ready', claim: 'renewed', previousId: created.id });
    if (opened.kind !== 'ready') throw new Error('expected a ready copy');
    expect(opened.id).not.toBe(created.id);

    // The claim moved the copy's saved work to its new id, so it opens as its own project with the same content.
    await expect(service.load(copyKey)).resolves.toMatchObject({
      kind: 'loaded',
      id: opened.id,
      documentProjectId: opened.id,
      revisionId: 'r1',
      document: documentFor(opened.id),
    });
    await expect(service.mediaStates(copyKey, [CLIP_ID])).resolves.toMatchObject({
      states: [{ assetId: CLIP_ID, present: true }],
    });
    await expect(
      service.save(copyKey, {
        projectId: opened.id,
        baseRevisionId: 'r1',
        revisionId: 'c1',
        title: 'Summer copy',
        document: documentFor(opened.id),
        media: [{ assetId: CLIP_ID, kind: 'video', displayName: 'beach.mp4' }],
      }),
    ).resolves.toEqual({ kind: 'saved', revisionId: 'c1', notStored: [] });
    await expect(service.load(copyKey)).resolves.toMatchObject({
      documentProjectId: opened.id,
      revisionId: 'c1',
    });

    // The original is untouched: it keeps its id and its saved work.
    const originalKey = await keyOf(service, 'Summer.joyproj');
    await expect(service.open(originalKey)).resolves.toMatchObject({
      kind: 'ready',
      claim: 'kept',
      id: created.id,
    });
    await expect(service.load(originalKey)).resolves.toMatchObject({
      revisionId: 'r1',
      documentProjectId: created.id,
    });
    expect(existsSync(join(directory, 'Summer copy.joyproj', 'assets', `${CLIP_SHA}.bin`))).toBe(
      true,
    );
  });
});

describe('the editing messages the worker accepts', () => {
  it('routes load, save, media and close, and refuses a malformed save', async () => {
    const service = serviceOn();
    const created = await createdProject(service);
    await service.open(created.key);
    await expect(
      handleProjectFolderMessage(service, { id: 1, op: 'load', payload: { key: created.key } }),
    ).resolves.toMatchObject({ id: 1, ok: true, value: { kind: 'loaded' } });
    await expect(
      handleProjectFolderMessage(service, {
        id: 2,
        op: 'save',
        payload: {
          key: created.key,
          projectId: created.id,
          baseRevisionId: '',
          revisionId: 'r1',
          title: 'S',
        },
      }),
    ).resolves.toEqual({ id: 2, ok: false, error: 'Invalid project folder request' });
    await expect(
      handleProjectFolderMessage(service, {
        id: 3,
        op: 'save',
        payload: {
          key: created.key,
          projectId: created.id,
          baseRevisionId: '',
          revisionId: 'r1',
          title: 'S',
          document: {},
          media: [{ assetId: 'a', kind: 'image', displayName: 'a.png', sourcePath: 42 }],
        },
      }),
    ).resolves.toEqual({ id: 3, ok: false, error: 'Invalid project folder request' });
    await expect(
      handleProjectFolderMessage(service, {
        id: 4,
        op: 'media',
        payload: { key: created.key, assetIds: ['a'] },
      }),
    ).resolves.toMatchObject({ id: 4, ok: true, value: { kind: 'media' } });
    await expect(
      handleProjectFolderMessage(service, {
        id: 5,
        op: 'media',
        payload: { key: created.key, assetId: 'a', offset: -1 },
      }),
    ).resolves.toEqual({ id: 5, ok: false, error: 'Invalid project folder request' });
    await expect(
      handleProjectFolderMessage(service, { id: 6, op: 'close', payload: { key: created.key } }),
    ).resolves.toEqual({ id: 6, ok: true, value: { kind: 'closed' } });
  });
});

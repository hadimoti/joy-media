import { describe, expect, it } from 'vitest';
import type { LookInstance } from '@joy-media/project-schema';
import { EditorSession, LOOK_INSTANCES_LOG_KEY } from './editor-session.js';
import { createBlankProjectDocuments } from './project-factory.js';
import { upsertCatalogProject, type ProjectCatalogEntry } from './project-catalog.js';
import {
  createProjectPackage,
  importProjectPackage,
  parseProjectPackage,
  serializeProjectPackage,
} from './project-package.js';
import { duplicateLocalProject, purgeLocalProject } from './project-lifecycle.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  };
}

function instance(overrides: Partial<LookInstance> = {}): LookInstance {
  return {
    id: 'look-1',
    definitionId: 'editorial-clean',
    definitionVersion: 2,
    compositionId: 'root',
    entityBindings: { headline: 'headline-object' },
    controlValues: { energy: 0.7, tone: 'warm' },
    overriddenBindingIds: ['headline'],
    createdEntityIds: [],
    ...overrides,
  };
}

/** A source project with one visual object and one applied Look. */
function sourceWithLook(store = memoryStorage(), id = 'source-project') {
  const now = '2026-09-09T00:00:00.000Z';
  const seeds = createBlankProjectDocuments(id, 'Source', now);
  const session = new EditorSession(store.storage, seeds.timeline, seeds.visual);
  session.replaceVisualProject({
    ...session.visualProject,
    visualObjects: {
      'headline-object': {
        id: 'headline-object',
        kind: 'text',
        text: 'Hi',
        transform: {
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      },
    },
  });
  session.dispatchCompound('Apply Editorial Clean', {
    lookInstances: { id, schemaVersion: 1, instances: { 'look-1': instance() } },
  });
  const entry: ProjectCatalogEntry = {
    id,
    title: 'Source',
    createdAt: now,
    updatedAt: now,
    timelineProjectId: id,
    visualProjectId: id,
  };
  upsertCatalogProject(store.storage, entry);
  return { store, entry };
}

describe('Look Instances — package + duplication + purge (GAP 1a)', () => {
  it('round-trips the Look Instances document through export -> import', async () => {
    const { store, entry } = sourceWithLook();
    const pkg = await createProjectPackage(entry, store.storage);
    expect(pkg.documents.lookInstances.instances['look-1']).toEqual(instance());

    const reparsed = parseProjectPackage(JSON.parse(serializeProjectPackage(pkg)));
    const dest = memoryStorage();
    const result = await importProjectPackage(dest.storage, reparsed, { collision: 'rename' });

    const imported = new EditorSession(
      dest.storage,
      { ...createBlankProjectDocuments(result.entry.id, 't').timeline, id: result.entry.id },
      { ...createBlankProjectDocuments(result.entry.id, 't').visual, id: result.entry.id },
    );
    const look = imported.lookInstances.instances['look-1'];
    expect(look).toBeDefined();
    expect(look!.controlValues).toEqual({ energy: 0.7, tone: 'warm' });
    expect(look!.overriddenBindingIds).toEqual(['headline']);
    // The document id followed the new project; the binding target did not move.
    expect(imported.lookInstances.id).toBe(result.entry.id);
    expect(look!.entityBindings).toEqual({ headline: 'headline-object' });
  });

  it('a package with no Looks still carries an empty document, and imports cleanly', async () => {
    const store = memoryStorage();
    const now = '2026-09-09T00:00:00.000Z';
    const seeds = createBlankProjectDocuments('empty-src', 'Empty', now);
    new EditorSession(store.storage, seeds.timeline, seeds.visual);
    const entry: ProjectCatalogEntry = {
      id: 'empty-src',
      title: 'Empty',
      createdAt: now,
      updatedAt: now,
      timelineProjectId: 'empty-src',
      visualProjectId: 'empty-src',
    };
    upsertCatalogProject(store.storage, entry);

    const pkg = await createProjectPackage(entry, store.storage);
    expect(pkg.documents.lookInstances).toEqual({
      id: 'empty-src',
      schemaVersion: 1,
      instances: {},
    });

    const dest = memoryStorage();
    const result = await importProjectPackage(dest.storage, parseProjectPackage(pkg), {
      collision: 'rename',
    });
    expect(result.entry.id).toBeDefined();
    // No Looks -> the import does not create the log at all.
    expect(dest.values.has(LOOK_INSTANCES_LOG_KEY)).toBe(false);
  });

  it('rejects a package whose Look Instances document is malformed (nothing half-imported)', async () => {
    const { store, entry } = sourceWithLook();
    const pkg = await createProjectPackage(entry, store.storage);
    const broken = {
      ...pkg,
      documents: {
        ...pkg.documents,
        lookInstances: {
          ...pkg.documents.lookInstances,
          instances: { 'look-1': { ...instance(), definitionVersion: -5 } },
        },
      },
    };
    const dest = memoryStorage();
    await expect(
      importProjectPackage(dest.storage, broken, { collision: 'rename' }),
    ).rejects.toThrow(/lookInstances/);
    expect(dest.values.has(LOOK_INSTANCES_LOG_KEY)).toBe(false);
  });

  it('duplicateLocalProject copies the Look Instances to the new project id', () => {
    const { store, entry } = sourceWithLook();
    const dup = duplicateLocalProject(store.storage, entry, 'Copy');

    const session = new EditorSession(
      store.storage,
      { ...createBlankProjectDocuments(dup.id, 't').timeline, id: dup.id },
      { ...createBlankProjectDocuments(dup.id, 't').visual, id: dup.id },
    );
    expect(session.lookInstances.id).toBe(dup.id);
    expect(session.lookInstances.instances['look-1']!.controlValues).toEqual({
      energy: 0.7,
      tone: 'warm',
    });
    // The source is untouched.
    const src = new EditorSession(
      store.storage,
      { ...createBlankProjectDocuments(entry.id, 't').timeline, id: entry.id },
      { ...createBlankProjectDocuments(entry.id, 't').visual, id: entry.id },
    );
    expect(src.lookInstances.instances['look-1']).toBeDefined();
  });

  it('purgeLocalProject removes the Look Instances log', () => {
    const { store, entry } = sourceWithLook();
    expect(store.values.has(LOOK_INSTANCES_LOG_KEY)).toBe(true);
    purgeLocalProject(store.storage, entry);

    const reopened = new EditorSession(
      store.storage,
      { ...createBlankProjectDocuments(entry.id, 't').timeline, id: entry.id },
      { ...createBlankProjectDocuments(entry.id, 't').visual, id: entry.id },
    );
    expect(reopened.lookInstances.instances).toEqual({});
  });
});

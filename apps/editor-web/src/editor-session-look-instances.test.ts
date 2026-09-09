import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import {
  emptyLookInstancesDocument,
  type LookInstance,
  type LookInstancesDocument,
} from '@joy-media/project-schema';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession, LOOK_INSTANCES_LOG_KEY } from './editor-session.js';

const VISUAL_KEY = 'joy-media.visual-object-project-log.v1';
/** The look-instances document is keyed on the timeline project id. */
const PROJECT_ID = buildReferenceSpikeProject().id;

function memoryStorage(seed: Readonly<Record<string, string>> = {}) {
  const values = new Map<string, string>(Object.entries(seed));
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  };
}

/** `intro-title` is a real visual object in INITIAL_EDITOR_PROJECT. */
function instance(overrides: Partial<LookInstance> = {}): LookInstance {
  return {
    id: 'look-1',
    definitionId: 'editorial-clean',
    definitionVersion: 1,
    compositionId: 'root',
    entityBindings: { headline: 'intro-title' },
    controlValues: { energy: 0.5 },
    overriddenBindingIds: [],
    createdEntityIds: [],
    ...overrides,
  };
}

function lookDoc(instances: readonly LookInstance[] = [instance()]): LookInstancesDocument {
  return {
    id: PROJECT_ID,
    schemaVersion: 1,
    instances: Object.fromEntries(instances.map((i) => [i.id, i])),
  };
}

function newSession(store = memoryStorage()) {
  return new EditorSession(store.storage, buildReferenceSpikeProject(), INITIAL_EDITOR_PROJECT);
}

describe('EditorSession — Look Instances document (GAP 1a)', () => {
  it('a legacy project with no log opens as the empty document and is NOT rewritten', () => {
    const store = memoryStorage();
    const session = newSession(store);
    expect(session.lookInstances).toEqual(emptyLookInstancesDocument(PROJECT_ID));
    expect(store.values.has(LOOK_INSTANCES_LOG_KEY)).toBe(false);

    const before = session.projectRevisionId;
    const reopened = newSession(store);
    expect(store.values.has(LOOK_INSTANCES_LOG_KEY)).toBe(false);
    expect(reopened.projectRevisionId).toBe(before);
    expect(reopened.recoveryWarnings).toEqual([]);
    expect(reopened.orphanedLookInstanceIds).toEqual([]);
  });

  it('persists a Look Instance with its visual edit and reopens with both', () => {
    const store = memoryStorage();
    const session = newSession(store);
    const base = session.projectRevisionId;

    session.dispatchCompound('Apply Editorial Clean', {
      document: { ...session.visualProject, title: 'With a Look' },
      lookInstances: lookDoc(),
    });

    expect(session.lookInstances.instances['look-1']).toEqual(instance());
    expect(session.visualProject.title).toBe('With a Look');
    expect(session.projectRevisionId).not.toBe(base);
    expect(store.values.has(LOOK_INSTANCES_LOG_KEY)).toBe(true);

    const reopened = newSession(store);
    expect(reopened.lookInstances.instances['look-1']).toEqual(instance());
    expect(reopened.visualProject.title).toBe('With a Look');
    expect(reopened.projectRevisionId).toBe(session.projectRevisionId);
  });

  it('reopening a project that HAS Looks does not rewrite either log', () => {
    const store = memoryStorage();
    const session = newSession(store);
    session.dispatchCompound('Apply', {
      document: { ...session.visualProject, title: 'Has Looks' },
      lookInstances: lookDoc(),
    });
    const lookBytes = store.values.get(LOOK_INSTANCES_LOG_KEY);
    const visualBytes = store.values.get(VISUAL_KEY);

    newSession(store);
    expect(store.values.get(LOOK_INSTANCES_LOG_KEY)).toBe(lookBytes);
    expect(store.values.get(VISUAL_KEY)).toBe(visualBytes);
  });

  it('undo and redo move the visual edit and the Look Instance together', () => {
    const store = memoryStorage();
    const session = newSession(store);

    session.dispatchCompound('Apply', {
      document: { ...session.visualProject, title: 'Looked' },
      lookInstances: lookDoc(),
    });

    session.undo();
    expect(session.visualProject.title).toBe(INITIAL_EDITOR_PROJECT.title);
    expect(session.lookInstances.instances).toEqual({});
    const revisionAfterUndo = session.projectRevisionId;
    expect(newSession(store).projectRevisionId).toBe(revisionAfterUndo); // stable across reopen

    session.redo();
    expect(session.visualProject.title).toBe('Looked');
    expect(session.lookInstances.instances['look-1']).toEqual(instance());

    const reopened = newSession(store);
    expect(reopened.lookInstances.instances['look-1']).toEqual(instance());
    expect(reopened.visualProject.title).toBe('Looked');
    expect(reopened.projectRevisionId).toBe(session.projectRevisionId);
  });

  it('interleaves a plain visual edit without desyncing the Look history', () => {
    const session = newSession();
    session.dispatchCompound('Apply', {
      document: { ...session.visualProject, title: 'A' },
      lookInstances: lookDoc(),
    });
    session.replaceVisualProject({ ...session.visualProject, title: 'B' });

    session.undo(); // undo the plain visual edit
    expect(session.visualProject.title).toBe('A');
    expect(session.lookInstances.instances['look-1']).toEqual(instance());

    session.undo(); // undo the Look apply
    expect(session.visualProject.title).toBe(INITIAL_EDITOR_PROJECT.title);
    expect(session.lookInstances.instances).toEqual({});
  });

  it('rejects a Look Instance bound to a visual object that does not exist', () => {
    const store = memoryStorage();
    const session = newSession(store);
    expect(() =>
      session.dispatchCompound('Apply to a ghost', {
        lookInstances: lookDoc([instance({ entityBindings: { headline: 'not-a-real-object' } })]),
      }),
    ).toThrow(expect.objectContaining({ code: 'PERSISTENCE_COMPOUND_LOOK_INSTANCE_DANGLING' }));
    expect(session.lookInstances.instances).toEqual({});
    expect(store.values.has(LOOK_INSTANCES_LOG_KEY)).toBe(false);
  });

  it('a binding that dangles because its object was deleted LATER is orphaned, not rejected', () => {
    const session = newSession();
    session.dispatchCompound('Apply', { lookInstances: lookDoc() });
    expect(session.orphanedLookInstanceIds).toEqual([]);

    const { 'intro-title': _removed, ...rest } = session.visualProject.visualObjects;
    session.replaceVisualProject({ ...session.visualProject, visualObjects: rest });
    expect(session.orphanedLookInstanceIds).toEqual(['look-1']);

    // An unrelated Look write still succeeds — the pre-existing dangler (its
    // record unchanged) is not re-validated.
    session.dispatchCompound('Apply another', {
      lookInstances: lookDoc([
        instance(),
        instance({ id: 'look-2', entityBindings: { headline: 'product-image' } }),
      ]),
    });
    expect(session.lookInstances.instances['look-2']).toBeDefined();
  });

  it('replaceVisualProjectWithLookOverrides commits the edit + the override atomically; one Undo reverts both', () => {
    const store = memoryStorage();
    const session = newSession(store);
    session.dispatchCompound('Apply', { lookInstances: lookDoc() });
    const baseTitle = session.visualProject.title;

    // Mark 'headline' overridden alongside a title edit.
    const nextDoc = {
      ...session.lookInstances,
      instances: {
        'look-1': {
          ...session.lookInstances.instances['look-1']!,
          overriddenBindingIds: ['headline'],
        },
      },
    };
    session.replaceVisualProjectWithLookOverrides(
      { ...session.visualProject, title: 'Hand edited' },
      nextDoc,
    );
    expect(session.visualProject.title).toBe('Hand edited');
    expect(session.lookInstances.instances['look-1']!.overriddenBindingIds).toEqual(['headline']);
    const reopened = newSession(store);
    expect(reopened.visualProject.title).toBe('Hand edited');
    expect(reopened.lookInstances.instances['look-1']!.overriddenBindingIds).toEqual(['headline']);

    session.undo();
    expect(session.visualProject.title).toBe(baseTitle);
    expect(session.lookInstances.instances['look-1']!.overriddenBindingIds).toEqual([]);

    // An unchanged Look doc -> plain replaceVisualProject (no look-instance op).
    session.replaceVisualProjectWithLookOverrides(
      { ...session.visualProject, title: 'Plain' },
      session.lookInstances,
    );
    expect(session.visualProject.title).toBe('Plain');
  });

  it('an override-mark on an already-orphaned instance is NOT rejected', () => {
    const session = newSession();
    session.dispatchCompound('Apply', { lookInstances: lookDoc() });
    const { 'intro-title': _gone, ...rest } = session.visualProject.visualObjects;
    session.replaceVisualProject({ ...session.visualProject, visualObjects: rest });
    expect(session.orphanedLookInstanceIds).toEqual(['look-1']);

    // The instance's entityBindings are unchanged; only overriddenBindingIds moves.
    expect(() =>
      session.dispatchCompound('Mark override on an orphan', {
        lookInstances: {
          ...session.lookInstances,
          instances: {
            'look-1': {
              ...session.lookInstances.instances['look-1']!,
              overriddenBindingIds: ['headline'],
            },
          },
        },
      }),
    ).not.toThrow();
    expect(session.lookInstances.instances['look-1']!.overriddenBindingIds).toEqual(['headline']);
  });

  it.each(['document', 'look-instance', 'journal-commit'] as const)(
    'a failure at %s never leaves only the visual edit or only the Look Instance',
    (failurePoint) => {
      const values = new Map<string, string>();
      const initialTimeline = buildReferenceSpikeProject();
      const journalKey = `joy-media.editor-compound-write.v1:${encodeURIComponent(initialTimeline.id)}`;
      let armed = false;
      let injected = false;
      let journalWrites = 0;
      const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          const isJournal = key === journalKey;
          if (armed && isJournal) journalWrites += 1;
          const shouldFail =
            armed &&
            !injected &&
            ((failurePoint === 'document' && key === VISUAL_KEY) ||
              (failurePoint === 'look-instance' && key === LOOK_INSTANCES_LOG_KEY) ||
              (failurePoint === 'journal-commit' && isJournal && journalWrites === 2));
          if (shouldFail) {
            injected = true;
            throw new Error(`injected ${failurePoint} failure`);
          }
          values.set(key, value);
        },
        removeItem: (key: string) => values.delete(key),
      };
      const session = new EditorSession(storage, initialTimeline, INITIAL_EDITOR_PROJECT);
      const beforeVisual = session.visualProject;
      const beforeLooks = session.lookInstances;
      const beforeRevision = session.projectRevisionId;

      armed = true;
      expect(() =>
        session.dispatchCompound(`Failure ${failurePoint}`, {
          document: { ...beforeVisual, title: `Failure ${failurePoint}` },
          lookInstances: lookDoc(),
        }),
      ).toThrow();
      expect(injected).toBe(true);

      // In-memory: exactly the pre-commit state, both halves.
      expect(session.visualProject).toEqual(beforeVisual);
      expect(session.lookInstances).toEqual(beforeLooks);
      expect(session.projectRevisionId).toBe(beforeRevision);

      // On reopen (recovery from whatever journal state was left): still both
      // halves at pre-commit, never a mix.
      injected = true;
      const reopened = new EditorSession(storage, initialTimeline, INITIAL_EDITOR_PROJECT);
      expect(reopened.visualProject.title).toBe(INITIAL_EDITOR_PROJECT.title);
      expect(reopened.lookInstances.instances).toEqual({});
      expect(reopened.projectRevisionId).toBe(beforeRevision);
    },
  );

  it('recovers a hand-written prepared journal spanning the visual and Look logs', () => {
    const store = memoryStorage();
    const initialTimeline = buildReferenceSpikeProject();
    const journalKey = `joy-media.editor-compound-write.v1:${encodeURIComponent(initialTimeline.id)}`;
    const s1 = new EditorSession(store.storage, initialTimeline, INITIAL_EDITOR_PROJECT);
    s1.dispatchCompound('First', {
      document: { ...s1.visualProject, title: 'v1' },
      lookInstances: lookDoc([instance({ controlValues: { energy: 0.1 } })]),
    });
    const preVisual = store.values.get(VISUAL_KEY)!;
    const preLooks = store.values.get(LOOK_INSTANCES_LOG_KEY)!;

    s1.dispatchCompound('Second', {
      document: { ...s1.visualProject, title: 'v2' },
      lookInstances: lookDoc([instance({ controlValues: { energy: 0.9 } })]),
    });

    const record = (bytes: string, id: string) => JSON.stringify(JSON.parse(bytes).projects[id]);
    store.values.set(
      journalKey,
      JSON.stringify({
        version: 2,
        state: 'prepared',
        projectId: initialTimeline.id,
        previous: [
          {
            storageKey: VISUAL_KEY,
            projectId: INITIAL_EDITOR_PROJECT.id,
            storageKind: 'project-log',
            serialized: record(preVisual, INITIAL_EDITOR_PROJECT.id),
          },
          {
            storageKey: LOOK_INSTANCES_LOG_KEY,
            projectId: initialTimeline.id,
            storageKind: 'project-log',
            serialized: record(preLooks, initialTimeline.id),
          },
        ],
      }),
    );

    const recovered = new EditorSession(store.storage, initialTimeline, INITIAL_EDITOR_PROJECT);
    expect(recovered.visualProject.title).toBe('v1');
    expect(recovered.lookInstances.instances['look-1']!.controlValues).toEqual({ energy: 0.1 });
    expect(store.values.get(journalKey)).toBeUndefined();

    // A `committed` journal is just cleaned up, the on-disk writes are kept.
    store.values.set(
      journalKey,
      JSON.stringify({
        version: 2,
        state: 'committed',
        projectId: initialTimeline.id,
        previous: [],
      }),
    );
    const kept = new EditorSession(store.storage, initialTimeline, INITIAL_EDITOR_PROJECT);
    expect(kept.visualProject.title).toBe('v1');
    expect(store.values.get(journalKey)).toBeUndefined();
  });
});

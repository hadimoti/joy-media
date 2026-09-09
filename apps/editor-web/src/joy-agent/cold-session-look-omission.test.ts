/**
 * P1-R1 — truthful omission reporting for the cold-session `looks` context
 * domain (review corrections 1 & 2).
 *
 * The P1 patch (`070e254c`) added a project-scoped `looks` domain but its
 * sanitizer under-reported: nested caps (`entityBindings`, `controlValues`,
 * `createdEntityIds`, override/missing lists) truncated silently; dropped unsafe
 * list entries were invisible; an over-long identifier was truncated into a
 * *different* id and still surfaced; a malformed runtime shape either threw a
 * `TypeError` or was misread positionally; and a rejected `packTitle` vanished
 * with no signal. A reader could then not tell an *incomplete* projection from
 * an *empty* project.
 *
 * Cases 1-9 fail against `070e254c` and pass after the correction. Case 10 is a
 * hardening guard (the pre-fix `> MAX_LOOK_INSTANCES` count rule already forced
 * the label in that scenario; the fix makes per-chunk preservation explicit).
 *
 * Genuine-reopen cases cross the real persistence → hydration → context → host
 * boundary: a value is written through `EditorSession.synchronizeLookInstances`
 * and read back by a brand-new `EditorSession` before the context is built.
 * Boundary-fuzz cases construct the malformed `JoyAgentContextSnapshotInput`
 * directly — that IS the sanitizer boundary, and such shapes cannot be
 * persisted (`validateLookInstancesDocument` rejects them).
 */

import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { editorialClean } from '@joy-media/motion-core';
import type { LookInstance, LookInstancesDocument } from '@joy-media/project-schema';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { EditorSession } from '../editor-session.js';
import {
  createJoyAgentContextSnapshot,
  createJoyAgentPagedContext,
  type JoyAgentContextSnapshotInput,
  type JoyAgentLookInstanceContext,
} from './context-snapshot.js';
import { createJoyAgentHostRpcMethods } from './tool-bridge.js';
import type {
  HostRpcHandlerContext,
  HostRpcJson,
  HostRpcMethod,
  HostRpcMethods,
} from './host-rpc.js';

const PROJECT_ID = buildReferenceSpikeProject().id;

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

function newSession(store: ReturnType<typeof memoryStorage>) {
  return new EditorSession(store.storage, buildReferenceSpikeProject(), INITIAL_EDITOR_PROJECT);
}

function baseInstance(overrides: Partial<LookInstance> = {}): LookInstance {
  return {
    id: 'look-omit-0001-1111-2222-333333333333',
    definitionId: editorialClean.id,
    definitionVersion: editorialClean.version,
    compositionId: 'root',
    entityBindings: { headline: 'intro-title' },
    controlValues: {},
    overriddenBindingIds: [],
    createdEntityIds: [],
    ...overrides,
  };
}

function lookDoc(instances: readonly LookInstance[]): LookInstancesDocument {
  return {
    id: PROJECT_ID,
    schemaVersion: 1,
    instances: Object.fromEntries(instances.map((i) => [i.id, i])),
  };
}

function handlerContext(): HostRpcHandlerContext {
  return {
    run: { runId: 'omit-run', epoch: 1 },
    requestId: 'req-1',
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5_000,
  };
}

async function readContext(methods: HostRpcMethods, args: HostRpcJson): Promise<HostRpcJson> {
  const method = methods.read_project_context as unknown as HostRpcMethod<HostRpcJson, HostRpcJson>;
  return method.parseResult(await method.execute(method.parseArgs(args), handlerContext()));
}

/** Reopen from storage bytes and build the host method map a cold run would. */
function reopenMethods(store: ReturnType<typeof memoryStorage>): HostRpcMethods {
  const session = newSession(store);
  const input = buildContextInputFromSession(session);
  return createJoyAgentHostRpcMethods({ context: createJoyAgentPagedContext(input) });
}

/**
 * A minimal `JoyAgentContextSnapshotInput` from a reopened session — only the
 * identity plus the Look-instance projection this suite exercises. Mirrors
 * `buildJoyAgentContextInput` for the Look fields.
 */
function buildContextInputFromSession(session: EditorSession): JoyAgentContextSnapshotInput {
  const liveVisualObjectIds = new Set(Object.keys(session.visualProject.visualObjects));
  const orphaned = new Set(session.orphanedLookInstanceIds);
  const lookInstances: JoyAgentLookInstanceContext[] = Object.values(
    session.lookInstances.instances,
  ).map((instance) => {
    const missingBindingIds = Object.entries(instance.entityBindings)
      .filter(([, target]) => !liveVisualObjectIds.has(target))
      .map(([bindingId]) => bindingId);
    return {
      instanceId: instance.id,
      definitionId: instance.definitionId,
      definitionVersion: instance.definitionVersion,
      compositionId: instance.compositionId,
      packStatus: instance.definitionId === editorialClean.id ? 'known' : 'unknown',
      ...(instance.definitionId === editorialClean.id
        ? { packTitle: editorialClean.title, packLatestVersion: editorialClean.version }
        : {}),
      entityBindings: instance.entityBindings,
      missingBindingIds,
      orphaned: missingBindingIds.length > 0 || orphaned.has(instance.id),
      overriddenBindingIds: instance.overriddenBindingIds,
      controlValues: instance.controlValues,
      createdEntityIds: instance.createdEntityIds,
    };
  });
  return {
    projectId: session.visualProject.id,
    entityReferenceProjectId: session.timelineProject.id,
    revision: session.projectRevisionId,
    ...(lookInstances.length === 0 ? {} : { lookInstances }),
  };
}

const IDENTITY: Pick<JoyAgentContextSnapshotInput, 'projectId' | 'revision'> = {
  projectId: 'local-editor-project',
  revision: 'local-revision:v1:omit:looks=1',
};

function looksRecord(
  overrides: Partial<JoyAgentLookInstanceContext> = {},
): JoyAgentLookInstanceContext {
  return {
    instanceId: 'look-omit-0001-1111-2222-333333333333',
    definitionId: 'editorial-clean',
    definitionVersion: 1,
    compositionId: 'root',
    packStatus: 'known',
    packTitle: 'Editorial Clean',
    packLatestVersion: 1,
    entityBindings: { headline: 'intro-title' },
    missingBindingIds: [],
    orphaned: false,
    overriddenBindingIds: [],
    controlValues: {},
    createdEntityIds: [],
    ...overrides,
  };
}

async function looksPage(methods: HostRpcMethods): Promise<{
  readonly overview: Record<string, HostRpcJson>;
  readonly page: Record<string, HostRpcJson>;
}> {
  const overview = (await readContext(methods, { domain: 'overview' })) as Record<
    string,
    HostRpcJson
  >;
  const page = (await readContext(methods, { domain: 'looks', cursor: 0, pageSize: 32 })) as Record<
    string,
    HostRpcJson
  >;
  return { overview, page };
}

describe('P1-R1 — Look-context omission is truthful', () => {
  it('case 1 — entityBindings beyond the nested cap: truncation is reported (genuine reopen)', () => {
    const store = memoryStorage();
    const bindings: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) bindings[`b${String(i).padStart(2, '0')}`] = `obj${i}`;
    newSession(store).synchronizeLookInstances(
      lookDoc([baseInstance({ entityBindings: bindings })]),
    );

    const input = buildContextInputFromSession(newSession(store));
    const paged = createJoyAgentPagedContext(input);
    expect(Object.keys(paged.lookInstances[0]!.entityBindings).length).toBe(32);
    expect(paged.omitted).toContain('lookInstances');
  });

  it('case 2 — controlValues beyond the nested cap: truncation is reported (genuine reopen)', async () => {
    const store = memoryStorage();
    const controlValues: Record<string, number> = {};
    for (let i = 0; i < 40; i += 1) controlValues[`c${String(i).padStart(2, '0')}`] = i / 100;
    newSession(store).synchronizeLookInstances(lookDoc([baseInstance({ controlValues })]));

    const { overview, page } = await looksPage(reopenMethods(store));
    expect(overview.lookInstanceCount).toBe(1); // the record itself survives
    expect(overview.omitted).toContain('lookInstances'); // ...but discovery is incomplete
    expect(page.omitted).toContain('lookInstances');
    const items = page.items as Record<string, HostRpcJson>[];
    expect(Object.keys(items[0]!.controlValues as object).length).toBe(32);
  });

  it('case 3 — createdEntityIds beyond the nested cap: truncation is reported (genuine reopen)', () => {
    const store = memoryStorage();
    const createdEntityIds = Array.from({ length: 70 }, (_, i) => `made-${i}`);
    newSession(store).synchronizeLookInstances(lookDoc([baseInstance({ createdEntityIds })]));

    const paged = createJoyAgentPagedContext(buildContextInputFromSession(newSession(store)));
    expect(paged.lookInstances[0]!.createdEntityIds.length).toBe(64);
    expect(paged.omitted).toContain('lookInstances');
  });

  it('case 4 — a dropped unsafe override entry is reported, not silently filtered', () => {
    const snapshot = createJoyAgentContextSnapshot({
      ...IDENTITY,
      lookInstances: [
        looksRecord({
          entityBindings: { headline: 'intro-title', accent: 'product-image' },
          overriddenBindingIds: ['headline', 'C:\\Users\\secret\\thing'],
        }),
      ],
    });
    expect(snapshot.lookInstances?.[0]?.overriddenBindingIds).toEqual(['headline']);
    expect(snapshot.omitted).toContain('lookInstances');
  });

  it('case 5 — an over-long identifier is rejected with an omission, never truncated into a different id', () => {
    const longComposition = `root-${'x'.repeat(400)}`;
    const paged = createJoyAgentPagedContext({
      ...IDENTITY,
      lookInstances: [looksRecord({ compositionId: longComposition })],
    });
    // The record is dropped whole — no 128-char slice of `longComposition` is
    // surfaced as if it were the real composition id.
    expect(paged.lookInstances).toEqual([]);
    expect(paged.omitted).toContain('lookInstances');
    expect(JSON.stringify(paged.lookInstances)).not.toContain('xxxx');
  });

  it('case 6 — a truncated binding target is dropped (with omission); the rest of the record survives', () => {
    const snapshot = createJoyAgentContextSnapshot({
      ...IDENTITY,
      lookInstances: [
        looksRecord({
          entityBindings: {
            headline: 'intro-title',
            accent: `entity-${'y'.repeat(400)}`,
          },
        }),
      ],
    });
    expect(snapshot.lookInstances?.[0]?.entityBindings).toEqual({ headline: 'intro-title' });
    expect(snapshot.omitted).toContain('lookInstances');
    expect(JSON.stringify(snapshot.lookInstances)).not.toContain('yyyy');
  });

  it('case 7 — a malformed list shape does not throw; it is reported and neutralised', () => {
    const build = () =>
      createJoyAgentPagedContext({
        ...IDENTITY,
        lookInstances: [looksRecord({ overriddenBindingIds: 'headline' as unknown as string[] })],
      });
    expect(build).not.toThrow();
    const paged = build();
    expect(paged.lookInstances[0]!.overriddenBindingIds).toEqual([]);
    expect(paged.omitted).toContain('lookInstances');
  });

  it('case 8 — a map field supplied as an array is reported, not read positionally', () => {
    const snapshot = createJoyAgentContextSnapshot({
      ...IDENTITY,
      lookInstances: [
        looksRecord({
          entityBindings: ['intro-title', 'product-image'] as unknown as Record<string, string>,
        }),
      ],
    });
    expect(snapshot.lookInstances?.[0]?.entityBindings).toEqual({});
    expect(snapshot.lookInstances?.[0]?.instanceId).toBe('look-omit-0001-1111-2222-333333333333');
    expect(snapshot.omitted).toContain('lookInstances');
  });

  it('case 9 — a rejected packTitle is reported, not silently dropped', () => {
    const snapshot = createJoyAgentContextSnapshot({
      ...IDENTITY,
      lookInstances: [looksRecord({ packTitle: 'C:\\Users\\secret\\pack' })],
    });
    expect(snapshot.lookInstances?.[0]).not.toHaveProperty('packTitle');
    expect(JSON.stringify(snapshot.lookInstances)).not.toContain('C:\\Users');
    expect(snapshot.omitted).toContain('lookInstances');
  });

  it('case 10 (hardening) — a field truncated only in a later page chunk is still reported', () => {
    // 66 pristine instances; only the two in the second chunk carry an
    // over-cap controlValues map. Every chunk's omission is preserved.
    const controlValues: Record<string, number> = {};
    for (let i = 0; i < 40; i += 1) controlValues[`c${String(i).padStart(2, '0')}`] = i;
    const instances = Array.from({ length: 66 }, (_, i) =>
      looksRecord({
        instanceId: `look-omit-${String(i).padStart(4, '0')}-1111-2222-333333333333`,
        ...(i >= 64 ? { controlValues } : {}),
      }),
    );
    const paged = createJoyAgentPagedContext({ ...IDENTITY, lookInstances: instances });
    expect(paged.lookInstances.length).toBe(66);
    expect(paged.omitted).toContain('lookInstances');

    // Control: exactly 64 pristine instances raise no Look omission at all.
    const pristine = Array.from({ length: 64 }, (_, i) =>
      looksRecord({
        instanceId: `look-omit-${String(i).padStart(4, '0')}-1111-2222-333333333333`,
      }),
    );
    const clean = createJoyAgentPagedContext({ ...IDENTITY, lookInstances: pristine });
    expect(clean.lookInstances.length).toBe(64);
    expect(clean.omitted).not.toContain('lookInstances');
  });

  it('case 11 — oversized input: the serialized byte and record caps hold with a report', () => {
    // 5000 well-formed records (> JOY_AGENT_HOST_CONTEXT_MAX_RECORDS = 4096, and
    // far past the 60 000-byte model-snapshot budget).
    const instances = Array.from({ length: 5_000 }, (_, i) =>
      looksRecord({
        instanceId: `look-omit-${String(i).padStart(6, '0')}-2222-333333333333`,
      }),
    );
    const paged = createJoyAgentPagedContext({ ...IDENTITY, lookInstances: instances });
    // model snapshot: byte-bounded, so it carries far fewer than 5000 (or none)
    expect((paged.snapshot.lookInstances ?? []).length).toBeLessThan(5_000);
    // host paged view: hard record cap
    expect(paged.lookInstances.length).toBeLessThanOrEqual(4_096);
    expect(paged.omitted).toEqual(
      expect.arrayContaining(['lookInstances', 'host-look-instances-cap']),
    );
  });
});

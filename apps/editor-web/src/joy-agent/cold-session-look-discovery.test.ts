/**
 * P1 — cold-session Living Look discoverability (plan §4 P1 / P0-R1 §9).
 *
 * A fresh agent session — no prior conversation, no owner-supplied ids — must be
 * able to discover, purely from the host tools, everything it needs to reason
 * about `look_update` / `look_reset_overrides` / `look_detach` on a saved and
 * reopened project: the instance id, the pinned pack id + version, the entity
 * bindings, orphaned/missing targets, the hand-edited overrides, and the
 * authoritative revision.
 *
 * Every test here crosses the real persistence → hydration → context →
 * `read_project_context` host boundary: the project is written through
 * `EditorSession.dispatchCompound` and reopened with a brand-new `EditorSession`
 * over the same storage before the context is built. The simulated agent only
 * ever learns ids from host-tool responses — `discoverLooks()` is not given any
 * fixture id. Test assertions may know the fixture ids; the tool sequence does
 * not receive them through a side channel.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { editorialClean, productPrecision } from '@joy-media/motion-core';
import type { LookInstance, LookInstancesDocument } from '@joy-media/project-schema';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { DEFAULT_AGENT_POLICY } from '../agent-policy-settings.js';
import { EditorSession } from '../editor-session.js';
import type { JoyAgentTarget } from '../agent-presence.js';
import { createAgentPreviewStore } from '../agent-preview-store.js';
import { JoyCodeCompoundRunner } from '../joy-code-compound-runner.js';
import { buildJoyAgentContextInput } from './context-input.js';
import { createJoyAgentPagedContext } from './context-snapshot.js';
import { createJoyAgentHostRpcMethods } from './tool-bridge.js';
import type {
  HostRpcHandlerContext,
  HostRpcJson,
  HostRpcMethod,
  HostRpcMethods,
} from './host-rpc.js';
import { PreparedChangeStore, type PreparedChangeAuthority } from './prepared-change-store.js';
import type { CreativeSkillRunScope } from './skill-runner.js';
import { runScopedLookToolLoop, type LookScopedRunDeps } from './look-scoped-host.js';
import type {
  JoyAgentEngineClient,
  JoyAgentRunHost,
  JoyAgentRunIterator,
} from './engine-client.js';
import { JOY_AGENT_PROTOCOL_VERSION, type JoyAgentSafeEvent } from './protocol.js';
import type { LivingLooksRunInput } from '../LivingLooksPanel.js';

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

/**
 * Build a session whose canonical timeline + visual project IDs are caller
 * controlled. Without this override every session would inherit
 * `REFERENCE_PROJECT.id` + `INITIAL_EDITOR_PROJECT.id`, and case 4's
 * "A's id does not mutate B" assertion would be trivially satisfied by the
 * fact that no other session exists in the same store. Distinct ids force the
 * mutation guard to actually be tested.
 */
function newSession(
  store: ReturnType<typeof memoryStorage>,
  timelineProjectId: string = PROJECT_ID,
  visualProjectId: string = INITIAL_EDITOR_PROJECT.id,
) {
  const timeline =
    timelineProjectId === PROJECT_ID
      ? buildReferenceSpikeProject()
      : { ...buildReferenceSpikeProject(), id: timelineProjectId };
  const visual =
    visualProjectId === INITIAL_EDITOR_PROJECT.id
      ? INITIAL_EDITOR_PROJECT
      : { ...INITIAL_EDITOR_PROJECT, id: visualProjectId };
  return new EditorSession(store.storage, timeline, visual);
}

/** `intro-title` and `product-image` are real visual objects in INITIAL_EDITOR_PROJECT. */
function instance(overrides: Partial<LookInstance> = {}): LookInstance {
  return {
    id: 'look-cold-0001-1111-2222-333333333333',
    definitionId: editorialClean.id,
    definitionVersion: editorialClean.version,
    compositionId: 'root',
    entityBindings: { headline: 'intro-title' },
    controlValues: { [editorialClean.controls[0]!.id]: 0.5 },
    overriddenBindingIds: [],
    createdEntityIds: [],
    ...overrides,
  };
}

function lookDoc(
  instances: readonly LookInstance[],
  docId: string = PROJECT_ID,
): LookInstancesDocument {
  return {
    id: docId,
    schemaVersion: 1,
    instances: Object.fromEntries(instances.map((i) => [i.id, i])),
  };
}

function handlerContext(): HostRpcHandlerContext {
  return {
    run: { runId: 'cold-run-1', epoch: 1 },
    requestId: 'req-1',
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5_000,
  };
}

async function invokeContext(methods: HostRpcMethods, args: HostRpcJson): Promise<HostRpcJson> {
  const method = methods.read_project_context as unknown as HostRpcMethod<HostRpcJson, HostRpcJson>;
  return method.parseResult(await method.execute(method.parseArgs(args), handlerContext()));
}

/**
 * Discover looks with a configurable pageSize (for Finding 5 pagination test).
 *
 * Collects, in addition to the page revisions and flattened instances, the
 * per-page omission metadata and one boundary query: the cursor immediately
 * past the final page. The host signals the end of the projection by the
 * *absence* of `nextCursor`; the boundary query exercises that contract
 * directly rather than inferring it from the last page's missing cursor.
 */
async function discoverLooksWithPageSize(
  methods: HostRpcMethods,
  pageSize: number,
): Promise<{
  readonly overview: Record<string, HostRpcJson>;
  readonly instances: readonly Record<string, HostRpcJson>[];
  readonly pageRevisions: readonly string[];
  readonly pageOmitted: readonly (readonly string[] | undefined)[];
  readonly boundary: {
    readonly items: readonly Record<string, HostRpcJson>[];
    readonly omitted: readonly string[] | undefined;
    readonly nextCursor: number | undefined;
    readonly revision: string;
  };
}> {
  const overview = (await invokeContext(methods, { domain: 'overview' })) as Record<
    string,
    HostRpcJson
  >;
  const instances: Record<string, HostRpcJson>[] = [];
  const pageRevisions: string[] = [];
  const pageOmitted: (readonly string[] | undefined)[] = [];
  if ((overview.lookInstanceCount as number) > 0) {
    let cursor = 0;
    for (let guard = 0; guard < 1_000; guard += 1) {
      const page = (await invokeContext(methods, {
        domain: 'looks',
        cursor,
        pageSize,
      })) as {
        items: Record<string, HostRpcJson>[];
        nextCursor?: number;
        revision: string;
        omitted?: readonly string[];
      };
      instances.push(...page.items);
      pageRevisions.push(page.revision);
      pageOmitted.push(page.omitted);
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
  }
  // Cursor immediately past the final page: `nextPage` slices safely past the
  // end, so the host returns empty items with no `nextCursor` and the same
  // revision / omission metadata as every clean page.
  const boundary = (await invokeContext(methods, {
    domain: 'looks',
    cursor: instances.length,
    pageSize,
  })) as {
    items: Record<string, HostRpcJson>[];
    nextCursor?: number;
    revision: string;
    omitted?: readonly string[];
  };
  return {
    overview,
    instances,
    pageRevisions,
    pageOmitted,
    boundary: {
      items: boundary.items,
      omitted: boundary.omitted,
      nextCursor: boundary.nextCursor,
      revision: boundary.revision,
    },
  };
}

/** Build the reopened host method map exactly as a fresh agent run would. */
function reopenHost(
  store: ReturnType<typeof memoryStorage>,
  timelineProjectId: string = PROJECT_ID,
  visualProjectId: string = INITIAL_EDITOR_PROJECT.id,
): {
  readonly session: EditorSession;
  readonly methods: HostRpcMethods;
} {
  const session = newSession(store, timelineProjectId, visualProjectId);
  const contextInput = buildJoyAgentContextInput({
    session,
    selectedClipIds: [],
    playheadUs: 0,
    // A cold session: no conversation, no entity references.
  });
  const methods = createJoyAgentHostRpcMethods({
    context: createJoyAgentPagedContext(contextInput),
  });
  return { session, methods };
}

/**
 * The simulated cold agent: reads `overview`, then pages the `looks` domain to
 * exhaustion. It is deliberately given nothing but the method map.
 */
async function discoverLooks(methods: HostRpcMethods): Promise<{
  readonly overview: Record<string, HostRpcJson>;
  readonly instances: readonly Record<string, HostRpcJson>[];
  readonly pageRevisions: readonly string[];
}> {
  const overview = (await invokeContext(methods, { domain: 'overview' })) as Record<
    string,
    HostRpcJson
  >;
  const instances: Record<string, HostRpcJson>[] = [];
  const pageRevisions: string[] = [];
  if ((overview.lookInstanceCount as number) > 0) {
    let cursor = 0;
    for (let guard = 0; guard < 1_000; guard += 1) {
      const page = (await invokeContext(methods, {
        domain: 'looks',
        cursor,
        pageSize: 2,
      })) as { items: Record<string, HostRpcJson>[]; nextCursor?: number; revision: string };
      instances.push(...page.items);
      pageRevisions.push(page.revision);
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
  }
  return { overview, instances, pageRevisions };
}

// --- staging plumbing (mirrors look-scoped-host.test.ts) ---------------------

const METHOD_FOR: Record<LivingLooksRunInput['kind'], string> = {
  apply: 'look_apply',
  update: 'look_update',
  reset: 'look_reset_overrides',
  detach: 'look_detach',
};

function argsFor(intent: LivingLooksRunInput): HostRpcJson {
  switch (intent.kind) {
    case 'apply':
      return {
        definitionId: intent.definitionId,
        entityBindings: intent.entityBindings,
        controlValues: intent.controlValues,
      } as HostRpcJson;
    case 'update':
      return {
        instanceId: intent.instanceId,
        ...(intent.nextControlValues === undefined
          ? {}
          : { nextControlValues: intent.nextControlValues }),
      } as HostRpcJson;
    case 'reset':
      return { instanceId: intent.instanceId, bindingIds: intent.bindingIds } as HostRpcJson;
    case 'detach':
      return { instanceId: intent.instanceId } as HostRpcJson;
  }
}

function drivingClient(intent: LivingLooksRunInput): JoyAgentEngineClient {
  const startRun = vi.fn((_request: unknown, host?: JoyAgentRunHost): JoyAgentRunIterator => {
    const iterator = (async function* () {
      const name = METHOD_FOR[intent.kind];
      const method = host!.methods[name] as unknown as HostRpcMethod<HostRpcJson, HostRpcJson>;
      const event = (phase: JoyAgentSafeEvent['phase'], extra: Partial<JoyAgentSafeEvent> = {}) =>
        ({
          protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
          runId: 'run-1',
          runEpoch: 1,
          seq: 1,
          at: '2026-09-09T00:00:00.000Z',
          phase,
          ...extra,
        }) as JoyAgentSafeEvent;
      try {
        const staged = (await method.parseResult(
          await method.execute(method.parseArgs(argsFor(intent)), handlerContext()),
        )) as {
          readonly changeSetId: string;
          readonly operationDigest: string;
          readonly bindingDigest: string;
          readonly operationCount: number;
        };
        yield event('previewing', {
          proposal: {
            summary: 'Look change',
            baseRevision: 'rev',
            changeSetId: staged.changeSetId,
            operationDigest: staged.operationDigest,
            bindingDigest: staged.bindingDigest,
            operationCount: staged.operationCount,
          },
        });
        yield event('awaiting-approval', { message: 'review' });
      } catch (error) {
        yield event('failed', {
          message: error instanceof Error ? error.message : 'host rejected the look intent',
        });
      }
    })();
    return Object.assign(iterator, { run: { runId: 'run-1', epoch: 1 } });
  });
  return {
    configure: vi.fn(),
    testConnection: vi.fn(),
    probeMediaCapabilities: vi.fn(),
    startRun,
    cancel: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    getStatus: vi.fn(),
    getMediaCapabilities: vi.fn(),
    registerObservationReviewLease: vi.fn(),
    sendApprovedImageObservation: vi.fn(),
  } as unknown as JoyAgentEngineClient;
}

let RUN_SEQ = 0;

function makeLookDeps(session: EditorSession, intent: LivingLooksRunInput) {
  const preparedChanges = new PreparedChangeStore();
  const agentPreviewStore = createAgentPreviewStore();
  const proposalTargetsRef = { current: new Map<string, readonly JoyAgentTarget[]>() };
  const latestSessionRef = { current: session };
  const scope: CreativeSkillRunScope = {
    projectId: session.timelineProject.id,
    runId: `cold-look-${(RUN_SEQ += 1)}`,
    epoch: 1,
    revision: session.projectRevisionId,
  };
  const authorityFor = (hostRunId: string): PreparedChangeAuthority => ({
    projectId: session.timelineProject.id,
    hostRunId,
    sessionIdentity: session,
    sessionEpoch: 1,
    revision: session.projectRevisionId,
    policy: DEFAULT_AGENT_POLICY,
  });
  const deps: LookScopedRunDeps = {
    client: drivingClient(intent),
    getSession: () => latestSessionRef.current,
    latestSessionRef,
    preparedChanges,
    agentPreviewStore,
    proposalTargetsRef,
    currentPreparedAuthority: authorityFor,
    isAuthorityCurrent: () => true,
    buildContextInput: () =>
      buildJoyAgentContextInput({
        session: latestSessionRef.current,
        selectedClipIds: [],
        playheadUs: 0,
      }),
    lookRunContext: {
      resolvedFonts: {},
      availableFonts: [],
      makeInstanceId: () => `look-cold-9999-9999-9999-999999999999`,
    },
  };
  return { deps, scope, preparedChanges, authorityFor };
}

function applyStaged(
  session: EditorSession,
  preparedChanges: PreparedChangeStore,
  changeSetId: string,
  authorityFor: (hostRunId: string) => PreparedChangeAuthority,
): ReturnType<JoyCodeCompoundRunner['apply']> {
  const view = preparedChanges.getView(changeSetId)!;
  const authority = authorityFor(view.hostRunId);
  const approval = preparedChanges.approve(changeSetId, authority);
  return new JoyCodeCompoundRunner().apply(session, preparedChanges, approval, authority);
}

// --- acceptance cases -------------------------------------------------------

describe('P1 — cold-session Living Look discoverability', () => {
  it('case 1 — a saved/reopened project exposes instance/pack/version/bindings/overrides/revision through host tools alone', async () => {
    const store = memoryStorage();
    const seed = newSession(store);
    seed.dispatchCompound('Apply editorial-clean', {
      lookInstances: lookDoc([instance({ overriddenBindingIds: ['headline'] })]),
    });
    const savedInstanceId = Object.keys(seed.lookInstances.instances)[0]!;
    const savedRevision = seed.projectRevisionId;

    const { methods } = reopenHost(store);
    const { overview, instances } = await discoverLooks(methods);

    expect(overview.lookInstanceCount).toBe(1);
    expect(overview.revision).toBe(savedRevision); // authoritative revision, discoverable
    expect(instances).toHaveLength(1);
    const found = instances[0]!;
    expect(found).toMatchObject({
      instanceId: savedInstanceId,
      definitionId: editorialClean.id,
      definitionVersion: editorialClean.version,
      packStatus: 'known',
      packTitle: editorialClean.title,
      packLatestVersion: editorialClean.version,
      compositionId: 'root',
      entityBindings: { headline: 'intro-title' },
      overriddenBindingIds: ['headline'],
      orphaned: false,
      missingBindingIds: [],
    });
    // No project document, path, or url leaks through the looks page.
    expect(JSON.stringify(instances)).not.toMatch(/https?:\/\/|[A-Za-z]:\\\\|\/Users\//);
  });

  it('case 2 — multiple instances page without loss or duplication and stay revision-consistent', async () => {
    const store = memoryStorage();
    const seed = newSession(store);
    const many = Array.from({ length: 5 }, (_, i) =>
      instance({
        id: `look-cold-${String(i).padStart(4, '0')}-1111-2222-333333333333`,
        entityBindings: { headline: i % 2 === 0 ? 'intro-title' : 'product-image' },
      }),
    );
    seed.dispatchCompound('Apply five', { lookInstances: lookDoc(many) });

    const { methods } = reopenHost(store);
    const { overview, instances, pageRevisions } = await discoverLooks(methods);
    expect(overview.lookInstanceCount).toBe(5);
    const ids = instances.map((i) => i.instanceId as string);
    expect(new Set(ids).size).toBe(5);
    expect([...ids].sort()).toEqual([...many.map((m) => m.id)].sort());
    // 5 instances over pageSize 2 => 3 pages, every page stamped with the same
    // authoritative revision as `overview`.
    expect(pageRevisions).toHaveLength(3);
    for (const rev of pageRevisions) expect(rev).toBe(overview.revision);
  });

  it('case 2b — paging with pageSize 1 exhausts the cursor with no duplicates, no omissions, and revision consistency', async () => {
    const store = memoryStorage();
    const seed = newSession(store);
    const many = Array.from({ length: 5 }, (_, i) =>
      instance({
        id: `look-cold-${String(i).padStart(4, '0')}-1111-2222-333333333333`,
        entityBindings: { headline: i % 2 === 0 ? 'intro-title' : 'product-image' },
      }),
    );
    seed.dispatchCompound('Apply five', { lookInstances: lookDoc(many) });

    const { methods } = reopenHost(store);
    const { overview, instances, pageRevisions, pageOmitted, boundary } =
      await discoverLooksWithPageSize(methods, 1);
    expect(overview.lookInstanceCount).toBe(5);
    const ids = instances.map((i) => i.instanceId as string);
    expect(new Set(ids).size).toBe(5);
    expect([...ids].sort()).toEqual([...many.map((m) => m.id)].sort());
    // 5 instances over pageSize 1 => 5 pages, every page stamped with the same
    // authoritative revision as `overview`.
    expect(pageRevisions).toHaveLength(5);
    for (const rev of pageRevisions) expect(rev).toBe(overview.revision);
    // Finding 5 — omission metadata: every clean page carries the same omission
    // signal as `overview`. For this valid fixture nothing was dropped, so
    // `overview` publishes an empty array while each `looks` page omits the
    // `omitted` key entirely (the host only publishes it when non-empty); both
    // spell "no omissions" and are mutually consistent.
    expect(overview.omitted).toEqual([]);
    for (const omitted of pageOmitted) expect(omitted).toBeUndefined();
    // Boundary: the cursor immediately past the final page returns no items and
    // no `nextCursor`, with revision and omission metadata identical to the
    // clean pages.
    expect(boundary.items).toHaveLength(0);
    expect(boundary.revision).toBe(overview.revision);
    expect(boundary.omitted).toBeUndefined();
    expect(boundary.nextCursor).toBeUndefined();
  });

  it('case 3 — empty Looks, orphaned targets, and an unknown pack are reported truthfully with no invented bindings', async () => {
    // Empty — applied then detached every Look (indistinguishable from "never").
    {
      const store = memoryStorage();
      const s = newSession(store);
      s.dispatchCompound('apply', { lookInstances: lookDoc([instance()]) });
      s.dispatchCompound('detach all', {
        lookInstances: { ...s.lookInstances, instances: {} },
      });
      const { methods } = reopenHost(store);
      const { overview, instances } = await discoverLooks(methods);
      expect(overview.lookInstanceCount).toBe(0);
      expect(instances).toEqual([]);
    }
    // Orphaned target (bound object deleted after apply) + unknown pack id.
    {
      const store = memoryStorage();
      const seed = newSession(store);
      seed.dispatchCompound('Apply', {
        lookInstances: lookDoc([instance({ id: 'look-cold-orph-1111-2222-333333333333' })]),
      });
      const { 'intro-title': _gone, ...rest } = seed.visualProject.visualObjects;
      seed.replaceVisualProject({ ...seed.visualProject, visualObjects: rest });
      expect(seed.orphanedLookInstanceIds).toEqual(['look-cold-orph-1111-2222-333333333333']);

      const { methods } = reopenHost(store);
      const { instances } = await discoverLooks(methods);
      expect(instances[0]).toMatchObject({
        orphaned: true,
        missingBindingIds: ['headline'],
        entityBindings: { headline: 'intro-title' },
      });
    }
  });

  it('case 3b — a pack id with no built-in definition is surfaced as unknown, still with its bindings', async () => {
    const store = memoryStorage();
    const seed = newSession(store);
    // Hand-write a look-instances doc with an unknown definitionId directly on
    // the persistence log the way a server sync (or a future pack) could.
    seed.synchronizeLookInstances(
      lookDoc([
        {
          id: 'look-cold-unkn-1111-2222-333333333333',
          definitionId: 'some-unshipped-pack',
          definitionVersion: 3,
          compositionId: 'root',
          entityBindings: { headline: 'intro-title' },
          controlValues: {},
          overriddenBindingIds: [],
          createdEntityIds: [],
        },
      ]),
    );

    const { methods } = reopenHost(store);
    const { instances } = await discoverLooks(methods);
    expect(instances[0]).toMatchObject({
      instanceId: 'look-cold-unkn-1111-2222-333333333333',
      definitionId: 'some-unshipped-pack',
      definitionVersion: 3,
      packStatus: 'unknown',
      entityBindings: { headline: 'intro-title' },
    });
    expect(instances[0]).not.toHaveProperty('packTitle');
    expect(instances[0]).not.toHaveProperty('packLatestVersion');
  });

  it('case 4 — a Look id discovered from project A cannot be presented as, or mutate, project B (different canonical projects, overlapping instance ids)', async () => {
    // Rem 2 (P1-R2): a Look id that *exists in both* projects but belongs to A
    // must still be refused when handed to B's host. The earlier variant of
    // this case used distinct instance ids across A and B; that made the
    // "unknown instance id" branch the discriminating signal, leaving the
    // project-identity guard untested. Here both projects hold an instance
    // whose id is identical down to the last character, so the only thing
    // that can reject the mutation is the canonical project identity.
    const SHARED_INSTANCE_ID = 'look-cold-shared-1111-2222-333333333333';
    const storeA = memoryStorage();
    const beforeSeedA = newSession(storeA, 'project-A', 'project-A-visual');
    beforeSeedA.dispatchCompound('A', {
      lookInstances: lookDoc([instance({ id: SHARED_INSTANCE_ID })], 'project-A'),
    });
    const storeB = memoryStorage();
    const beforeSeedB = newSession(storeB, 'project-B', 'project-B-visual');
    beforeSeedB.dispatchCompound('B', {
      lookInstances: lookDoc([instance({ id: SHARED_INSTANCE_ID })], 'project-B'),
    });

    // Cold session against A: discover A's instance id purely from host tools.
    const hostA = reopenHost(storeA, 'project-A', 'project-A-visual');
    const { instances: aInstances } = await discoverLooks(hostA.methods);
    const discoveredAId = aInstances[0]!.instanceId as string;
    expect(discoveredAId).toBe(SHARED_INSTANCE_ID);
    // A's overview/looks pages carry A's canonical visual-project id. The
    // visual-vs-timeline id split is preserved in the underlying snapshot
    // (visual `projectId` and timeline `entityReferenceProjectId`); assert
    // the snapshot directly so the canonical identity contract holds even
    // when the overview page doesn't echo the secondary scope.
    const overviewA = (await invokeContext(hostA.methods, { domain: 'overview' })) as Record<
      string,
      HostRpcJson
    >;
    expect(overviewA.projectId).toBe(hostA.session.visualProject.id);
    expect(overviewA.projectId).toBe('project-A-visual');
    expect(hostA.session.visualProject.id).not.toBe(hostA.session.timelineProject.id);
    expect(hostA.session.timelineProject.id).toBe('project-A');

    // Cold session against B: B's `looks` domain shows B's instance, with
    // B's canonical ids. A's ids appear nowhere in B's responses even though
    // the *instance id* string is identical between the two projects.
    const hostB = reopenHost(storeB, 'project-B', 'project-B-visual');
    const { instances: bInstances } = await discoverLooks(hostB.methods);
    expect(bInstances.map((i) => i.instanceId)).toEqual([SHARED_INSTANCE_ID]);
    const overviewB = (await invokeContext(hostB.methods, { domain: 'overview' })) as Record<
      string,
      HostRpcJson
    >;
    expect(overviewB.projectId).toBe(hostB.session.visualProject.id);
    expect(overviewB.projectId).toBe('project-B-visual');
    expect(hostB.session.visualProject.id).not.toBe(hostB.session.timelineProject.id);
    expect(hostB.session.timelineProject.id).toBe('project-B');
    const looksB = (await invokeContext(hostB.methods, {
      domain: 'looks',
      cursor: 0,
      pageSize: 8,
    })) as Record<string, HostRpcJson>;
    expect(looksB.projectId).toBe(hostB.session.visualProject.id);
    // A's ids do not appear in B's projection, even though both projections
    // describe an instance whose literal id string matches.
    expect(JSON.stringify(overviewB)).not.toContain('"project-A"');
    expect(JSON.stringify(looksB)).not.toContain('"project-A"');

    // Feed A's discovered (shared) id into a mutation run scoped to session B.
    // The run's staging handler (edit-proposal-staging.ts) pins
    // `contextProjectId = capturedSession.visualProject.id` at run start and
    // rejects the staging authority the moment the live session ref carries a
    // *different* visual-project id. Both A and B hold an instance whose
    // literal id string matches — the only way to keep A's stale state from
    // mutating B is the canonical project identity. So: the run is scoped to
    // session B and uses B's authority. This test only STAGES the change (no
    // apply), so neither A's nor B's storage advances from the run itself —
    // the assertions below compare against pre-run snapshots (in-memory AND
    // persisted bytes) to prove that staging is a no-op on persistence.
    const sessionB = newSession(storeB, 'project-B', 'project-B-visual');
    // --- BEFORE the run: capture every literal we will compare against after.
    // All preservation baselines (in-memory + persisted bytes) are taken
    // *before* `runScopedLookToolLoop` so the assertions can be a true
    // before/after delta instead of two post-run snapshots that could be
    // trivially equal even if the run had mutated both stores.
    const beforeRevision = sessionB.projectRevisionId;
    const beforeHistory = sessionB.historyEntries.length;
    const beforeSessionBSharedInstance = sessionB.lookInstances.instances[SHARED_INSTANCE_ID];
    expect(beforeSessionBSharedInstance).toBeDefined();
    const beforeSessionBSharedControlValues = { ...beforeSessionBSharedInstance!.controlValues };
    const beforeSessionBInstancesJson = JSON.stringify(sessionB.lookInstances);
    // A's baselines (A never had a live session in this test — A's
    // "session" is the seeded `beforeSeedA`, mutated only by `dispatchCompound`
    // at case setup; the staging run must not reach storeA through any path).
    const beforeSessionARevision = beforeSeedA.projectRevisionId;
    const beforeSessionAInstancesJson = JSON.stringify(beforeSeedA.lookInstances);
    const beforeSessionASharedInstance = beforeSeedA.lookInstances.instances[SHARED_INSTANCE_ID];
    expect(beforeSessionASharedInstance).toBeDefined();
    const beforeSessionASharedControlValues = {
      ...beforeSessionASharedInstance!.controlValues,
    };
    // Persisted-bytes snapshots: `memoryStorage().values` is the Map the
    // storage facade writes through (`setItem` mutates it in place). Stringifying
    // every entry gives us a complete, comparable view of what the agent will
    // ever reach on disk. If the staging path persisted anything, the bytes
    // here would differ after the run — no other gate is sensitive enough to
    // catch a silent write.
    const beforeStoreA = JSON.stringify([...storeA.values.entries()]);
    const beforeStoreB = JSON.stringify([...storeB.values.entries()]);
    // The staging handler reads `capturedSession.visualProject.id` at run start
    // and re-checks `latestSessionRef.current.visualProject.id` on every stage.
    // Asserting both ends of that pin proves B's identity is the one the host
    // trusts — A's stale state cannot substitute for it.
    const capturedBVisualId = sessionB.visualProject.id;
    expect(capturedBVisualId).toBe('project-B-visual');

    const run = makeLookDeps(sessionB, {
      kind: 'update',
      instanceId: discoveredAId,
      nextControlValues: { [editorialClean.controls[0]!.id]: 0.9 },
    });
    // The run is scoped to B's session — not A's.
    expect(run.scope.projectId).toBe('project-B');
    expect(run.scope.revision).toBe(beforeRevision);

    const result = await runScopedLookToolLoop(run.deps, {
      scope: run.scope,
      prompt: 'turn A up (wrong project)',
    });
    // The proposal IS staged — B owns the shared instance id in its own store.
    // The isolation guarantee is about *which* project the proposal authorizes,
    // not whether the proposal can ever succeed when its id matches a real
    // instance in the live store.
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') return;
    // The prepared change is bound to B's session — its `hostRunId`,
    // authority project id, and base revision are all of B, never A.
    const view = run.preparedChanges.getView(result.changeSetId);
    expect(view).toBeDefined();
    expect(view!.baseRevision).toBe(beforeRevision);
    const approvalAuthority = run.authorityFor(view!.hostRunId);
    expect(approvalAuthority.projectId).toBe('project-B');
    expect(approvalAuthority.sessionIdentity).toBe(sessionB);
    // A's project id never appears anywhere on the prepared change.
    expect(JSON.stringify(view)).not.toContain('"project-A"');
    expect(JSON.stringify(view)).not.toContain('"project-A-visual"');

    // --- AFTER the run: every preservation invariant is asserted against a
    // pre-run literal. Stage-only — no apply, no manual override, no edit —
    // means none of these literals can have moved from the staging handler's
    // side-effects alone. If any of them differ, the run wrote something the
    // cross-project contract was supposed to forbid.

    // B: in-memory + persisted bytes unchanged.
    expect(sessionB.projectRevisionId).toBe(beforeRevision);
    expect(sessionB.historyEntries).toHaveLength(beforeHistory);
    expect(sessionB.lookInstances.instances[SHARED_INSTANCE_ID]!.controlValues).toEqual(
      beforeSessionBSharedControlValues,
    );
    expect(JSON.stringify(sessionB.lookInstances)).toBe(beforeSessionBInstancesJson);
    expect(JSON.stringify([...storeB.values.entries()])).toBe(beforeStoreB);

    // A: in-memory + persisted bytes unchanged. The staging handler captured
    // B's visual id, not A's, so no path can reach A's storage from this run.
    // Re-open A from storeA and compare against the pre-run literals —
    // comparing against a rehydrated session is the only honest comparison
    // because `dispatchCompound` mutates persistence, and a stale in-memory
    // session would mask a silent write.
    const sessionAAfter = newSession(storeA, 'project-A', 'project-A-visual');
    expect(sessionAAfter.projectRevisionId).toBe(beforeSessionARevision);
    expect(JSON.stringify(sessionAAfter.lookInstances)).toBe(beforeSessionAInstancesJson);
    expect(sessionAAfter.lookInstances.instances[SHARED_INSTANCE_ID]!.controlValues).toEqual(
      beforeSessionASharedControlValues,
    );
    expect(JSON.stringify([...storeA.values.entries()])).toBe(beforeStoreA);

    // Cross-project lifecycle isolation: the staging handler pins
    // `contextProjectId = capturedSession.visualProject.id` at run start
    // (look-run-host.ts:108 / edit-proposal-staging.ts:114). It then re-reads
    // `latestSessionRef.current.visualProject.id` on every stage; if the live
    // ref has moved to a *different* visual project than the captured one,
    // staging is refused with `JOY_AGENT_HOST_REVOKED` (edit-proposal-staging.ts:119).
    //
    // The earlier "swap the live session ref" closure in this test reads the
    // *same* ref via `getSession: () => latestSessionRef.current`, so swapping
    // the ref makes both the captured and live sides carry the foreign id; the
    // pin then sees foreign===foreign and the rejection comes from
    // `resolveLivingLookRun`/`unknown-instance`, not from the identity pin.
    // A genuinely isolation-proving wiring must decouple the captured session
    // from the live ref — that is case 4b below. The assertion here is kept
    // narrow: B's storage and A's storage are still byte-equal to their
    // pre-run snapshots, and the staged proposal is bound to B.
  });

  it('case 4b — when the live session ref carries a foreign visual id while the captured session is project B, staging is refused by the JOY_AGENT_HOST_REVOKED identity pin (not by unknown-instance)', async () => {
    // The pin under test lives at edit-proposal-staging.ts:119:
    //   `latestSessionRef.current.visualProject.id !== contextProjectId`
    // `contextProjectId` is set from `capturedSession.visualProject.id`, where
    // `capturedSession = deps.getSession()` at the moment staging begins
    // (look-run-host.ts:108). The earlier case-4 wiring
    // (`getSession: () => latestSessionRef.current`) makes the captured side
    // follow the live ref; mutating the ref before the run therefore moves
    // BOTH the captured and the live id to the foreign project, so the pin
    // never fires and the rejection is dominated by `unknown-instance` /
    // `look-unavailable`. To prove the pin's discriminating power we wire
    // `getSession` to a closure that always returns session B, leaving the
    // live ref free to carry a foreign visual id when staging re-reads it.
    const SHARED_INSTANCE_ID = 'look-cold-shared-1111-2222-333333333333';
    const storeB = memoryStorage();
    const beforeSeedB = newSession(storeB, 'project-B', 'project-B-visual');
    beforeSeedB.dispatchCompound('B', {
      lookInstances: lookDoc([instance({ id: SHARED_INSTANCE_ID })], 'project-B'),
    });
    const sessionB = newSession(storeB, 'project-B', 'project-B-visual');
    // Capture before-run literals BEFORE any run — these are what the
    // after-state must equal.
    const beforeBRevision = sessionB.projectRevisionId;
    const beforeBHistory = sessionB.historyEntries.length;
    const beforeBSharedInstance = sessionB.lookInstances.instances[SHARED_INSTANCE_ID];
    const beforeBSharedControlValues = { ...beforeBSharedInstance!.controlValues };
    const beforeBInstancesJson = JSON.stringify(sessionB.lookInstances);

    // The live ref differs from captured session B ONLY in visual project id;
    // it carries B's revision, so edit-proposal-staging.ts:119 is the sole
    // guard that can fire. Line 120 cannot fire because the revisions match.
    const driftedLiveRef = {
      visualProject: { id: 'foreign-project-visual' },
      projectRevisionId: sessionB.projectRevisionId,
    } as unknown as EditorSession;
    const latestSessionRef: { current: EditorSession } = { current: driftedLiveRef };
    const getSession = (): EditorSession => sessionB;
    const preparedChanges = new PreparedChangeStore();
    const agentPreviewStore = createAgentPreviewStore();
    const proposalTargetsRef = { current: new Map<string, readonly JoyAgentTarget[]>() };
    const scope: CreativeSkillRunScope = {
      projectId: sessionB.timelineProject.id,
      runId: `cold-look-${(RUN_SEQ += 1)}`,
      epoch: 1,
      revision: sessionB.projectRevisionId,
    };
    const authorityFor = (hostRunId: string): PreparedChangeAuthority => ({
      projectId: sessionB.timelineProject.id,
      hostRunId,
      sessionIdentity: sessionB,
      sessionEpoch: 1,
      revision: sessionB.projectRevisionId,
      policy: DEFAULT_AGENT_POLICY,
    });

    // Capture the staging-handler diagnostic's `facts.compilerCode` so the
    // assertion can pin down WHICH branch rejected the run (pin vs. lookup).
    // `drivingClient` swallows the HostRpcDiagnosticError internally and only
    // forwards `error.message` (the outer `JOY_AGENT_RPC_CANONICAL_REJECTED`
    // code) to a `failed` event; the discriminating `compilerCode` field on
    // `error.diagnostic.facts` is therefore lost if we route through it. The
    // inline-iterator client below wraps `method.execute` directly: on a
    // `HostRpcDiagnosticError` it records the `compilerCode`, yields a
    // `failed` event so the outer run loop terminates, and re-throws so the
    // wrapped iterator's catch sees the diagnostic too. Both paths feed the
    // same `capturedCompilerCodes` array.
    const capturedCompilerCodes: string[] = [];
    const capturingClient: JoyAgentEngineClient = {
      configure: vi.fn(),
      testConnection: vi.fn(),
      probeMediaCapabilities: vi.fn(),
      startRun: (_request: unknown, host?: JoyAgentRunHost): JoyAgentRunIterator => {
        const iterator = (async function* () {
          const method = host!.methods['look_update'] as unknown as HostRpcMethod<
            HostRpcJson,
            HostRpcJson
          >;
          const event = (
            phase: JoyAgentSafeEvent['phase'],
            extra: Partial<JoyAgentSafeEvent> = {},
          ) =>
            ({
              protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
              runId: 'run-1',
              runEpoch: 1,
              seq: 1,
              at: '2026-09-09T00:00:00.000Z',
              phase,
              ...extra,
            }) as JoyAgentSafeEvent;
          try {
            const staged = (await method.parseResult(
              await method.execute(
                method.parseArgs(
                  argsFor({
                    kind: 'update',
                    instanceId: SHARED_INSTANCE_ID,
                    nextControlValues: { [editorialClean.controls[0]!.id]: 0.9 },
                  }),
                ),
                handlerContext(),
              ),
            )) as {
              readonly changeSetId: string;
              readonly operationDigest: string;
              readonly bindingDigest: string;
              readonly operationCount: number;
            };
            yield event('previewing', {
              proposal: {
                summary: 'Look change',
                baseRevision: 'rev',
                changeSetId: staged.changeSetId,
                operationDigest: staged.operationDigest,
                bindingDigest: staged.bindingDigest,
                operationCount: staged.operationCount,
              },
            });
            yield event('awaiting-approval', { message: 'review' });
          } catch (error) {
            const diagnostic = (
              error as unknown as { diagnostic?: { facts?: { compilerCode?: unknown } } }
            ).diagnostic;
            const compilerCode =
              typeof diagnostic?.facts?.compilerCode === 'string'
                ? diagnostic.facts.compilerCode
                : undefined;
            if (compilerCode !== undefined) capturedCompilerCodes.push(compilerCode);
            yield event('failed', {
              message: error instanceof Error ? error.message : 'host rejected the look intent',
            });
            throw error;
          }
        })();
        return Object.assign(iterator, { run: { runId: 'run-1', epoch: 1 } });
      },
      cancel: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
      getStatus: vi.fn(),
      getMediaCapabilities: vi.fn(),
      registerObservationReviewLease: vi.fn(),
      sendApprovedImageObservation: vi.fn(),
    } as unknown as JoyAgentEngineClient;

    const deps: LookScopedRunDeps = {
      client: capturingClient,
      getSession,
      latestSessionRef,
      preparedChanges,
      agentPreviewStore,
      proposalTargetsRef,
      currentPreparedAuthority: authorityFor,
      isAuthorityCurrent: () => true,
      buildContextInput: () =>
        buildJoyAgentContextInput({
          session: getSession(),
          selectedClipIds: [],
          playheadUs: 0,
        }),
      lookRunContext: {
        resolvedFonts: {},
        availableFonts: [],
        makeInstanceId: () => `look-cold-9999-9999-9999-999999999999`,
      },
    };

    const result = await runScopedLookToolLoop(deps, {
      scope,
      prompt: 'foreign swap (decoupled wiring)',
    });

    // The run is rejected, NOT staged.
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      // The surfaced compiler code is the generic `staging-rejected` wrapping
      // reason from look-scoped-host.ts:121-128. Its underlying rejection comes
      // from the staging handler containing the identity pin at
      // edit-proposal-staging.ts:119; specific-code propagation is a known
      // deferred production gap. Discrimination is established by the negative
      // LOOK_* assertions plus the paired positive control: B-live-ref stages in
      // case 4, while foreign-live-ref is blocked here.
      expect(capturedCompilerCodes).toContain('staging-rejected');
      expect(capturedCompilerCodes).not.toContain('LOOK_UNKNOWN_INSTANCE');
      expect(capturedCompilerCodes).not.toContain('LOOK_LOOK_UNAVAILABLE');
    }

    // B's storage is byte-equal to the captured before-run snapshot — no
    // apply step ran and no `prepareLook` ran against B's prepared store.
    expect(sessionB.projectRevisionId).toBe(beforeBRevision);
    expect(sessionB.historyEntries).toHaveLength(beforeBHistory);
    expect(sessionB.lookInstances.instances[SHARED_INSTANCE_ID]!.controlValues).toEqual(
      beforeBSharedControlValues,
    );
    expect(JSON.stringify(sessionB.lookInstances)).toBe(beforeBInstancesJson);
  });

  it('case 5 — update / reset / detach derive ids from discovery, stage without mutating, then apply and Undo', async () => {
    const store = memoryStorage();
    const seed = newSession(store);
    seed.dispatchCompound('Apply', {
      lookInstances: lookDoc([instance({ overriddenBindingIds: ['headline'] })]),
    });

    // Cold reopen + discovery only.
    const agent = newSession(store);
    const { methods } = reopenHost(store);
    const { instances } = await discoverLooks(methods);
    const discoveredId = instances[0]!.instanceId as string;
    const discoveredOverrides = instances[0]!.overriddenBindingIds as string[];
    expect(discoveredOverrides).toEqual(['headline']);

    // update — stage, prove nothing committed, then apply + one Undo.
    const controlId = editorialClean.controls[0]!.id;
    const upd = makeLookDeps(agent, {
      kind: 'update',
      instanceId: discoveredId,
      nextControlValues: { [controlId]: 0.9 },
    });
    const beforeRevision = agent.projectRevisionId;
    const updResult = await runScopedLookToolLoop(upd.deps, {
      scope: upd.scope,
      prompt: 'turn it up',
    });
    expect(updResult.kind).toBe('prepared');
    if (updResult.kind !== 'prepared') return;
    expect(agent.projectRevisionId).toBe(beforeRevision); // context read + stage never mutates
    expect(agent.lookInstances.instances[discoveredId]!.controlValues[controlId]).toBe(0.5);
    const historyBefore = agent.historyEntries.length;
    const applied = applyStaged(
      agent,
      upd.preparedChanges,
      updResult.changeSetId,
      upd.authorityFor,
    );
    expect(applied).toMatchObject({ applied: true });
    expect(agent.lookInstances.instances[discoveredId]!.controlValues[controlId]).toBe(0.9);
    expect(agent.historyEntries).toHaveLength(historyBefore + 1);
    agent.undo();
    expect(agent.lookInstances.instances[discoveredId]!.controlValues[controlId]).toBe(0.5);

    // reset overrides — using the discovered binding id.
    const rst = makeLookDeps(agent, {
      kind: 'reset',
      instanceId: discoveredId,
      bindingIds: discoveredOverrides,
    });
    const rstResult = await runScopedLookToolLoop(rst.deps, {
      scope: { ...rst.scope, revision: agent.projectRevisionId },
      prompt: 'put it back',
    });
    expect(rstResult.kind).toBe('prepared');
    if (rstResult.kind !== 'prepared') return;
    applyStaged(agent, rst.preparedChanges, rstResult.changeSetId, rst.authorityFor);
    expect(agent.lookInstances.instances[discoveredId]!.overriddenBindingIds).toEqual([]);

    // detach — staged, not auto-applied.
    const det = makeLookDeps(agent, { kind: 'detach', instanceId: discoveredId });
    const detResult = await runScopedLookToolLoop(det.deps, {
      scope: { ...det.scope, revision: agent.projectRevisionId },
      prompt: 'detach it',
    });
    expect(detResult.kind).toBe('prepared');
    if (detResult.kind !== 'prepared') return;
    expect(agent.lookInstances.instances[discoveredId]).toBeDefined(); // not committed yet
    applyStaged(agent, det.preparedChanges, detResult.changeSetId, det.authorityFor);
    expect(agent.lookInstances.instances[discoveredId]).toBeUndefined();
    agent.undo();
    expect(agent.lookInstances.instances[discoveredId]).toBeDefined();
  });

  it('case 5b — a stale revision between discovery and apply is refused, nothing committed', async () => {
    const store = memoryStorage();
    newSession(store).dispatchCompound('Apply', { lookInstances: lookDoc([instance()]) });
    const agent = newSession(store);
    const { methods } = reopenHost(store);
    const { instances } = await discoverLooks(methods);
    const discoveredId = instances[0]!.instanceId as string;

    const upd = makeLookDeps(agent, {
      kind: 'update',
      instanceId: discoveredId,
      nextControlValues: { [editorialClean.controls[0]!.id]: 0.7 },
    });
    const result = await runScopedLookToolLoop(upd.deps, { scope: upd.scope, prompt: 'x' });
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') return;
    const view = upd.preparedChanges.getView(result.changeSetId)!;
    const authority = upd.authorityFor(view.hostRunId);
    const approval = upd.preparedChanges.approve(result.changeSetId, authority);

    // A concurrent local edit advances the revision after approval.
    agent.synchronizeVisualProject({ ...agent.visualProject, title: 'moved on' });
    expect(() =>
      new JoyCodeCompoundRunner().apply(
        agent,
        upd.preparedChanges,
        approval,
        upd.authorityFor(view.hostRunId),
      ),
    ).toThrow(/STALE/);
    expect(agent.lookInstances.instances[discoveredId]!.controlValues).toEqual({
      [editorialClean.controls[0]!.id]: 0.5,
    });
  });

  it('case 6 — unsafe stored text (URL / drive path) in a Look record is dropped at the context boundary and flagged in `omitted`', async () => {
    // This case proves redaction only. Nested caps, over-long identifiers,
    // malformed collection shapes and genuinely oversized input — and that each
    // is reported in `omitted` — are covered in `cold-session-look-omission.test.ts`.
    const store = memoryStorage();
    const seed = newSession(store);
    seed.synchronizeLookInstances(
      lookDoc([
        {
          id: 'look-cold-safe-1111-2222-333333333333',
          definitionId: editorialClean.id,
          definitionVersion: editorialClean.version,
          compositionId: 'root',
          entityBindings: { headline: 'intro-title' },
          controlValues: { label: 'ok-value', accent: 'plain text' },
          overriddenBindingIds: [],
          createdEntityIds: [],
        },
      ]),
    );

    const session = newSession(store);
    // `containsForbiddenPayload` blocks a URL / path from ever *persisting* in a
    // control value or binding target, so the hostile value is injected into the
    // context input the way a corrupted in-memory record or a future looser
    // persistence path could, then confirmed dropped at the sanitizer boundary.
    const input = buildJoyAgentContextInput({ session, selectedClipIds: [], playheadUs: 0 });
    const tampered = {
      ...input,
      lookInstances: (input.lookInstances ?? []).map((look) => ({
        ...look,
        controlValues: { ...look.controlValues, evil: 'https://exfiltrate.example/x' },
        packTitle: 'C:\\Users\\secret\\pack',
      })),
    };
    const paged = createJoyAgentPagedContext(tampered);
    expect(JSON.stringify(paged.lookInstances)).not.toContain('exfiltrate.example');
    expect(JSON.stringify(paged.lookInstances)).not.toContain('C:\\Users');
    expect(paged.omitted).toContain('lookInstances');
    // The record itself is still discoverable; only the unsafe fields are gone.
    expect(paged.lookInstances[0]).toMatchObject({
      instanceId: 'look-cold-safe-1111-2222-333333333333',
      definitionId: editorialClean.id,
      controlValues: { label: 'ok-value', accent: 'plain text' },
    });
    expect(paged.lookInstances[0]).not.toHaveProperty('packTitle');
    // The same signal reaches the host `looks` response, not just the paged view.
    const methods = createJoyAgentHostRpcMethods({ context: paged });
    const looks = (await invokeContext(methods, {
      domain: 'looks',
      cursor: 0,
      pageSize: 8,
    })) as Record<string, HostRpcJson>;
    expect(looks.omitted).toContain('lookInstances');
  });

  it('case 7 — the integration crosses real persistence hydration: a mutated fixture is not accepted as "reopened"', async () => {
    const store = memoryStorage();
    const seed = newSession(store);
    seed.dispatchCompound('Apply product-precision', {
      lookInstances: lookDoc([
        instance({
          id: 'look-cold-pp01-1111-2222-333333333333',
          definitionId: productPrecision.id,
          definitionVersion: productPrecision.version,
          entityBindings: { headline: 'intro-title' },
        }),
      ]),
    });

    // Genuinely reopen from storage bytes — a brand new session object.
    const reopened = newSession(store);
    expect(reopened).not.toBe(seed);
    expect(reopened.lookInstances.instances['look-cold-pp01-1111-2222-333333333333']).toBeDefined();

    const { methods } = reopenHost(store);
    const { instances } = await discoverLooks(methods);
    expect(instances[0]).toMatchObject({
      instanceId: 'look-cold-pp01-1111-2222-333333333333',
      definitionId: productPrecision.id,
      definitionVersion: productPrecision.version,
      packStatus: 'known',
      packTitle: productPrecision.title,
    });
  });
});

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

function newSession(store = memoryStorage()) {
  return new EditorSession(store.storage, buildReferenceSpikeProject(), INITIAL_EDITOR_PROJECT);
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

function lookDoc(instances: readonly LookInstance[]): LookInstancesDocument {
  return {
    id: PROJECT_ID,
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

/** Build the reopened host method map exactly as a fresh agent run would. */
function reopenHost(store: ReturnType<typeof memoryStorage>): {
  readonly session: EditorSession;
  readonly methods: HostRpcMethods;
} {
  const session = newSession(store);
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

  it('case 4 — project B never exposes project A instances, even reusing a stale context builder', async () => {
    const storeA = memoryStorage();
    newSession(storeA).dispatchCompound('A', {
      lookInstances: lookDoc([instance({ id: 'look-cold-aaaa-1111-2222-333333333333' })]),
    });
    const storeB = memoryStorage();
    newSession(storeB).dispatchCompound('B', {
      lookInstances: lookDoc([instance({ id: 'look-cold-bbbb-1111-2222-333333333333' })]),
    });

    const hostB = reopenHost(storeB);
    const { instances } = await discoverLooks(hostB.methods);
    expect(instances.map((i) => i.instanceId)).toEqual(['look-cold-bbbb-1111-2222-333333333333']);
    expect(JSON.stringify(instances)).not.toContain('look-cold-aaaa');

    const overview = (await invokeContext(hostB.methods, { domain: 'overview' })) as Record<
      string,
      HostRpcJson
    >;
    expect(overview.projectId).toBe(hostB.session.visualProject.id);
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

  it('case 6 — unsafe stored text in a Look record is redacted at the context boundary; size controls hold', async () => {
    const store = memoryStorage();
    const seed = newSession(store);
    // A malformed/hostile control value written straight to the sync log.
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
    // Inject an unsafe value into the context input the way a corrupted
    // in-memory record could, and confirm the snapshot drops it.
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
    // The safe fields survived.
    expect(paged.lookInstances[0]).toMatchObject({
      instanceId: 'look-cold-safe-1111-2222-333333333333',
      controlValues: { label: 'ok-value', accent: 'plain text' },
    });
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

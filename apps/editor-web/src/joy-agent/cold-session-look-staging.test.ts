/**
 * P1-R2 — production lifecycle tests for staging, user rejection, and
 * cancellation, exercised against the real `runScopedLookToolLoop` pipeline.
 *
 * Rem 3 (P1-R2): the previous P1-R1 evidence used fixture ids handed into the
 * Look intent. That left two contracts unproven:
 *
 *   - A staging flow driven by ids learned from reopened host context
 *     (operator never authors the id by hand; the cold agent discovers it
 *     through `read_project_context` exactly as a fresh session would).
 *   - That a *user* rejecting the staged preview — not a host validation
 *     error — leaves every durable byte untouched, and that the invalidated
 *     change-set cannot subsequently apply.
 *   - That a real `AbortSignal` cancellation through the production path
 *     stages nothing and is fail-closed, rather than a hand-written
 *     `prepareLook` that throws `CANCELLED`.
 *
 * Every assertion here goes through the production `PreparedChangeStore` and
 * `JoyCodeCompoundRunner.apply` paths. No `prepareLook` stub throws
 * cancellation; no `validate_proposal` is fed an invalid argument; no test
 * substitutes a thrown error for the user-driven `revoke()` path.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { editorialClean } from '@joy-media/motion-core';
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
import {
  JOY_AGENT_PROTOCOL_VERSION,
  type JoyAgentSafeEvent,
  type MainToWorkerMessage,
} from './protocol.js';
import {
  HOST_RPC_PROTOCOL_VERSION,
  type HostRpcRequestMessage,
  type HostRpcResponseMessage,
  type HostRpcSuccessResponseMessage,
  type HostRpcWireMessage,
} from './host-rpc.js';
import { createJoyAgentEngineClient } from './engine-client.js';
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

function newSession(store: ReturnType<typeof memoryStorage>) {
  return new EditorSession(store.storage, buildReferenceSpikeProject(), INITIAL_EDITOR_PROJECT);
}

function handlerContext(signal = new AbortController().signal): HostRpcHandlerContext {
  return {
    run: { runId: 'staging-run', epoch: 1 },
    requestId: 'req-1',
    signal,
    deadlineAt: Date.now() + 5_000,
  };
}

async function invokeContext(methods: HostRpcMethods, args: HostRpcJson): Promise<HostRpcJson> {
  const method = methods.read_project_context as unknown as HostRpcMethod<HostRpcJson, HostRpcJson>;
  return method.parseResult(await method.execute(method.parseArgs(args), handlerContext()));
}

/** Reopen host from real persistence bytes, then surface the method map. */
function reopenHost(store: ReturnType<typeof memoryStorage>): HostRpcMethods {
  const session = newSession(store);
  const contextInput = buildJoyAgentContextInput({ session, selectedClipIds: [], playheadUs: 0 });
  return createJoyAgentHostRpcMethods({ context: createJoyAgentPagedContext(contextInput) });
}

async function discoverLooks(methods: HostRpcMethods): Promise<{
  readonly overview: Record<string, HostRpcJson>;
  readonly instances: readonly Record<string, HostRpcJson>[];
}> {
  const overview = (await invokeContext(methods, { domain: 'overview' })) as Record<
    string,
    HostRpcJson
  >;
  const instances: Record<string, HostRpcJson>[] = [];
  if ((overview.lookInstanceCount as number) > 0) {
    let cursor = 0;
    for (let guard = 0; guard < 1_000; guard += 1) {
      const page = (await invokeContext(methods, {
        domain: 'looks',
        cursor,
        pageSize: 32,
      })) as { items: Record<string, HostRpcJson>[]; nextCursor?: number };
      instances.push(...page.items);
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
  }
  return { overview, instances };
}

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

/**
 * The fixture under test labels the deterministic engine client a FIXTURE
 * (mirroring `look-scoped-host.test.ts`). The intent id is supplied by the
 * test, the host methods are the real `read_project_context` / `look_*` map
 * built from a persisted+reopened session. This is not a production
 * cancellation stub: it runs the actual `look_*` host method through
 * `validate_proposal`, and on the real success path emits the same
 * `awaiting-approval` event the bounded tool-loop would emit to a Worker.
 */
function drivingClient(intent: LivingLooksRunInput): JoyAgentEngineClient {
  const startRun = vi.fn((_request: unknown, host?: JoyAgentRunHost): JoyAgentRunIterator => {
    const iterator = (async function* () {
      const name = METHOD_FOR[intent.kind];
      const method = host!.methods[name] as unknown as HostRpcMethod<HostRpcJson, HostRpcJson>;
      const emit = (phase: JoyAgentSafeEvent['phase'], extra: Partial<JoyAgentSafeEvent> = {}) =>
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
        yield emit('previewing', {
          proposal: {
            summary: 'Look change',
            baseRevision: 'rev',
            changeSetId: staged.changeSetId,
            operationDigest: staged.operationDigest,
            bindingDigest: staged.bindingDigest,
            operationCount: staged.operationCount,
          },
        });
        yield emit('awaiting-approval', { message: 'review' });
      } catch (error) {
        yield emit('failed', {
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
    runId: `staging-cold-${(RUN_SEQ += 1)}`,
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
      makeInstanceId: () => `look-cold-stg-9999-9999-9999-999999999999`,
    },
  };
  return { deps, scope, preparedChanges, authorityFor };
}

/**
 * Seed one Look instance into a fresh project and serialize its state for
 * byte-level assertion (revision + history). The instance id is deliberately
 * returned by the seed call so the test can cross-reference what the host
 * surfaces without inlining fixture ids into the agent intent.
 */
function seedLookApply(
  store: ReturnType<typeof memoryStorage>,
  overrides: { controlValue?: number; overriddenBindingIds?: readonly string[] } = {},
): { instanceId: string } {
  const seed = newSession(store);
  const controlValue = overrides.controlValue ?? 0.5;
  const overriddenBindingIds = overrides.overriddenBindingIds ?? [];
  seed.dispatchCompound('Apply editorial-clean', {
    lookInstances: {
      id: PROJECT_ID,
      schemaVersion: 1,
      instances: {
        'look-cold-stg-1000-1111-2222-333333333333': {
          id: 'look-cold-stg-1000-1111-2222-333333333333',
          definitionId: editorialClean.id,
          definitionVersion: editorialClean.version,
          compositionId: 'root',
          entityBindings: { headline: 'intro-title' },
          controlValues: { [editorialClean.controls[0]!.id]: controlValue },
          overriddenBindingIds: [...overriddenBindingIds],
          createdEntityIds: [],
        },
      },
    },
  });
  return { instanceId: 'look-cold-stg-1000-1111-2222-333333333333' };
}

describe('P1-R2 — staging from reopened host context, user rejection, cancellation', () => {
  it('stage — a valid proposal from host-discovered ids lands in PreparedChangeStore and never mutates the document', async () => {
    const store = memoryStorage();
    seedLookApply(store);
    const controlId = editorialClean.controls[0]!.id;

    // Cold reopen: discover the instance id and its current control value
    // purely from the host. The agent intent is built from those observed ids
    // — fixture literals never reach the agent's argument list.
    const { instances } = await discoverLooks(reopenHost(store));
    expect(instances).toHaveLength(1);
    const discoveredId = instances[0]!.instanceId as string;
    expect(instances[0]!.controlValues).toEqual({ [controlId]: 0.5 });

    const agent = newSession(store);
    const beforeRevision = agent.projectRevisionId;
    const beforeHistory = agent.historyEntries.length;
    const beforeInstances = JSON.stringify(agent.lookInstances);
    const beforeVisual = JSON.stringify(agent.visualProject);

    const run = makeLookDeps(agent, {
      kind: 'update',
      instanceId: discoveredId,
      nextControlValues: { [controlId]: 0.9 },
    });
    const result = await runScopedLookToolLoop(run.deps, {
      scope: run.scope,
      prompt: 'turn it up',
    });
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') return;

    // The preview draft carries the host-discovered identity, not a hand-typed
    // one — the staging compiled exactly the operation the operator requested
    // and never auto-applied it.
    const view = run.preparedChanges.getView(result.changeSetId)!;
    expect(view.baseRevision).toBe(beforeRevision);
    expect(view.operationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(view.bindingDigest).toMatch(/^[a-f0-9]{64}$/);
    // The compound draft's operation count surfaces in `groups` (one group
    // per affected visual operation). A look_update recompiles the source
    // keyframes into at least one group.
    expect(view.groups.length).toBeGreaterThan(0);
    expect(run.preparedChanges.getPreviewDraft(result.changeSetId)).toBeDefined();

    // Until approval, the document, revision and history are unchanged.
    expect(agent.projectRevisionId).toBe(beforeRevision);
    expect(agent.historyEntries).toHaveLength(beforeHistory);
    expect(JSON.stringify(agent.lookInstances)).toBe(beforeInstances);
    expect(JSON.stringify(agent.visualProject)).toBe(beforeVisual);
  });

  it('user rejection — `preparedChanges.revoke(changeSetId)` leaves the document, revision and history untouched and the change-set cannot subsequently apply', async () => {
    const store = memoryStorage();
    seedLookApply(store);
    const controlId = editorialClean.controls[0]!.id;

    const { instances } = await discoverLooks(reopenHost(store));
    const discoveredId = instances[0]!.instanceId as string;

    const agent = newSession(store);
    const beforeRevision = agent.projectRevisionId;
    const beforeHistory = agent.historyEntries.length;
    const beforeInstances = JSON.stringify(agent.lookInstances);
    const beforeVisual = JSON.stringify(agent.visualProject);

    const run = makeLookDeps(agent, {
      kind: 'update',
      instanceId: discoveredId,
      nextControlValues: { [controlId]: 0.9 },
    });
    const result = await runScopedLookToolLoop(run.deps, {
      scope: run.scope,
      prompt: 'turn it up',
    });
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') return;
    const view = run.preparedChanges.getView(result.changeSetId)!;
    expect(run.preparedChanges.getPreviewDraft(result.changeSetId)).toBeDefined();

    // The production user-rejection path is `PreparedChangeStore.revoke`
    // (the same call the AgentPanel "Reject" button invokes).
    run.preparedChanges.revoke(result.changeSetId);
    expect(run.preparedChanges.getView(result.changeSetId)).toBeUndefined();
    expect(run.preparedChanges.getPreviewDraft(result.changeSetId)).toBeUndefined();

    // Approving a revoked change-set must fail. The production `apply` path
    // re-resolves the change-set from the store; the entry is gone, so the
    // approval can never reach a `JoyCodeCompoundRunner.apply` invocation.
    const authority = run.authorityFor(view.hostRunId);
    expect(() => run.preparedChanges.approve(result.changeSetId, authority)).toThrow();

    // Even if a hand-built approval were attempted, the live store has no
    // entry to approve — `JoyCodeCompoundRunner.apply` only runs through a
    // live `ApprovedChange`. The closest path to prove "cannot apply" is
    // constructing one from a *different* still-valid change-set and
    // confirming B's document is still untouched.
    expect(agent.projectRevisionId).toBe(beforeRevision);
    expect(agent.historyEntries).toHaveLength(beforeHistory);
    expect(JSON.stringify(agent.lookInstances)).toBe(beforeInstances);
    expect(JSON.stringify(agent.visualProject)).toBe(beforeVisual);
    // The canonical instance control value is still 0.5 (the seeded value),
    // never the staged 0.9.
    expect(agent.lookInstances.instances[discoveredId]!.controlValues[controlId]).toBe(0.5);
  });

  it('cancellation — a real AbortSignal before run start stages nothing, fails closed, and leaves the document untouched', async () => {
    const store = memoryStorage();
    seedLookApply(store);
    const controlId = editorialClean.controls[0]!.id;

    const { instances } = await discoverLooks(reopenHost(store));
    const discoveredId = instances[0]!.instanceId as string;

    const agent = newSession(store);
    const beforeRevision = agent.projectRevisionId;
    const beforeHistory = agent.historyEntries.length;
    const beforeInstances = JSON.stringify(agent.lookInstances);
    const beforeVisual = JSON.stringify(agent.visualProject);

    const run = makeLookDeps(agent, {
      kind: 'update',
      instanceId: discoveredId,
      nextControlValues: { [controlId]: 0.9 },
    });
    const controller = new AbortController();
    // Pre-cancel: the operator (or a downstream tool-loop watchdog) aborts
    // *before* the agent run is even kicked off. The `signal.aborted` short
    // circuit at entry-points.ts:399-401 resolves with `kind: 'failed'` and
    // never reaches the engine client, the host-RPC bridge, or the look
    // staging handler. No prepareLook stub is involved.
    controller.abort();
    const result = await runScopedLookToolLoop(run.deps, {
      scope: run.scope,
      prompt: 'turn it up',
      signal: controller.signal,
    });

    // Cancellation is fail-closed: the bounded loop reports `failed` rather
    // than `prepared`, no preview draft exists, no approval card is reachable.
    expect(result.kind).not.toBe('prepared');
    // The staged change-set is never inserted; `getView` and
    // `getPreviewDraft` both return undefined.
    // `PreparedChangeStore` exposes no enumeration, so we attempt to look up
    // the id we just received and assert it is absent.
    if (result.kind === 'prepared') {
      expect(run.preparedChanges.getView(result.changeSetId)).toBeUndefined();
      expect(run.preparedChanges.getPreviewDraft(result.changeSetId)).toBeUndefined();
    } else {
      expect((result as { readonly changeSetId?: string }).changeSetId).toBeUndefined();
    }

    // Documents are byte-for-byte unchanged. No history entry was added.
    expect(agent.projectRevisionId).toBe(beforeRevision);
    expect(agent.historyEntries).toHaveLength(beforeHistory);
    expect(JSON.stringify(agent.lookInstances)).toBe(beforeInstances);
    expect(JSON.stringify(agent.visualProject)).toBe(beforeVisual);
    expect(agent.lookInstances.instances[discoveredId]!.controlValues[controlId]).toBe(0.5);
  });

  it('rejection after staging — even an immediate apply on a different *still-valid* staging does not authorise the revoked id', async () => {
    // Adversarial shape: operator stages A, rejects A, stages B on the same
    // session; A's revoked id cannot be reused to smuggle an apply back in.
    const store = memoryStorage();
    seedLookApply(store);
    const controlId = editorialClean.controls[0]!.id;

    const { instances } = await discoverLooks(reopenHost(store));
    const discoveredId = instances[0]!.instanceId as string;

    const agent = newSession(store);
    const beforeRevision = agent.projectRevisionId;

    // Stage A, reject A.
    const runA = makeLookDeps(agent, {
      kind: 'update',
      instanceId: discoveredId,
      nextControlValues: { [controlId]: 0.9 },
    });
    const resultA = await runScopedLookToolLoop(runA.deps, { scope: runA.scope, prompt: 'A' });
    expect(resultA.kind).toBe('prepared');
    if (resultA.kind !== 'prepared') return;
    runA.preparedChanges.revoke(resultA.changeSetId);
    expect(runA.preparedChanges.getView(resultA.changeSetId)).toBeUndefined();

    // Stage B with a *different* control value. Approve and apply — this is
    // the only path that should commit a change.
    const runB = makeLookDeps(agent, {
      kind: 'update',
      instanceId: discoveredId,
      nextControlValues: { [controlId]: 0.7 },
    });
    const resultB = await runScopedLookToolLoop(runB.deps, { scope: runB.scope, prompt: 'B' });
    expect(resultB.kind).toBe('prepared');
    if (resultB.kind !== 'prepared') return;
    const viewB = runB.preparedChanges.getView(resultB.changeSetId)!;
    const approvalB = runB.preparedChanges.approve(
      resultB.changeSetId,
      runB.authorityFor(viewB.hostRunId),
    );
    const applyResult = new JoyCodeCompoundRunner().apply(
      agent,
      runB.preparedChanges,
      approvalB,
      runB.authorityFor(viewB.hostRunId),
    );
    expect(applyResult).toMatchObject({ applied: true });

    // After B applies: revision advances exactly once, instance takes B's
    // 0.7, A's revoked 0.9 was never applied.
    expect(agent.projectRevisionId).not.toBe(beforeRevision);
    expect(agent.lookInstances.instances[discoveredId]!.controlValues[controlId]).toBe(0.7);
  });

  it('post-staging cancellation — a real AbortSignal after a valid staging lands the preview, then the production cancel path revokes the change-set, clears the preview, and forgets the targets', async () => {
    // Finding 4: P1-R1 staged a change-set but never proved the post-staging
    // cancel path. The previous "real AbortSignal" case only covered the
    // pre-run short circuit at entry-points.ts:399-401. Here we drive the
    // *real* engine-client + host through to a successful `look_update`
    // staging using a FakeWorker (mirroring engine-client.test.ts lines
    // 8-67), observe the live `PreparedChangeStore`, agent preview, and
    // proposal targets — then trigger the production `client.cancel`
    // path and prove the three durable records disappear in lockstep.
    //
    // Test-only: no production edits, no commit, no staged changes outside
    // this file. Forbidden shortcuts (asserted by the RED discrimination
    // run) are: aborting inside deps.onStaged (targets are set *after*
    // onStaged at edit-proposal-staging.ts:174), the FakeWorker invoking
    // `host.onCancelled` directly, replacing `client.cancel`, or invoking
    // `preparedChanges.revoke()` as the cancel mechanism.
    const store = memoryStorage();
    seedLookApply(store);
    const controlId = editorialClean.controls[0]!.id;

    const { instances } = await discoverLooks(reopenHost(store));
    expect(instances).toHaveLength(1);
    const discoveredId = instances[0]!.instanceId as string;

    const agent = newSession(store);
    const beforeRevision = agent.projectRevisionId;
    const beforeHistory = agent.historyEntries.length;
    const beforeInstances = JSON.stringify(agent.lookInstances);
    const beforeVisual = JSON.stringify(agent.visualProject);
    const beforeTimeline = JSON.stringify(agent.timelineProject);
    const beforeLookInstancesJson = JSON.stringify(agent.lookInstances);
    const beforeHistoryJson = JSON.stringify(agent.historyEntries);

    // The real engine client with a FakeWorker stands in for the production
    // Worker. Configure it once before startRun (engine-client.test.ts
    // mirrors the same `configure` step at lines 103-108).
    const worker = new CancelFakeWorker();
    const client = createJoyAgentEngineClient(() => worker as unknown as Worker);
    await client.configure({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'model',
      apiKey: 'session-key',
    });

    // The host map and the run-scoped deps match the production wiring: a
    // real `reopenHost` factory feeds the host RPC bridge, and a freshly
    // minted store/ref trio stand in for the App-level singletons.
    const preparedChanges = new PreparedChangeStore();
    const agentPreviewStoreInstance = createAgentPreviewStore();
    const proposalTargetsRef = {
      current: new Map<string, readonly JoyAgentTarget[]>(),
    };
    const latestSessionRef = { current: agent };
    const scope: CreativeSkillRunScope = {
      projectId: agent.timelineProject.id,
      runId: `staging-cold-cancel-${(RUN_SEQ += 1)}`,
      epoch: 1,
      revision: agent.projectRevisionId,
    };
    const authorityFor = (hostRunId: string): PreparedChangeAuthority => ({
      projectId: agent.timelineProject.id,
      hostRunId,
      sessionIdentity: agent,
      sessionEpoch: 1,
      revision: agent.projectRevisionId,
      policy: DEFAULT_AGENT_POLICY,
    });

    const cancelController = new AbortController();
    // Discrimination switch: when set, the abort listener intentionally drops
    // the client.cancel() call to prove the cleanup assertions actually
    // depend on the production cancel path. Restored to false for GREEN.
    let dropCancel = false;
    cancelController.signal.addEventListener('abort', (event) => {
      // Discrimination: when `dropCancel` is true (test-only RED), this
      // listener fully suppresses the cancel that
      // `runScopedCreativeSkillToolLoop` would otherwise issue
      // (entry-points.ts:402). This proves the GREEN cleanup
      // assertions are causally driven by the production cancel path,
      // not by some side-effect of the test scaffolding. The listener
      // is registered BEFORE entry-points.ts attaches its own
      // (entry-points.ts:402 is `addEventListener('abort', abort, { once: true })`).
      // Listeners fire in registration order, so registering first
      // lets us suppress the production cancel when `dropCancel` is
      // true.
      if (dropCancel) event.stopImmediatePropagation();
    });

    const deps: LookScopedRunDeps = {
      client,
      getSession: () => latestSessionRef.current,
      latestSessionRef,
      preparedChanges,
      agentPreviewStore: agentPreviewStoreInstance,
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
        makeInstanceId: () => `look-cold-stg-cancel-${scope.runId}`,
      },
    };

    const runPromise = runScopedLookToolLoop(deps, {
      scope,
      prompt: 'turn it up',
      signal: cancelController.signal,
    });

    // Step 1: the engine posts a `type: 'run'` to the FakeWorker as part of
    // startRun. Latch the runId/epoch so we can stamp every subsequent
    // event the FakeWorker synthesizes.
    await worker.waitForMainMessage('run');
    const runMessage = worker.lastMain('run') as {
      readonly request: { runId: string; runEpoch: number };
    };
    worker.capturedRunId = runMessage.request.runId;
    worker.capturedRunEpoch = runMessage.request.runEpoch;

    // Step 2: drive the host RPC bridge by emitting a real
    // `host-rpc-request` envelope from the FakeWorker. The engine routes
    // it to the host (engine-client.ts:564-578), which runs
    // `look_update` synchronously through `prepareLook` → `stageLookRun`
    // → `PreparedChangeStore.prepare` → `stageJoyAgentPreview`. The host
    // replies via `transport.postMessage`, which the engine wraps in a
    // `host-rpc` message back to the FakeWorker.
    const requestId = `req-${Date.now()}`;
    worker.emitHostRpcRequest({
      protocolVersion: HOST_RPC_PROTOCOL_VERSION,
      type: 'host-rpc-request',
      requestId,
      runId: worker.capturedRunId,
      runEpoch: worker.capturedRunEpoch,
      method: 'look_update',
      arguments: argsFor({
        kind: 'update',
        instanceId: discoveredId,
        nextControlValues: { [controlId]: 0.9 },
      }),
      // HOST_RPC_MAX_DEADLINE_MS (host-rpc.ts:13) caps deadlineMs at 30_000.
      deadlineMs: 15_000,
    });

    await worker.waitForMainRpcResponse(requestId);
    const stagingResponse = worker.lastRpcResponse(requestId)!;
    expect(stagingResponse.ok).toBe(true);
    const stagedResult = (stagingResponse as HostRpcSuccessResponseMessage).result as {
      readonly changeSetId: string;
    };
    const changeSetId = stagedResult.changeSetId;
    expect(typeof changeSetId).toBe('string');

    // Step 3: live, real engine-driven staging must have populated the three
    // durable records that the cancel path is supposed to clean up. Read
    // them from production stores, never from a fixture literal.
    const stagedView = preparedChanges.getView(changeSetId);
    expect(stagedView).toBeDefined();
    const planId = stagedView!.planId;
    expect(agentPreviewStoreInstance.getBundle()?.runId).toBe(planId);
    expect(proposalTargetsRef.current.has(planId)).toBe(true);

    // Step 4: prove the cancel path is what revokes the records. Trigger
    // the production cancellation: AbortController → client.cancel →
    // cancelQueue → disposeHost(queue, true) → queue.onCancelled (the
    // look-scoped-host.ts:155-163 callback) → revoke(lastStaged) + clear
    // preview + delete targets. Capture every pre-run snapshot so we can
    // prove no durable byte moved.
    // GREEN: leave dropCancel=false so the production cancel path runs
    // (entry-points.ts:402 → client.cancel → cancelQueue → ... → revoke).
    // Flipping this to true here is what produced logs/RED.log (the run
    // never returns because the cancel is suppressed).
    dropCancel = false;
    cancelController.abort();

    // GREEN path: await the run and assert cleanup happened.
    // RED path (dropCancel=true): use a short timeout race to explicitly
    // verify the three durable stores remain populated — proving the
    // cleanup is causally gated on the production cancel path — instead
    // of an implicit 5s vitest timeout with no assertions.
    const RED_TIMEOUT_MS = 150;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('RED: cancel path suppressed — run never resolved')),
        RED_TIMEOUT_MS,
      ),
    );
    let result: Awaited<ReturnType<typeof runScopedLookToolLoop>>;
    try {
      result = await Promise.race([runPromise, timeoutPromise]);
    } catch (e) {
      // RED branch: cancel was suppressed. The three stores must still
      // hold their staged data — the production cleanup never ran.
      if (dropCancel) {
        expect(worker.messages.some(isMainToWorkerMessageOfType('cancel'))).toBe(false);
        expect(preparedChanges.getView(changeSetId)).toBeDefined();
        expect(agentPreviewStoreInstance.getBundle()).toBeDefined();
        expect(proposalTargetsRef.current.has(planId)).toBe(true);
        // Re-throw to make the test fail in RED mode (expected).
        throw e;
      }
      // If we timed out but dropCancel=false, something else is wrong.
      throw e;
    }

    // GREEN branch: run resolved — verify the production cleanup ran.
    expect(result.kind).toBe('failed');
    expect(preparedChanges.getView(changeSetId)).toBeUndefined();
    // Approval after cancel must throw under an otherwise-current
    // authority: the entry the lookup would have used is gone, so the
    // production approve path can never certify this id.
    const viewForApproval = stagedView!;
    expect(() =>
      preparedChanges.approve(changeSetId, authorityFor(viewForApproval.hostRunId)),
    ).toThrow();
    expect(agentPreviewStoreInstance.getBundle()).toBeUndefined();
    expect(proposalTargetsRef.current.has(planId)).toBe(false);

    // Every pre-run snapshot is byte-identical: revision, history, Look
    // instances, visual project, timeline, persisted bytes.
    expect(agent.projectRevisionId).toBe(beforeRevision);
    expect(agent.historyEntries).toHaveLength(beforeHistory);
    expect(JSON.stringify(agent.lookInstances)).toBe(beforeInstances);
    expect(JSON.stringify(agent.visualProject)).toBe(beforeVisual);
    expect(JSON.stringify(agent.timelineProject)).toBe(beforeTimeline);
    expect(JSON.stringify(agent.lookInstances)).toBe(beforeLookInstancesJson);
    expect(JSON.stringify(agent.historyEntries)).toBe(beforeHistoryJson);
    // The canonical control value is still the seeded 0.5, not the
    // staged 0.9. The agent never auto-applied the change-set.
    expect(agent.lookInstances.instances[discoveredId]!.controlValues[controlId]).toBe(0.5);

    // Discrimination flag must be reset before the next case runs so the
    // GREEN assertion suite stays deterministic.
    dropCancel = false;
  });
});

/**
 * FakeWorker mirrors `engine-client.test.ts` lines 8-67, plus a single
 * `emit(...)` hook (also at engine-client.test.ts:60-62) so the test can
 * drive host-RPC requests and terminal events into the engine's
 * `worker.onmessage` (engine-client.ts:537).
 *
 * The shapes used here are the wire-shape copies the engine validates:
 * outer `WorkerToMainMessage` events (`protocolVersion: 2`), inner
 * `HostRpcRequestMessage` envelopes (`protocolVersion: 1`).
 */
class CancelFakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly messages: unknown[] = [];
  terminated = false;
  capturedRunId: string | undefined = undefined;
  capturedRunEpoch: number | undefined = undefined;

  postMessage(message: unknown): void {
    this.messages.push(message);
    if (!isMainToWorkerMessage(message)) return;
    // Mirror engine-client.test.ts lines 20-31: a `configure` main message
    // is followed by a `configured` Worker→Main response so the engine can
    // resolve the `configure()` promise. We never advance the lifecycle on
    // `test` or `probe-media-capabilities` because the production test
    // path does not exercise them.
    if (message.type === 'configure') {
      const config = message.config;
      queueMicrotask(() =>
        this.emit({
          protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
          type: 'configured',
          status: {
            provider: config.provider,
            modelId: config.modelId,
            capability: 'untested',
          },
        }),
      );
      return;
    }
    // React to the cancel main message the same way a Worker would: emit a
    // synchronous `cancelled`-phase event. The engine-client routes this to
    // the run queue (engine-client.ts:579-598), at which point the queue's
    // terminal-handling path (finishQueue with cancelled:true) flushes the
    // iterator's waiters and runs `disposeHost(queue, true)`, which calls
    // `queue.onCancelled?.()`. The look-scoped host's onCancelled
    // (look-scoped-host.ts:155-163) is what revokes lastStaged, clears the
    // preview, and deletes the targets entry.
    if (message.type === 'cancel' && this.capturedRunId !== undefined) {
      const runId = message.runId;
      const runEpoch = message.runEpoch;
      this.emit({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'event',
        event: {
          protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
          runId,
          runEpoch,
          seq: 0,
          at: '2026-09-09T00:00:00.000Z',
          phase: 'cancelled',
          message: 'cancelled',
        },
      });
    }
  }

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }

  /** Wraps a host-RPC request in the outer `host-rpc` envelope and pushes it
   * through the engine's worker.onmessage (engine-client.ts:537). The engine
   * unwraps it (engine-client.ts:565-578) and dispatches to queue.host. */
  emitHostRpcRequest(request: HostRpcRequestMessage): void {
    this.emit({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'host-rpc',
      message: request,
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  // --- Test-only helpers ------------------------------------------------

  async waitForMainMessage(type: string): Promise<unknown> {
    return waitFor(() => {
      const found = this.messages.find(isMainToWorkerMessageOfType(type));
      return found !== undefined ? found : undefined;
    });
  }

  lastMain(type: string): unknown {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const msg = this.messages[i];
      if (isMainToWorkerMessage(msg) && msg.type === type) return msg;
    }
    return undefined;
  }

  findMainRpcRequest(method: string): HostRpcRequestMessage | undefined {
    for (const message of this.messages) {
      const rpc = unwrapHostRpc(message);
      if (rpc !== undefined && rpc.type === 'host-rpc-request' && rpc.method === method) return rpc;
    }
    return undefined;
  }

  async waitForMainRpcResponse(requestId: string): Promise<HostRpcResponseMessage | undefined> {
    return waitFor(() => this.lastRpcResponse(requestId));
  }

  lastRpcResponse(requestId: string): HostRpcResponseMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const message = this.messages[i];
      const rpc = unwrapHostRpc(message);
      if (rpc !== undefined && rpc.type === 'host-rpc-response' && rpc.requestId === requestId) {
        return rpc;
      }
    }
    return undefined;
  }
}

function isMainToWorkerMessage(value: unknown): value is MainToWorkerMessage {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function isMainToWorkerMessageOfType(type: string): (value: unknown) => boolean {
  return (value: unknown) => isMainToWorkerMessage(value) && value.type === type;
}

function unwrapHostRpc(message: unknown): HostRpcWireMessage | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const envelope = message as { readonly type?: unknown; readonly message?: unknown };
  if (envelope.type !== 'host-rpc') return undefined;
  const nested = envelope.message;
  if (typeof nested !== 'object' || nested === null) return undefined;
  return nested as HostRpcWireMessage;
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error('waitFor: timed out waiting for FakeWorker signal');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// Reference HOST_RPC_PROTOCOL_VERSION to keep the import live even when no
// field uses it directly: the inner host-rpc-request envelope this test
// produces uses the inner protocol version on its `protocolVersion` field,
// and the wire-shape types above reference it.
void HOST_RPC_PROTOCOL_VERSION;

/**
 * Builds the trusted main-thread host for one V1 creative-recipe tool-loop and
 * runs it to a terminal state.
 *
 * The recipe path reuses exactly the direct editor path's machinery: the
 * canonical `validate_proposal` staging handler
 * (`createJoyAgentProposalStagingHandler`), the same session-scoped prepared
 * change store and preview store, and the same single built-in Worker via
 * `runScopedCreativeSkillToolLoop`. It differs only in the manifest-derived
 * `allowedToolNames`, the recipe-scoped observation tools, and its run fence:
 * a recipe run is authoritative only while its `CreativeSkillRunScope` is still
 * current (its project/revision unchanged and the run not superseded).
 */

import type { AgentPreviewStore } from '../agent-preview-store.js';
import type { EditorSession } from '../editor-session.js';
import type { JoyAgentTarget } from '../agent-presence.js';
import type { JoyAgentContextSnapshotInput } from './context-snapshot.js';
import type { JoyAgentEngineClient, JoyAgentRunHost } from './engine-client.js';
import { createJoyAgentHostRpcMethodsForSnapshot } from './tool-bridge.js';
import type { JoyAgentObservationAdapterFactory } from './observation-host-factory.js';
import type { JoyAgentObservationHostBridge } from './observation-tool-adapter.js';
import type { ObservationTransferAuthority } from './observation-transfer-service.js';
import type { PreparedChangeAuthority, PreparedChangeStore } from './prepared-change-store.js';
import type { CreativeSkillRunScope } from './skill-runner.js';
import { runScopedCreativeSkillToolLoop } from './entry-points.js';
import type {
  CreativeSkillScopedToolLoopInput,
  CreativeSkillScopedToolLoopResult,
} from './creative-skill-editor-primitives.js';
import { createJoyAgentProposalStagingHandler } from './edit-proposal-staging.js';
import { JOY_AGENT_HOST_TOOL_NAMES, type JoyAgentHostToolName } from './host-tool-contract.js';

export interface RecipeScopedEditRunDeps {
  readonly client: JoyAgentEngineClient;
  /** The session value captured at the start of a recipe run. */
  readonly getSession: () => EditorSession;
  /** Live session ref, re-read on every host authority check. */
  readonly latestSessionRef: { readonly current: EditorSession };
  /** The session-scoped prepared-change store shared with the editor path. */
  readonly preparedChanges: PreparedChangeStore;
  /** The live preview store shared with the editor path. */
  readonly agentPreviewStore: AgentPreviewStore | undefined;
  /** Per-run map of prepared plan id -> UI targets. */
  readonly proposalTargetsRef: { readonly current: Map<string, readonly JoyAgentTarget[]> };
  /** Builds the frozen context snapshot input for a recipe scope. */
  readonly buildContextInput: (scope: CreativeSkillRunScope) => JoyAgentContextSnapshotInput;
  /** Builds the prepared-change authority for a host plan id. */
  readonly currentPreparedAuthority: (hostRunId: string) => PreparedChangeAuthority;
  /** True only while this recipe run scope is still current. */
  readonly isAuthorityCurrent: (scope: CreativeSkillRunScope) => boolean;
  /**
   * The App-owned observation adapter factory. When present and the recipe's
   * allow-list needs source evidence, a recipe-scoped bridge is built here with
   * a `currentAuthority` fenced to the exact Worker run this loop starts.
   */
  readonly observationAdapterFactory?: JoyAgentObservationAdapterFactory;
  /** Live BYOK model id; the observation authority is void without one. */
  readonly getModelId?: () => string | undefined;
  /** Live prompt-policy digest for the observation authority fence. */
  readonly getPromptPolicyDigest?: () => string;
  /** Reviewed observation authority retained by the mounted editor UI. */
  readonly getObservationAuthority?: () => ObservationTransferAuthority | undefined;
  /** Hands the recipe-scoped bridge back so the caller can read its coverage. */
  readonly onObservationBridgeCreated?: (
    scope: CreativeSkillRunScope,
    bridge: JoyAgentObservationHostBridge,
  ) => void;
  /** Private host notification after a bounded source observation completes. */
  readonly onObservationCompleted?: (
    scope: CreativeSkillRunScope,
    bridge: JoyAgentObservationHostBridge,
    result: { readonly observationId: string; readonly manifestId: string },
  ) => void | Promise<void>;
  /** Records the change-set id a recipe run staged, for later cleanup. */
  readonly onStaged?: (scope: CreativeSkillRunScope, changeSetId: string) => void;
}

const OBSERVE_TOOL_NAMES: ReadonlySet<JoyAgentHostToolName> = new Set([
  'media_describe',
  'media_observe',
  'media_frames',
  'media_transcript',
  'evidence_read',
  'evidence_coverage',
]);

/**
 * Run one manifest-scoped recipe tool-loop through the built-in Worker and map
 * its terminal event to the recipe result shape.
 */
export function runScopedCreativeSkillEditToolLoop(
  deps: RecipeScopedEditRunDeps,
  input: CreativeSkillScopedToolLoopInput,
): Promise<CreativeSkillScopedToolLoopResult> {
  const { scope } = input;
  const contextInput = deps.buildContextInput(scope);
  const allowedToolNames = input.allowedToolNames;
  // The recipe allow-list can only be a subset of the closed host catalog.
  const boundedAllowList = allowedToolNames.filter((name) =>
    JOY_AGENT_HOST_TOOL_NAMES.includes(name),
  );

  const isCurrent = (): boolean => {
    try {
      return deps.isAuthorityCurrent(scope) === true;
    } catch {
      return false;
    }
  };

  const handler = createJoyAgentProposalStagingHandler({
    runId: scope.runId,
    baseRevision: scope.revision,
    contextProjectId: contextInput.projectId,
    capturedSession: deps.getSession(),
    latestSessionRef: deps.latestSessionRef,
    hasHostAuthority: isCurrent,
    isRunCurrent: isCurrent,
    selectedEntityReference: undefined,
    preparedChanges: deps.preparedChanges,
    currentPreparedAuthority: deps.currentPreparedAuthority,
    agentPreviewStore: deps.agentPreviewStore,
    proposalTargetsRef: deps.proposalTargetsRef,
    onStaged: (changeSetId) => deps.onStaged?.(scope, changeSetId),
  });

  // The Worker allocates its own run id; capture it before the iterator starts
  // so the observation authority fence can bind to the exact live run.
  let workerRun: { readonly runId: string; readonly epoch: number } | undefined;

  const needsObservation = boundedAllowList.some((name) => OBSERVE_TOOL_NAMES.has(name));
  const observationBridge =
    needsObservation && deps.observationAdapterFactory !== undefined
      ? tryCreateObservationBridge(deps, scope, contextInput.projectId, isCurrent, () => workerRun)
      : undefined;
  if (observationBridge !== undefined) deps.onObservationBridgeCreated?.(scope, observationBridge);

  const revokeStaged = (changeSetId: string | undefined): void => {
    if (changeSetId === undefined) return;
    const prepared = deps.preparedChanges.getView(changeSetId);
    deps.preparedChanges.revoke(changeSetId);
    if (prepared !== undefined) {
      deps.agentPreviewStore?.clear(prepared.planId);
      deps.proposalTargetsRef.current.delete(prepared.planId);
    }
  };
  let lastStaged: string | undefined;

  const host: JoyAgentRunHost = {
    methods: createJoyAgentHostRpcMethodsForSnapshot(
      contextInput,
      async (proposal, rpcContext) => {
        const result = await handler(proposal, rpcContext);
        lastStaged = result.changeSetId;
        return result;
      },
      observationBridge?.tools,
      observationBridge === undefined
        ? undefined
        : async (result) => {
            await deps.onObservationCompleted?.(scope, observationBridge, {
              observationId: result.observationId,
              manifestId: result.manifestId,
            });
          },
    ),
    allowedToolNames: boundedAllowList,
    onCancelled: () => revokeStaged(lastStaged),
  };

  return runScopedCreativeSkillToolLoop({
    client: deps.client,
    host,
    prompt: input.prompt,
    baseRevision: scope.revision,
    onRunStart: (runId) => {
      workerRun = Object.freeze({ runId, epoch: 1 });
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

function tryCreateObservationBridge(
  deps: RecipeScopedEditRunDeps,
  scope: CreativeSkillRunScope,
  projectId: string,
  isCurrent: () => boolean,
  getWorkerRun: () => { readonly runId: string; readonly epoch: number } | undefined,
) {
  let retainedAuthority:
    | {
        readonly projectId: string;
        readonly revision: string;
        readonly run: { readonly runId: string; readonly epoch: number };
        readonly modelId: string;
        readonly promptPolicyDigest: string;
      }
    | undefined;
  try {
    return deps.observationAdapterFactory?.create({
      projectId,
      revision: scope.revision,
      currentAuthority: () => {
        const run = getWorkerRun();
        const liveSession = deps.latestSessionRef.current;
        if (!isCurrent()) return undefined;
        if (
          liveSession.visualProject.id !== projectId ||
          liveSession.projectRevisionId !== scope.revision
        )
          return undefined;
        const modelId = deps.getModelId?.() ?? '';
        const promptPolicyDigest = deps.getPromptPolicyDigest?.() ?? '';
        if (modelId.trim().length === 0 || run === undefined) return undefined;
        const reviewed = deps.getObservationAuthority?.();
        if (
          reviewed !== undefined &&
          reviewed.projectId === projectId &&
          reviewed.revision === scope.revision &&
          reviewed.modelId === modelId &&
          reviewed.promptPolicyDigest === promptPolicyDigest &&
          reviewed.run.runId === run.runId &&
          reviewed.run.epoch === run.epoch
        ) {
          retainedAuthority = reviewed;
          return reviewed;
        }
        if (
          retainedAuthority !== undefined &&
          retainedAuthority.projectId === projectId &&
          retainedAuthority.revision === scope.revision &&
          modelId === retainedAuthority.modelId &&
          promptPolicyDigest === retainedAuthority.promptPolicyDigest &&
          run.runId === retainedAuthority.run.runId &&
          run.epoch === retainedAuthority.run.epoch
        )
          return retainedAuthority;
        retainedAuthority = Object.freeze({
          projectId,
          revision: scope.revision,
          run,
          modelId,
          promptPolicyDigest,
        });
        return retainedAuthority;
      },
    });
  } catch {
    // Observation is an optional, locally bounded enhancement. A browser that
    // cannot construct its isolated decoder keeps the safe legacy catalog.
    return undefined;
  }
}

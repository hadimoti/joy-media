/**
 * Builds the trusted main-thread host for one Living Look agent tool-loop and
 * runs it to a terminal state (R2 / GAP 5).
 *
 * It reuses the direct/recipe machinery exactly: the built-in Worker via
 * `runScopedCreativeSkillToolLoop`, the same session-scoped prepared-change and
 * preview stores, and the same `validate_proposal` staging handler (through
 * `stageLookRun` / `stageLookInstancesOnly`). It differs only in its allow-list
 * — `read_project_context` plus the four `look_*` intent tools — and its run
 * fence: a Look run is authoritative only while its `CreativeSkillRunScope` is
 * still current. There is no new apply path; the operator approves the staged
 * change through the same approval card and Undo.
 */

import type { AgentPreviewStore } from '../agent-preview-store.js';
import type { EditorSession } from '../editor-session.js';
import type { JoyAgentTarget } from '../agent-presence.js';
import type { JoyAgentContextSnapshotInput } from './context-snapshot.js';
import { createJoyAgentPagedContext } from './context-snapshot.js';
import type { JoyAgentEngineClient, JoyAgentRunHost } from './engine-client.js';
import { createJoyAgentHostRpcMethods } from './tool-bridge.js';
import type { PreparedChangeAuthority, PreparedChangeStore } from './prepared-change-store.js';
import type { CreativeSkillRunScope } from './skill-runner.js';
import { runScopedCreativeSkillToolLoop } from './entry-points.js';
import type { CreativeSkillScopedToolLoopResult } from './creative-skill-editor-primitives.js';
import { HostRpcDiagnosticError, type HostRpcHandlerContext } from './host-rpc.js';
import type { JoyAgentHostToolName } from './host-tool-contract.js';
import { resolveLivingLookRun, type LivingLookRunContext } from './living-look-run.js';
import { stageLookInstancesOnly, stageLookRun, type LookRunDeps } from './look-run-host.js';
import type { LivingLooksRunInput } from '../LivingLooksPanel.js';
import type { JoyAgentPreparedHostResult } from './tool-bridge.js';

const LOOK_TOOL_ALLOW_LIST: readonly JoyAgentHostToolName[] = [
  'read_project_context',
  'look_apply',
  'look_update',
  'look_reset_overrides',
  'look_detach',
];

export interface LookScopedRunDeps {
  readonly client: JoyAgentEngineClient;
  readonly getSession: () => EditorSession;
  readonly latestSessionRef: { readonly current: EditorSession };
  readonly preparedChanges: PreparedChangeStore;
  readonly agentPreviewStore: AgentPreviewStore | undefined;
  readonly proposalTargetsRef: { readonly current: Map<string, readonly JoyAgentTarget[]> };
  readonly currentPreparedAuthority: (hostRunId: string) => PreparedChangeAuthority;
  readonly isAuthorityCurrent: (scope: CreativeSkillRunScope) => boolean;
  readonly buildContextInput: (scope: CreativeSkillRunScope) => JoyAgentContextSnapshotInput;
  /** The pure resolution context (fonts / availability / id factory / audio bakes). */
  readonly lookRunContext: LivingLookRunContext;
  /** Records the change-set id a Look run staged, for later cleanup. */
  readonly onStaged?: (scope: CreativeSkillRunScope, changeSetId: string) => void;
}

export interface LookScopedRunInput {
  readonly scope: CreativeSkillRunScope;
  readonly prompt: string;
  readonly signal?: AbortSignal;
  readonly onRunStart?: (runId: string) => void;
}

export function runScopedLookToolLoop(
  deps: LookScopedRunDeps,
  input: LookScopedRunInput,
): Promise<CreativeSkillScopedToolLoopResult> {
  const { scope } = input;
  const contextInput = deps.buildContextInput(scope);

  const lookRunDeps: LookRunDeps = {
    getSession: deps.getSession,
    latestSessionRef: deps.latestSessionRef,
    preparedChanges: deps.preparedChanges,
    agentPreviewStore: deps.agentPreviewStore,
    proposalTargetsRef: deps.proposalTargetsRef,
    currentPreparedAuthority: deps.currentPreparedAuthority,
    isAuthorityCurrent: deps.isAuthorityCurrent,
    ...(deps.onStaged === undefined ? {} : { onStaged: deps.onStaged }),
  };

  let lastStaged: string | undefined;
  const trackStaged: LookRunDeps = {
    ...lookRunDeps,
    onStaged: (stagedScope, changeSetId) => {
      lastStaged = changeSetId;
      deps.onStaged?.(stagedScope, changeSetId);
    },
  };

  const prepareLook = async (
    request: LivingLooksRunInput,
    rpcContext: HostRpcHandlerContext,
  ): Promise<JoyAgentPreparedHostResult> => {
    const resolution = resolveLivingLookRun(deps.getSession(), request, deps.lookRunContext);
    if (resolution.kind === 'blocked')
      throw new HostRpcDiagnosticError({
        code: 'JOY_AGENT_RPC_CANONICAL_REJECTED',
        retryable: resolution.reason !== 'look-unavailable',
        operation: 'look_intent',
        facts: { compilerCode: `LOOK_${resolution.reason.toUpperCase().replace(/-/g, '_')}` },
      });

    const staged =
      resolution.kind === 'detach'
        ? await stageLookInstancesOnly(trackStaged, {
            scope,
            lookInstancesWrite: resolution.lookInstancesWrite,
            summary: `Detach the "${resolution.title}" Look — its styling stays as editable keyframes.`,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          })
        : await stageLookRun(trackStaged, {
            scope,
            compileInput: resolution.compileInput,
            goal: resolution.goal,
            currentTextByObjectId: deps.lookRunContext.currentTextByObjectId ?? {},
            lookInstancesWrite: resolution.lookInstancesWrite,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });

    if (staged.kind === 'blocked')
      throw new HostRpcDiagnosticError({
        code: 'JOY_AGENT_RPC_CANONICAL_REJECTED',
        retryable:
          staged.reason !== 'JOY_CODE_STALE_REVISION' && staged.reason !== 'stale-authority',
        operation: 'look_intent',
        facts: { compilerCode: staged.reason.slice(0, 64) },
      });

    const view = deps.preparedChanges.getView(staged.changeSetId);
    if (view === undefined)
      throw new HostRpcDiagnosticError({
        code: 'JOY_AGENT_RPC_CANONICAL_REJECTED',
        retryable: false,
        operation: 'look_intent',
        facts: { compilerCode: 'LOOK_PREVIEW_AUTHORITY_LOST' },
      });
    rpcContext.signal.throwIfAborted();
    return {
      summary: staged.summary.slice(0, 512),
      baseRevision: view.baseRevision,
      changeSetId: view.changeSetId,
      operationDigest: view.operationDigest,
      bindingDigest: view.bindingDigest,
      operationCount: Math.min(Math.max(staged.operationCount, 1), 32),
    };
  };

  const host: JoyAgentRunHost = {
    methods: createJoyAgentHostRpcMethods({
      context: createJoyAgentPagedContext(contextInput),
      prepareLook,
    }),
    allowedToolNames: LOOK_TOOL_ALLOW_LIST,
    onCancelled: () => {
      if (lastStaged === undefined) return;
      const prepared = deps.preparedChanges.getView(lastStaged);
      deps.preparedChanges.revoke(lastStaged);
      if (prepared !== undefined) {
        deps.agentPreviewStore?.clear(prepared.planId);
        deps.proposalTargetsRef.current.delete(prepared.planId);
      }
    },
  };

  return runScopedCreativeSkillToolLoop({
    client: deps.client,
    host,
    prompt: input.prompt,
    baseRevision: scope.revision,
    ...(input.onRunStart === undefined ? {} : { onRunStart: input.onRunStart }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

/**
 * The `validate_proposal` host handler for a structured JOY edit run.
 *
 * A Worker proposal reaches this handler through Host RPC; the handler runs the
 * canonical compound compiler, prepares a session-scoped change, stages its
 * live preview, and returns only display-safe opaque identities. It performs
 * every authority re-check the inline `AgentPanel` handler did — the captured
 * run id, the composer host lease, and both the captured and live session
 * revisions — so a superseded or reconfigured run can never stage a preview.
 *
 * It is a pure factory: the direct editor path and the V1 recipe path both
 * build their host with this handler, differing only in `allowedToolNames`,
 * the observation tools, and the surrounding run-consumption loop.
 */

import type { AgentPreviewStore } from '../agent-preview-store.js';
import type { EditorSession } from '../editor-session.js';
import type { JoyAgentTarget } from '../agent-presence.js';
import { compileJoyCodeCompoundDraft } from '../joy-code-compound-compiler.js';
import { targetsForJoyCodeOperations } from '../agent-ui-targets.js';
import type { JoyAgentComposerHostLease } from './composer-host-lease.js';
import { isJoyAgentComposerHostLeaseCurrent } from './composer-host-lease.js';
import type { BrowserProposal } from './bounded-tool-loop.js';
import type { HostRpcHandlerContext } from './host-rpc.js';
import { HostRpcDiagnosticError } from './host-rpc.js';
import type { JoyAgentPreparedHostResult } from './tool-bridge.js';
import type { PreparedChangeAuthority, PreparedChangeStore } from './prepared-change-store.js';
import { stageJoyAgentPreview } from './stage-preview.js';
import {
  constrainJoyAgentConversationTarget,
  JOY_AGENT_CONVERSATION_TARGET_MISMATCH,
} from './conversation-target-constraint.js';
import type { JoyAgentConversationEntityReference } from './conversation-entity-references.js';

export interface JoyAgentProposalStagingDeps {
  /** The active model run id this handler is bound to. */
  readonly runId: string;
  /** The project revision captured when the run started. */
  readonly baseRevision: string;
  /** `JoyAgentContextSnapshotInput.projectId` for the run. */
  readonly contextProjectId: string;
  /** The session value captured in the run closure (checked alongside the live ref). */
  readonly capturedSession: EditorSession;
  /** Live session ref; its `.current` is re-read on every authority check. */
  readonly latestSessionRef: { readonly current: EditorSession };
  /** Live active-model-run ref; `.current` must still equal `runId`. */
  readonly activeModelRunIdRef: { readonly current: string | undefined };
  /** Reads the run's composer host lease (assigned after the host is built). */
  readonly getComposerHostLease: () => JoyAgentComposerHostLease | undefined;
  /** A conversation follow-up constrains which entity the proposal may touch. */
  readonly selectedEntityReference: JoyAgentConversationEntityReference | undefined;
  /** Session-scoped prepared-change store. */
  readonly preparedChanges: PreparedChangeStore;
  /** Builds the prepared-change authority for a host plan id. */
  readonly currentPreparedAuthority: (hostRunId: string) => PreparedChangeAuthority;
  /** Live preview store; the staged draft is published here. */
  readonly agentPreviewStore: AgentPreviewStore | undefined;
  /** Per-run map of prepared plan id -> UI targets. */
  readonly proposalTargetsRef: { readonly current: Map<string, readonly JoyAgentTarget[]> };
  /** Records the staged change-set id so the run loop can revoke it. */
  readonly onStaged: (changeSetId: string) => void;
}

export type JoyAgentPrepareProposalHandler = (
  proposal: BrowserProposal,
  context: HostRpcHandlerContext,
) => Promise<JoyAgentPreparedHostResult>;

export function createJoyAgentProposalStagingHandler(
  deps: JoyAgentProposalStagingDeps,
): JoyAgentPrepareProposalHandler {
  const {
    runId,
    baseRevision,
    contextProjectId,
    capturedSession: session,
    latestSessionRef,
    activeModelRunIdRef,
    getComposerHostLease,
    selectedEntityReference,
    preparedChanges,
    currentPreparedAuthority,
    agentPreviewStore,
    proposalTargetsRef,
    onStaged,
  } = deps;

  return async (proposal, rpcContext) => {
    const hostPlanId = `${runId}.epoch-${rpcContext.run.epoch}`;
    const reject = (
      field: string,
      compilerCode: string,
      retryable = true,
    ): HostRpcDiagnosticError =>
      new HostRpcDiagnosticError({
        code: 'JOY_AGENT_RPC_CANONICAL_REJECTED',
        retryable,
        operation: 'validate_proposal',
        field,
        facts: { compilerCode },
      });
    const hasCurrentHostLease = (): boolean => {
      const lease = getComposerHostLease();
      return (
        lease !== undefined &&
        lease.run.runId === rpcContext.run.runId &&
        lease.run.epoch === rpcContext.run.epoch &&
        isJoyAgentComposerHostLeaseCurrent(lease)
      );
    };
    rpcContext.signal.throwIfAborted();
    if (
      !hasCurrentHostLease() ||
      activeModelRunIdRef.current !== runId ||
      session.projectRevisionId !== baseRevision ||
      latestSessionRef.current.visualProject.id !== contextProjectId ||
      latestSessionRef.current.projectRevisionId !== baseRevision
    )
      throw reject('run', 'JOY_AGENT_HOST_REVOKED', false);
    if (selectedEntityReference !== undefined) {
      const targetConstraint = constrainJoyAgentConversationTarget(
        selectedEntityReference,
        proposal.operations,
      );
      if (!targetConstraint.ok)
        throw reject(
          `operations.${targetConstraint.operationId}`,
          JOY_AGENT_CONVERSATION_TARGET_MISMATCH,
          false,
        );
    }
    const compiled = compileJoyCodeCompoundDraft({
      planId: hostPlanId,
      baseRevision,
      timeline: session.timelineProject,
      visualProject: session.visualProject,
      registeredAssetIds: Object.keys(session.visualProject.assets),
      operations: proposal.operations,
    });
    if (!compiled.ok)
      throw reject(
        'operations',
        compiled.error.code.slice(0, 64),
        compiled.error.code !== 'JOY_CODE_STALE_REVISION',
      );
    rpcContext.signal.throwIfAborted();
    if (
      !hasCurrentHostLease() ||
      session.projectRevisionId !== baseRevision ||
      latestSessionRef.current.projectRevisionId !== baseRevision
    )
      throw reject('run', 'JOY_AGENT_HOST_REVOKED', false);
    let preparedChangeSetId: string | undefined;
    try {
      const prepared = preparedChanges.prepare(compiled, currentPreparedAuthority(hostPlanId));
      preparedChangeSetId = prepared.changeSetId;
      const preview = preparedChanges.getPreviewDraft(prepared.changeSetId);
      if (preview === undefined) throw new Error('JOY_CODE_PREPARED_CHANGE_MISSING');
      rpcContext.signal.throwIfAborted();
      stageJoyAgentPreview(agentPreviewStore, session, preview);
      rpcContext.signal.throwIfAborted();
      if (
        !hasCurrentHostLease() ||
        activeModelRunIdRef.current !== runId ||
        session.projectRevisionId !== baseRevision ||
        latestSessionRef.current.projectRevisionId !== baseRevision
      )
        throw reject('run', 'JOY_AGENT_HOST_REVOKED', false);
      onStaged(prepared.changeSetId);
      proposalTargetsRef.current.set(
        prepared.planId,
        targetsForJoyCodeOperations(
          proposal.operations as unknown as readonly {
            readonly kind: string;
            readonly [key: string]: unknown;
          }[],
        ),
      );
      return {
        summary: proposal.summary,
        baseRevision,
        changeSetId: prepared.changeSetId,
        operationDigest: prepared.operationDigest,
        bindingDigest: prepared.bindingDigest,
        operationCount: proposal.operations.length,
      };
    } catch (error) {
      if (preparedChangeSetId !== undefined) {
        const prepared = preparedChanges.getView(preparedChangeSetId);
        preparedChanges.revoke(preparedChangeSetId);
        if (prepared !== undefined) {
          agentPreviewStore?.clear(prepared.planId);
          proposalTargetsRef.current.delete(prepared.planId);
        }
      }
      throw error;
    }
  };
}

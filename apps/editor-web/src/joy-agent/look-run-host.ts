/**
 * Living Look run host (R2 / L2 wiring).
 *
 * A Look run has no model and no Worker: `prepareLookPlan` builds the canonical
 * plan deterministically on the main thread. This module hands that plan to the
 * **same** `createJoyAgentProposalStagingHandler` the direct-edit and recipe
 * paths use — canonical compound compile → session-scoped prepared change →
 * staged live preview → the existing approval envelope + Undo. No new apply
 * path, no new commit tool.
 *
 * The staging handler expects a Host-RPC handler context; a Look run supplies a
 * synthetic one bound to its own run id, with the same authority predicates the
 * recipe path uses (`isAuthorityCurrent(scope)`).
 */

import type { AgentPreviewStore } from '../agent-preview-store.js';
import type { EditorSession } from '../editor-session.js';
import type { JoyAgentTarget } from '../agent-presence.js';
import { validateBrowserProposal } from './bounded-tool-loop.js';
import { createJoyAgentProposalStagingHandler } from './edit-proposal-staging.js';
import { HostRpcDiagnosticError, type HostRpcHandlerContext } from './host-rpc.js';
import type { PreparedChangeAuthority, PreparedChangeStore } from './prepared-change-store.js';
import type { CreativeSkillRunScope } from './skill-runner.js';
import { prepareLookPlan } from './look-operations.js';
import type { LookCompileInput } from '@joy-media/motion-core';

export interface LookRunDeps {
  readonly getSession: () => EditorSession;
  readonly latestSessionRef: { readonly current: EditorSession };
  readonly preparedChanges: PreparedChangeStore;
  readonly agentPreviewStore: AgentPreviewStore | undefined;
  readonly proposalTargetsRef: { readonly current: Map<string, readonly JoyAgentTarget[]> };
  readonly currentPreparedAuthority: (hostRunId: string) => PreparedChangeAuthority;
  /** True only while this Look run scope is still current (revision unchanged, not superseded). */
  readonly isAuthorityCurrent: (scope: CreativeSkillRunScope) => boolean;
  readonly onStaged?: (scope: CreativeSkillRunScope, changeSetId: string) => void;
}

export interface LookRunInput {
  readonly scope: CreativeSkillRunScope;
  readonly compileInput: LookCompileInput;
  readonly goal: string;
  /** objectId -> current text, so a template swap keeps the operator's copy. */
  readonly currentTextByObjectId?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export type LookRunResult =
  | {
      readonly kind: 'ready-for-approval';
      readonly changeSetId: string;
      readonly operationCount: number;
      readonly changedBindingIds: readonly string[];
      readonly summary: string;
    }
  | {
      readonly kind: 'blocked';
      readonly reason: string;
      readonly diagnostics: readonly string[];
    };

const STAGE_DEADLINE_MS = 30_000;

export async function stageLookRun(deps: LookRunDeps, input: LookRunInput): Promise<LookRunResult> {
  const { scope } = input;

  const planResult = prepareLookPlan(input.compileInput, input.goal, input.currentTextByObjectId);
  if (!planResult.ok || planResult.plan === undefined) {
    return {
      kind: 'blocked',
      reason: 'compile-failed',
      diagnostics: planResult.compilation.diagnostics.map((d) => `${d.code}: ${d.message}`),
    };
  }
  if (planResult.plan.operations.length === 0) {
    return { kind: 'blocked', reason: 'no-operations', diagnostics: [] };
  }

  let proposal: ReturnType<typeof validateBrowserProposal>;
  try {
    proposal = validateBrowserProposal({
      summary: planResult.plan.summary,
      operations: planResult.plan.operations,
    });
  } catch {
    return { kind: 'blocked', reason: 'invalid-proposal', diagnostics: [] };
  }

  const isCurrent = (): boolean => {
    try {
      return deps.isAuthorityCurrent(scope) === true;
    } catch {
      return false;
    }
  };
  if (!isCurrent()) {
    return { kind: 'blocked', reason: 'stale-authority', diagnostics: [] };
  }

  const capturedSession = deps.getSession();
  const handler = createJoyAgentProposalStagingHandler({
    runId: scope.runId,
    baseRevision: scope.revision,
    // The staging handler checks the live visual-project id against this, so it
    // must be the document id, not the control-plane project id in the scope.
    contextProjectId: capturedSession.visualProject.id,
    capturedSession,
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

  const controller = new AbortController();
  if (input.signal !== undefined) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const rpcContext: HostRpcHandlerContext = Object.freeze({
    run: { runId: scope.runId, epoch: scope.epoch },
    requestId: `look-${scope.runId}`,
    signal: controller.signal,
    deadlineAt: Date.now() + STAGE_DEADLINE_MS,
  });

  try {
    const result = await handler(proposal, rpcContext);
    return {
      kind: 'ready-for-approval',
      changeSetId: result.changeSetId,
      operationCount: result.operationCount,
      changedBindingIds: planResult.compilation.changedBindingIds,
      summary: result.summary,
    };
  } catch (error) {
    if (error instanceof HostRpcDiagnosticError) {
      const facts = (error as unknown as { facts?: { compilerCode?: string } }).facts;
      return {
        kind: 'blocked',
        reason: facts?.compilerCode ?? 'staging-rejected',
        diagnostics: [],
      };
    }
    return {
      kind: 'blocked',
      reason: error instanceof Error ? error.message.slice(0, 120) : 'staging-failed',
      diagnostics: [],
    };
  }
}

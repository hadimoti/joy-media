import { useEffect, useMemo, useRef, useState } from 'react';
import type { SpikeProject } from '@joy-media/project-schema';
import type {
  AgentEditPlan,
  ApprovalDecision,
  AuditEntry,
  DryRunResult,
  EditorContext,
  ExecutionResult,
} from '@joy-media/agent-tools';
import {
  ApprovalEngine,
  createAuditTrail,
  createPlan,
  createToolRegistry,
  dryRunPlan,
  buildEditorContext,
  runPlanAtomically,
  RevisionConflictError,
} from '@joy-media/agent-tools';
import type { AgentActor, AtomicRunResult, ProjectRevisionId } from '@joy-media/agent-tools';
import {
  AGENT_INTENTS,
  buildShortenIntroRecipe,
  buildSplitTrimRecipe,
  type AgentIntent,
} from './agent-panel-intents.js';
import { AgentTimelineCanvas } from './AgentTimelineCanvas.js';
import { extractPendingChanges } from './agent-plan-visualizer.js';
import { saveWorkflow } from './workflow-recorder.js';
import type { EditorSession } from './editor-session.js';
import { JOY_MEDIA_ASSET_DND } from './TimelinePanel.js';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import type { AgentSettings } from './agent-settings.js';
import { approvalPolicyForAgentSettings } from './agent-settings.js';

/** Every edit this panel commits is attributed to the local agent adapter. */
const AGENT_ACTOR: AgentActor = { type: 'agent', id: 'kilocode' };

/**
 * The last-run UI is shaped around `ExecutionResult`; the atomic runner reports
 * an `AtomicRunResult`. Only the fields the panel actually reads are mapped.
 */
function toExecutionResult(run: AtomicRunResult): ExecutionResult {
  return {
    planId: run.planId,
    success: run.committed || run.replayed,
    transactionLabel: run.transactionLabel,
    stepResults: run.steps.map((step) => ({
      stepId: step.stepId,
      status: step.status === 'staged' ? ('success' as const) : ('failed' as const),
      ...(step.error !== undefined ? { error: step.error } : {}),
      durationMs: 0,
    })),
    aggregateDiff: {
      clipsCreated: 0,
      clipsModified: run.commands.length,
      clipsDeleted: 0,
      tracksAffected: [],
      timeRangesAffected: [],
      effectsAdded: 0,
      captionsAdded: 0,
      jobsRequired: 0,
      summary: run.replayed
        ? 'already applied; retry was a no-op'
        : `${run.commands.length} command(s) in one transaction`,
    },
    durationMs: 0,
    errors: run.errors,
    warnings: [],
    rollbackAvailable: run.committed,
  };
}

const TABS: readonly PanelTabSpec[] = [
  { id: 'compose', label: 'Compose' },
  { id: 'activity', label: 'Activity' },
];
import {
  CheckIcon,
  CloseIcon,
  CutIcon,
  PlayIcon,
  PlusIcon,
  SaveIcon,
  ScissorsIcon,
  TrashIcon,
  UndoIcon,
} from './icons.js';

export interface KiloCodeAttachedAsset {
  readonly assetId: string;
  readonly kind: 'image' | 'video';
  readonly displayName: string;
}

interface PendingPlan {
  readonly intent: AgentIntent;
  readonly plan: AgentEditPlan;
  readonly baseRevision: ProjectRevisionId;
  readonly baseProject: SpikeProject;
  readonly dryRun: DryRunResult;
  readonly approval: ApprovalDecision;
}

interface LastRun {
  readonly intent: AgentIntent;
  readonly plan: AgentEditPlan;
  readonly executionResult: ExecutionResult;
  readonly reverted: boolean;
  readonly savedWorkflowId?: string;
}

function intentIcon(intentId: string) {
  switch (intentId) {
    case 'split-at-playhead':
    case 'recipe-split-trim':
      return <ScissorsIcon />;
    case 'move-to-playhead':
      return <CutIcon />;
    case 'remove-selected':
      return <TrashIcon />;
    case 'join-with-next':
      return <CheckIcon />;
    case 'insert-test-clip':
      return <PlusIcon />;
    default:
      return <PlayIcon />;
  }
}

function shortIntentLabel(label: string): string {
  if (label.startsWith('Recipe:')) return 'Recipe';
  if (label.startsWith('Split')) return 'Split';
  if (label.startsWith('Move')) return 'Move';
  if (label.startsWith('Remove')) return 'Remove';
  if (label.startsWith('Join')) return 'Join';
  if (label.startsWith('Insert')) return 'Insert';
  return label;
}

export type AgentPanelCommandType = 'new-task' | 'activity' | 'stop';
export interface AgentPanelCommand {
  readonly serial: number;
  readonly type: AgentPanelCommandType;
}

/**
 * WP-15.2 — structured agent intents on the real EditorSession command bus.
 */
export function AgentPanel({
  project,
  selectedClipIds,
  playheadUs,
  agentContext,
  onUndo,
  session,
  attachedAssets = [],
  onDetachAsset,
  onAttachAsset,
  settings,
  command,
}: {
  readonly project: SpikeProject;
  readonly selectedClipIds: readonly string[];
  readonly playheadUs: number;
  readonly agentContext: EditorContext;
  readonly onUndo: () => void;
  readonly session: EditorSession;
  readonly attachedAssets?: readonly KiloCodeAttachedAsset[];
  readonly onDetachAsset?: (assetId: string) => void;
  readonly onAttachAsset?: (asset: KiloCodeAttachedAsset) => void;
  readonly settings: AgentSettings;
  readonly command?: AgentPanelCommand;
}) {
  const registry = useMemo(() => createToolRegistry(), []);
  const auditRef = useRef(createAuditTrail());
  const [pending, setPending] = useState<PendingPlan | undefined>(undefined);
  const [lastRun, setLastRun] = useState<LastRun | undefined>(undefined);
  const [, forceRender] = useState(0);
  const [tab, setTab] = useState('compose');

  const approvalEngine = useMemo(
    () => new ApprovalEngine(approvalPolicyForAgentSettings(settings)),
    [settings],
  );

  useEffect(() => {
    if (command === undefined) return;
    if (command.type === 'activity') {
      setTab('activity');
      return;
    }
    if (command.type === 'stop' && pending !== undefined) {
      auditRef.current.record({
        planId: pending.plan.planId,
        action: 'plan-rejected',
        userId: 'local-owner',
        metadata: { source: 'agent-menu-stop' },
      });
    }
    setPending(undefined);
    if (command.type === 'new-task') {
      setLastRun(undefined);
      setTab('compose');
    }
  }, [command, pending]);

  const plan = (intent: AgentIntent) => {
    const baseRevision = session.projectRevisionId;
    const baseProject = project;
    const built =
      intent.id === 'recipe-split-trim'
        ? (() => {
            const recipe = buildSplitTrimRecipe(project, selectedClipIds, playheadUs);
            if (!recipe.ok) return recipe;
            return { ok: true as const, steps: recipe.steps, goal: recipe.goal };
          })()
        : intent.id === 'shorten-intro'
          ? (() => {
              const recipe = buildShortenIntroRecipe(project);
              if (!recipe.ok) return recipe;
              return { ok: true as const, steps: recipe.steps, goal: recipe.goal };
            })()
          : (() => {
              const single = intent.buildStep(project, selectedClipIds, playheadUs);
              if (!single.ok) return single;
              return { ok: true as const, steps: [single.step], goal: intent.label };
            })();
    if (!built.ok) return;
    const agentPlan = createPlan(built.goal, [...built.steps]);
    const dryRun = dryRunPlan(agentPlan, registry, buildEditorContext(baseProject));
    const decisions = approvalEngine.evaluatePlan(
      agentPlan,
      agentContext,
      (toolName) => registry.tools.get(toolName)?.scope,
    );
    const approval =
      decisions.find((decision) => decision.decision === 'blocked') ??
      decisions.find((decision) => decision.decision === 'requires-manual') ??
      decisions[0];
    if (approval === undefined) return;
    auditRef.current.record({
      planId: agentPlan.planId,
      action: 'plan-created',
      ...(built.steps[0]?.tool !== undefined ? { tool: built.steps[0].tool } : {}),
      ...(built.steps[0]?.arguments !== undefined ? { arguments: built.steps[0].arguments } : {}),
      userId: 'local-owner',
    });
    auditRef.current.record({
      planId: agentPlan.planId,
      action: 'dry-run-completed',
      userId: 'local-owner',
      metadata: { summary: dryRun.aggregateDiff.summary, decision: approval.decision },
    });
    setPending({ intent, plan: agentPlan, baseRevision, baseProject, dryRun, approval });
    setLastRun(undefined);
  };

  const reject = () => {
    if (pending === undefined) return;
    auditRef.current.record({
      planId: pending.plan.planId,
      action: 'plan-rejected',
      userId: 'local-owner',
    });
    setPending(undefined);
    forceRender((n) => n + 1);
  };

  const executePending = async (manualApprovalGranted: boolean) => {
    if (pending === undefined) return;
    const { intent, plan: agentPlan, baseRevision, baseProject } = pending;
    auditRef.current.record({
      planId: agentPlan.planId,
      action: 'execution-started',
      userId: 'local-owner',
    });
    // Atomic path: stage every step, then commit once. The previous
    // per-step executor produced one undo entry per step, so `undoLastRun`'s
    // single onUndo() only reverted the final step of a multi-step recipe.
    let atomic: AtomicRunResult;
    try {
      atomic = runPlanAtomically(agentPlan, {
        registry,
        approvalEngine,
        actor: AGENT_ACTOR,
        projectId: baseProject.id,
        baseRevision,
        baseProject,
        contextFor: (staged) => buildEditorContext(staged),
        currentRevision: () => session.projectRevisionId,
        idempotency: session.agentIdempotency,
        ...(manualApprovalGranted
          ? {
              manualApproval: {
                planId: agentPlan.planId,
                approvedAt: new Date().toISOString(),
              },
            }
          : {}),
        commit: (transaction) =>
          agentContext.dispatch?.dispatchTimeline(transaction.commands, transaction.label) ?? {
            success: false,
            error: 'no command bus bound to this panel',
          },
      });
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error;
      auditRef.current.record({
        planId: agentPlan.planId,
        action: 'execution-failed',
        userId: 'local-owner',
        error: error.message,
      });
      setPending(undefined);
      setLastRun({
        intent,
        plan: agentPlan,
        executionResult: {
          planId: agentPlan.planId,
          success: false,
          transactionLabel: '',
          stepResults: [],
          aggregateDiff: {
            clipsCreated: 0,
            clipsModified: 0,
            clipsDeleted: 0,
            tracksAffected: [],
            timeRangesAffected: [],
            effectsAdded: 0,
            captionsAdded: 0,
            jobsRequired: 0,
            summary: 'not applied',
          },
          durationMs: 0,
          errors: [error.message],
          warnings: [],
          rollbackAvailable: false,
        },
        reverted: false,
      });
      return;
    }
    const executionResult = toExecutionResult(atomic);
    auditRef.current.record({
      planId: agentPlan.planId,
      action: executionResult.success ? 'execution-completed' : 'execution-failed',
      userId: 'local-owner',
      ...(executionResult.errors[0] !== undefined && { error: executionResult.errors[0] }),
      metadata: { transactionLabel: executionResult.transactionLabel },
    });
    setPending(undefined);
    setLastRun({ intent, plan: agentPlan, executionResult, reverted: false });
  };

  const saveLastRunAsWorkflow = () => {
    if (lastRun === undefined || !lastRun.executionResult.success) return;
    const recorded = saveWorkflow(session, lastRun.plan);
    auditRef.current.record({
      planId: lastRun.plan.planId,
      action: 'workflow-saved',
      userId: 'local-owner',
      metadata: { workflowId: recorded.workflow.id },
    });
    setLastRun({ ...lastRun, savedWorkflowId: recorded.workflow.id });
  };

  const undoLastRun = () => {
    if (lastRun === undefined) return;
    onUndo();
    auditRef.current.record({
      planId: lastRun.executionResult.planId,
      action: 'revert-completed',
      userId: 'local-owner',
      metadata: { transactionLabel: lastRun.executionResult.transactionLabel },
    });
    setLastRun({ ...lastRun, reverted: true });
  };

  const entries: readonly AuditEntry[] = [...auditRef.current.getAllEntries()].reverse();

  const pendingChanges = useMemo(() => {
    if (pending === undefined) return [];
    return extractPendingChanges(pending.plan, project);
  }, [pending, project]);

  return (
    <PanelShell
      title="Agent"
      iconUrl={panelTabIconUrl('agent')}
      className="agent-panel"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
    >
      <div
        className="agent-drop-target"
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(JOY_MEDIA_ASSET_DND)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (onAttachAsset === undefined) return;
          const raw = event.dataTransfer.getData(JOY_MEDIA_ASSET_DND);
          if (!raw) return;
          try {
            const asset = JSON.parse(raw) as {
              assetId: string;
              kind: string;
              displayName?: string;
            };
            if (asset.kind !== 'image' && asset.kind !== 'video') return;
            onAttachAsset({
              assetId: asset.assetId,
              kind: asset.kind,
              displayName: asset.displayName ?? asset.assetId,
            });
          } catch {
            /* ignore malformed payload */
          }
        }}
      >
        {tab === 'compose' && (
          <>
            <section className="agent-runtime-summary" aria-label="Active agent policy">
              <strong>KiloCode</strong>
              <span>{settings.executionMode.replaceAll('-', ' ')}</span>
              <span>
                {settings.privacyMode === 'local-only' ? 'local only' : 'remote actions ask first'}
              </span>
            </section>
            <section className="agent-attachments" aria-label="KiloCode media attachments">
              <h3>Attached for AI</h3>
              {attachedAssets.length === 0 ? (
                <p className="agent-attachments-empty">
                  Drop an image/video here, or use Edit with AI on an Assets card. Then run intents
                  / automations against the attachment.
                </p>
              ) : (
                <ul className="agent-attachment-list">
                  {attachedAssets.map((asset) => (
                    <li key={asset.assetId} className="agent-attachment-chip">
                      <span className="agent-attachment-kind">{asset.kind}</span>
                      <span className="agent-attachment-name" title={asset.assetId}>
                        {asset.displayName}
                      </span>
                      {onDetachAsset !== undefined && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Detach ${asset.displayName}`}
                          title="Detach"
                          data-guide="Detach"
                          onClick={() => onDetachAsset(asset.assetId)}
                        >
                          <CloseIcon />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="agent-intents" aria-label="Agent intents">
              <h3>Intents</h3>
              <ul className="agent-intent-grid">
                {AGENT_INTENTS.map((intent) => {
                  const built =
                    intent.id === 'recipe-split-trim'
                      ? buildSplitTrimRecipe(project, selectedClipIds, playheadUs)
                      : intent.buildStep(project, selectedClipIds, playheadUs);
                  return (
                    <li key={intent.id}>
                      <button
                        type="button"
                        className={
                          intent.destructive
                            ? 'agent-intent-card agent-intent-card-danger'
                            : 'agent-intent-card'
                        }
                        disabled={!built.ok}
                        aria-label={intent.label}
                        data-guide={shortIntentLabel(intent.label)}
                        onClick={() => plan(intent)}
                      >
                        <span className="agent-intent-icon" aria-hidden="true">
                          {intentIcon(intent.id)}
                        </span>
                        <span className="agent-intent-name">{shortIntentLabel(intent.label)}</span>
                      </button>
                      {!built.ok && <p className="agent-intent-reason">{built.reason}</p>}
                    </li>
                  );
                })}
              </ul>
            </section>

            {pending !== undefined && (
              <section className="agent-pending-plan" aria-live="polite">
                <div className="agent-pending-head">
                  <h3>{pending.intent.label}</h3>
                  <span
                    className={`agent-decision agent-decision-${pending.approval.decision}`}
                    title={pending.approval.reason}
                  >
                    {pending.approval.decision}
                  </span>
                </div>
                <p className="agent-pending-summary">
                  Dry-run: {pending.dryRun.aggregateDiff.summary}
                </p>
                <AgentTimelineCanvas
                  project={project}
                  playheadUs={playheadUs}
                  highlightedClipIds={selectedClipIds}
                  pendingChanges={pendingChanges}
                  width={400}
                  height={120}
                />
                {pending.dryRun.errors.length > 0 && (
                  <p className="agent-error">Dry-run errors: {pending.dryRun.errors.join(', ')}</p>
                )}
                <p className="agent-pending-reason">{pending.approval.reason}</p>
                <div className="agent-pending-actions">
                  {pending.approval.decision === 'blocked' && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Dismiss blocked plan"
                      title="Dismiss"
                      onClick={reject}
                    >
                      <CloseIcon />
                    </button>
                  )}
                  {pending.approval.decision === 'requires-manual' && (
                    <>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Approve and execute"
                        data-guide="Approve"
                        onClick={() => void executePending(true)}
                      >
                        <CheckIcon />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Reject plan"
                        title="Reject plan"
                        onClick={reject}
                      >
                        <CloseIcon />
                      </button>
                    </>
                  )}
                  {pending.approval.decision === 'auto-approved' && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Execute plan"
                      data-guide="Execute"
                      onClick={() => void executePending(false)}
                    >
                      <PlayIcon />
                    </button>
                  )}
                </div>
              </section>
            )}

            {lastRun !== undefined && (
              <section className="agent-last-run" aria-live="polite">
                <div className="agent-last-run-row">
                  <p>
                    {lastRun.executionResult.success ? 'Executed' : 'Failed'}:{' '}
                    {lastRun.intent.label}
                  </p>
                  <div className="agent-pending-actions">
                    {lastRun.executionResult.rollbackAvailable && !lastRun.reverted && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Undo this run"
                        title="Undo this run"
                        onClick={undoLastRun}
                      >
                        <UndoIcon />
                      </button>
                    )}
                    {lastRun.executionResult.success && lastRun.savedWorkflowId === undefined && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Save as reusable workflow"
                        title="Save as reusable workflow"
                        onClick={saveLastRunAsWorkflow}
                      >
                        <SaveIcon />
                      </button>
                    )}
                  </div>
                </div>
                {!lastRun.executionResult.success && (
                  <p className="agent-error">{lastRun.executionResult.errors.join(', ')}</p>
                )}
                {lastRun.savedWorkflowId !== undefined && (
                  <p className="agent-workflow-saved">Saved as {lastRun.savedWorkflowId}</p>
                )}
                {lastRun.reverted && <p className="agent-pending-reason">Reverted.</p>}
              </section>
            )}
          </>
        )}

        {tab === 'activity' && (
          <section className="agent-activity">
            {entries.length === 0 ? (
              <p className="agent-activity-empty">No agent activity yet</p>
            ) : (
              <ul className="agent-activity-list">
                {entries.map((entry) => (
                  <li key={entry.id} className="agent-activity-row">
                    <span className="agent-activity-action">{entry.action}</span>
                    {entry.tool !== undefined && (
                      <span className="agent-activity-tool">{entry.tool}</span>
                    )}
                    {entry.error !== undefined && (
                      <span className="agent-error">{entry.error}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </PanelShell>
  );
}

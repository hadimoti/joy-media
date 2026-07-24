import { useMemo, useRef, useState } from 'react';
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
  createDefaultApprovalPolicy,
  createPermissiveApprovalPolicy,
  createPlan,
  createToolRegistry,
  dryRunPlan,
  PlanExecutor,
} from '@joy-media/agent-tools';
import { AGENT_INTENTS, buildSplitTrimRecipe, type AgentIntent } from './agent-panel-intents.js';
import { AgentTimelineCanvas } from './AgentTimelineCanvas.js';
import { extractPendingChanges } from './agent-plan-visualizer.js';
import { saveWorkflow } from './workflow-recorder.js';
import type { EditorSession } from './editor-session.js';
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

type PolicyName = 'default' | 'permissive';

interface PendingPlan {
  readonly intent: AgentIntent;
  readonly plan: AgentEditPlan;
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
}: {
  readonly project: SpikeProject;
  readonly selectedClipIds: readonly string[];
  readonly playheadUs: number;
  readonly agentContext: EditorContext;
  readonly onUndo: () => void;
  readonly session: EditorSession;
}) {
  const registry = useMemo(() => createToolRegistry(), []);
  const auditRef = useRef(createAuditTrail());
  const [policyName, setPolicyName] = useState<PolicyName>('default');
  const [pending, setPending] = useState<PendingPlan | undefined>(undefined);
  const [lastRun, setLastRun] = useState<LastRun | undefined>(undefined);
  const [, forceRender] = useState(0);

  const approvalEngine = useMemo(
    () =>
      new ApprovalEngine(
        policyName === 'permissive'
          ? createPermissiveApprovalPolicy()
          : createDefaultApprovalPolicy(),
      ),
    [policyName],
  );

  const plan = (intent: AgentIntent) => {
    const built =
      intent.id === 'recipe-split-trim'
        ? (() => {
            const recipe = buildSplitTrimRecipe(project, selectedClipIds, playheadUs);
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
    const dryRun = dryRunPlan(agentPlan, registry, agentContext);
    const approval = approvalEngine.evaluatePlan(agentPlan, agentContext)[0];
    if (approval === undefined) return;
    auditRef.current.record({
      planId: agentPlan.planId,
      action: 'plan-created',
      ...(built.steps[0]?.tool !== undefined ? { tool: built.steps[0].tool } : {}),
      ...(built.steps[0]?.arguments !== undefined
        ? { arguments: built.steps[0].arguments }
        : {}),
      userId: 'local-owner',
    });
    auditRef.current.record({
      planId: agentPlan.planId,
      action: 'dry-run-completed',
      userId: 'local-owner',
      metadata: { summary: dryRun.aggregateDiff.summary, decision: approval.decision },
    });
    setPending({ intent, plan: agentPlan, dryRun, approval });
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

  const executePending = async () => {
    if (pending === undefined) return;
    const { intent, plan: agentPlan } = pending;
    auditRef.current.record({
      planId: agentPlan.planId,
      action: 'execution-started',
      userId: 'local-owner',
    });
    const executor = new PlanExecutor(registry, approvalEngine);
    const executionResult = await executor.execute(agentPlan, agentContext, {});
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
    <article className="agent-panel">
      <div className="agent-policy" role="group" aria-label="Approval policy">
        <span className="agent-policy-label">Approval</span>
        <div className="agent-policy-seg">
          <button
            type="button"
            className="agent-policy-btn"
            aria-pressed={policyName === 'default'}
            title="Default — blocks destructive edits"
            onClick={() => setPolicyName('default')}
          >
            Default
          </button>
          <button
            type="button"
            className="agent-policy-btn"
            aria-pressed={policyName === 'permissive'}
            title="Permissive — asks before destructive edits"
            onClick={() => setPolicyName('permissive')}
          >
            Permissive
          </button>
        </div>
      </div>

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
          <p className="agent-pending-summary">Dry-run: {pending.dryRun.aggregateDiff.summary}</p>
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
                  onClick={() => void executePending()}
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
                onClick={() => void executePending()}
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
              {lastRun.executionResult.success ? 'Executed' : 'Failed'}: {lastRun.intent.label}
            </p>
            <div className="agent-pending-actions">
              {lastRun.executionResult.success && !lastRun.reverted && (
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

      <section className="agent-activity">
        <h3>Activity</h3>
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
    </article>
  );
}

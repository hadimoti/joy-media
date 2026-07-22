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
import { AGENT_INTENTS, type AgentIntent } from './agent-panel-intents.js';

type PolicyName = 'default' | 'permissive';

interface PendingPlan {
  readonly intent: AgentIntent;
  readonly plan: AgentEditPlan;
  readonly dryRun: DryRunResult;
  readonly approval: ApprovalDecision;
}

interface LastRun {
  readonly intent: AgentIntent;
  readonly executionResult: ExecutionResult;
  readonly reverted: boolean;
}

/**
 * WP-15.2 — a real agent surface, not a mock. Each intent is a structured
 * (not natural-language) template that builds a real `AgentPlanStep` from the
 * live timeline and real selection/playhead state (WP-15 plan scope
 * boundary). Dry-run, approval, and execution all run against `agentContext`,
 * which WP-15.1 bound to the real `EditorSession` command bus — a plan step
 * that executes here is the same kind of mutation the human Timeline panel
 * makes, visible in the same Undo button and persisted the same way.
 */
export function AgentPanel({
  project,
  selectedClipIds,
  playheadUs,
  agentContext,
  onUndo,
}: {
  readonly project: SpikeProject;
  readonly selectedClipIds: readonly string[];
  readonly playheadUs: number;
  readonly agentContext: EditorContext;
  readonly onUndo: () => void;
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
        policyName === 'permissive' ? createPermissiveApprovalPolicy() : createDefaultApprovalPolicy(),
      ),
    [policyName],
  );

  const plan = (intent: AgentIntent) => {
    const built = intent.buildStep(project, selectedClipIds, playheadUs);
    if (!built.ok) return;
    const agentPlan = createPlan(intent.label, [built.step]);
    const dryRun = dryRunPlan(agentPlan, registry, agentContext);
    const approval = approvalEngine.evaluatePlan(agentPlan, agentContext)[0];
    if (approval === undefined) return;
    auditRef.current.record({
      planId: agentPlan.planId,
      action: 'plan-created',
      tool: built.step.tool,
      arguments: built.step.arguments,
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
    setLastRun({ intent, executionResult, reverted: false });
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

  return (
    <article className="agent-panel">
      <p>
        Structured agent intents — real commands through the same undo stack the Timeline panel
        uses.
      </p>
      <label>
        Approval policy:{' '}
        <select value={policyName} onChange={(event) => setPolicyName(event.target.value as PolicyName)}>
          <option value="default">Default (blocks destructive edits)</option>
          <option value="permissive">Permissive (asks before destructive edits)</option>
        </select>
      </label>

      <ul className="agent-intent-list">
        {AGENT_INTENTS.map((intent) => {
          const built = intent.buildStep(project, selectedClipIds, playheadUs);
          return (
            <li key={intent.id}>
              <button disabled={!built.ok} onClick={() => plan(intent)} title={intent.description}>
                {intent.label}
                {intent.destructive ? ' ⚠' : ''}
              </button>
              {!built.ok && <span className="agent-intent-reason"> — {built.reason}</span>}
            </li>
          );
        })}
      </ul>

      {pending !== undefined && (
        <section className="agent-pending-plan" aria-live="polite">
          <h3>{pending.intent.label}</h3>
          <p>Dry-run: {pending.dryRun.aggregateDiff.summary}</p>
          {pending.dryRun.errors.length > 0 && (
            <p className="agent-error">Dry-run errors: {pending.dryRun.errors.join(', ')}</p>
          )}
          <p>
            Approval: <strong>{pending.approval.decision}</strong> — {pending.approval.reason}
          </p>
          {pending.approval.decision === 'blocked' && (
            <button onClick={reject}>Dismiss</button>
          )}
          {pending.approval.decision === 'requires-manual' && (
            <>
              <button onClick={() => void executePending()}>Approve &amp; Execute</button>
              <button onClick={reject}>Reject</button>
            </>
          )}
          {pending.approval.decision === 'auto-approved' && (
            <button onClick={() => void executePending()}>Execute</button>
          )}
        </section>
      )}

      {lastRun !== undefined && (
        <section className="agent-last-run" aria-live="polite">
          <p>
            {lastRun.executionResult.success ? 'Executed' : 'Failed'}: {lastRun.intent.label} (
            {lastRun.executionResult.transactionLabel})
          </p>
          {!lastRun.executionResult.success && (
            <p className="agent-error">{lastRun.executionResult.errors.join(', ')}</p>
          )}
          {lastRun.executionResult.success && !lastRun.reverted && (
            <button onClick={undoLastRun}>Undo this</button>
          )}
          {lastRun.reverted && <p>Reverted.</p>}
        </section>
      )}

      <section className="agent-activity">
        <h3>Activity</h3>
        <ul>
          {entries.map((entry) => (
            <li key={entry.id}>
              {entry.timestamp} — {entry.action}
              {entry.tool ? ` (${entry.tool})` : ''}
              {entry.error ? `: ${entry.error}` : ''}
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}

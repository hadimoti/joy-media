import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { SpikeProject } from '@joy-media/project-schema';
import type {
  AgentEditPlan,
  ApprovalDecision,
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
import type { JoyCodePlanProposalV1 } from '@joy-media/agent-tools';
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
import type { AgentSettings } from './agent-settings.js';
import { approvalPolicyForAgentSettings } from './agent-settings.js';
import { JoyCodeLogo } from './JoyCodeLogo.js';
import { openJoyCodeOpfsAssetCache } from './joycode-opfs-assets.js';
import {
  addJoyCodeMessage,
  createJoyCodeThread,
  loadJoyCodeThreads,
  matchJoyCodeIntentId,
  saveJoyCodeThreads,
  setJoyCodeThreadStatus,
  type JoyCodeThread,
} from './joy-code-history.js';
import { CheckIcon, CloseIcon, PlayIcon, PlusIcon, SaveIcon, UndoIcon } from './icons.js';
import type { JoyCode3DRenderAsset } from './JoyCode3DViewer.js';
import type { JoyCodeServerSession } from './joy-code-server-session.js';
import type { JoyCodeCompoundDraft } from './joy-code-compound-compiler.js';
import { JoyCodeCompoundRunner } from './joy-code-compound-runner.js';

/** Every edit this panel commits is attributed to the KiloCode adapter. */
const AGENT_ACTOR: AgentActor = { type: 'agent', id: 'kilocode' };
const THINKING_REVEAL_MS = 320;
const JoyCode3DViewer = lazy(() =>
  import('./JoyCode3DViewer.js').then((module) => ({ default: module.JoyCode3DViewer })),
);

const TABS: readonly PanelTabSpec[] = [
  { id: 'history', label: 'History' },
  { id: 'composer', label: 'Composer' },
  { id: '3d', label: '', iconUrl: '/assets/24_3d.png' },
];

interface PendingPlan {
  readonly threadId: string;
  readonly intent: AgentIntent;
  readonly plan: AgentEditPlan;
  readonly baseRevision: ProjectRevisionId;
  readonly baseProject: SpikeProject;
  readonly dryRun: DryRunResult;
  readonly approval: ApprovalDecision;
}

interface LastRun {
  readonly threadId: string;
  readonly intent: AgentIntent;
  readonly plan: AgentEditPlan;
  readonly executionResult: ExecutionResult;
  readonly reverted: boolean;
  readonly savedWorkflowId?: string;
}

interface JoyCodeState {
  readonly threads: readonly JoyCodeThread[];
  readonly activeThreadId: string;
}

export interface KiloCodeAttachedAsset {
  readonly assetId: string;
  readonly kind: 'image' | 'video' | 'markdown';
  readonly displayName: string;
  /** Present when the file lives under OPFS joy-media-assets/joycode/. */
  readonly source?: 'joycode-folder';
}

export type AgentPanelCommandType = 'new-task' | 'activity' | 'stop';
export interface AgentPanelCommand {
  readonly serial: number;
  readonly type: AgentPanelCommandType;
}

/**
 * Maps the atomic runner into the result shape used by the run summary UI.
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

function makeJoyCodeId(prefix: string): string {
  const randomPart =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}-${randomPart}`;
}

function initialJoyCodeState(projectId: string): JoyCodeState {
  let threads: readonly JoyCodeThread[] = [];
  try {
    threads = loadJoyCodeThreads(window.localStorage, projectId);
  } catch {
    // Storage can be disabled by browser policy. The composer still works in memory.
  }
  const existing = threads[0];
  if (existing !== undefined) return { threads, activeThreadId: existing.id };
  const thread = createJoyCodeThread(makeJoyCodeId('task'), new Date().toISOString());
  return { threads: [thread], activeThreadId: thread.id };
}

function threadTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * Joy Code — a conversational shell over the guarded KiloCode editing adapter.
 * Prompt routing currently exposes the same deterministic timeline intents as
 * the former dashboard; unsupported free-form prompts are reported honestly.
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
  onAdd3DRender,
  settings,
  command,
  joyCodeServerSession,
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
  readonly onAdd3DRender?: (asset: JoyCode3DRenderAsset) => Promise<void>;
  readonly settings: AgentSettings;
  readonly command?: AgentPanelCommand;
  /** Optional guarded server planner for unmatched free-form prompts. */
  readonly joyCodeServerSession?: JoyCodeServerSession;
}) {
  const registry = useMemo(() => createToolRegistry(), []);
  const auditRef = useRef(createAuditTrail());
  const handledCommandRef = useRef<number | undefined>(undefined);
  const thinkingTimerRef = useRef<number | undefined>(undefined);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingPlan | undefined>(undefined);
  const [lastRun, setLastRun] = useState<LastRun | undefined>(undefined);
  const [thinkingThreadId, setThinkingThreadId] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState('composer');
  const [draft, setDraft] = useState('');
  const [attachError, setAttachError] = useState<string | undefined>(undefined);
  const [attaching, setAttaching] = useState(false);
  const [joyCode, setJoyCode] = useState<JoyCodeState>(() => initialJoyCodeState(project.id));
const [serverProposal, setServerProposal] = useState<JoyCodePlanProposalV1 | undefined>(undefined);
  const [serverDraft, setServerDraft] = useState<JoyCodeCompoundDraft | undefined>(undefined);
  const serverRunnerRef = useRef(new JoyCodeCompoundRunner());

  const approvalEngine = useMemo(
    () => new ApprovalEngine(approvalPolicyForAgentSettings(settings)),
    [settings],
  );

  const activeThread =
    joyCode.threads.find((thread) => thread.id === joyCode.activeThreadId) ?? joyCode.threads[0];

  useEffect(() => {
    try {
      saveJoyCodeThreads(window.localStorage, project.id, joyCode.threads);
    } catch {
      // History persistence is optional; never block editing when storage is unavailable.
    }
  }, [joyCode.threads, project.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeThread?.messages.length, pending, lastRun, tab, thinkingThreadId]);

  useEffect(
    () => () => {
      if (thinkingTimerRef.current !== undefined) {
        window.clearTimeout(thinkingTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (command === undefined || handledCommandRef.current === command.serial) return;
    handledCommandRef.current = command.serial;
    if (command.type === 'activity') {
      setTab('history');
      return;
    }
    if (command.type === 'stop' && pending !== undefined) {
      auditRef.current.record({
        planId: pending.plan.planId,
        action: 'plan-rejected',
        userId: 'local-owner',
        metadata: { source: 'agent-menu-stop' },
      });
      appendMessage(pending.threadId, 'assistant', 'Stopped. The proposed edit was not applied.');
      updateThreadStatus(pending.threadId, 'draft');
    }
    setPending(undefined);
    if (command.type === 'new-task') startNewTask();
  }, [command, pending]);

  function startNewTask() {
    if (thinkingTimerRef.current !== undefined) {
      window.clearTimeout(thinkingTimerRef.current);
      thinkingTimerRef.current = undefined;
    }
    const now = new Date().toISOString();
    const thread = createJoyCodeThread(makeJoyCodeId('task'), now);
    setJoyCode((current) => ({
      threads: [thread, ...current.threads],
      activeThreadId: thread.id,
    }));
    setPending(undefined);
    setLastRun(undefined);
    setThinkingThreadId(undefined);
    setDraft('');
    setTab('composer');
  }

  function appendMessage(threadId: string, role: 'user' | 'assistant', body: string): void {
    const now = new Date().toISOString();
    setJoyCode((current) => ({
      ...current,
      threads: addJoyCodeMessage(current.threads, threadId, {
        id: makeJoyCodeId('message'),
        role,
        body,
        createdAt: now,
      }),
    }));
  }

  function updateThreadStatus(threadId: string, status: JoyCodeThread['status']): void {
    setJoyCode((current) => ({
      ...current,
      threads: setJoyCodeThreadStatus(current.threads, threadId, status, new Date().toISOString()),
    }));
  }

  function buildIntent(intent: AgentIntent) {
    return intent.id === 'recipe-split-trim'
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
  }

  function plan(intent: AgentIntent, threadId: string) {
    const baseRevision = session.projectRevisionId;
    const baseProject = project;
    const built = buildIntent(intent);
    if (!built.ok) {
      appendMessage(threadId, 'assistant', built.reason);
      return;
    }
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
    if (approval === undefined) {
      appendMessage(threadId, 'assistant', 'No approval decision was created for this plan.');
      return;
    }
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
    appendMessage(
      threadId,
      'assistant',
      approval.decision === 'blocked'
        ? `The plan is ready, but execution policy blocked it: ${approval.reason}`
        : `The “${intent.label}” plan is ready. Preview: ${dryRun.aggregateDiff.summary}. Review the proposed change below.`,
    );
    setPending({ threadId, intent, plan: agentPlan, baseRevision, baseProject, dryRun, approval });
    setLastRun(undefined);
    updateThreadStatus(threadId, 'planning');
  }

  function submitPrompt(prompt: string) {
    const body = prompt.trim();
    if (body.length === 0 || activeThread === undefined || thinkingThreadId !== undefined) return;
    const threadId = activeThread.id;
    setDraft('');
    setTab('composer');
    appendMessage(threadId, 'user', body);
    if (pending !== undefined) {
      appendMessage(
        threadId,
        'assistant',
        'Review, run, or reject the current plan before starting a new edit.',
      );
      return;
    }
    const intentId = matchJoyCodeIntentId(body);
    const intent = AGENT_INTENTS.find((candidate) => candidate.id === intentId);
    if (intent === undefined && joyCodeServerSession !== undefined) {
      setThinkingThreadId(threadId);
      void joyCodeServerSession
        .plan(body, { clipIds: selectedClipIds })
        .then((result) => {
          if (result.kind === 'success') {
            setServerProposal(result.proposal);
            return import('./joy-code-compound-compiler.js').then(({ compileJoyCodeCompoundDraft }) => {
              const compiled = compileJoyCodeCompoundDraft({ planId: result.proposal.planId, baseRevision: result.proposal.snapshotRevisionId, timeline: session.timelineProject, visualProject: session.visualProject, registeredAssetIds: Object.keys(session.visualProject.assets), operations: result.proposal.operations });
              if (!compiled.ok) {
                appendMessage(threadId, 'assistant', `The proposal could not be compiled safely (${compiled.error.code}). No edits were applied.`);
              } else {
                setServerDraft(compiled);
                appendMessage(threadId, 'assistant', `A guarded Joy Code proposal is ready: ${result.proposal.summary}. Review and explicitly approve the bounded changes.`);
              }
            });
          } else if (result.kind === 'stale') {
            appendMessage(threadId, 'assistant', 'The project changed while planning. Refresh the project and try again.');
          } else if (result.kind === 'cancelled') {
            appendMessage(threadId, 'assistant', 'Joy Code planning was cancelled.');
          } else {
            appendMessage(threadId, 'assistant', `Joy Code planning did not complete (${result.kind}). No edits were applied.`);
          }
        })
        .catch(() => appendMessage(threadId, 'assistant', 'Joy Code planning failed safely. No edits were applied.'))
        .finally(() => setThinkingThreadId((current) => (current === threadId ? undefined : current)));
      return;
    }
    if (intent === undefined) {
      appendMessage(
        threadId,
        'assistant',
        'Joy Code accepts direct timeline requests such as shortening an intro, trimming, moving, joining, adding, or removing clips. Server planning is not configured for this session.',
      );
      return;
    }
    setThinkingThreadId(threadId);
    thinkingTimerRef.current = window.setTimeout(() => {
      thinkingTimerRef.current = undefined;
      try {
        plan(intent, threadId);
      } finally {
        setThinkingThreadId((current) => (current === threadId ? undefined : current));
      }
    }, THINKING_REVEAL_MS);
  }

  function rejectServerProposal() {
    setServerProposal(undefined);
    setServerDraft(undefined);
    if (activeThread !== undefined) appendMessage(activeThread.id, 'assistant', 'Joy Code proposal rejected. No edits were applied.');
  }

  function applyServerProposal() {
    if (serverDraft === undefined || activeThread === undefined) return;
    try {
      serverRunnerRef.current.apply(session, serverDraft, { planId: serverDraft.planId, proposalHash: serverDraft.proposalHash, baseRevision: serverDraft.baseRevision, approvedAt: new Date().toISOString() });
      appendMessage(activeThread.id, 'assistant', 'Approved and applied as one compound edit. One Undo restores the prior timeline and visual document.');
      setServerProposal(undefined);
      setServerDraft(undefined);
    } catch (error) {
      appendMessage(activeThread.id, 'assistant', error instanceof Error ? `Joy Code apply failed: ${error.message}` : 'Joy Code apply failed safely.');
    }
  }

  function reject() {
    if (pending === undefined) return;
    auditRef.current.record({
      planId: pending.plan.planId,
      action: 'plan-rejected',
      userId: 'local-owner',
    });
    appendMessage(pending.threadId, 'assistant', 'Rejected. No timeline changes were applied.');
    updateThreadStatus(pending.threadId, 'draft');
    setPending(undefined);
  }

  async function executePending(manualApprovalGranted: boolean) {
    if (pending === undefined) return;
    const { threadId, intent, plan: agentPlan, baseRevision, baseProject } = pending;
    auditRef.current.record({
      planId: agentPlan.planId,
      action: 'execution-started',
      userId: 'local-owner',
    });
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
      const failedResult: ExecutionResult = {
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
      };
      appendMessage(threadId, 'assistant', `The edit was not applied: ${error.message}`);
      updateThreadStatus(threadId, 'failed');
      setPending(undefined);
      setLastRun({
        threadId,
        intent,
        plan: agentPlan,
        executionResult: failedResult,
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
    appendMessage(
      threadId,
      'assistant',
      executionResult.success
        ? `“${intent.label}” was applied to the timeline as one atomic transaction.`
        : `The edit failed: ${executionResult.errors.join(', ')}`,
    );
    updateThreadStatus(threadId, executionResult.success ? 'completed' : 'failed');
    setPending(undefined);
    setLastRun({ threadId, intent, plan: agentPlan, executionResult, reverted: false });
  }

  function saveLastRunAsWorkflow() {
    if (lastRun === undefined || !lastRun.executionResult.success) return;
    const recorded = saveWorkflow(session, lastRun.plan);
    auditRef.current.record({
      planId: lastRun.plan.planId,
      action: 'workflow-saved',
      userId: 'local-owner',
      metadata: { workflowId: recorded.workflow.id },
    });
    appendMessage(lastRun.threadId, 'assistant', `Saved as workflow ${recorded.workflow.id}.`);
    setLastRun({ ...lastRun, savedWorkflowId: recorded.workflow.id });
  }

  function undoLastRun() {
    if (lastRun === undefined) return;
    onUndo();
    auditRef.current.record({
      planId: lastRun.executionResult.planId,
      action: 'revert-completed',
      userId: 'local-owner',
      metadata: { transactionLabel: lastRun.executionResult.transactionLabel },
    });
    appendMessage(lastRun.threadId, 'assistant', 'The complete run was reverted with one Undo.');
    updateThreadStatus(lastRun.threadId, 'draft');
    setLastRun({ ...lastRun, reverted: true });
  }

  const pendingChanges = useMemo(() => {
    if (pending === undefined) return [];
    return extractPendingChanges(pending.plan, project);
  }, [pending, project]);
  const isThinking = thinkingThreadId === activeThread?.id;

  const uploadJoyCodeFiles = async (fileList: FileList | null) => {
    if (fileList === null || fileList.length === 0 || onAttachAsset === undefined) return;
    setAttaching(true);
    setAttachError(undefined);
    try {
      const cache = await openJoyCodeOpfsAssetCache();
      for (const file of Array.from(fileList)) {
        const meta = await cache.put(file);
        onAttachAsset({
          assetId: meta.assetId,
          kind: meta.kind,
          displayName: meta.displayName,
          source: 'joycode-folder',
        });
      }
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : String(error));
    } finally {
      setAttaching(false);
      if (attachInputRef.current !== null) attachInputRef.current.value = '';
    }
  };

  return (
    <PanelShell
      title="Joy Code"
      className="joy-code-panel"
      actions={
        <button
          type="button"
          className="icon-button"
          aria-label="New Joy Code task"
          title="New task"
          onClick={startNewTask}
        >
          <PlusIcon />
        </button>
      }
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      tabsInHeader
    >
      <div
        className="joy-code-drop-target"
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
            /* Ignore malformed asset payloads. */
          }
        }}
      >
        {tab === 'history' && (
          <section className="joy-code-history" aria-label="Joy Code task history">
            <div className="joy-code-history-intro">
              <div>
                <strong>Recent tasks</strong>
                <span>Saved for this project</span>
              </div>
              <button type="button" onClick={startNewTask}>
                <PlusIcon />
                New task
              </button>
            </div>
            <ul className="joy-code-thread-list">
              {joyCode.threads.map((thread) => {
                const preview = thread.messages.at(-1)?.body ?? 'Ready for a request';
                return (
                  <li key={thread.id}>
                    <button
                      type="button"
                      className="joy-code-thread"
                      aria-current={thread.id === joyCode.activeThreadId ? 'true' : undefined}
                      onClick={() => {
                        setJoyCode((current) => ({ ...current, activeThreadId: thread.id }));
                        setTab('composer');
                      }}
                    >
                      <span className={`joy-code-thread-status is-${thread.status}`} />
                      <span className="joy-code-thread-copy">
                        <strong>{thread.title}</strong>
                        <span>{preview}</span>
                      </span>
                      <time dateTime={thread.updatedAt}>{threadTimestamp(thread.updatedAt)}</time>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {tab === 'composer' && (
          <section className="joy-code-composer" aria-label="Joy Code composer">
            <div className="joy-code-messages" aria-live="polite">
              {activeThread?.messages.length === 0 && (
                <div className="joy-code-welcome">
                  <JoyCodeLogo variant="horizontal" label="Joy Code" />
                  <h3>What should we edit?</h3>
                  <p>
                    <strong>Joy Code</strong> prepares controlled timeline plans. Nothing changes
                    until the plan passes policy and the execution mode permits it.
                  </p>
                </div>
              )}

              {activeThread?.messages.map((message) => (
                <article
                  key={message.id}
                  className={`joy-code-message is-${message.role}`}
                  aria-label={message.role === 'user' ? 'You' : 'Joy Code'}
                >
                  {message.role === 'assistant' && (
                    <span className="joy-code-avatar" aria-hidden="true">
                      <JoyCodeLogo variant="mark" />
                    </span>
                  )}
                  <div>
                    <strong>{message.role === 'user' ? 'You' : 'Joy Code'}</strong>
                    <p
                      lang={
                        message.role === 'assistant' && /[\u0600-\u06ff]/u.test(message.body)
                          ? 'fa'
                          : undefined
                      }
                    >
                      {message.body}
                    </p>
                  </div>
                </article>
              ))}

              {isThinking && (
                <article
                  className="joy-code-message is-assistant is-thinking"
                  aria-label="Joy Code is thinking"
                  role="status"
                >
                  <span className="joy-code-avatar" aria-hidden="true">
                    <JoyCodeLogo variant="mark" thinking />
                  </span>
                  <div>
                    <strong>Joy Code</strong>
                    <p>Thinking…</p>
                  </div>
                </article>
              )}

              {pending !== undefined && pending.threadId === activeThread?.id && (
                <section className="joy-code-plan-card" aria-label="Proposed timeline plan">
                  <div className="joy-code-plan-head">
                    <div>
                      <span>Proposed edit</span>
                      <strong>{pending.intent.label}</strong>
                    </div>
                    <span className={`agent-decision agent-decision-${pending.approval.decision}`}>
                      {pending.approval.decision.replaceAll('-', ' ')}
                    </span>
                  </div>
                  <p>{pending.dryRun.aggregateDiff.summary}</p>
                  <AgentTimelineCanvas
                    project={project}
                    playheadUs={playheadUs}
                    highlightedClipIds={selectedClipIds}
                    pendingChanges={pendingChanges}
                    width={400}
                    height={120}
                  />
                  {pending.dryRun.errors.length > 0 && (
                    <p className="agent-error">
                      Dry-run errors: {pending.dryRun.errors.join(', ')}
                    </p>
                  )}
                  <span className="joy-code-plan-reason">{pending.approval.reason}</span>
                  <div className="joy-code-plan-actions">
                    {pending.approval.decision === 'blocked' && (
                      <button type="button" onClick={reject}>
                        Dismiss
                      </button>
                    )}
                    {pending.approval.decision === 'requires-manual' && (
                      <>
                        <button
                          type="button"
                          className="is-primary"
                          onClick={() => void executePending(true)}
                        >
                          <CheckIcon />
                          Approve &amp; apply
                        </button>
                        <button type="button" onClick={reject}>
                          <CloseIcon />
                          Reject
                        </button>
                      </>
                    )}
                    {pending.approval.decision === 'auto-approved' && (
                      <button
                        type="button"
                        className="is-primary"
                        onClick={() => void executePending(false)}
                      >
                        <PlayIcon />
                        Apply edit
                      </button>
                    )}
                  </div>
                </section>
              )}

              {serverDraft !== undefined && serverProposal !== undefined && activeThread !== undefined && (
                <section className="joy-code-plan-card" aria-label="Proposed server Joy Code plan">
                  <div className="joy-code-plan-head">
                    <div><span>Server proposal</span><strong>{serverProposal.summary}</strong></div>
                    <span className="agent-decision agent-decision-requires-manual">manual approval</span>
                  </div>
                  <p>{serverDraft.groups.map((group) => group.summary).join(' · ')}</p>
                  {serverDraft.warnings.length > 0 && <p className="agent-error">{serverDraft.warnings.join(', ')}</p>}
                  <div className="joy-code-plan-actions">
                    <button type="button" className="is-primary" onClick={applyServerProposal}><CheckIcon />Approve &amp; apply</button>
                    <button type="button" onClick={rejectServerProposal}><CloseIcon />Reject</button>
                  </div>
                </section>
              )}

              {lastRun !== undefined && lastRun.threadId === activeThread?.id && (
                <section
                  className={`joy-code-run-card ${
                    lastRun.executionResult.success ? 'is-success' : 'is-failed'
                  }`}
                  aria-label="Last Joy Code run"
                >
                  <div>
                    <strong>
                      {lastRun.executionResult.success ? 'Edit applied' : 'Edit failed'}
                    </strong>
                    <span>{lastRun.intent.label}</span>
                  </div>
                  <div className="joy-code-run-actions">
                    {lastRun.executionResult.rollbackAvailable && !lastRun.reverted && (
                      <button type="button" onClick={undoLastRun}>
                        <UndoIcon />
                        Undo run
                      </button>
                    )}
                    {lastRun.executionResult.success && lastRun.savedWorkflowId === undefined && (
                      <button type="button" onClick={saveLastRunAsWorkflow}>
                        <SaveIcon />
                        Save workflow
                      </button>
                    )}
                  </div>
                  {!lastRun.executionResult.success && (
                    <p className="agent-error">{lastRun.executionResult.errors.join(', ')}</p>
                  )}
                  {lastRun.reverted && <p>Reverted.</p>}
                  {lastRun.savedWorkflowId !== undefined && (
                    <p>
                      Saved with ID <bdi>{lastRun.savedWorkflowId}</bdi>.
                    </p>
                  )}
                </section>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="joy-code-compose-dock">
              {attachedAssets.length > 0 && (
                <ul className="joy-code-attachments" aria-label="Attached media">
                  {attachedAssets.map((asset) => (
                    <li key={asset.assetId}>
                      <span>{asset.kind}</span>
                      <strong title={asset.assetId}>{asset.displayName}</strong>
                      {onDetachAsset !== undefined && (
                        <button
                          type="button"
                          aria-label={`Detach ${asset.displayName}`}
                          onClick={() => onDetachAsset(asset.assetId)}
                        >
                          <CloseIcon />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {attachError !== undefined && (
                <p className="joy-code-attach-error" role="alert">
                  {attachError}
                </p>
              )}
              <input
                ref={attachInputRef}
                type="file"
                className="sr-only"
                accept="image/*,.md,text/markdown,text/plain"
                multiple
                aria-hidden="true"
                tabIndex={-1}
                onChange={(event) => {
                  void uploadJoyCodeFiles(event.currentTarget.files);
                }}
              />
              <div className="joy-code-input">
                <button
                  type="button"
                  className="icon-button joy-code-attach"
                  aria-label="Attach image or Markdown"
                  title="Attach image or Markdown"
                  disabled={attaching || onAttachAsset === undefined}
                  onClick={() => attachInputRef.current?.click()}
                >
                  <PlusIcon />
                </button>
                <textarea
                  rows={3}
                  value={draft}
                  aria-label="Message Joy Code"
                  placeholder="Describe the timeline edit you want…"
                  onChange={(event) => setDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      submitPrompt(draft);
                    }
                  }}
                />
                <button
                  type="button"
                  className="joy-code-send"
                  aria-label={
                    isThinking
                      ? 'Joy Code is thinking'
                      : pending === undefined
                        ? 'Send message'
                        : 'Stop current plan'
                  }
                  title={isThinking ? 'Thinking…' : pending === undefined ? 'Send' : 'Stop'}
                  disabled={isThinking || (pending === undefined && draft.trim().length === 0)}
                  onClick={() => {
                    if (pending !== undefined) reject();
                    else submitPrompt(draft);
                  }}
                >
                  {pending === undefined ? <PlayIcon /> : <CloseIcon />}
                </button>
              </div>
            </div>
          </section>
        )}

        {tab === '3d' && (
          <Suspense fallback={null}>
            <JoyCode3DViewer
              {...(onAdd3DRender === undefined ? {} : { onAddToTimeline: onAdd3DRender })}
            />
          </Suspense>
        )}
      </div>
    </PanelShell>
  );
}

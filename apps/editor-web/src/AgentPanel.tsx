import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
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
  validateCreativeBrief,
} from '@joy-media/agent-tools';
import type { AgentActor, AtomicRunResult, ProjectRevisionId } from '@joy-media/agent-tools';
import type { CreativeBriefV1 } from '@joy-media/agent-tools';
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
import { PanelShell } from './PanelShell.js';
import type { AgentPolicyPreferences } from './agent-policy-settings.js';
import { approvalPolicyForAgentPolicy } from './agent-policy-settings.js';
import { JoyCodeLogo } from './JoyCodeLogo.js';
import { openJoyCodeOpfsAssetCache } from './joycode-opfs-assets.js';
import { matchJoyCodeIntentId, type JoyCodeThreadStatus } from './joy-code-history.js';
import {
  addJoyCodeConversationMessage,
  createJoyCodeConversation,
  loadJoyCodeConversation,
  saveJoyCodeConversation,
  setJoyCodeConversationStatus,
  type JoyCodeConversation,
} from './joy-code-conversation.js';
import { CheckIcon, CloseIcon, PlayIcon, PlusIcon, SaveIcon, UndoIcon } from './icons.js';
import { CreativeBriefPanel } from './CreativeBriefPanel.js';
import type { JoyCodeCompoundDraft } from './joy-code-compound-compiler.js';
import { compileJoyCodeCompoundDraft } from './joy-code-compound-compiler.js';
import { JoyCodeCompoundRunner } from './joy-code-compound-runner.js';
import { AgentPreviewBadge } from './AgentPreviewBadge.js';
import type { JoyAgentEngineClient } from './joy-agent/engine-client.js';
import { createJoyAgentContextSnapshot } from './joy-agent/context-snapshot.js';
import type { JoyAgentPhase } from './joy-agent/protocol.js';
import {
  EMPTY_AGENT_PRESENCE,
  type AgentPresenceState,
  type AgentPresenceStore,
  type JoyAgentPresenceEvent,
} from './agent-presence.js';
import type { AgentPreviewStore } from './agent-preview-store.js';
import { stageJoyAgentPreview } from './joy-agent/stage-preview.js';
import { inferJoyAgentTaskKind, targetForJoyAgentTask } from './agent-ui-targets.js';

/** Every edit this panel commits is attributed to the built-in JOY engine. */
const AGENT_ACTOR: AgentActor = { type: 'agent', id: 'joy-agent' };
const THINKING_REVEAL_MS = 320;
const MAX_COMPOSER_PROMPT_CHARS = 8_000;
const CREDENTIAL_LIKE_PROMPT =
  /(?:bearer\s+[A-Za-z0-9._~-]{16,}|(?:api[_-]?key|secret|token)\s*[:=]\s*\S{12,}|sk-[A-Za-z0-9_-]{20,})/i;
type ComposerCapability = 'edit' | 'creative-brief';
const NOOP_SUBSCRIBE = () => () => {};
const NOOP_PRESENCE_SNAPSHOT = (): AgentPresenceState => EMPTY_AGENT_PRESENCE;

interface PendingPlan {
  readonly runId: string;
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

export interface JoyAgentAttachedAsset {
  readonly assetId: string;
  readonly kind: 'image' | 'video' | 'markdown';
  readonly displayName: string;
  /** Present when the file lives under OPFS joy-media-assets/joycode/. */
  readonly source?: 'joycode-folder';
}

export type AgentPanelCommandType = 'stop' | 'select-capability';
export interface AgentPanelCommand {
  readonly serial: number;
  readonly type: AgentPanelCommandType;
  readonly capability?: ComposerCapability;
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

function initialJoyCodeConversation(projectId: string): JoyCodeConversation {
  try {
    const existing = loadJoyCodeConversation(window.localStorage, projectId);
    if (existing !== undefined) return existing;
  } catch {
    // Storage can be disabled by browser policy. The composer still works in memory.
  }
  return createJoyCodeConversation(makeJoyCodeId('conversation'), new Date().toISOString());
}

/**
 * Joy Code — a conversational shell over the guarded JOY Agent Engine.
 * Deterministic timeline intents remain available offline; other prompts use
 * the configured built-in JOY Agent Worker and stay behind the same approval
 * and revision boundary.
 */
export function AgentPanel({
  project,
  selectedClipIds,
  playheadUs,
  agentContext,
  onUndo,
  onProjectRevision,
  session,
  attachedAssets = [],
  onDetachAsset,
  onAttachAsset,
  settings,
  command,
  creativeBriefOptedIn = false,
  creativeBriefRunner,
  onCreativeBriefOptIn,
  joyAgentEngineClient,
  agentPresenceStore,
  agentPreviewStore,
}: {
  readonly project: SpikeProject;
  readonly selectedClipIds: readonly string[];
  readonly playheadUs: number;
  readonly agentContext: EditorContext;
  readonly onUndo: () => void;
  /** Notify the app shell after a model draft mutates the shared session. */
  readonly onProjectRevision?: () => void;
  readonly session: EditorSession;
  readonly attachedAssets?: readonly JoyAgentAttachedAsset[];
  readonly onDetachAsset?: (assetId: string) => void;
  readonly onAttachAsset?: (asset: JoyAgentAttachedAsset) => void;
  readonly settings: AgentPolicyPreferences;
  readonly command?: AgentPanelCommand;
  readonly creativeBriefOptedIn?: boolean;
  readonly creativeBriefRunner?: (requestText: string) => Promise<CreativeBriefV1>;
  readonly onCreativeBriefOptIn?: () => Promise<void>;
  readonly joyAgentEngineClient?: JoyAgentEngineClient;
  readonly agentPresenceStore?: AgentPresenceStore;
  readonly agentPreviewStore?: AgentPreviewStore;
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
  const [agentPhase, setAgentPhase] = useState<JoyAgentPhase | undefined>(undefined);
  const [agentRunId, setAgentRunId] = useState<string | undefined>(undefined);
  const [composerCapability, setComposerCapability] = useState<ComposerCapability>('edit');
  const [draft, setDraft] = useState('');
  const [attachError, setAttachError] = useState<string | undefined>(undefined);
  const [attaching, setAttaching] = useState(false);
  const [conversation, setConversation] = useState<JoyCodeConversation>(() =>
    initialJoyCodeConversation(project.id),
  );
  const [creativeBriefContext, setCreativeBriefContext] = useState<CreativeBriefV1 | undefined>(
    undefined,
  );
  const [modelDraft, setModelDraft] = useState<JoyCodeCompoundDraft | undefined>(undefined);
  const modelRunnerRef = useRef(new JoyCodeCompoundRunner());
  const presenceState = useSyncExternalStore(
    agentPresenceStore?.subscribe ?? NOOP_SUBSCRIBE,
    agentPresenceStore?.getState ?? NOOP_PRESENCE_SNAPSHOT,
    NOOP_PRESENCE_SNAPSHOT,
  );

  useEffect(() => {
    setCreativeBriefContext(undefined);
    setComposerCapability('edit');
    setConversation(initialJoyCodeConversation(project.id));
  }, [project.id]);

  useEffect(() => {
    const preview = agentPreviewStore?.getState();
    if (
      preview?.timeline?.baseRevision !== undefined &&
      preview.timeline.baseRevision !== session.projectRevisionId
    )
      agentPreviewStore?.clear();
    if (
      preview?.document?.baseRevision !== undefined &&
      preview.document.baseRevision !== session.projectRevisionId
    )
      agentPreviewStore?.clear();
  }, [agentPreviewStore, session.projectRevisionId]);

  // A trusted Creative Brief target can arrive from an older deep link or a
  // live run before this panel has rendered. Keep Composer selected and open
  // the matching first-party capability without allowing provider routing to
  // choose a UI surface.
  useEffect(() => {
    if (
      presenceState.targets.some(
        (target) => target.panelId === 'agent' && target.capability === 'creative-brief',
      ) ||
      (presenceState.terminalTarget?.panelId === 'agent' &&
        presenceState.terminalTarget.capability === 'creative-brief')
    )
      setComposerCapability('creative-brief');
  }, [presenceState.targets, presenceState.terminalTarget]);

  const approvalEngine = useMemo(
    () => new ApprovalEngine(approvalPolicyForAgentPolicy(settings)),
    [settings],
  );
  // Internal runner records retain a threadId field for compatibility with
  // plans and audit entries. It is now the stable project conversation ID.
  const activeThread = conversation;

  useEffect(() => {
    try {
      saveJoyCodeConversation(window.localStorage, project.id, conversation);
    } catch {
      // Conversation persistence is optional; never block editing when storage is unavailable.
    }
  }, [conversation, project.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [conversation.messages.length, pending, lastRun, thinkingThreadId]);

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
    if (command.type === 'select-capability') {
      if (command.capability !== undefined) setComposerCapability(command.capability);
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
    const commandRunId = agentRunId ?? presenceState.runId;
    if (
      command.type === 'stop' &&
      commandRunId !== undefined &&
      joyAgentEngineClient !== undefined
    ) {
      void joyAgentEngineClient.cancel(commandRunId);
      agentPresenceStore?.clear();
      agentPreviewStore?.clear(commandRunId);
      setAgentPhase('cancelled');
      setModelDraft(undefined);
    }
    setPending(undefined);
  }, [
    agentPresenceStore,
    agentPreviewStore,
    agentRunId,
    command,
    joyAgentEngineClient,
    pending,
    presenceState.runId,
  ]);

  function appendMessage(_threadId: string, role: 'user' | 'assistant', body: string): void {
    const now = new Date().toISOString();
    setConversation((current) =>
      addJoyCodeConversationMessage(current, {
        id: makeJoyCodeId('message'),
        role,
        body,
        createdAt: now,
      }),
    );
  }

  const handOffCreativeBrief = useCallback(
    (brief: CreativeBriefV1): void => {
      const threadId = conversation.id;
      if (!validateCreativeBrief(brief).valid) {
        appendMessage(
          threadId,
          'assistant',
          'Creative Brief hand-off was rejected because the brief failed validation. No planner context was queued.',
        );
        return;
      }
      setCreativeBriefContext(brief);
      appendMessage(
        threadId,
        'user',
        `Creative Brief artifact attached (review only): ${brief.request}\n\nValidated brief context is available to the next guarded Joy Code edit. No recommendation was executed.`,
      );
      setComposerCapability('creative-brief');
    },
    [conversation.id],
  );

  function updateThreadStatus(_threadId: string, status: JoyCodeThreadStatus): void {
    setConversation((current) =>
      setJoyCodeConversationStatus(current, status, new Date().toISOString()),
    );
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
    const runId = makeJoyCodeId('run');
    agentPresenceStore?.beginRun(runId, session.historyCursorSequence);
    agentPresenceStore?.dispatch({
      protocolVersion: 1,
      runId,
      seq: 0,
      at: new Date().toISOString(),
      revision: session.historyCursorSequence,
      kind: 'activity',
      phase: 'planning',
      targets: [{ panelId: 'timeline', sectionId: 'timeline' }],
    });
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
    setPending({
      runId,
      threadId,
      intent,
      plan: agentPlan,
      baseRevision,
      baseProject,
      dryRun,
      approval,
    });
    agentPresenceStore?.dispatch({
      protocolVersion: 1,
      runId,
      seq: 1,
      at: new Date().toISOString(),
      revision: session.historyCursorSequence,
      kind: 'approval-required',
      phase: 'awaiting-approval',
      targets: [{ panelId: 'timeline', sectionId: 'timeline' }],
    });
    setLastRun(undefined);
    updateThreadStatus(threadId, 'planning');
  }

  function submitPrompt(prompt: string) {
    const body = prompt.trim().slice(0, MAX_COMPOSER_PROMPT_CHARS);
    if (body.length === 0 || thinkingThreadId !== undefined) return;
    const threadId = activeThread.id;
    if (CREDENTIAL_LIKE_PROMPT.test(body)) {
      appendMessage(
        threadId,
        'assistant',
        'This request looks like it contains a credential. JOY did not save or send it; remove the secret and try again.',
      );
      setDraft('');
      return;
    }
    setDraft('');
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
    if (intent === undefined && settings.privacyMode === 'local-only') {
      appendMessage(
        threadId,
        'assistant',
        'Local-only privacy is enabled. Connect a remote model or switch the privacy policy before using natural-language JOY edits.',
      );
      return;
    }
    if (
      creativeBriefContext !== undefined &&
      creativeBriefContext.snapshotRevisionId !== session.projectRevisionId
    ) {
      appendMessage(
        threadId,
        'assistant',
        'The attached Creative Brief is stale because the project changed. Regenerate it before starting this edit.',
      );
      setCreativeBriefContext(undefined);
      setComposerCapability('creative-brief');
      return;
    }
    if (intent === undefined && joyAgentEngineClient !== undefined) {
      const connectionStatus = joyAgentEngineClient.getStatus();
      if (connectionStatus === undefined || connectionStatus.capability === 'incompatible') {
        appendMessage(
          threadId,
          'assistant',
          connectionStatus?.capability === 'incompatible'
            ? 'The configured model is incompatible. Test another model in Agent Settings; no fallback provider was selected.'
            : 'Connect a model in Agent Settings to run natural-language JOY edits. No fallback provider was selected.',
        );
        return;
      }
      const runId = makeJoyCodeId('run');
      const taskKind = inferJoyAgentTaskKind(body);
      const taskTarget = targetForJoyAgentTask(taskKind);
      setAgentRunId(runId);
      setModelDraft(undefined);
      agentPreviewStore?.clear();
      agentPresenceStore?.beginRun(runId, session.historyCursorSequence);
      setThinkingThreadId(threadId);
      setAgentPhase('connecting');
      void (async () => {
        try {
          const composition =
            session.timelineProject.compositions[session.timelineProject.rootCompositionId];
          const contextSnapshot = createJoyAgentContextSnapshot({
            projectId: session.visualProject.id,
            revision: session.projectRevisionId,
            compositionId: session.timelineProject.rootCompositionId,
            trackIds: composition?.tracks.map((track) => track.id) ?? [],
            selectedClipIds,
            playheadUs,
            ...(composition === undefined
              ? {}
              : {
                  clips: composition.tracks.flatMap((track) =>
                    track.clips.map((clip) => ({
                      id: clip.id,
                      trackId: track.id,
                      startUs: clip.startUs,
                      durationUs: clip.durationUs,
                    })),
                  ),
                }),
            assets: Object.values(session.visualProject.assets).map((asset) => ({
              id: asset.id,
              kind: asset.kind,
              displayName: asset.displayName,
            })),
            ...(creativeBriefContext === undefined ? {} : { creativeBrief: creativeBriefContext }),
          });
          for await (const event of joyAgentEngineClient.startRun({
            runId,
            taskKind,
            prompt: body,
            baseRevision: session.projectRevisionId,
            context: contextSnapshot,
            mode:
              joyAgentEngineClient.getStatus()?.capability === 'plan-only'
                ? 'plan-only'
                : 'tool-loop',
          })) {
            setAgentPhase(event.phase);
            const terminal =
              event.phase === 'completed' ||
              event.phase === 'failed' ||
              event.phase === 'cancelled';
            const presenceEvent: JoyAgentPresenceEvent = {
              protocolVersion: 1,
              runId,
              seq: event.seq,
              at: event.at,
              revision: session.historyCursorSequence,
              kind: terminal
                ? event.phase
                : event.phase === 'awaiting-approval'
                  ? 'approval-required'
                  : event.phase === 'previewing'
                    ? 'preview'
                    : 'activity',
              phase: event.phase,
              ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
              targets:
                event.phase === 'previewing' || event.phase === 'awaiting-approval'
                  ? [
                      { panelId: 'agent', sectionId: 'composer' },
                      taskTarget,
                      { panelId: 'timeline', sectionId: 'timeline' },
                    ]
                  : [{ panelId: 'agent', sectionId: 'composer' }, taskTarget],
              ...(event.proposal === undefined
                ? {}
                : {
                    preview: {
                      revision: session.historyCursorSequence,
                      summaryCode: 'joy-agent-proposal',
                      targetCount: event.proposal.operations.length,
                    },
                  }),
            };
            agentPresenceStore?.dispatch(presenceEvent);
            if (event.phase === 'awaiting-approval')
              appendMessage(
                threadId,
                'assistant',
                'JOY prepared a bounded proposal. Review the live preview before applying.',
              );
            if (event.proposal !== undefined && event.proposal.operations.length > 0) {
              const compiled = compileJoyCodeCompoundDraft({
                planId: runId,
                baseRevision: event.proposal.baseRevision,
                timeline: session.timelineProject,
                visualProject: session.visualProject,
                registeredAssetIds: Object.keys(session.visualProject.assets),
                operations: event.proposal.operations as never,
              });
              if (compiled.ok) {
                stageJoyAgentPreview(agentPreviewStore, session, compiled);
                setModelDraft(compiled);
              } else {
                setModelDraft(undefined);
                agentPreviewStore?.clear(runId);
                appendMessage(
                  threadId,
                  'assistant',
                  `JOY rejected the proposal: ${compiled.error.message}`,
                );
                throw new Error('Proposal validation failed. No edits were staged.');
              }
              appendMessage(
                threadId,
                'assistant',
                `${event.proposal.summary} (${event.proposal.operations.length} bounded operation${event.proposal.operations.length === 1 ? '' : 's'}) is ready for JOY validation.`,
              );
            }
            if (event.phase === 'completed')
              appendMessage(
                threadId,
                'assistant',
                'The model response was received. JOY keeps edits in preview until you approve them.',
              );
            if (event.phase === 'failed')
              appendMessage(
                threadId,
                'assistant',
                event.message ?? 'JOY could not complete this run. No edits were applied.',
              );
            if (event.phase === 'cancelled')
              appendMessage(threadId, 'assistant', 'JOY run cancelled. No edits were applied.');
            if (event.phase === 'failed' || event.phase === 'cancelled')
              agentPreviewStore?.clear(runId);
          }
        } catch (error) {
          appendMessage(
            threadId,
            'assistant',
            error instanceof Error ? error.message : 'JOY run failed safely.',
          );
          setAgentPhase('failed');
        } finally {
          setThinkingThreadId((current) => (current === threadId ? undefined : current));
          setAgentRunId((current) => (current === runId ? undefined : current));
        }
      })();
      return;
    }
    if (intent === undefined) {
      appendMessage(
        threadId,
        'assistant',
        'Connect a model in Agent Settings to run natural-language JOY edits. Direct timeline recipes remain available without a connection.',
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
    agentPreviewStore?.clear(pending.runId);
  }

  function rejectModelDraft() {
    void joyAgentEngineClient?.cancel(modelDraft?.planId ?? '');
    setModelDraft(undefined);
    setAgentPhase('cancelled');
    agentPreviewStore?.clear(modelDraft?.planId);
    if (activeThread !== undefined)
      appendMessage(activeThread.id, 'assistant', 'JOY preview rejected. No edits were applied.');
    agentPresenceStore?.clear();
  }

  function applyModelDraft() {
    if (modelDraft === undefined || activeThread === undefined) return;
    try {
      modelRunnerRef.current.apply(
        session,
        modelDraft,
        {
          planId: modelDraft.planId,
          proposalHash: modelDraft.proposalHash,
          baseRevision: modelDraft.baseRevision,
          approvedAt: new Date().toISOString(),
        },
        settings,
      );
      onProjectRevision?.();
      appendMessage(
        activeThread.id,
        'assistant',
        'Approved and applied as one atomic JOY edit. One Undo restores the prior state.',
      );
      setModelDraft(undefined);
      setAgentPhase('completed');
      agentPreviewStore?.clear(modelDraft.planId);
      void joyAgentEngineClient?.cancel(modelDraft.planId);
      agentPresenceStore?.dispatch({
        protocolVersion: 1,
        runId: modelDraft.planId,
        seq: 99,
        at: new Date().toISOString(),
        revision: session.historyCursorSequence,
        kind: 'completed',
        phase: 'completed',
        targets: [{ panelId: 'timeline', sectionId: 'timeline' }],
      });
      window.setTimeout(() => agentPresenceStore?.completeHandoff(), 1200);
    } catch (error) {
      appendMessage(
        activeThread.id,
        'assistant',
        error instanceof Error ? `JOY apply failed: ${error.message}` : 'JOY apply failed safely.',
      );
    }
  }

  async function executePending(manualApprovalGranted: boolean) {
    if (pending === undefined) return;
    const { threadId, intent, plan: agentPlan, baseRevision, baseProject } = pending;
    agentPresenceStore?.dispatch({
      protocolVersion: 1,
      runId: pending.runId,
      seq: 2,
      at: new Date().toISOString(),
      revision: session.historyCursorSequence,
      kind: 'activity',
      phase: 'applying',
      targets: [{ panelId: 'timeline', sectionId: 'timeline' }],
    });
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
    agentPreviewStore?.clear(pending.runId);
    agentPresenceStore?.dispatch({
      protocolVersion: 1,
      runId: pending.runId,
      seq: 3,
      at: new Date().toISOString(),
      revision: session.historyCursorSequence,
      kind: executionResult.success ? 'completed' : 'failed',
      phase: executionResult.success ? 'completed' : 'failed',
      targets: [{ panelId: 'timeline', sectionId: 'timeline' }],
      ...(executionResult.success ? {} : { errorCode: 'JOY_AGENT_INVALID_PROPOSAL' as const }),
    });
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
  const composerPresenceActive = presenceState.targets.some(
    (target) => target.panelId === 'agent' && target.sectionId === 'composer',
  );
  const liveAgentPhase =
    agentPhase ??
    (composerPresenceActive || presenceState.terminalTarget?.panelId === 'agent'
      ? presenceState.phase === 'idle'
        ? undefined
        : presenceState.phase
      : undefined);
  const liveAgentBusy =
    liveAgentPhase !== undefined &&
    liveAgentPhase !== 'completed' &&
    liveAgentPhase !== 'failed' &&
    liveAgentPhase !== 'cancelled';
  const activeRunId = agentRunId ?? presenceState.runId;

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
        {liveAgentPhase !== undefined && (
          <div
            className={`joy-agent-live-status is-${liveAgentPhase}`}
            role="status"
            aria-live="polite"
          >
            <span className="joy-agent-live-mark" aria-hidden="true" />
            <strong>
              {liveAgentPhase === 'awaiting-approval'
                ? 'Needs approval'
                : `JOY ${liveAgentPhase.replaceAll('-', ' ')}`}
            </strong>
            <span>
              {liveAgentPhase === 'previewing' || liveAgentPhase === 'planning'
                ? 'Previewing changes in the editor'
                : 'Live engine activity'}
            </span>
            {(liveAgentPhase === 'thinking' ||
              liveAgentPhase === 'connecting' ||
              liveAgentPhase === 'planning' ||
              liveAgentPhase === 'previewing') &&
              joyAgentEngineClient !== undefined && (
                <button
                  type="button"
                  onClick={() => {
                    if (activeRunId !== undefined) void joyAgentEngineClient.cancel(activeRunId);
                    setAgentPhase('cancelled');
                    setModelDraft(undefined);
                    agentPreviewStore?.clear(activeRunId);
                    agentPresenceStore?.clear();
                  }}
                >
                  Stop
                </button>
              )}
          </div>
        )}
        <section
            className={`joy-code-composer is-${composerCapability} ${liveAgentBusy ? 'is-agent-busy' : ''}`}
            aria-label="Joy Code composer"
            aria-busy={liveAgentBusy}
            data-agent-phase={liveAgentPhase}
          >
            <div
              className="joy-code-capabilities"
              role="toolbar"
              aria-label="Composer capabilities"
            >
              <span className="joy-code-capabilities-label">Create with JOY</span>
              <button
                type="button"
                className={`joy-code-capability ${
                  composerCapability === 'edit' ? 'is-active' : ''
                }`}
                aria-pressed={composerCapability === 'edit'}
                onClick={() => setComposerCapability('edit')}
              >
                <JoyCodeLogo variant="mark" />
                Edit
              </button>
              <button
                type="button"
                className={`joy-code-capability ${
                  composerCapability === 'creative-brief' ? 'is-active' : ''
                } ${creativeBriefContext !== undefined ? 'has-artifact' : ''}`}
                aria-pressed={composerCapability === 'creative-brief'}
                onClick={() => setComposerCapability('creative-brief')}
              >
                <span className="joy-code-capability-spark" aria-hidden="true">
                  ✦
                </span>
                Creative Brief
                {creativeBriefContext !== undefined && (
                  <span className="joy-code-capability-dot" aria-label="Brief attached" />
                )}
              </button>
            </div>
            {creativeBriefContext !== undefined && (
              <section className="joy-code-brief-artifact" aria-label="Attached Creative Brief">
                <div className="joy-code-brief-artifact-copy">
                  <span className="joy-code-brief-artifact-kicker">
                    <span aria-hidden="true">✦</span> Creative Brief attached
                  </span>
                  <strong>{creativeBriefContext.request}</strong>
                  <span>
                    {creativeBriefContext.recommendations.length}{' '}
                    {creativeBriefContext.recommendations.length === 1
                      ? 'recommendation'
                      : 'recommendations'}{' '}
                    · revision {creativeBriefContext.snapshotRevisionId}
                  </span>
                </div>
                <div className="joy-code-brief-artifact-actions">
                  <button type="button" onClick={() => setComposerCapability('creative-brief')}>
                    Open brief
                  </button>
                  <button
                    type="button"
                    className="is-subtle"
                    onClick={() => setCreativeBriefContext(undefined)}
                  >
                    Detach
                  </button>
                </div>
              </section>
            )}
            <div
              className="joy-code-creative-brief"
              aria-label="Creative Brief capability"
              hidden={composerCapability !== 'creative-brief'}
            >
              <CreativeBriefPanel
                revisionId={session.projectRevisionId}
                projectId={project.id}
                optedIn={creativeBriefOptedIn}
                onBriefReady={handOffCreativeBrief}
                onBriefHydrated={setCreativeBriefContext}
                onBriefCleared={() => setCreativeBriefContext(undefined)}
                {...(onCreativeBriefOptIn === undefined ? {} : { onOptIn: onCreativeBriefOptIn })}
                {...(creativeBriefRunner === undefined ? {} : { runBrief: creativeBriefRunner })}
                embedded
              />
            </div>
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

              {modelDraft !== undefined && activeThread !== undefined && (
                <section
                  className="joy-code-plan-card joy-code-model-plan"
                  aria-label="JOY Agent live proposal"
                >
                  <AgentPreviewBadge surface="JOY Code" />
                  <div className="joy-code-plan-head">
                    <div>
                      <span>JOY Agent preview</span>
                      <strong>Not applied</strong>
                    </div>
                    <span className="agent-decision agent-decision-requires-manual">
                      needs approval
                    </span>
                  </div>
                  <p>{modelDraft.groups.map((group) => group.summary).join(' · ')}</p>
                  <p>
                    Applying this local edit adds no provider cost. BYOK model spend is unknown; the
                    dollar limit cannot cap provider billing. Requests are limited to four steps of
                    2,048 output tokens.
                  </p>
                  {modelDraft.warnings.length > 0 && (
                    <p className="agent-error">{modelDraft.warnings.join(', ')}</p>
                  )}
                  <div className="joy-code-plan-actions">
                    <button type="button" className="is-primary" onClick={applyModelDraft}>
                      <CheckIcon /> Approve &amp; apply
                    </button>
                    <button type="button" onClick={rejectModelDraft}>
                      <CloseIcon /> Reject
                    </button>
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

            {composerCapability === 'edit' && (
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
            )}
        </section>
      </div>
    </PanelShell>
  );
}

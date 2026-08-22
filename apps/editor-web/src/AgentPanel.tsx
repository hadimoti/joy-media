import { useEffect, useMemo, useRef, useState } from 'react';
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
import {
  AGENT_INTENTS,
  buildShortenIntroRecipe,
  buildSplitTrimRecipe,
  findClipLocation,
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
import {
  BrowserControlPlaneError,
  BrowserControlPlaneClient,
  type BrowserAsset,
  type BrowserProviderApprovalPreflight,
  type BrowserJoyCodeReasoningRequest,
  type BrowserJoyCodeReasoningResponse,
} from './control-plane-client.js';
import { JoyCodeLogo } from './JoyCodeLogo.js';
import { JoyCode3DViewer } from './JoyCode3DViewer.js';
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

/** Every edit this panel commits is attributed to the KiloCode adapter. */
const AGENT_ACTOR: AgentActor = { type: 'agent', id: 'kilocode' };
const THINKING_REVEAL_MS = 320;

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
  readonly reasoning?: BrowserJoyCodeReasoningResponse;
}

interface LastRun {
  readonly threadId: string;
  readonly intent: AgentIntent;
  readonly plan: AgentEditPlan;
  readonly executionResult: ExecutionResult;
  readonly reverted: boolean;
  readonly savedWorkflowId?: string;
}

interface PendingReasoningApproval {
  readonly threadId: string;
  readonly request: BrowserJoyCodeReasoningRequest;
  readonly preflight: BrowserProviderApprovalPreflight;
}

interface JoyCodeState {
  readonly threads: readonly JoyCodeThread[];
  readonly activeThreadId: string;
}

export type JoyCodeReasoningResponse = BrowserJoyCodeReasoningResponse;

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

export type JoyCodePromptRoute =
  { readonly kind: 'intent'; readonly intent: AgentIntent } | { readonly kind: 'reasoning' };

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

export function selectJoyCodePendingApproval(
  decisions: readonly ApprovalDecision[],
): ApprovalDecision | undefined {
  return (
    decisions.find((decision) => decision.decision === 'blocked') ??
    decisions.find(
      (decision) =>
        decision.decision === 'requires-manual' && decision.request.providerApproval !== undefined,
    ) ??
    decisions.find((decision) => decision.decision === 'requires-manual') ??
    decisions[0]
  );
}

function approvalCostLabel(approval: ApprovalDecision): string | undefined {
  const cost = approval.request.estimatedCost;
  return cost === undefined ? undefined : `${cost.amount} ${cost.currency}`;
}

export function ProviderApprovalDetails({ approval }: { readonly approval: ApprovalDecision }) {
  const provider = approval.request.providerApproval;
  if (provider === undefined) return null;
  const cost = approvalCostLabel(approval);
  return (
    <dl className="joy-code-provider-approval" aria-label="Provider approval details">
      <div>
        <dt>Provider</dt>
        <dd>{provider.providerId}</dd>
      </div>
      <div>
        <dt>Capability</dt>
        <dd>{provider.capability}</dd>
      </div>
      {cost !== undefined && (
        <div>
          <dt>Cost cap</dt>
          <dd>{cost}</dd>
        </div>
      )}
      <div>
        <dt>Approval</dt>
        <dd>{provider.requestDigest}</dd>
      </div>
    </dl>
  );
}

export function JoyCodeReasoningDetails({
  reasoning,
}: {
  readonly reasoning: BrowserJoyCodeReasoningResponse;
}) {
  const usage = reasoning.provider.usage;
  return (
    <dl className="joy-code-provider-approval" aria-label="Joy Code reasoning details">
      <div>
        <dt>Provider</dt>
        <dd>{reasoning.provider.providerId}</dd>
      </div>
      <div>
        <dt>Model</dt>
        <dd>{reasoning.provider.modelId}</dd>
      </div>
      <div>
        <dt>Decision</dt>
        <dd>{reasoning.provider.decisionRef}</dd>
      </div>
      <div>
        <dt>Brief</dt>
        <dd>{reasoning.provider.briefRef}</dd>
      </div>
      {usage !== undefined && (
        <div>
          <dt>Usage</dt>
          <dd>
            {(usage.inputTokens ?? 0).toLocaleString()} in /{' '}
            {(usage.outputTokens ?? 0).toLocaleString()} out
          </dd>
        </div>
      )}
    </dl>
  );
}

export function JoyCodeReasoningApprovalDetails({
  preflight,
}: {
  readonly preflight: BrowserProviderApprovalPreflight;
}) {
  return (
    <dl className="joy-code-provider-approval" aria-label="Joy Code reasoning approval details">
      <div>
        <dt>Provider</dt>
        <dd>{preflight.providerId}</dd>
      </div>
      <div>
        <dt>Capability</dt>
        <dd>{preflight.capability}</dd>
      </div>
      <div>
        <dt>Approval</dt>
        <dd>{preflight.requestDigest}</dd>
      </div>
      {preflight.estimatedCost !== undefined && (
        <div>
          <dt>Cost cap</dt>
          <dd>
            {preflight.estimatedCost.amount} {preflight.estimatedCost.currency}
          </dd>
        </div>
      )}
    </dl>
  );
}

export function routeJoyCodePrompt(prompt: string): JoyCodePromptRoute {
  const intentId = matchJoyCodeIntentId(prompt.trim());
  const intent =
    intentId === undefined
      ? undefined
      : AGENT_INTENTS.find((candidate) => candidate.id === intentId);
  return intent === undefined ? { kind: 'reasoning' } : { kind: 'intent', intent };
}

function shortHash(value: unknown): string {
  const text = stableJson(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function selectedClipEvidence(
  project: SpikeProject,
  selectedClipIds: readonly string[],
): ReadonlyArray<BrowserJoyCodeReasoningRequest['evidence'][number]> {
  return selectedClipIds.flatMap((clipId) => {
    const location = findClipLocation(project, clipId);
    if (location === undefined) return [];
    return [
      {
        evidenceId: `clip:${clipId}`,
        kind: 'selected-clip' as const,
        label: location.clip.id,
        detail: `${location.compositionId}/${location.trackId} from ${location.clip.startUs}us for ${location.clip.durationUs}us`,
      },
    ];
  });
}

export function buildJoyCodeReasoningRequest(args: {
  readonly project: SpikeProject;
  readonly selectedClipIds: readonly string[];
  readonly playheadUs: number;
  readonly attachedAssets: readonly KiloCodeAttachedAsset[];
  readonly settings: Pick<AgentSettings, 'reasoningModel' | 'privacyMode'>;
  readonly projectRevision: ProjectRevisionId;
  readonly goal: string;
}): BrowserJoyCodeReasoningRequest {
  const evidence = [
    ...selectedClipEvidence(args.project, args.selectedClipIds),
    ...args.attachedAssets.map((asset) => ({
      evidenceId: `asset:${asset.assetId}`,
      kind: 'attached-asset' as const,
      label: asset.displayName,
      detail: `${asset.kind} asset ${asset.assetId}`,
    })),
    {
      evidenceId: `playhead:${args.playheadUs}`,
      kind: 'timeline-range' as const,
      label: 'Playhead',
      detail: `Current playhead at ${args.playheadUs}us`,
    },
  ];
  return {
    model: args.settings.reasoningModel || 'mistral-small-latest',
    goal: args.goal.trim(),
    snapshotDigest: shortHash({
      projectId: args.project.id,
      projectRevision: args.projectRevision,
      selectedClipIds: args.selectedClipIds,
      playheadUs: args.playheadUs,
      evidence,
    }),
    projectRevision: args.projectRevision,
    idempotencyKey: makeJoyCodeId('reasoning'),
    privacyMode: args.settings.privacyMode,
    evidence,
    allowedIntentIds: AGENT_INTENTS.map((intent) => intent.id),
    maxTokens: 600,
  };
}

export function buildPendingPlanFromJoyCodeProposal(args: {
  readonly response: BrowserJoyCodeReasoningResponse;
  readonly project: SpikeProject;
  readonly selectedClipIds: readonly string[];
  readonly playheadUs: number;
  readonly baseRevision: ProjectRevisionId;
  readonly registry: ReturnType<typeof createToolRegistry>;
  readonly approvalEngine: ApprovalEngine;
  readonly agentContext: EditorContext;
}): PendingPlan | undefined {
  const intentId = args.response.proposal?.intentId;
  if (intentId === undefined) return undefined;
  const intent = AGENT_INTENTS.find((candidate) => candidate.id === intentId);
  if (intent === undefined) return undefined;
  const built =
    intent.id === 'recipe-split-trim'
      ? buildSplitTrimRecipe(args.project, args.selectedClipIds, args.playheadUs)
      : intent.id === 'shorten-intro'
        ? buildShortenIntroRecipe(args.project)
        : (() => {
            const single = intent.buildStep(args.project, args.selectedClipIds, args.playheadUs);
            if (!single.ok) return single;
            return { ok: true as const, steps: [single.step], goal: intent.label };
          })();
  if (!built.ok) return undefined;
  const plan = createPlan(built.goal, [...built.steps]);
  const dryRun = dryRunPlan(plan, args.registry, buildEditorContext(args.project));
  const approval =
    selectJoyCodePendingApproval(
      args.approvalEngine.evaluatePlan(
        plan,
        args.agentContext,
        (toolName) => args.registry.tools.get(toolName)?.scope,
      ),
    ) ??
    ({
      decision: 'blocked',
      reason: 'No approval decision was produced.',
      request: {
        id: 'approval-missing',
        stepId: 'plan',
        reason: 'unresolved-assumptions',
        description: 'No approval decision was produced.',
        privacyImpact: { dataLeavesDevice: false, dataTypes: [] },
        isReversible: true,
        status: 'pending',
      },
    } satisfies ApprovalDecision);
  return {
    threadId: 'reasoning-proposal',
    intent,
    plan,
    baseRevision: args.baseRevision,
    baseProject: args.project,
    dryRun,
    approval,
    reasoning: args.response,
  };
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
  assets = [],
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
  /** Registered catalog assets available to the asset-backed 3D preview. */
  readonly assets?: readonly BrowserAsset[];
  readonly onDetachAsset?: (assetId: string) => void;
  readonly onAttachAsset?: (asset: KiloCodeAttachedAsset) => void;
  readonly settings: AgentSettings;
  readonly command?: AgentPanelCommand;
}) {
  const registry = useMemo(() => createToolRegistry(), []);
  const controlPlaneClient = useMemo(() => new BrowserControlPlaneClient(), []);
  const auditRef = useRef(createAuditTrail());
  const handledCommandRef = useRef<number | undefined>(undefined);
  const thinkingTimerRef = useRef<number | undefined>(undefined);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingPlan | undefined>(undefined);
  const [pendingReasoningApproval, setPendingReasoningApproval] = useState<
    PendingReasoningApproval | undefined
  >(undefined);
  const [lastRun, setLastRun] = useState<LastRun | undefined>(undefined);
  const [lastReasoning, setLastReasoning] = useState<BrowserJoyCodeReasoningResponse | undefined>(
    undefined,
  );
  const [thinkingThreadId, setThinkingThreadId] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState('composer');
  const [draft, setDraft] = useState('');
  const [attachError, setAttachError] = useState<string | undefined>(undefined);
  const [attaching, setAttaching] = useState(false);
  const [joyCode, setJoyCode] = useState<JoyCodeState>(() => initialJoyCodeState(project.id));

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
  }, [
    activeThread?.messages.length,
    pending,
    pendingReasoningApproval,
    lastRun,
    tab,
    thinkingThreadId,
  ]);

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
      appendMessage(pending.threadId, 'assistant', 'متوقف شد. ویرایش پیشنهادی اعمال نشد.');
      updateThreadStatus(pending.threadId, 'draft');
    }
    if (command.type === 'stop' && pendingReasoningApproval !== undefined) {
      appendMessage(
        pendingReasoningApproval.threadId,
        'assistant',
        'تأیید پردازش راه‌دور لغو شد. هیچ داده‌ای ارسال نشد.',
      );
      updateThreadStatus(pendingReasoningApproval.threadId, 'draft');
    }
    setPending(undefined);
    setPendingReasoningApproval(undefined);
    if (command.type === 'new-task') startNewTask();
  }, [command, pending, pendingReasoningApproval]);

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
    setPendingReasoningApproval(undefined);
    setLastRun(undefined);
    setLastReasoning(undefined);
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

  function plan(
    intent: AgentIntent,
    threadId: string,
    reasoning?: BrowserJoyCodeReasoningResponse,
  ) {
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
    const approval = selectJoyCodePendingApproval(decisions);
    if (approval === undefined) {
      appendMessage(threadId, 'assistant', 'برای این برنامه هیچ تصمیم تأییدی ایجاد نشد.');
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
        ? `برنامه آماده شد، اما سیاست اجرایی آن را مسدود کرد: ${approval.reason}`
        : `برنامهٔ «${intent.label}» آماده شد. اجرای آزمایشی: ${dryRun.aggregateDiff.summary}. تغییر زیر را بررسی کنید.`,
    );
    setPending({
      threadId,
      intent,
      plan: agentPlan,
      baseRevision,
      baseProject,
      dryRun,
      approval,
      ...(reasoning === undefined ? {} : { reasoning }),
    });
    if (reasoning !== undefined) setLastReasoning(reasoning);
    setLastRun(undefined);
    updateThreadStatus(threadId, 'planning');
  }

  async function runReasoningRequest(
    request: BrowserJoyCodeReasoningRequest,
    threadId: string,
  ): Promise<void> {
    try {
      const reasoning = await controlPlaneClient.joyCodeReasoning(request);
      setPendingReasoningApproval(undefined);
      setLastReasoning(reasoning);
      appendMessage(threadId, 'assistant', reasoning.brief.summary);
      if (reasoning.proposal !== undefined) {
        const proposalPlan = buildPendingPlanFromJoyCodeProposal({
          response: reasoning,
          project,
          selectedClipIds,
          playheadUs,
          baseRevision: session.projectRevisionId,
          registry,
          approvalEngine,
          agentContext,
        });
        if (proposalPlan !== undefined) {
          setPending({ ...proposalPlan, threadId });
          setLastRun(undefined);
          updateThreadStatus(threadId, 'planning');
          return;
        }
      }
      updateThreadStatus(threadId, 'draft');
    } catch (error) {
      if (
        error instanceof BrowserControlPlaneError &&
        error.code === 'PROVIDER_APPROVAL_REQUIRED' &&
        error.preflight !== undefined &&
        request.privacyMode === 'ask-before-remote'
      ) {
        setPendingReasoningApproval({ threadId, request, preflight: error.preflight });
        appendMessage(
          threadId,
          'assistant',
          'Remote reasoning needs your approval before this bounded request leaves the device.',
        );
        updateThreadStatus(threadId, 'planning');
        return;
      }
      appendMessage(
        threadId,
        'assistant',
        error instanceof Error ? error.message : 'Bounded reasoning is unavailable right now.',
      );
      updateThreadStatus(threadId, 'failed');
    }
  }

  async function requestReasoning(prompt: string, threadId: string): Promise<void> {
    if (settings.reasoningModel === '') {
      appendMessage(
        threadId,
        'assistant',
        'Joy Code اکنون درخواست‌های مستقیم تایم‌لاین را می‌پذیرد. برای نقد یا پیشنهاد bounded، ابتدا یک مدل reasoning را در Agent Settings انتخاب کنید.',
      );
      return;
    }
    await runReasoningRequest(
      buildJoyCodeReasoningRequest({
        project,
        selectedClipIds,
        playheadUs,
        attachedAssets,
        settings,
        projectRevision: session.projectRevisionId,
        goal: prompt,
      }),
      threadId,
    );
  }

  async function approveReasoning(): Promise<void> {
    if (pendingReasoningApproval === undefined) return;
    const { threadId, request, preflight } = pendingReasoningApproval;
    setThinkingThreadId(threadId);
    try {
      const grant = await controlPlaneClient.issueProviderApprovalGrant({
        providerId: preflight.providerId,
        capability: preflight.capability,
        requestDigest: preflight.requestDigest,
        ...(preflight.estimatedCost === undefined ? {} : { costCap: preflight.estimatedCost }),
      });
      await runReasoningRequest({ ...request, providerApprovalGrant: grant }, threadId);
    } finally {
      setThinkingThreadId((current) => (current === threadId ? undefined : current));
    }
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
        'پیش از شروع ویرایش تازه، برنامهٔ فعلی را بررسی، اجرا یا رد کنید.',
      );
      return;
    }
    if (pendingReasoningApproval !== undefined) {
      appendMessage(
        threadId,
        'assistant',
        'پیش از شروع درخواست تازه، تأیید پردازش راه‌دور فعلی را تأیید یا رد کنید.',
      );
      return;
    }
    const route = routeJoyCodePrompt(body);
    setThinkingThreadId(threadId);
    thinkingTimerRef.current = window.setTimeout(() => {
      thinkingTimerRef.current = undefined;
      const action =
        route.kind === 'intent'
          ? Promise.resolve().then(() => plan(route.intent, threadId))
          : requestReasoning(body, threadId);
      void action.finally(() => {
        setThinkingThreadId((current) => (current === threadId ? undefined : current));
      });
    }, THINKING_REVEAL_MS);
  }

  function reject() {
    if (pending !== undefined) {
      auditRef.current.record({
        planId: pending.plan.planId,
        action: 'plan-rejected',
        userId: 'local-owner',
      });
      appendMessage(pending.threadId, 'assistant', 'رد شد. هیچ تغییری روی تایم‌لاین اعمال نشد.');
      updateThreadStatus(pending.threadId, 'draft');
      setPending(undefined);
      return;
    }
    if (pendingReasoningApproval !== undefined) {
      appendMessage(
        pendingReasoningApproval.threadId,
        'assistant',
        'پردازش راه‌دور رد شد. هیچ داده‌ای برای reasoning ارسال نشد.',
      );
      updateThreadStatus(pendingReasoningApproval.threadId, 'draft');
      setPendingReasoningApproval(undefined);
    }
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
      appendMessage(threadId, 'assistant', `ویرایش اعمال نشد: ${error.message}`);
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
        ? `«${intent.label}» به‌صورت یک تراکنش اتمیک روی تایم‌لاین اعمال شد.`
        : `ویرایش ناموفق بود: ${executionResult.errors.join(', ')}`,
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
    appendMessage(
      lastRun.threadId,
      'assistant',
      `به‌عنوان گردش‌کار ${recorded.workflow.id} ذخیره شد.`,
    );
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
    appendMessage(lastRun.threadId, 'assistant', 'کل اجرا با یک Undo بازگردانی شد.');
    updateThreadStatus(lastRun.threadId, 'draft');
    setLastRun({ ...lastRun, reverted: true });
  }

  const pendingChanges = useMemo(() => {
    if (pending === undefined) return [];
    return extractPendingChanges(pending.plan, project);
  }, [pending, project]);
  const hasBlockingPending = pending !== undefined || pendingReasoningApproval !== undefined;
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
                <span lang="fa">برای این پروژه ذخیره شده‌اند</span>
              </div>
              <button type="button" onClick={startNewTask}>
                <PlusIcon />
                New task
              </button>
            </div>
            <ul className="joy-code-thread-list">
              {joyCode.threads.map((thread) => {
                const preview = thread.messages.at(-1)?.body ?? 'آمادهٔ دریافت درخواست';
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
                  <h3 lang="fa">چه چیزی را ویرایش کنیم؟</h3>
                  <p lang="fa">
                    <strong>جوی کد</strong> برنامه‌های کنترل‌شدهٔ تایم‌لاین را آماده می‌کند. تا
                    زمانی که برنامه از سیاست‌ها عبور نکند و حالت اجرا اجازه ندهد، چیزی تغییر
                    نمی‌کند.
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
                    <p lang="fa">در حال فکر کردن…</p>
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
                  {pending.reasoning !== undefined && (
                    <>
                      <p>
                        {pending.reasoning.proposal?.summary ?? pending.reasoning.brief.summary}
                      </p>
                      <JoyCodeReasoningDetails reasoning={pending.reasoning} />
                    </>
                  )}
                  <ProviderApprovalDetails approval={pending.approval} />
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
              {pendingReasoningApproval !== undefined &&
                pendingReasoningApproval.threadId === activeThread?.id && (
                  <section
                    className="joy-code-plan-card"
                    aria-label="Joy Code remote reasoning approval"
                  >
                    <div className="joy-code-plan-head">
                      <div>
                        <span>Remote reasoning approval</span>
                        <strong>{pendingReasoningApproval.request.model}</strong>
                      </div>
                      <span className="agent-decision agent-decision-requires-manual">
                        requires manual
                      </span>
                    </div>
                    <p>
                      <span lang="fa">
                        پیش از آن‌که Joy Code این درخواست محدود را به مدل راه‌دور بفرستد، آن را
                        تأیید کنید.
                      </span>
                    </p>
                    <span className="joy-code-plan-reason">
                      {pendingReasoningApproval.preflight.retentionDisclosure ??
                        'درخواست محدود به ارائه‌دهندهٔ reasoning راه‌دورِ پیکربندی‌شده فرستاده می‌شود.'}
                    </span>
                    <JoyCodeReasoningApprovalDetails
                      preflight={pendingReasoningApproval.preflight}
                    />
                    <div className="joy-code-plan-actions">
                      <button
                        type="button"
                        className="is-primary"
                        onClick={() => void approveReasoning()}
                      >
                        <CheckIcon />
                        Allow remote reasoning
                      </button>
                      <button type="button" onClick={reject}>
                        <CloseIcon />
                        Reject
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
                  {lastRun.reverted && <p lang="fa">بازگردانی شد.</p>}
                  {lastRun.savedWorkflowId !== undefined && (
                    <p lang="fa">
                      با شناسهٔ <bdi>{lastRun.savedWorkflowId}</bdi> ذخیره شد.
                    </p>
                  )}
                </section>
              )}
              {lastReasoning !== undefined &&
                lastReasoning.proposal === undefined &&
                pending?.threadId !== activeThread?.id && (
                  <section className="joy-code-run-card" aria-label="Last Joy Code critique">
                    <div>
                      <strong>Bounded critique</strong>
                      <span>{lastReasoning.brief.summary}</span>
                    </div>
                    <p>{lastReasoning.brief.rationale}</p>
                    <JoyCodeReasoningDetails reasoning={lastReasoning} />
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
                  placeholder="ویرایش موردنظر روی تایم‌لاین را توضیح دهید…"
                  lang="fa"
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
                      : !hasBlockingPending
                        ? 'Send message'
                        : 'Stop current request'
                  }
                  title={isThinking ? 'Thinking…' : !hasBlockingPending ? 'Send' : 'Stop'}
                  disabled={isThinking || (!hasBlockingPending && draft.trim().length === 0)}
                  onClick={() => {
                    if (hasBlockingPending) reject();
                    else submitPrompt(draft);
                  }}
                >
                  {!hasBlockingPending ? <PlayIcon /> : <CloseIcon />}
                </button>
              </div>
            </div>
          </section>
        )}

        {tab === '3d' && <JoyCode3DViewer assets={assets} />}
      </div>
    </PanelShell>
  );
}

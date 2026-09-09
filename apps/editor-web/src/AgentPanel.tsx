import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import type { ProjectWriterStorage } from './project-writer.js';
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
  setJoyCodeConversationEntityReferences,
  setJoyCodeConversationStatus,
  type JoyCodeConversation,
} from './joy-code-conversation.js';
import { CheckIcon, CloseIcon, PlayIcon, PlusIcon, SaveIcon, UndoIcon } from './icons.js';
import { CreativeBriefPanel } from './CreativeBriefPanel.js';
import { JoyCodeCompoundRunner } from './joy-code-compound-runner.js';
import { AgentPreviewBadge } from './AgentPreviewBadge.js';
import {
  AgentObservationConsent,
  type AgentObservationConsentScope,
} from './AgentObservationConsent.js';
import type { JoyAgentEngineClient, JoyAgentRunIterator } from './joy-agent/engine-client.js';
import {
  createJoyAgentContextSnapshot,
  type JoyAgentContextSnapshotInput,
} from './joy-agent/context-snapshot.js';
import { createJoyAgentHostRpcMethodsForSnapshot } from './joy-agent/tool-bridge.js';
import type { JoyAgentObservationAdapterFactory } from './joy-agent/observation-host-factory.js';
import type {
  JoyAgentObservationHostBridge,
  JoyAgentObservationReviewCandidate,
} from './joy-agent/observation-tool-adapter.js';
import { resolveJoyAgentObservationAuthority } from './joy-agent/observation-run-authority.js';
import {
  createObservationReviewController,
  type ObservationReviewController,
  type ObservationReviewState,
} from './joy-agent/observation-review-controller.js';
import { createWorkerObservationReviewTransfer } from './joy-agent/worker-observation-transfer.js';
import { MAX_PRIVATE_OBSERVATION_FIRST_RELEASE_BYTES } from './joy-agent/observation-transfer-port-protocol.js';
import type { ObservationTransferAuthority } from './joy-agent/observation-transfer-service.js';
import { digestJoyAgentPolicy } from './joy-agent/prepared-change-store.js';
import {
  JOY_AGENT_HOST_TOOL_NAMES,
  type JoyAgentHostToolName,
} from './joy-agent/host-tool-contract.js';
import {
  createJoyAgentComposerHostLease,
  interruptJoyAgentComposerHostLease,
  isJoyAgentComposerHostLeaseCurrent,
  revokeJoyAgentComposerHostLease,
  type JoyAgentComposerHostLease,
} from './joy-agent/composer-host-lease.js';
import type { JoyAgentPhase } from './joy-agent/protocol.js';
import {
  createJoyAgentRunController,
  type JoyAgentRunController,
  type JoyAgentRunEventAcceptance,
} from './joy-agent/run-controller.js';
import {
  JOY_AGENT_RUN_EVENT_VERSION,
  JOY_AGENT_RUN_ERROR_CODES,
  isTerminalJoyAgentRunState,
  type JoyAgentActiveRunState,
  type JoyAgentRunArtifactReference,
  type JoyAgentRunErrorCode,
} from './joy-agent/run-events.js';
import {
  EMPTY_AGENT_PRESENCE,
  type AgentPresenceState,
  type AgentPresenceStore,
  type JoyAgentTarget,
  type JoyAgentPresenceEvent,
} from './agent-presence.js';
import {
  isAgentPreviewBundleReady,
  type AgentPreviewBundle,
  type AgentPreviewStore,
} from './agent-preview-store.js';
import { createJoyAgentProposalStagingHandler } from './joy-agent/edit-proposal-staging.js';
import { buildJoyAgentContextInput } from './joy-agent/context-input.js';
import { createCreativeSkillEditorPrimitiveDeps } from './joy-agent/creative-skill-editor-deps.js';
import type { CreativeSkillEditorPrimitiveDeps } from './joy-agent/creative-skill-editor-primitives.js';
import { listCreativeSkills, runEditorCreativeSkill } from './joy-agent/entry-points.js';
import type { CreativeSkillRunScope } from './joy-agent/skill-runner.js';
import { BUILT_IN_LOOK_PACKS, type LookDefinition } from '@joy-media/motion-core';
import { CONTENT_FONT_FAMILIES } from '@joy-media/project-schema';
import { catalog as buildLookCatalog } from './joy-agent/look-operations.js';
import {
  buildLookInstanceRecord,
  detachLookInstance,
  lookInstanceUpdateCompileInput,
  upsertLookInstance,
} from './joy-agent/look-instance-operations.js';
import { stageLookRun } from './joy-agent/look-run-host.js';
import {
  LivingLooksPanel,
  type LivingLooksAppliedView,
  type LivingLooksEntityOption,
  type LivingLooksRunInput,
} from './LivingLooksPanel.js';
import {
  deriveJoyAgentConversationEntityReferences,
  resolveJoyAgentConversationEntityReference,
  type JoyAgentConversationEntityReference,
} from './joy-agent/conversation-entity-references.js';
import {
  PreparedChangeStore,
  type PreparedChangeAuthority,
} from './joy-agent/prepared-change-store.js';
import {
  applyPreparedJoyCodeChange,
  type PreparedJoyCodeApplyOutcome,
} from './joy-agent/prepared-apply-outcome.js';
import { inferJoyAgentTaskKind, targetForJoyAgentTask } from './agent-ui-targets.js';

/** Every edit this panel commits is attributed to the built-in JOY engine. */
const AGENT_ACTOR: AgentActor = { type: 'agent', id: 'joy-agent' };
const THINKING_REVEAL_MS = 320;
const MAX_COMPOSER_PROMPT_CHARS = 8_000;
const CREDENTIAL_LIKE_PROMPT =
  /(?:bearer\s+[A-Za-z0-9._~-]{16,}|(?:api[_-]?key|secret|token)\s*[:=]\s*\S{12,}|sk-[A-Za-z0-9_-]{20,})/i;
// The Persian alternatives are anchored on non-letter boundaries so a short
// pronoun such as این is not matched inside an ordinary word like اینکه.
const CONVERSATION_REFERENCE_WORD =
  /\b(?:that|this|same|previous|it)\b|(?<![\p{L}\p{M}])(?:همان|همین|این|آن|قبلی|اون|همونو|همینو)(?![\p{L}\p{M}])/iu;
const CONVERSATION_TITLE_WORD =
  /\b(?:title|heading|text)\b|(?<![\p{L}\p{M}])(?:عنوان|تیتر|متن)(?![\p{L}\p{M}])/iu;
const CONVERSATION_REFERENCE_AMBIGUOUS_MESSAGE =
  'JOY cannot safely determine which previous item to use. Select one item before continuing.';
type ComposerCapability = 'edit' | 'creative-brief' | 'recipes' | 'looks';

const LEGACY_JOY_AGENT_TOOL_NAMES = Object.freeze([
  'read_project_context',
  'validate_proposal',
] as const satisfies readonly JoyAgentHostToolName[]);

/** A Worker approval event held until the staged preview has actually rendered. */
interface DeferredPreviewApproval {
  readonly run: JoyAgentRunIterator['run'];
  readonly threadId: string;
  readonly presence: JoyAgentPresenceEvent;
  readonly display: string;
}

interface PrivateObservationReviewLease {
  readonly bridge: JoyAgentObservationHostBridge;
  readonly candidate: JoyAgentObservationReviewCandidate;
  readonly leaseId: string;
  readonly expiresAtMs: number;
}

interface ObservationReviewDisplay {
  readonly evidenceCount: number;
  readonly range: { readonly domain: 'source'; readonly startUs: number; readonly endUs: number };
  readonly modelId: string;
}

interface ObservationReviewUiState {
  readonly status: ObservationReviewState['status'];
  readonly analysis?: string;
  readonly message?: string;
}

const OBSERVATION_REVIEW_PROMPT =
  'Review only the explicitly approved image evidence. Describe observable visual facts and possible edit opportunities without making edits.';
const OBSERVATION_REVIEW_TTL_MS = 2 * 60 * 1_000;
const OBSERVATION_REVIEW_MAX_BYTES = MAX_PRIVATE_OBSERVATION_FIRST_RELEASE_BYTES;
const OPENROUTER_PRIVACY_POLICY_HREF = 'https://openrouter.ai/privacy';

const NOOP_SUBSCRIBE = () => () => {};
const NOOP_PRESENCE_SNAPSHOT = (): AgentPresenceState => EMPTY_AGENT_PRESENCE;
const NOOP_PREVIEW_BUNDLE = (): AgentPreviewBundle | undefined => undefined;

function sameObservationTransferAuthority(
  left: ObservationTransferAuthority | undefined,
  right: ObservationTransferAuthority | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.projectId === right.projectId &&
    left.revision === right.revision &&
    left.run.runId === right.run.runId &&
    left.run.epoch === right.run.epoch &&
    left.modelId === right.modelId &&
    left.promptPolicyDigest === right.promptPolicyDigest
  );
}

function reviewUiState(state: ObservationReviewState): ObservationReviewUiState {
  if (state.status === 'reviewed') return { status: state.status, analysis: state.analysis.text };
  if (state.status === 'failed')
    return { status: state.status, message: 'Image review could not be completed.' };
  if (state.status === 'cancelled')
    return { status: state.status, message: 'Image review was cancelled.' };
  return { status: state.status };
}

function boundedAgentResultText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>;
  if (result.kind === 'answer' && typeof result.text === 'string')
    return result.text.slice(0, 8_192);
  if (result.kind === 'clarification' && typeof result.question === 'string')
    return result.question.slice(0, 8_192);
  return undefined;
}

/**
 * The older local recipe executor predates durable prepared changes. Keep its
 * UI route hard-disabled until it is migrated through JoyCodeCompoundRunner.
 */
export function legacyRecipeExecutionEnabled(): false {
  return false;
}

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

/** Prepared preview IDs add an epoch, while Worker cancellation uses the source run ID. */
function sourceRunIdForPreparedPlan(planId: string): string {
  const epochMarker = planId.lastIndexOf('.epoch-');
  return epochMarker > 0 ? planId.slice(0, epochMarker) : planId;
}

function initialJoyCodeConversation(
  storage: ProjectWriterStorage,
  projectId: string,
): JoyCodeConversation {
  try {
    const existing = loadJoyCodeConversation(storage, projectId);
    if (existing !== undefined) return existing;
  } catch {
    // Storage can be disabled by browser policy. The composer still works in memory.
  }
  return createJoyCodeConversation(makeJoyCodeId('conversation'), new Date().toISOString());
}

function createPreparedChangesForScope(
  _projectId: string,
  _session: EditorSession,
): PreparedChangeStore {
  // The arguments make the scope change explicit at the call site. The store
  // itself intentionally retains no live editor or project objects.
  return new PreparedChangeStore();
}

function lifecycleStateForAgentPhase(phase: JoyAgentPhase): JoyAgentActiveRunState {
  switch (phase) {
    case 'connecting':
    case 'thinking':
    case 'inspecting':
      return 'inspecting';
    case 'planning':
      return 'preparing';
    case 'previewing':
      // A canonical proposal is only staged here. The lifecycle enters
      // preview-ready after every mapped surface acknowledges an actual render.
      return 'preparing';
    case 'awaiting-approval':
      return 'awaiting-approval';
    case 'applying':
      return 'committing';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

function agentPhaseForLifecycleState(
  state: ReturnType<JoyAgentRunController['getSnapshot']>['state'],
): JoyAgentPhase | undefined {
  switch (state) {
    case 'inspecting':
      return 'inspecting';
    case 'preparing':
      return 'planning';
    case 'preview-ready':
      return 'previewing';
    case 'awaiting-approval':
      return 'awaiting-approval';
    case 'committing':
    case 'verifying':
      return 'applying';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'interrupted':
      return 'failed';
    case 'cancel-requested':
    case 'cancelled':
      return 'cancelled';
    case 'idle':
      return undefined;
  }
}

function runErrorCodeForAgentError(value: unknown): JoyAgentRunErrorCode | undefined {
  return typeof value === 'string' &&
    JOY_AGENT_RUN_ERROR_CODES.includes(value as JoyAgentRunErrorCode)
    ? (value as JoyAgentRunErrorCode)
    : undefined;
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
  joyAgentRunController,
  agentPresenceStore,
  agentPreviewStore,
  observationAdapterFactory,
  storage,
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
  /** App-owned lifecycle evidence; a test-only fallback is used when omitted. */
  readonly joyAgentRunController?: JoyAgentRunController;
  readonly agentPresenceStore?: AgentPresenceStore;
  readonly agentPreviewStore?: AgentPreviewStore;
  /**
   * Main-thread-only factory for bounded local evidence. Its output is paired
   * with the exact Worker tool catalog below; the model never receives the
   * resolver, decoder, cache, or evidence store.
   */
  readonly observationAdapterFactory?: JoyAgentObservationAdapterFactory;
  /** Writer-fenced browser persistence owned by the writable editor root. */
  readonly storage: ProjectWriterStorage;
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
    initialJoyCodeConversation(storage, project.id),
  );
  const [recipeRunningId, setRecipeRunningId] = useState<string | undefined>(undefined);
  const recipeRunScopeRef = useRef<CreativeSkillRunScope | undefined>(undefined);
  const recipeStagedChangeSetRef = useRef<string | undefined>(undefined);
  const [lookRunningId, setLookRunningId] = useState<string | undefined>(undefined);
  // Production passes an App-owned controller so panel remounts cannot revive
  // authority or lose lifecycle evidence. Keep an isolated fallback for
  // focused component tests and older embedders that have not adopted F4 yet.
  const fallbackRunController = useMemo(
    () =>
      createJoyAgentRunController({
        projectId: project.id,
        conversationId: `conversation-${project.id}`,
      }),
    [project.id],
  );
  const runController = joyAgentRunController ?? fallbackRunController;
  const conversationProjectIdRef = useRef(project.id);
  const [creativeBriefContext, setCreativeBriefContext] = useState<CreativeBriefV1 | undefined>(
    undefined,
  );
  const proposalTargetsRef = useRef(new Map<string, readonly JoyAgentTarget[]>());
  // A store is deliberately scoped to one mounted project/session. Async work
  // from an old session only retains its now-detached store, not authority over
  // the current panel.
  const preparedChanges = useMemo(
    () => createPreparedChangesForScope(project.id, session),
    [project.id, session],
  );
  const preparedChangesRef = useRef(preparedChanges);
  preparedChangesRef.current = preparedChanges;
  const preparedScopeRef = useRef({ projectId: project.id, session, epoch: 1 });
  if (
    preparedScopeRef.current.projectId !== project.id ||
    preparedScopeRef.current.session !== session
  )
    preparedScopeRef.current = {
      projectId: project.id,
      session,
      epoch: preparedScopeRef.current.epoch + 1,
    };
  const preparedSessionEpoch = preparedScopeRef.current.epoch;
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;
  const latestSessionRef = useRef(session);
  latestSessionRef.current = session;
  const activeModelRunIdRef = useRef<string | undefined>(undefined);
  const activeComposerHostLeaseRef = useRef<JoyAgentComposerHostLease | undefined>(undefined);
  const sessionScopeRef = useRef({
    projectId: project.id,
    session,
    revision: session.projectRevisionId,
  });
  const modelChangeSetIdRef = useRef<string | undefined>(undefined);
  const deferredPreviewApprovalRef = useRef<DeferredPreviewApproval | undefined>(undefined);
  const [modelChangeSetId, setModelChangeSetId] = useState<string | undefined>(undefined);
  const modelRunnerRef = useRef(new JoyCodeCompoundRunner());
  // The lease and candidate remain in private refs. React receives only a
  // redacted count/range/status, never frame IDs, a prompt, bytes, endpoint,
  // or BYOK material.
  const observationReviewLeaseRef = useRef<PrivateObservationReviewLease | undefined>(undefined);
  const observationReviewControllerRef = useRef<ObservationReviewController | undefined>(undefined);
  const observationReviewRegistrationRef = useRef(0);
  const [observationReviewDisplay, setObservationReviewDisplay] = useState<
    ObservationReviewDisplay | undefined
  >(undefined);
  const [observationReviewUi, setObservationReviewUi] = useState<ObservationReviewUiState>({
    status: 'idle',
  });
  const presenceState = useSyncExternalStore(
    agentPresenceStore?.subscribe ?? NOOP_SUBSCRIBE,
    agentPresenceStore?.getState ?? NOOP_PRESENCE_SNAPSHOT,
    NOOP_PRESENCE_SNAPSHOT,
  );
  const previewBundle = useSyncExternalStore(
    agentPreviewStore?.subscribe ?? NOOP_SUBSCRIBE,
    agentPreviewStore?.getBundle ?? NOOP_PREVIEW_BUNDLE,
    NOOP_PREVIEW_BUNDLE,
  );
  const runLifecycle = useSyncExternalStore(
    runController.subscribe,
    runController.getSnapshot,
    runController.getSnapshot,
  );

  const discardObservationReview = useCallback((): void => {
    observationReviewRegistrationRef.current += 1;
    observationReviewControllerRef.current?.dispose();
    observationReviewControllerRef.current = undefined;
    observationReviewLeaseRef.current = undefined;
    setObservationReviewDisplay(undefined);
    setObservationReviewUi({ status: 'idle' });
  }, []);

  const currentObservationReviewAuthority = useCallback(():
    ObservationTransferAuthority | undefined => {
    const review = observationReviewLeaseRef.current;
    const status = joyAgentEngineClient?.getStatus();
    const liveSession = latestSessionRef.current;
    if (
      review === undefined ||
      review.expiresAtMs <= Date.now() ||
      status === undefined ||
      status.modelId !== review.candidate.authority.modelId ||
      liveSession.visualProject.id !== review.candidate.authority.projectId ||
      liveSession.projectRevisionId !== review.candidate.authority.revision ||
      digestJoyAgentPolicy(latestSettingsRef.current) !==
        review.candidate.authority.promptPolicyDigest
    )
      return undefined;
    return review.candidate.authority;
  }, [joyAgentEngineClient]);

  const registerObservationReviewCandidate = useCallback(
    async (bridge: JoyAgentObservationHostBridge, observationId: string): Promise<void> => {
      const client = joyAgentEngineClient;
      if (client === undefined) return;
      const candidate = bridge.createReviewCandidate(observationId);
      const status = client.getStatus();
      if (
        candidate === undefined ||
        status === undefined ||
        status.modelId !== candidate.authority.modelId ||
        latestSessionRef.current.visualProject.id !== candidate.authority.projectId ||
        latestSessionRef.current.projectRevisionId !== candidate.authority.revision ||
        digestJoyAgentPolicy(latestSettingsRef.current) !== candidate.authority.promptPolicyDigest
      )
        return;
      const registration = ++observationReviewRegistrationRef.current;
      const expiresAtMs = Date.now() + OBSERVATION_REVIEW_TTL_MS;
      const lease = await client.registerObservationReviewLease({
        authority: candidate.authority,
        manifestId: candidate.manifest.manifestId,
        range: candidate.range,
        evidenceIds: candidate.evidenceIds,
        expiresAtMs,
      });
      if (
        lease === undefined ||
        registration !== observationReviewRegistrationRef.current ||
        lease.expiresAtMs < expiresAtMs ||
        latestSessionRef.current.visualProject.id !== candidate.authority.projectId ||
        latestSessionRef.current.projectRevisionId !== candidate.authority.revision ||
        client.getStatus()?.modelId !== candidate.authority.modelId ||
        digestJoyAgentPolicy(latestSettingsRef.current) !== candidate.authority.promptPolicyDigest
      )
        return;
      observationReviewControllerRef.current?.dispose();
      observationReviewControllerRef.current = undefined;
      observationReviewLeaseRef.current = Object.freeze({
        bridge,
        candidate,
        leaseId: lease.leaseId,
        expiresAtMs: lease.expiresAtMs,
      });
      setObservationReviewDisplay(
        Object.freeze({
          evidenceCount: candidate.evidenceIds.length,
          range: candidate.range,
          modelId: candidate.authority.modelId,
        }),
      );
      setObservationReviewUi({ status: 'idle' });
    },
    [joyAgentEngineClient],
  );

  const prepareObservationReview = useCallback((): void => {
    const client = joyAgentEngineClient;
    const review = observationReviewLeaseRef.current;
    const media = client?.getMediaCapabilities();
    const status = client?.getStatus();
    if (
      client === undefined ||
      review === undefined ||
      media?.modelId !== review.candidate.authority.modelId ||
      media.image !== 'supported' ||
      !media.modalities.includes('image') ||
      status === undefined
    ) {
      setObservationReviewUi({
        status: 'failed',
        message: 'Test image capability in JOY Agent Settings before reviewing local images.',
      });
      return;
    }
    observationReviewControllerRef.current?.dispose();
    const candidate = review.candidate;
    const controller = createObservationReviewController({
      bridge: review.bridge,
      currentAuthority: currentObservationReviewAuthority,
      createHostTransfer: ({ evidenceResolver, currentAuthority }) =>
        createWorkerObservationReviewTransfer({
          engineClient: client,
          evidenceResolver,
          currentAuthority,
          lease: () => {
            const current = observationReviewLeaseRef.current;
            return current !== undefined && current.candidate === candidate
              ? Object.freeze({ leaseId: current.leaseId, expiresAtMs: current.expiresAtMs })
              : undefined;
          },
          markReviewed: (authority, manifest, evidenceIds) => {
            const current = observationReviewLeaseRef.current;
            if (
              current === undefined ||
              current.candidate !== candidate ||
              !sameObservationTransferAuthority(current.candidate.authority, authority) ||
              current.candidate.manifest.manifestId !== manifest.manifestId ||
              current.candidate.evidenceIds.length !== evidenceIds.length ||
              !current.candidate.evidenceIds.every((id, index) => id === evidenceIds[index])
            )
              return false;
            return current.bridge.markReviewedEvidence({
              authority,
              manifest,
              range: current.candidate.range,
              evidenceIds,
            });
          },
        }),
    });
    observationReviewControllerRef.current = controller;
    controller.subscribe((next) => setObservationReviewUi(reviewUiState(next)));
    const providerCapability =
      status.capability === 'tool-loop'
        ? ({ state: 'structured-tools', diagnostic: 'structured-tool-proven' } as const)
        : status.capability === 'plan-only'
          ? ({ state: 'plan-only', diagnostic: 'plan-only-proven' } as const)
          : ({ state: 'unavailable', diagnostic: 'provider-probe-missing' } as const);
    setObservationReviewUi(
      reviewUiState(
        controller.prepareReview({
          authority: candidate.authority,
          manifest: candidate.manifest,
          range: candidate.range,
          evidenceIds: candidate.evidenceIds,
          modalities: ['image'],
          prompt: OBSERVATION_REVIEW_PROMPT,
          providerCapability,
          mediaCapability: { modelId: candidate.authority.modelId, modalities: ['image'] },
        }),
      ),
    );
  }, [currentObservationReviewAuthority, joyAgentEngineClient]);

  const approveObservationReview = useCallback((): void => {
    const controller = observationReviewControllerRef.current;
    const review = observationReviewLeaseRef.current;
    if (controller === undefined || review === undefined) return;
    const expiresAtMs = Math.min(review.expiresAtMs, Date.now() + OBSERVATION_REVIEW_TTL_MS);
    void controller.grantUserApprovedReview({
      maxRequests: 1,
      maxBytes: OBSERVATION_REVIEW_MAX_BYTES,
      expiresAtMs,
    });
  }, []);

  const acceptRunLifecycle = useCallback(
    (
      run: JoyAgentRunIterator['run'],
      state: JoyAgentActiveRunState,
      options: {
        readonly at?: string;
        readonly seq?: number;
        readonly display?: string;
        readonly errorCode?: JoyAgentRunErrorCode;
        readonly changeSetVersion?: number;
        readonly artifacts?: readonly JoyAgentRunArtifactReference[];
      } = {},
    ): JoyAgentRunEventAcceptance | undefined => {
      const current = runController.getSnapshot().run;
      if (
        current === undefined ||
        current.scope.runId !== run.runId ||
        current.scope.epoch !== run.epoch
      )
        return undefined;
      return runController.accept({
        version: JOY_AGENT_RUN_EVENT_VERSION,
        scope: {
          // The editor's durable project key can differ from the timeline
          // document's ID. The App-owned controller is the scope authority.
          projectId: current.scope.projectId,
          runId: run.runId,
          epoch: run.epoch,
          seq: options.seq ?? current.scope.seq + 1,
        },
        state,
        at: options.at ?? new Date().toISOString(),
        ...(options.display === undefined ? {} : { display: options.display }),
        ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
        ...(options.changeSetVersion === undefined
          ? {}
          : { changeSetVersion: options.changeSetVersion }),
        ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
      });
    },
    [runController],
  );

  const revokeActiveComposerHostLease = useCallback((runId?: string): void => {
    const lease = activeComposerHostLeaseRef.current;
    if (lease === undefined || (runId !== undefined && lease.run.runId !== runId)) return;
    revokeJoyAgentComposerHostLease(lease);
    activeComposerHostLeaseRef.current = undefined;
  }, []);

  const beginRunLifecycle = useCallback(
    (run: JoyAgentRunIterator['run']): void => {
      runController.start({
        runId: run.runId,
        epoch: run.epoch,
        at: new Date().toISOString(),
        state: 'inspecting',
        display: 'JOY is inspecting the project.',
      });
    },
    [runController],
  );

  const cancelRunLifecycle = useCallback(
    (runId: string, display = 'JOY run cancelled.'): void => {
      const current = runController.getSnapshot().run;
      if (current === undefined || current.scope.runId !== runId) return;
      revokeActiveComposerHostLease(runId);
      runController.requestCancel(new Date().toISOString(), display);
      const pending = runController.getSnapshot().run;
      if (pending === undefined || pending.scope.runId !== runId) return;
      acceptRunLifecycle({ runId: pending.scope.runId, epoch: pending.scope.epoch }, 'cancelled', {
        display,
      });
    },
    [acceptRunLifecycle, revokeActiveComposerHostLease, runController],
  );

  /**
   * Preview bundles are keyed by the prepared, epoch-qualified plan ID. Never
   * pass a bare Worker run ID to the store: it would leave the matching staged
   * overlay behind after cancellation while still protecting a newer run.
   */
  const clearAgentPreviewForSourceRun = useCallback(
    (sourceRunId?: string): void => {
      const bundle = agentPreviewStore?.getBundle();
      if (bundle === undefined) return;
      if (sourceRunId === undefined || sourceRunIdForPreparedPlan(bundle.runId) === sourceRunId)
        agentPreviewStore?.clear(bundle.runId);
    },
    [agentPreviewStore],
  );

  useEffect(() => {
    const deferred = deferredPreviewApprovalRef.current;
    if (deferred === undefined) return;
    const expectedBundleRunId = `${deferred.run.runId}.epoch-${deferred.run.epoch}`;
    const current = runController.getSnapshot().run;
    if (
      current === undefined ||
      current.scope.runId !== deferred.run.runId ||
      current.scope.epoch !== deferred.run.epoch ||
      activeModelRunIdRef.current !== deferred.run.runId
    ) {
      deferredPreviewApprovalRef.current = undefined;
      return;
    }
    if (previewBundle?.runId !== expectedBundleRunId || !isAgentPreviewBundleReady(previewBundle))
      return;

    // The Worker already created the prepared change, but its review state is
    // not truthfully ready until every mapped editor surface has acknowledged
    // the one immutable preview bundle it actually rendered.
    if (current.state === 'preparing') {
      runController.accept({
        version: JOY_AGENT_RUN_EVENT_VERSION,
        scope: {
          projectId: current.scope.projectId,
          runId: current.scope.runId,
          epoch: current.scope.epoch,
          seq: current.scope.seq + 1,
        },
        state: 'preview-ready',
        at: new Date().toISOString(),
        display: 'JOY preview rendered and ready for review.',
      });
    }
    const ready = runController.getSnapshot().run;
    if (
      ready !== undefined &&
      ready.scope.runId === deferred.run.runId &&
      ready.scope.epoch === deferred.run.epoch &&
      ready.state === 'preview-ready'
    ) {
      runController.accept({
        version: JOY_AGENT_RUN_EVENT_VERSION,
        scope: {
          projectId: ready.scope.projectId,
          runId: ready.scope.runId,
          epoch: ready.scope.epoch,
          seq: ready.scope.seq + 1,
        },
        state: 'awaiting-approval',
        at: new Date().toISOString(),
        display: deferred.display,
      });
      agentPresenceStore?.dispatch(deferred.presence);
      setAgentPhase('awaiting-approval');
    }
    deferredPreviewApprovalRef.current = undefined;
  }, [agentPresenceStore, previewBundle, runController]);

  useEffect(() => {
    setCreativeBriefContext(undefined);
    setComposerCapability('edit');
  }, [project.id]);

  useEffect(() => {
    // A Dockview relocation may unmount this view while the App-owned Worker
    // and run controller remain alive. Revoke only this React closure's host
    // lease: the old host cannot inspect media or prepare a write after the
    // panel leaves, while the controller remains the durable lifecycle record.
    return () => {
      revokeActiveComposerHostLease();
      deferredPreviewApprovalRef.current = undefined;
      observationReviewRegistrationRef.current += 1;
      observationReviewControllerRef.current?.dispose();
      observationReviewControllerRef.current = undefined;
      observationReviewLeaseRef.current = undefined;
      preparedChangesRef.current.clear();
    };
  }, [revokeActiveComposerHostLease]);

  useEffect(() => {
    const previous = sessionScopeRef.current;
    const scopeChanged =
      previous.projectId !== project.id ||
      previous.session !== session ||
      previous.revision !== session.projectRevisionId;
    if (!scopeChanged) return;

    // A genuine editor project/session transition is not a panel relocation.
    // Terminate only the exact lease this panel minted; a stale cleanup can
    // never interrupt a later App-owned run.
    const runId = activeModelRunIdRef.current;
    const lease = activeComposerHostLeaseRef.current;
    const ownsCurrentRun =
      lease !== undefined &&
      isJoyAgentComposerHostLeaseCurrent(lease) &&
      (runId === undefined || lease.run.runId === runId);
    const current = runController.getSnapshot().run;
    // If Dockview remounted before a genuine project transition, this panel
    // may no longer own the old closure's lease. The controller is still the
    // project authority, so cancel its one nonterminal run rather than leave a
    // detached Worker alive against a changed revision.
    const runIdToCancel =
      ownsCurrentRun && lease !== undefined
        ? lease.run.runId
        : current !== undefined && !isTerminalJoyAgentRunState(current.state)
          ? current.scope.runId
          : undefined;
    const interruptedByExactLease =
      ownsCurrentRun && lease !== undefined
        ? interruptJoyAgentComposerHostLease(
            lease,
            new Date().toISOString(),
            'JOY run interrupted because the editor project changed. Reconnect before continuing.',
          )
        : false;
    if (lease !== undefined) revokeActiveComposerHostLease(lease.run.runId);
    if (runIdToCancel !== undefined) {
      if (
        !interruptedByExactLease &&
        current !== undefined &&
        current.scope.runId === runIdToCancel &&
        !isTerminalJoyAgentRunState(current.state)
      )
        runController.interrupt(
          new Date().toISOString(),
          'JOY run interrupted because the editor project changed. Reconnect before continuing.',
        );
      void joyAgentEngineClient?.cancel(runIdToCancel);
    }
    activeModelRunIdRef.current = undefined;
    discardObservationReview();
    deferredPreviewApprovalRef.current = undefined;
    modelChangeSetIdRef.current = undefined;
    preparedChanges.clear();
    agentPreviewStore?.clear();
    setModelChangeSetId(undefined);
    agentPresenceStore?.clear();
    sessionScopeRef.current = {
      projectId: project.id,
      session,
      revision: session.projectRevisionId,
    };
  }, [
    agentPresenceStore,
    agentPreviewStore,
    discardObservationReview,
    joyAgentEngineClient,
    preparedChanges,
    project.id,
    revokeActiveComposerHostLease,
    runController,
    session,
    session.projectRevisionId,
  ]);

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
    const changeSetId = modelChangeSetIdRef.current;
    const prepared = changeSetId === undefined ? undefined : preparedChanges.getView(changeSetId);
    if (
      changeSetId !== undefined &&
      prepared !== undefined &&
      (prepared.projectId !== session.timelineProject.id ||
        prepared.sessionEpoch !== preparedSessionEpoch ||
        prepared.baseRevision !== session.projectRevisionId)
    ) {
      // `run-finished` intentionally retains this host endpoint while the
      // owner can approve its preview. A human revision invalidates that
      // authority, so close the retained endpoint before revoking the card.
      const invalidatedRunId = sourceRunIdForPreparedPlan(prepared.planId);
      cancelRunLifecycle(invalidatedRunId, 'JOY preview expired because the project changed.');
      void joyAgentEngineClient?.cancel(invalidatedRunId);
      if (activeModelRunIdRef.current === invalidatedRunId) activeModelRunIdRef.current = undefined;
      preparedChanges.revoke(changeSetId);
      modelChangeSetIdRef.current = undefined;
      setModelChangeSetId(undefined);
      agentPreviewStore?.clear(prepared.planId);
      proposalTargetsRef.current.delete(prepared.planId);
    }
  }, [
    agentPreviewStore,
    cancelRunLifecycle,
    joyAgentEngineClient,
    preparedChanges,
    preparedSessionEpoch,
    session.projectRevisionId,
    session.timelineProject.id,
  ]);

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
  const modelView =
    modelChangeSetId === undefined ? undefined : preparedChanges.getView(modelChangeSetId);
  const modelPreviewReady =
    modelView !== undefined &&
    (agentPreviewStore === undefined ||
      (previewBundle?.runId === modelView.planId && isAgentPreviewBundleReady(previewBundle)));
  const modelAwaitingApproval =
    modelPreviewReady &&
    modelView !== undefined &&
    runLifecycle.run?.scope.runId === sourceRunIdForPreparedPlan(modelView.planId) &&
    runLifecycle.run.state === 'awaiting-approval';

  function currentPreparedAuthority(hostRunId: string): PreparedChangeAuthority {
    return {
      projectId: session.timelineProject.id,
      hostRunId,
      sessionIdentity: session,
      sessionEpoch: preparedSessionEpoch,
      revision: session.projectRevisionId,
      policy: latestSettingsRef.current,
    };
  }

  function setPreparedModelChange(changeSetId: string | undefined): void {
    modelChangeSetIdRef.current = changeSetId;
    setModelChangeSetId(changeSetId);
  }

  const discardPreparedModelChange = useCallback(
    (runId?: string): void => {
      const changeSetId = modelChangeSetIdRef.current;
      if (changeSetId === undefined) return;
      const prepared = preparedChanges.getView(changeSetId);
      // An old async closure must never erase a newer session's change card.
      if (
        prepared === undefined ||
        (runId !== undefined && sourceRunIdForPreparedPlan(prepared.planId) !== runId)
      )
        return;
      preparedChanges.revoke(changeSetId);
      modelChangeSetIdRef.current = undefined;
      setModelChangeSetId(undefined);
      agentPreviewStore?.clear(prepared.planId);
      proposalTargetsRef.current.delete(prepared.planId);
    },
    [agentPreviewStore, preparedChanges],
  );

  const creativeSkills = useMemo(() => listCreativeSkills(), []);
  const lookCatalog = useMemo(
    () =>
      buildLookCatalog(BUILT_IN_LOOK_PACKS, {
        availableFonts: CONTENT_FONT_FAMILIES as readonly string[],
      }),
    [],
  );
  const lookEntities = useMemo<readonly LivingLooksEntityOption[]>(() => {
    const visual = Object.values(session.visualProject.visualObjects ?? {}).map((object) => ({
      id: object.id,
      label: `${object.id}${object.kind === 'text' && typeof object.text === 'string' ? ` — ${object.text.slice(0, 24)}` : ''}`,
      kind: 'visual-object' as const,
    }));
    const captions: LivingLooksEntityOption[] = [];
    for (const composition of Object.values(session.visualProject.compositions)) {
      for (const track of composition.tracks) {
        if (track.kind !== 'caption') continue;
        for (const clip of track.clips) {
          captions.push({ id: clip.id, label: `${clip.id} (caption)`, kind: 'caption-clip' });
        }
      }
    }
    return [...visual, ...captions];
  }, [session.visualProject]);
  const currentTextByObjectId = useMemo<Readonly<Record<string, string>>>(() => {
    const map: Record<string, string> = {};
    for (const object of Object.values(session.visualProject.visualObjects ?? {})) {
      if (object.kind === 'text' && typeof object.text === 'string') map[object.id] = object.text;
    }
    return map;
  }, [session.visualProject]);
  const appliedLooks = useMemo<readonly LivingLooksAppliedView[]>(() => {
    const orphaned = new Set(session.orphanedLookInstanceIds);
    return Object.values(session.lookInstances.instances)
      .filter((instance) => instance.compositionId === session.visualProject.rootCompositionId)
      .map((instance) => ({
        instanceId: instance.id,
        definitionId: instance.definitionId,
        title:
          BUILT_IN_LOOK_PACKS.find((pack) => pack.id === instance.definitionId)?.title ??
          instance.definitionId,
        controlValues: instance.controlValues,
        overriddenBindingIds: instance.overriddenBindingIds,
        orphaned: orphaned.has(instance.id),
      }));
  }, [
    session.lookInstances,
    session.orphanedLookInstanceIds,
    session.visualProject.rootCompositionId,
  ]);
  const isRecipeAuthorityCurrent = useCallback(
    (scope: CreativeSkillRunScope): boolean =>
      scope.runId === recipeRunScopeRef.current?.runId &&
      scope.projectId === project.id &&
      scope.revision === latestSessionRef.current.projectRevisionId &&
      (activeModelRunIdRef.current === undefined || activeModelRunIdRef.current === scope.runId),
    [project.id],
  );
  const creativeSkillDeps: CreativeSkillEditorPrimitiveDeps | undefined = useMemo(() => {
    if (joyAgentEngineClient === undefined) return undefined;
    return createCreativeSkillEditorPrimitiveDeps({
      client: joyAgentEngineClient,
      getSession: () => latestSessionRef.current,
      latestSessionRef,
      preparedChanges,
      agentPreviewStore,
      proposalTargetsRef,
      buildContextInput: () =>
        buildJoyAgentContextInput({
          session: latestSessionRef.current,
          selectedClipIds,
          playheadUs,
          conversationMessages: conversation.messages.slice(-8).map((message) => ({
            role: message.role,
            body: message.body,
          })),
        }),
      currentPreparedAuthority,
      isAuthorityCurrent: isRecipeAuthorityCurrent,
      ...(observationAdapterFactory === undefined ? {} : { observationAdapterFactory }),
      getModelId: () => joyAgentEngineClient.getStatus()?.modelId,
      getPromptPolicyDigest: () => digestJoyAgentPolicy(latestSettingsRef.current),
      onStaged: (scope, changeSetId) => {
        if (recipeRunScopeRef.current?.runId === scope.runId)
          recipeStagedChangeSetRef.current = changeSetId;
      },
    });
    // currentPreparedAuthority closes over live session; the recipe deps read it
    // through the accessors above, so it is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    joyAgentEngineClient,
    preparedChanges,
    agentPreviewStore,
    observationAdapterFactory,
    isRecipeAuthorityCurrent,
    selectedClipIds,
    playheadUs,
    conversation.messages,
  ]);

  useEffect(() => {
    // Do not save the prior project's conversation under a newly selected
    // project key during React's state-transition render. The next render
    // persists only the replacement conversation owned by this project.
    if (conversationProjectIdRef.current !== project.id) {
      conversationProjectIdRef.current = project.id;
      setConversation(initialJoyCodeConversation(storage, project.id));
      return;
    }
    try {
      saveJoyCodeConversation(storage, project.id, conversation);
    } catch {
      // Conversation persistence is optional; never block editing when storage is unavailable.
    }
  }, [conversation, project.id, storage]);

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
    if (command.type === 'stop') {
      if (commandRunId !== undefined) {
        cancelRunLifecycle(commandRunId);
        if (joyAgentEngineClient !== undefined) void joyAgentEngineClient.cancel(commandRunId);
      }
      activeModelRunIdRef.current = undefined;
      discardPreparedModelChange(commandRunId);
      agentPresenceStore?.clear();
      clearAgentPreviewForSourceRun(commandRunId);
      setAgentPhase('cancelled');
    }
    setPending(undefined);
  }, [
    agentPresenceStore,
    agentPreviewStore,
    agentRunId,
    cancelRunLifecycle,
    clearAgentPreviewForSourceRun,
    command,
    discardPreparedModelChange,
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
    if (modelView !== undefined) {
      appendMessage(
        threadId,
        'assistant',
        'Review, apply, or reject the current JOY preview before starting a new edit.',
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
      const entityReferenceSource = {
        timeline: session.timelineProject,
        visual: session.visualProject,
      };
      const storedEntityReferences = conversation.recentEntityReferences ?? [];
      // A generic request can naturally contain “it” (for example, “start an
      // edit, then stop it”). Treat pronouns as a constrained follow-up only
      // when this project has an actual durable entity reference to resolve.
      const isReferenceFollowUp =
        storedEntityReferences.length > 0 && CONVERSATION_REFERENCE_WORD.test(body);
      const referenceCandidates = CONVERSATION_TITLE_WORD.test(body)
        ? storedEntityReferences.filter((reference) => reference.entityKind === 'visual-text')
        : storedEntityReferences;
      let selectedEntityReference: JoyAgentConversationEntityReference | undefined;
      if (isReferenceFollowUp) {
        if (referenceCandidates.length !== 1) {
          appendMessage(threadId, 'assistant', CONVERSATION_REFERENCE_AMBIGUOUS_MESSAGE);
          return;
        }
        const resolved = resolveJoyAgentConversationEntityReference(
          referenceCandidates[0],
          entityReferenceSource,
        );
        if (resolved.kind === 'clarification') {
          appendMessage(threadId, 'assistant', resolved.clarification.message);
          return;
        }
        selectedEntityReference = resolved.reference;
      }
      // The reference is re-resolved at the last possible host boundary. A
      // deleted or cross-project record is never passed to the model, and a
      // pronoun-style follow-up above must name exactly one surviving target.
      const currentEntityReferences = storedEntityReferences.flatMap((reference) => {
        const resolved = resolveJoyAgentConversationEntityReference(
          reference,
          entityReferenceSource,
        );
        return resolved.kind === 'resolved' ? [resolved.reference] : [];
      });
      const contextualEntityReferences =
        selectedEntityReference === undefined ? currentEntityReferences : [selectedEntityReference];
      const runId = makeJoyCodeId('run');
      const taskKind = inferJoyAgentTaskKind(body);
      const taskTarget = targetForJoyAgentTask(taskKind);
      // A prepared preview intentionally keeps its host RPC queue alive until
      // the owner approves or rejects it. A new prompt supersedes that
      // authority, so close the prior queue before changing the active token.
      const supersededRunId = activeModelRunIdRef.current;
      if (supersededRunId !== undefined) {
        cancelRunLifecycle(supersededRunId, 'Superseded by a new JOY request.');
        void joyAgentEngineClient.cancel(supersededRunId);
      }
      discardObservationReview();
      discardPreparedModelChange();
      activeModelRunIdRef.current = runId;
      setAgentRunId(runId);
      proposalTargetsRef.current.delete(runId);
      agentPreviewStore?.clear();
      agentPresenceStore?.beginRun(runId, session.historyCursorSequence);
      setThinkingThreadId(threadId);
      setAgentPhase('connecting');
      void (async () => {
        let revokeStagedChange = (): void => {};
        let lifecycleRun: JoyAgentRunIterator['run'] | undefined;
        let activeObservationRun: JoyAgentRunIterator['run'] | undefined;
        let activeComposerHostLease: JoyAgentComposerHostLease | undefined;
        try {
          const baseRevision = session.projectRevisionId;
          const contextInput: JoyAgentContextSnapshotInput = buildJoyAgentContextInput({
            session,
            selectedClipIds,
            playheadUs,
            conversationMessages: conversation.messages.slice(-8).map((message) => ({
              role: message.role,
              body: message.body,
            })),
            recentEntityReferences: contextualEntityReferences,
            ...(selectedEntityReference === undefined ? {} : { selectedEntityReference }),
            ...(creativeBriefContext === undefined ? {} : { creativeBrief: creativeBriefContext }),
          });
          const mode =
            taskKind === 'creative-brief' ||
            joyAgentEngineClient.getStatus()?.capability === 'plan-only'
              ? ('plan-only' as const)
              : ('tool-loop' as const);
          const structured = mode === 'tool-loop' && taskKind !== 'creative-brief';
          const capturedModelId = joyAgentEngineClient.getStatus()?.modelId;
          const capturedPolicyDigest = digestJoyAgentPolicy(latestSettingsRef.current);
          let observationBridge: JoyAgentObservationHostBridge | undefined;
          if (
            structured &&
            capturedModelId !== undefined &&
            capturedModelId.trim().length > 0 &&
            observationAdapterFactory !== undefined
          ) {
            try {
              observationBridge = observationAdapterFactory.create({
                projectId: contextInput.projectId,
                revision: baseRevision,
                currentAuthority: () => {
                  const liveSession = latestSessionRef.current;
                  const liveRun = runController.getSnapshot().run;
                  const lifecycleMatches =
                    activeObservationRun !== undefined &&
                    activeComposerHostLease !== undefined &&
                    isJoyAgentComposerHostLeaseCurrent(activeComposerHostLease) &&
                    liveRun !== undefined &&
                    liveRun.scope.projectId === contextInput.projectId &&
                    liveRun.scope.runId === activeObservationRun.runId &&
                    liveRun.scope.epoch === activeObservationRun.epoch &&
                    !isTerminalJoyAgentRunState(liveRun.state);
                  const retainedReview = observationReviewLeaseRef.current;
                  const retainedReviewMatches =
                    retainedReview !== undefined &&
                    retainedReview.expiresAtMs > Date.now() &&
                    retainedReview.candidate.authority.projectId === contextInput.projectId &&
                    retainedReview.candidate.authority.revision === baseRevision &&
                    retainedReview.candidate.authority.modelId === capturedModelId &&
                    retainedReview.candidate.authority.promptPolicyDigest ===
                      capturedPolicyDigest &&
                    liveSession.visualProject.id === contextInput.projectId &&
                    liveSession.projectRevisionId === baseRevision &&
                    (joyAgentEngineClient.getStatus()?.modelId ?? '') === capturedModelId &&
                    digestJoyAgentPolicy(latestSettingsRef.current) === capturedPolicyDigest;
                  if (retainedReviewMatches) return retainedReview.candidate.authority;
                  const observedRun = lifecycleMatches ? activeObservationRun : undefined;
                  return resolveJoyAgentObservationAuthority(
                    {
                      projectId: contextInput.projectId,
                      revision: baseRevision,
                      modelId: capturedModelId,
                      promptPolicyDigest: capturedPolicyDigest,
                    },
                    {
                      projectId: liveSession.visualProject.id,
                      revision: liveSession.projectRevisionId,
                      modelId: joyAgentEngineClient.getStatus()?.modelId ?? '',
                      promptPolicyDigest: digestJoyAgentPolicy(latestSettingsRef.current),
                      run: observedRun,
                      terminal: observedRun === undefined || activeModelRunIdRef.current !== runId,
                    },
                  );
                },
              });
            } catch {
              // Observation is an optional, locally bounded enhancement. A
              // browser that cannot construct its isolated decoder keeps the
              // safe legacy catalog instead of falling back to a URL/path.
              observationBridge = undefined;
            }
          }
          let stagedChangeSetId: string | undefined;
          revokeStagedChange = (): void => {
            if (stagedChangeSetId === undefined) return;
            const staged = preparedChanges.getView(stagedChangeSetId);
            preparedChanges.revoke(stagedChangeSetId);
            if (staged !== undefined) {
              agentPreviewStore?.clear(staged.planId);
              proposalTargetsRef.current.delete(staged.planId);
            }
            if (modelChangeSetIdRef.current === stagedChangeSetId)
              setPreparedModelChange(undefined);
            stagedChangeSetId = undefined;
          };
          const terminalizeConnectionReset = (): void => {
            // This callback is fired by the main-thread client when it tears
            // down a run before the Worker can deliver a terminal event (for
            // example after Clear connection or provider reconfiguration).
            // Keep it scoped to this exact run so an old Worker cannot erase
            // a newer preview or lifecycle record.
            revokeStagedChange();
            revokeActiveComposerHostLease(runId);
            if (activeModelRunIdRef.current !== runId) return;

            const current = runController.getSnapshot().run;
            const receiptExists = current?.artifacts.some(
              (artifact) => artifact.kind === 'execution-receipt',
            );
            const display = receiptExists
              ? 'JOY’s connection changed while verification was pending. Reconnect before continuing.'
              : 'JOY run was cancelled because its model connection changed. No staged edit was applied.';
            if (
              current !== undefined &&
              current.scope.runId === runId &&
              !isTerminalJoyAgentRunState(current.state)
            ) {
              if (receiptExists) runController.interrupt(new Date().toISOString(), display);
              else cancelRunLifecycle(runId, display);
            }

            deferredPreviewApprovalRef.current = undefined;
            discardPreparedModelChange(runId);
            clearAgentPreviewForSourceRun(runId);
            proposalTargetsRef.current.delete(runId);
            activeModelRunIdRef.current = undefined;
            agentPresenceStore?.clear();
            setAgentPhase(receiptExists ? 'failed' : 'cancelled');
            appendMessage(threadId, 'assistant', display);
          };
          const host = !structured
            ? undefined
            : {
                methods: createJoyAgentHostRpcMethodsForSnapshot(
                  contextInput,
                  createJoyAgentProposalStagingHandler({
                    runId,
                    baseRevision,
                    contextProjectId: contextInput.projectId,
                    capturedSession: session,
                    latestSessionRef,
                    hasHostAuthority: (rpcRun) =>
                      activeComposerHostLease !== undefined &&
                      activeComposerHostLease.run.runId === rpcRun.runId &&
                      activeComposerHostLease.run.epoch === rpcRun.epoch &&
                      isJoyAgentComposerHostLeaseCurrent(activeComposerHostLease),
                    isRunCurrent: () => activeModelRunIdRef.current === runId,
                    selectedEntityReference,
                    preparedChanges,
                    currentPreparedAuthority,
                    agentPreviewStore,
                    proposalTargetsRef,
                    onStaged: (changeSetId) => {
                      stagedChangeSetId = changeSetId;
                    },
                  }),
                  observationBridge?.tools,
                  observationBridge === undefined
                    ? undefined
                    : async (result) => {
                        await registerObservationReviewCandidate(
                          observationBridge!,
                          result.observationId,
                        );
                      },
                ),
                allowedToolNames:
                  observationBridge === undefined
                    ? LEGACY_JOY_AGENT_TOOL_NAMES
                    : JOY_AGENT_HOST_TOOL_NAMES,
                onCancelled: revokeStagedChange,
              };
          const contextSnapshot = structured
            ? undefined
            : createJoyAgentContextSnapshot(contextInput);
          const runIterator = joyAgentEngineClient.startRun(
            {
              runId,
              taskKind,
              prompt: body,
              baseRevision,
              mode,
              ...(contextSnapshot === undefined ? {} : { context: contextSnapshot }),
            },
            host,
            { onConnectionCleared: terminalizeConnectionReset },
          );
          lifecycleRun = runIterator.run;
          activeObservationRun = runIterator.run;
          try {
            beginRunLifecycle(runIterator.run);
            activeComposerHostLease = createJoyAgentComposerHostLease(
              runController,
              runIterator.run,
            );
            activeComposerHostLeaseRef.current = activeComposerHostLease;
          } catch (error) {
            void joyAgentEngineClient.cancel(runId);
            throw error;
          }
          for await (const event of runIterator) {
            // Cancellation, a project switch, or a subsequent prompt revokes
            // this run synchronously. Late worker events are display-only at
            // best and must not create a new prepared change or clear a newer
            // preview.
            if (activeModelRunIdRef.current !== runId) continue;
            const terminal =
              event.phase === 'completed' ||
              event.phase === 'failed' ||
              event.phase === 'cancelled';
            let preparedProposalTargets: readonly JoyAgentTarget[] | undefined;
            let preparedChangeArtifact: JoyAgentRunArtifactReference | undefined;
            if (event.proposal !== undefined) {
              const prepared = preparedChanges.getView(event.proposal.changeSetId);
              const expectedHostRunId = `${runId}.epoch-${event.runEpoch}`;
              if (
                prepared === undefined ||
                prepared.hostRunId !== expectedHostRunId ||
                prepared.baseRevision !== event.proposal.baseRevision ||
                prepared.operationDigest !== event.proposal.operationDigest ||
                prepared.bindingDigest !== event.proposal.bindingDigest ||
                prepared.baseRevision !== session.projectRevisionId ||
                preparedChanges.getPreviewDraft(event.proposal.changeSetId) === undefined
              ) {
                revokeStagedChange();
                throw new Error('JOY preview authority was invalidated. Request a new edit.');
              }
              stagedChangeSetId = prepared.changeSetId;
              preparedChangeArtifact = {
                kind: 'prepared-change',
                id: prepared.changeSetId,
                version: event.seq,
              };
              preparedProposalTargets = proposalTargetsRef.current.get(prepared.planId);
              setPreparedModelChange(prepared.changeSetId);
              appendMessage(
                threadId,
                'assistant',
                `${event.proposal.summary} (${event.proposal.operationCount} bounded operation${event.proposal.operationCount === 1 ? '' : 's'}) is ready for JOY validation.`,
              );
            }
            const proposalTargets = preparedProposalTargets;
            const lifecycleErrorCode = runErrorCodeForAgentError(event.errorCode);
            const expectedPreviewBundleRunId = `${runId}.epoch-${event.runEpoch}`;
            const stagedPreviewBundle = agentPreviewStore?.getBundle();
            const previewRenderRequired = agentPreviewStore !== undefined;
            if (
              event.phase === 'awaiting-approval' &&
              previewRenderRequired &&
              stagedPreviewBundle?.runId !== expectedPreviewBundleRunId
            ) {
              revokeStagedChange();
              throw new Error('JOY preview was not rendered. Request a new edit.');
            }
            const awaitingPreviewRender =
              event.phase === 'awaiting-approval' &&
              previewRenderRequired &&
              !isAgentPreviewBundleReady(stagedPreviewBundle);
            setAgentPhase(awaitingPreviewRender ? 'planning' : event.phase);
            if (event.phase === 'awaiting-approval') {
              if (awaitingPreviewRender) {
                // Preserve the Worker event sequence as lifecycle evidence but
                // do not falsely surface approval before a real renderer ack.
                acceptRunLifecycle(runIterator.run, 'preparing', {
                  at: event.at,
                  seq: event.seq,
                  display: 'JOY is rendering the staged preview.',
                });
              } else {
                acceptRunLifecycle(runIterator.run, 'preview-ready', {
                  at: event.at,
                  seq: event.seq,
                  display: 'JOY preview rendered and ready for review.',
                });
                acceptRunLifecycle(runIterator.run, 'awaiting-approval', {
                  at: event.at,
                  seq: event.seq + 1,
                  display: 'Review the live preview before applying.',
                });
              }
            } else {
              acceptRunLifecycle(runIterator.run, lifecycleStateForAgentPhase(event.phase), {
                at: event.at,
                seq: event.seq,
                ...(event.phase === 'previewing' && preparedChangeArtifact !== undefined
                  ? {
                      changeSetVersion: preparedChangeArtifact.version,
                      artifacts: [preparedChangeArtifact],
                    }
                  : {}),
                ...(lifecycleErrorCode === undefined ? {} : { errorCode: lifecycleErrorCode }),
              });
            }
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
                proposalTargets ??
                (event.phase === 'previewing' || event.phase === 'awaiting-approval'
                  ? [
                      { panelId: 'agent', sectionId: 'composer' },
                      taskTarget,
                      { panelId: 'timeline', sectionId: 'timeline' },
                    ]
                  : [{ panelId: 'agent', sectionId: 'composer' }, taskTarget]),
              ...(event.proposal === undefined
                ? {}
                : {
                    preview: {
                      revision: session.historyCursorSequence,
                      summaryCode: 'joy-agent-proposal',
                      targetCount: event.proposal.operationCount,
                    },
                  }),
            };
            if (event.phase === 'awaiting-approval') {
              if (awaitingPreviewRender) {
                deferredPreviewApprovalRef.current = {
                  run: runIterator.run,
                  threadId,
                  presence: presenceEvent,
                  display: 'Review the live preview before applying.',
                };
                appendMessage(
                  threadId,
                  'assistant',
                  'JOY staged the proposal and is rendering the live preview.',
                );
              } else {
                appendMessage(
                  threadId,
                  'assistant',
                  'JOY prepared a bounded proposal. Review the live preview before applying.',
                );
              }
            }
            // A preview presence event is emitted only after the canonical
            // compiler has accepted the proposal. This keeps the activity
            // rail truthful when provider validation succeeds but a local
            // adapter rejects the draft.
            if (!awaitingPreviewRender) agentPresenceStore?.dispatch(presenceEvent);
            if (event.phase === 'completed') {
              const resultText = boundedAgentResultText(event.result);
              appendMessage(
                threadId,
                'assistant',
                resultText ??
                  (event.proposal === undefined
                    ? 'The model response was received safely.'
                    : 'The model response was received. JOY keeps edits in preview until you approve them.'),
              );
            }
            if (event.phase === 'failed')
              appendMessage(
                threadId,
                'assistant',
                event.message ?? 'JOY could not complete this run. No edits were applied.',
              );
            if (event.phase === 'cancelled')
              appendMessage(threadId, 'assistant', 'JOY run cancelled. No edits were applied.');
            if (event.phase === 'failed' || event.phase === 'cancelled') {
              revokeActiveComposerHostLease(runId);
              deferredPreviewApprovalRef.current = undefined;
              revokeStagedChange();
              discardPreparedModelChange(runId);
              clearAgentPreviewForSourceRun(runId);
              proposalTargetsRef.current.delete(runId);
              activeModelRunIdRef.current = undefined;
            }
          }
        } catch (error) {
          if (activeModelRunIdRef.current !== runId) return;
          revokeActiveComposerHostLease(runId);
          revokeStagedChange();
          discardPreparedModelChange(runId);
          // A local consistency failure can happen after a prepared preview.
          // Do not retain its host RPC endpoint after its UI authority is gone.
          void joyAgentEngineClient.cancel(runId);
          if (lifecycleRun !== undefined)
            acceptRunLifecycle(lifecycleRun, 'failed', {
              display: 'JOY run failed safely.',
            });
          activeModelRunIdRef.current = undefined;
          agentPresenceStore?.dispatch({
            protocolVersion: 1,
            runId,
            seq: Math.max(0, (agentPresenceStore?.getState().seq ?? -1) + 1),
            at: new Date().toISOString(),
            revision: session.historyCursorSequence,
            kind: 'failed',
            phase: 'failed',
            targets: proposalTargetsRef.current.get(runId) ?? [
              { panelId: 'agent', sectionId: 'composer' },
            ],
          });
          appendMessage(
            threadId,
            'assistant',
            error instanceof Error ? error.message : 'JOY run failed safely.',
          );
          setAgentPhase('failed');
        } finally {
          if (activeComposerHostLease !== undefined) {
            revokeJoyAgentComposerHostLease(activeComposerHostLease);
            if (activeComposerHostLeaseRef.current === activeComposerHostLease)
              activeComposerHostLeaseRef.current = undefined;
          }
          activeObservationRun = undefined;
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
        'Connect a model in Agent Settings to run natural-language JOY edits. No unfenced fallback recipe route is available.',
      );
      return;
    }
    if (!legacyRecipeExecutionEnabled()) {
      // This legacy deterministic recipe runner commits through an older
      // timeline-only idempotency route. It remains deliberately unavailable
      // until it is migrated to the same prepared-change + receipt authority
      // as the production Worker path above.
      appendMessage(
        threadId,
        'assistant',
        'This local recipe is temporarily unavailable while JOY finishes its durable approval and receipt boundary. Connect a model to use the guarded JOY edit path.',
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
    clearAgentPreviewForSourceRun(pending.runId);
  }

  async function runRecipe(skillId: string): Promise<void> {
    if (
      recipeRunningId !== undefined ||
      thinkingThreadId !== undefined ||
      modelView !== undefined ||
      pending !== undefined ||
      creativeSkillDeps === undefined ||
      joyAgentEngineClient === undefined
    )
      return;
    const entry = creativeSkills.find((candidate) => candidate.skill.id === skillId);
    if (entry === undefined || !entry.available) return;
    const threadId = activeThread.id;
    const scope: CreativeSkillRunScope = {
      projectId: project.id,
      runId: makeJoyCodeId('recipe'),
      epoch: 1,
      revision: session.projectRevisionId,
    };
    recipeRunScopeRef.current = scope;
    recipeStagedChangeSetRef.current = undefined;
    activeModelRunIdRef.current = scope.runId;
    setRecipeRunningId(skillId);
    setAgentPhase('connecting');
    appendMessage(threadId, 'user', `Run recipe — ${entry.skill.title}`);
    const lifecycleRun = { runId: scope.runId, epoch: scope.epoch };
    try {
      beginRunLifecycle(lifecycleRun);
      const result = await runEditorCreativeSkill({
        skillId,
        scope,
        deps: creativeSkillDeps,
        isAuthorityCurrent: isRecipeAuthorityCurrent,
        onEvent: (checkpoint) => {
          if (recipeRunScopeRef.current?.runId !== scope.runId) return;
          if (checkpoint.state === 'started') setAgentPhase('planning');
        },
      });
      if (recipeRunScopeRef.current?.runId !== scope.runId) return;
      if (result.kind === 'unavailable') {
        appendMessage(
          threadId,
          'assistant',
          `“${result.skill.title}” is unavailable: missing ${[
            ...result.missingCapabilities,
            ...result.missingOperations,
          ].join(', ')}.`,
        );
        cancelRunLifecycle(scope.runId, 'Recipe unavailable.');
        setAgentPhase('cancelled');
        if (activeModelRunIdRef.current === scope.runId) activeModelRunIdRef.current = undefined;
        return;
      }
      if (result.kind === 'blocked') {
        appendMessage(
          threadId,
          'assistant',
          `“${result.skill.title}” was blocked (${result.reason}). No edit was applied.`,
        );
        cancelRunLifecycle(scope.runId, 'Recipe blocked.');
        setAgentPhase('failed');
        if (activeModelRunIdRef.current === scope.runId) activeModelRunIdRef.current = undefined;
        return;
      }
      const artifactLines = result.artifacts
        .map(
          (item) =>
            `• ${item.summary}${item.uncertainty === undefined ? '' : ` (uncertainty: ${item.uncertainty})`}`,
        )
        .join('\n');
      const staged = recipeStagedChangeSetRef.current;
      if (result.kind === 'ready-for-approval') {
        const prepared = staged === undefined ? undefined : preparedChanges.getView(staged);
        if (prepared === undefined) {
          appendMessage(
            threadId,
            'assistant',
            'The recipe prepared a change but its preview authority was lost. Try again.',
          );
          cancelRunLifecycle(scope.runId, 'Recipe preview authority lost.');
          setAgentPhase('failed');
          if (activeModelRunIdRef.current === scope.runId) activeModelRunIdRef.current = undefined;
          return;
        }
        // Walk the lifecycle through its legal states so the approval UI sees
        // `awaiting-approval` from a `preparing`/`preview-ready` origin.
        acceptRunLifecycle(lifecycleRun, 'preparing', { display: 'Recipe prepared a change.' });
        acceptRunLifecycle(lifecycleRun, 'preview-ready', {
          display: 'Recipe preview rendered and ready for review.',
        });
        acceptRunLifecycle(lifecycleRun, 'awaiting-approval', {
          display: 'Review the live preview before applying.',
        });
        setPreparedModelChange(prepared.changeSetId);
        setAgentPhase('awaiting-approval');
        appendMessage(
          threadId,
          'assistant',
          `“${result.skill.title}” prepared a reversible change. Review the live preview before applying.\n${artifactLines}`,
        );
        return;
      }
      appendMessage(threadId, 'assistant', `“${result.skill.title}” completed.\n${artifactLines}`);
      acceptRunLifecycle(lifecycleRun, 'completed', { display: 'Recipe completed.' });
      setAgentPhase('completed');
      if (activeModelRunIdRef.current === scope.runId) activeModelRunIdRef.current = undefined;
    } catch (error) {
      if (recipeRunScopeRef.current?.runId !== scope.runId) return;
      appendMessage(
        threadId,
        'assistant',
        error instanceof Error ? error.message : 'The recipe run failed safely.',
      );
      cancelRunLifecycle(scope.runId, 'Recipe run failed.');
      setAgentPhase('failed');
      if (activeModelRunIdRef.current === scope.runId) activeModelRunIdRef.current = undefined;
    } finally {
      setRecipeRunningId((current) => (current === skillId ? undefined : current));
    }
  }

  /** Detach drops the instance record and leaves the authored keyframes. It
   * touches one document, so it commits directly (one Undo) with no preview. */
  function detachLook(instanceId: string): void {
    const instance = session.lookInstances.instances[instanceId];
    if (instance === undefined) return;
    const definition = BUILT_IN_LOOK_PACKS.find((pack) => pack.id === instance.definitionId);
    session.dispatchCompound(`Detach Look — ${definition?.title ?? instance.definitionId}`, {
      lookInstances: detachLookInstance(session.lookInstances, instanceId),
    });
    appendMessage(
      activeThread.id,
      'assistant',
      `Detached “${definition?.title ?? instance.definitionId}”. Its styling stays as ordinary editable keyframes; one Undo restores the Look.`,
    );
  }

  async function runLook(request: LivingLooksRunInput): Promise<void> {
    if (request.kind === 'detach') {
      detachLook(request.instanceId);
      return;
    }
    if (
      lookRunningId !== undefined ||
      recipeRunningId !== undefined ||
      thinkingThreadId !== undefined ||
      modelView !== undefined ||
      pending !== undefined
    )
      return;

    const resolvedFonts = Object.fromEntries(
      (CONTENT_FONT_FAMILIES as readonly string[]).map((family) => [family, family]),
    );
    const rootComposition =
      session.visualProject.compositions[session.visualProject.rootCompositionId];
    const format: 'portrait' | 'landscape' =
      rootComposition !== undefined && rootComposition.height >= rootComposition.width
        ? 'portrait'
        : 'landscape';

    // Resolve the definition, the compile input, and the next Look Instances
    // document once, per request kind. apply = fresh instance; update / reset =
    // recompile a stored instance's pinned definition.
    let definition: LookDefinition | undefined;
    let instanceId: string;
    let lookCompileInput: Parameters<typeof buildLookInstanceRecord>[1] | undefined;
    if (request.kind === 'apply') {
      definition = BUILT_IN_LOOK_PACKS.find((pack) => pack.id === request.definitionId);
      const entry = lookCatalog.find((c) => c.definition.id === request.definitionId);
      if (
        definition === undefined ||
        entry === undefined ||
        !entry.available ||
        rootComposition === undefined
      )
        return;
      instanceId = makeJoyCodeId('look');
      lookCompileInput = {
        definition,
        definitionVersion: request.definitionVersion,
        compositionId: session.visualProject.rootCompositionId,
        compositionDurationUs: rootComposition.durationUs,
        format,
        entityBindings: request.entityBindings,
        controlValues: request.controlValues,
        overriddenBindingIds: [],
        resolvedFonts,
      };
    } else {
      const stored = session.lookInstances.instances[request.instanceId];
      if (stored === undefined || rootComposition === undefined) return;
      definition = BUILT_IN_LOOK_PACKS.find((pack) => pack.id === stored.definitionId);
      const entry = lookCatalog.find((c) => c.definition.id === stored.definitionId);
      if (definition === undefined || entry === undefined || !entry.available) return;
      instanceId = stored.id;
      lookCompileInput = lookInstanceUpdateCompileInput(
        stored,
        request.kind === 'update'
          ? {
              ...(request.nextControlValues === undefined
                ? {}
                : { nextControlValues: request.nextControlValues }),
              ...(request.nextEntityBindings === undefined
                ? {}
                : { nextEntityBindings: request.nextEntityBindings }),
            }
          : { resetBindingIds: request.bindingIds },
        {
          definition,
          compositionDurationUs: rootComposition.durationUs,
          format,
          resolvedFonts,
        },
      );
    }

    const threadId = activeThread.id;
    const scope: CreativeSkillRunScope = {
      projectId: project.id,
      runId: makeJoyCodeId('look'),
      epoch: 1,
      revision: session.projectRevisionId,
    };
    recipeRunScopeRef.current = scope;
    recipeStagedChangeSetRef.current = undefined;
    activeModelRunIdRef.current = scope.runId;
    setLookRunningId(definition.id);
    setAgentPhase('planning');
    const verb =
      request.kind === 'apply'
        ? 'Apply'
        : request.kind === 'reset'
          ? 'Reset overrides on'
          : 'Adjust';
    appendMessage(threadId, 'user', `${verb} Look — ${definition.title}`);
    const lifecycleRun = { runId: scope.runId, epoch: scope.epoch };

    try {
      beginRunLifecycle(lifecycleRun);
      if (rootComposition === undefined) {
        appendMessage(
          threadId,
          'assistant',
          `“${definition.title}” could not be prepared: this project has no root composition. No edit was applied.`,
        );
        cancelRunLifecycle(scope.runId, 'Look blocked — no root composition.');
        setAgentPhase('failed');
        if (activeModelRunIdRef.current === scope.runId) activeModelRunIdRef.current = undefined;
        return;
      }
      // Persist / update the reopenable Look Instance atomically with the
      // keyframes (R2 / GAP 1b) — instance record and keyframes commit + undo
      // together via the approval compound.
      const lookInstancesWrite = upsertLookInstance(
        session.lookInstances,
        buildLookInstanceRecord(instanceId, lookCompileInput),
      );
      const result = await stageLookRun(
        {
          getSession: () => latestSessionRef.current,
          latestSessionRef,
          preparedChanges,
          agentPreviewStore,
          proposalTargetsRef,
          currentPreparedAuthority,
          isAuthorityCurrent: isRecipeAuthorityCurrent,
          onStaged: (staged, changeSetId) => {
            if (recipeRunScopeRef.current?.runId === staged.runId)
              recipeStagedChangeSetRef.current = changeSetId;
          },
        },
        {
          scope,
          goal: `${verb} the "${definition.title}" Look`,
          currentTextByObjectId,
          compileInput: lookCompileInput,
          lookInstancesWrite,
        },
      );
      if (recipeRunScopeRef.current?.runId !== scope.runId) return;

      if (result.kind === 'blocked') {
        appendMessage(
          threadId,
          'assistant',
          `“${definition.title}” could not be prepared (${result.reason}). No edit was applied.${
            result.diagnostics.length > 0 ? `\n${result.diagnostics.join('\n')}` : ''
          }`,
        );
        cancelRunLifecycle(scope.runId, 'Look blocked.');
        setAgentPhase('failed');
        if (activeModelRunIdRef.current === scope.runId) activeModelRunIdRef.current = undefined;
        return;
      }

      const prepared = preparedChanges.getView(result.changeSetId);
      if (prepared === undefined) {
        appendMessage(
          threadId,
          'assistant',
          'The Look prepared a change but its preview authority was lost. Try again.',
        );
        cancelRunLifecycle(scope.runId, 'Look preview authority lost.');
        setAgentPhase('failed');
        if (activeModelRunIdRef.current === scope.runId) activeModelRunIdRef.current = undefined;
        return;
      }

      acceptRunLifecycle(lifecycleRun, 'preparing', { display: 'Look prepared a change.' });
      acceptRunLifecycle(lifecycleRun, 'preview-ready', {
        display: 'Look preview rendered and ready for review.',
      });
      acceptRunLifecycle(lifecycleRun, 'awaiting-approval', {
        display: 'Review the live preview before applying.',
      });
      setPreparedModelChange(prepared.changeSetId);
      setAgentPhase('awaiting-approval');
      appendMessage(
        threadId,
        'assistant',
        `“${definition.title}” prepared a reversible change (${result.operationCount} operation(s), ${result.changedBindingIds.length} binding(s)). Review the live preview before applying.`,
      );
    } catch (error) {
      if (recipeRunScopeRef.current?.runId !== scope.runId) return;
      appendMessage(
        threadId,
        'assistant',
        error instanceof Error ? error.message : 'The Look run failed safely.',
      );
      cancelRunLifecycle(scope.runId, 'Look run failed.');
      setAgentPhase('failed');
      if (activeModelRunIdRef.current === scope.runId) activeModelRunIdRef.current = undefined;
    } finally {
      setLookRunningId((current) => (current === definition.id ? undefined : current));
    }
  }

  function rejectModelDraft() {
    const prepared = modelView;
    if (prepared === undefined) return;
    const sourceRunId = sourceRunIdForPreparedPlan(prepared.planId);
    activeModelRunIdRef.current = undefined;
    cancelRunLifecycle(sourceRunId, 'JOY preview rejected. No edits were applied.');
    void joyAgentEngineClient?.cancel(sourceRunId);
    discardPreparedModelChange(sourceRunId);
    setAgentPhase('cancelled');
    appendMessage(activeThread.id, 'assistant', 'JOY preview rejected. No edits were applied.');
    agentPresenceStore?.clear();
  }

  function applyModelDraft() {
    const changeSetId = modelChangeSetIdRef.current;
    const prepared = changeSetId === undefined ? undefined : preparedChanges.getView(changeSetId);
    if (changeSetId === undefined || prepared === undefined || !modelAwaitingApproval) return;
    const sourceRunId = sourceRunIdForPreparedPlan(prepared.planId);
    const lifecycleRecord = runController.getSnapshot().run;
    const lifecycleRun =
      lifecycleRecord?.scope.runId === sourceRunId && lifecycleRecord.state === 'awaiting-approval'
        ? { runId: lifecycleRecord.scope.runId, epoch: lifecycleRecord.scope.epoch }
        : undefined;
    if (lifecycleRun === undefined) return;
    const commitAccepted = acceptRunLifecycle(lifecycleRun, 'committing', {
      display: 'JOY is applying the approved edit.',
    });
    if (commitAccepted?.accepted !== true) return;
    setAgentPhase('applying');
    let outcome: PreparedJoyCodeApplyOutcome;
    try {
      const authority = currentPreparedAuthority(prepared.hostRunId);
      outcome = applyPreparedJoyCodeChange({
        session,
        preparedChanges,
        prepared,
        authority,
        runner: modelRunnerRef.current,
      });
    } catch (error) {
      if (isTerminalPreparedChangeError(error)) {
        discardPreparedModelChange(sourceRunIdForPreparedPlan(prepared.planId));
        void joyAgentEngineClient?.cancel(sourceRunIdForPreparedPlan(prepared.planId));
      }
      if (lifecycleRun !== undefined)
        acceptRunLifecycle(lifecycleRun, 'failed', { display: 'JOY apply failed safely.' });
      setAgentPhase('failed');
      appendMessage(
        activeThread.id,
        'assistant',
        error instanceof Error ? `JOY apply failed: ${error.message}` : 'JOY apply failed safely.',
      );
      return;
    }
    const applied = outcome.result;
    // Derive the next-turn targets from the host's verified receipt and the
    // just-read-back canonical documents. This never preserves prompt/model
    // text or guessed identifiers in the durable project conversation.
    const entityReferenceDerivation = deriveJoyAgentConversationEntityReferences(applied.receipt, {
      timeline: session.timelineProject,
      visual: session.visualProject,
    });
    setConversation((current) =>
      setJoyCodeConversationEntityReferences(
        current,
        entityReferenceDerivation.references,
        new Date().toISOString(),
      ),
    );
    const lifecycleVersion = runController.getSnapshot().run?.changeSetVersion ?? 1;
    if (lifecycleRun !== undefined)
      acceptRunLifecycle(lifecycleRun, 'verifying', {
        display: 'JOY is verifying the durable edit receipt.',
        changeSetVersion: lifecycleVersion,
        artifacts: [
          {
            kind: 'execution-receipt',
            id: applied.receipt.executionId,
            version: lifecycleVersion,
          },
        ],
      });
    if (!applied.replayed || outcome.recoveredFromReceipt) onProjectRevision?.();
    const completionTargets = proposalTargetsRef.current.get(prepared.planId) ?? [
      { panelId: 'agent', sectionId: 'composer' },
    ];
    appendMessage(
      activeThread.id,
      'assistant',
      outcome.recoveredFromReceipt
        ? `JOY edit was committed. Its completion response was interrupted, but revision ${applied.revisionId} was confirmed from its saved receipt; no new edit or Undo entry was created.`
        : `${applied.replayed ? 'This JOY edit was already committed.' : 'Approved and applied'} Revision ${applied.revisionId} was ${applied.replayed ? 'confirmed from its saved receipt; no new edit or Undo entry was created.' : 'read back successfully; one Undo restores the prior state.'}`,
    );
    activeModelRunIdRef.current = undefined;
    discardPreparedModelChange(sourceRunIdForPreparedPlan(prepared.planId));
    setAgentPhase('completed');
    if (lifecycleRun !== undefined)
      acceptRunLifecycle(lifecycleRun, 'completed', {
        display: 'JOY edit committed and verified.',
        changeSetVersion: lifecycleVersion,
        artifacts: [
          {
            kind: 'verification',
            id: applied.receipt.resultRevision,
            version: lifecycleVersion,
          },
        ],
      });
    void joyAgentEngineClient?.cancel(sourceRunIdForPreparedPlan(prepared.planId));
    agentPresenceStore?.dispatch({
      protocolVersion: 1,
      runId: sourceRunIdForPreparedPlan(prepared.planId),
      seq: Math.max(0, (agentPresenceStore?.getState().seq ?? -1) + 1),
      at: new Date().toISOString(),
      revision: session.historyCursorSequence,
      kind: 'completed',
      phase: 'completed',
      targets: completionTargets,
    });
    window.setTimeout(() => agentPresenceStore?.completeHandoff(), 1200);
  }

  function isTerminalPreparedChangeError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return /(?:JOY_CODE_(?:APPROVAL|PREPARED_CHANGE|POLICY_CHANGED|STALE_REVISION|EXECUTION_CONFLICT|VERIFICATION_FAILED)|PERSISTENCE_(?:RECOVERY_REQUIRED|ATOMIC_ROLLBACK_PENDING))/.test(
      error.message,
    );
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
    clearAgentPreviewForSourceRun(pending.runId);
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
    const recorded = saveWorkflow(session, lastRun.plan, storage);
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
    agentPhaseForLifecycleState(runLifecycle.state) ??
    agentPhase ??
    (composerPresenceActive || presenceState.terminalTarget?.panelId === 'agent'
      ? presenceState.phase === 'idle'
        ? undefined
        : presenceState.phase
      : agentPhaseForLifecycleState(runLifecycle.state));
  const liveAgentBusy =
    liveAgentPhase !== undefined &&
    liveAgentPhase !== 'completed' &&
    liveAgentPhase !== 'failed' &&
    liveAgentPhase !== 'cancelled';
  const activeRunId = agentRunId ?? presenceState.runId ?? runLifecycle.run?.scope.runId;

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
    <PanelShell title="Joy Code" className="joy-code-panel">
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
                    if (activeRunId !== undefined) {
                      cancelRunLifecycle(activeRunId);
                      void joyAgentEngineClient.cancel(activeRunId);
                    }
                    activeModelRunIdRef.current = undefined;
                    discardPreparedModelChange(activeRunId);
                    setAgentPhase('cancelled');
                    clearAgentPreviewForSourceRun(activeRunId);
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
          <div className="joy-code-capabilities" role="toolbar" aria-label="Composer capabilities">
            <span className="joy-code-capabilities-label">Create with JOY</span>
            <button
              type="button"
              className={`joy-code-capability ${composerCapability === 'edit' ? 'is-active' : ''}`}
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
            <button
              type="button"
              className={`joy-code-capability ${composerCapability === 'recipes' ? 'is-active' : ''}`}
              aria-pressed={composerCapability === 'recipes'}
              onClick={() => setComposerCapability('recipes')}
            >
              <span className="joy-code-capability-spark" aria-hidden="true">
                ☰
              </span>
              Recipes
            </button>
            <button
              type="button"
              className={`joy-code-capability ${composerCapability === 'looks' ? 'is-active' : ''}`}
              aria-pressed={composerCapability === 'looks'}
              onClick={() => setComposerCapability('looks')}
            >
              <span className="joy-code-capability-spark" aria-hidden="true">
                ◑
              </span>
              Looks
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
            className="joy-code-recipes"
            aria-label="Creative recipes"
            hidden={composerCapability !== 'recipes'}
          >
            <p className="joy-code-recipes-intro">
              Guided multi-step edits. Each runs through the same single JOY engine, staged preview,
              and approval as a direct edit.
            </p>
            <ul className="joy-code-recipes-list">
              {creativeSkills.map((entry) => {
                const missing = [...entry.missingCapabilities, ...entry.missingOperations];
                const running = recipeRunningId === entry.skill.id;
                return (
                  <li
                    key={entry.skill.id}
                    className={`joy-code-recipe ${entry.available ? '' : 'is-unavailable'}`}
                  >
                    <div className="joy-code-recipe-copy">
                      <strong>{entry.skill.title}</strong>
                      <span>{entry.skill.description}</span>
                      {!entry.available && missing.length > 0 && (
                        <span className="joy-code-recipe-missing">Needs: {missing.join(', ')}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="joy-code-recipe-run"
                      disabled={
                        !entry.available ||
                        recipeRunningId !== undefined ||
                        liveAgentBusy ||
                        creativeSkillDeps === undefined
                      }
                      aria-label={`Run ${entry.skill.title}`}
                      onClick={() => void runRecipe(entry.skill.id)}
                    >
                      {running ? 'Running…' : 'Run'}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <LivingLooksPanel
            hidden={composerCapability !== 'looks'}
            catalog={lookCatalog}
            entities={lookEntities}
            applied={appliedLooks}
            runningLookId={lookRunningId}
            busy={liveAgentBusy || recipeRunningId !== undefined}
            onRun={(request) => void runLook(request)}
          />
          <div
            className="joy-code-creative-brief"
            aria-label="Creative Brief capability"
            hidden={composerCapability !== 'creative-brief'}
          >
            <CreativeBriefPanel
              revisionId={session.projectRevisionId}
              projectId={project.id}
              storage={storage}
              optedIn={creativeBriefOptedIn}
              onBriefReady={handOffCreativeBrief}
              onBriefHydrated={setCreativeBriefContext}
              onBriefCleared={() => setCreativeBriefContext(undefined)}
              {...(onCreativeBriefOptIn === undefined ? {} : { onOptIn: onCreativeBriefOptIn })}
              {...(creativeBriefRunner === undefined ? {} : { runBrief: creativeBriefRunner })}
              embedded
            />
          </div>
          <div
            className={`joy-code-messages${activeThread?.messages.length === 0 ? ' is-empty' : ''}`}
            aria-live="polite"
          >
            {activeThread?.messages.length === 0 && (
              <div className="joy-code-welcome">
                <JoyCodeLogo variant="horizontal" label="Joy Code" />
                <h3 className="joy-code-welcome-title">What should we edit?</h3>
                <p className="joy-code-welcome-copy">
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
                  <p className="agent-error">Dry-run errors: {pending.dryRun.errors.join(', ')}</p>
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

            {modelView !== undefined && activeThread !== undefined && (
              <section
                className="joy-code-plan-card joy-code-model-plan"
                aria-label="JOY Agent live proposal"
                data-agent-preview-ready={modelAwaitingApproval ? 'true' : 'false'}
                data-agent-lifecycle-state={runLifecycle.state}
              >
                <AgentPreviewBadge surface="JOY Code" />
                <div className="joy-code-plan-head">
                  <div>
                    <span>JOY Agent preview</span>
                    <strong>Not applied</strong>
                  </div>
                  <span className="agent-decision agent-decision-requires-manual">
                    {modelAwaitingApproval
                      ? 'needs approval'
                      : modelPreviewReady
                        ? 'awaiting review state'
                        : 'rendering preview'}
                  </span>
                </div>
                <p>{modelView.groups.map((group) => group.summary).join(' · ')}</p>
                <p>
                  Applying this local edit adds no provider cost. BYOK model spend is unknown; the
                  dollar limit cannot cap provider billing. Requests are limited to four steps of
                  2,048 output tokens.
                </p>
                {modelView.warnings.length > 0 && (
                  <p className="agent-error">{modelView.warnings.join(', ')}</p>
                )}
                <div className="joy-code-plan-actions">
                  <button
                    type="button"
                    className="is-primary"
                    onClick={applyModelDraft}
                    disabled={!modelAwaitingApproval}
                    title={
                      modelAwaitingApproval
                        ? undefined
                        : 'Waiting for the live preview and approval state'
                    }
                  >
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
            {observationReviewDisplay !== undefined && (
              <section
                className="joy-code-plan-card joy-code-observation-review"
                aria-label="Optional image evidence review"
                data-observation-review-status={observationReviewUi.status}
              >
                <div className="joy-code-plan-head">
                  <div>
                    <span>Optional image review</span>
                    <strong>Sampled local evidence is ready</strong>
                  </div>
                  <span className="agent-decision agent-decision-requires-manual">your choice</span>
                </div>
                <p>
                  JOY can send {observationReviewDisplay.evidenceCount} small local image sample
                  {observationReviewDisplay.evidenceCount === 1 ? '' : 's'} to your configured model
                  only after you review and allow the exact scope. No video or audio is sent.
                </p>
                {(observationReviewUi.status === 'idle' ||
                  observationReviewUi.status === 'failed') && (
                  <div className="joy-code-plan-actions">
                    {observationReviewUi.status === 'idle' && (
                      <button
                        type="button"
                        className="is-primary"
                        onClick={prepareObservationReview}
                      >
                        Review image scope
                      </button>
                    )}
                    <button type="button" onClick={discardObservationReview}>
                      Dismiss
                    </button>
                  </div>
                )}
                {observationReviewUi.status === 'consent-required' && (
                  <AgentObservationConsent
                    scope={
                      {
                        providerName:
                          joyAgentEngineClient?.getStatus()?.provider === 'openrouter'
                            ? 'OpenRouter'
                            : 'OpenAI-compatible provider',
                        modelName: observationReviewDisplay.modelId,
                        availability: 'ready',
                        selectedEvidenceCount: observationReviewDisplay.evidenceCount,
                        modalities: ['image'],
                        range: observationReviewDisplay.range,
                        maxRequests: 1,
                        maxBytes: OBSERVATION_REVIEW_MAX_BYTES,
                        estimatedCost: 'unknown',
                        ...(joyAgentEngineClient?.getStatus()?.provider === 'openrouter'
                          ? { policyHref: OPENROUTER_PRIVACY_POLICY_HREF }
                          : {}),
                      } satisfies AgentObservationConsentScope
                    }
                    onApprove={approveObservationReview}
                    onNarrow={discardObservationReview}
                    onCancel={() => {
                      observationReviewControllerRef.current?.cancel();
                      discardObservationReview();
                    }}
                    narrow
                  />
                )}
                {observationReviewUi.status === 'transferring' && (
                  <p role="status">
                    JOY is sending the approved image scope through its private session.
                  </p>
                )}
                {observationReviewUi.status === 'reviewed' &&
                  observationReviewUi.analysis !== undefined && (
                    <p className="joy-code-observation-review__analysis">
                      {observationReviewUi.analysis}
                    </p>
                  )}
                {observationReviewUi.status === 'failed' && (
                  <p className="agent-error" role="status">
                    {observationReviewUi.message ??
                      'Image review could not be completed. Nothing else was shared.'}
                  </p>
                )}
                {observationReviewUi.status === 'cancelled' && (
                  <p role="status">
                    {observationReviewUi.message ?? 'Image review was cancelled.'}
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

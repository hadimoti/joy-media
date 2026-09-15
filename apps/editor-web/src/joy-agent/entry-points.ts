import type { CreativeBriefV1, CreativeSkillAvailability } from '@joy-media/agent-tools';
import { resolveCreativeSkillAvailability, validateCreativeBrief } from '@joy-media/agent-tools';
import type { JoyAgentEngineClient, JoyAgentRunHost } from './engine-client.js';
import {
  createCreativeSkillEditorPrimitives,
  type CreativeSkillEditorPrimitiveDeps,
  type CreativeSkillScopedToolLoopResult,
} from './creative-skill-editor-primitives.js';
import type {
  JoyAgentPreparedProposal,
  JoyAgentRunRequest,
  JoyAgentSafeEvent,
  JoyAgentTaskKind,
} from './protocol.js';
import {
  createEditorCreativeSkillRuntime,
  R1_EDITOR_CREATIVE_SKILL_SEAMS,
  type CreativeSkillSeamAvailability,
} from './creative-skill-runtime.js';
import {
  createCreativeSkillHostAdapter,
  type CreativeSkillHostPrimitives,
} from './creative-skill-host-adapter.js';
import {
  createCreativeSkillRunner,
  type CreativeSkillCheckpointEvent,
  type CreativeSkillRunResult,
  type CreativeSkillRunScope,
} from './skill-runner.js';

/** Product-owned map: every model-assisted surface uses the same Worker client. */
export const JOY_AGENT_ENTRY_POINTS = [
  {
    id: 'joy-code',
    taskKind: 'joy-code',
    panelId: 'agent',
    sectionId: 'composer',
    capability: 'timeline.write',
  },
  {
    id: 'creative-brief',
    taskKind: 'creative-brief',
    panelId: 'agent',
    sectionId: 'composer',
    capability: 'timeline.read',
  },
  {
    id: 'asset-edit',
    taskKind: 'asset-edit',
    panelId: 'media',
    sectionId: 'media',
    capability: 'assets.read',
  },
  {
    id: 'text',
    taskKind: 'text',
    panelId: 'media',
    sectionId: 'text',
    capability: 'timeline.write',
  },
  {
    id: 'effects',
    taskKind: 'effects',
    panelId: 'effects',
    sectionId: 'effects',
    capability: 'timeline.write',
  },
  {
    id: 'filters',
    taskKind: 'filters',
    panelId: 'effects',
    sectionId: 'filters',
    capability: 'timeline.write',
  },
  {
    id: 'transitions',
    taskKind: 'transitions',
    panelId: 'effects',
    sectionId: 'transitions',
    capability: 'timeline.write',
  },
  {
    id: 'color',
    taskKind: 'color',
    panelId: 'effects',
    sectionId: 'color',
    capability: 'timeline.write',
  },
  {
    id: 'motion',
    taskKind: 'motion',
    panelId: 'effects',
    sectionId: 'motion',
    capability: 'timeline.write',
  },
  {
    id: 'camera',
    taskKind: 'camera',
    panelId: 'monitor',
    sectionId: 'preview',
    capability: 'render.preview',
  },
  {
    id: 'captions',
    taskKind: 'captions',
    panelId: 'media',
    sectionId: 'captions',
    capability: 'timeline.write',
  },
  {
    id: 'audio',
    taskKind: 'audio',
    panelId: 'media',
    sectionId: 'audio',
    capability: 'timeline.write',
  },
  {
    id: '3d',
    taskKind: '3d',
    panelId: 'scene3d',
    sectionId: 'scene',
    capability: 'render.preview',
  },
  {
    id: 'workflow',
    taskKind: 'workflow',
    panelId: 'workflows',
    sectionId: 'workflows',
    capability: 'timeline.write',
  },
  {
    id: 'media-job',
    taskKind: 'media-job',
    panelId: 'jobs',
    sectionId: 'jobs',
    capability: 'provider.generate',
  },
] as const satisfies readonly {
  readonly id: string;
  readonly taskKind: JoyAgentTaskKind;
  readonly panelId: string;
  readonly sectionId: string;
  readonly capability: string;
}[];

export type JoyAgentEntryPointId = (typeof JOY_AGENT_ENTRY_POINTS)[number]['id'];

export interface RunJoyAgentTaskInput {
  readonly client: JoyAgentEngineClient;
  readonly taskKind: JoyAgentTaskKind;
  readonly prompt: string;
  readonly baseRevision: string;
  /** Required for every structured edit; never crosses into the Worker. */
  readonly host?: JoyAgentRunHost;
  /** Allowed only for the explicitly plan-only Creative Brief path. */
  readonly context?: unknown;
  readonly onEvent?: (event: JoyAgentSafeEvent) => void;
  /** Called after a run id is allocated and before the Worker iterator starts. */
  readonly onRunStart?: (runId: string) => void;
  /** Local-only policy must fail before any remote Worker/provider call. */
  readonly allowRemote?: boolean;
}

export class JoyAgentTaskError extends Error {
  readonly code:
    | 'failed'
    | 'cancelled'
    | 'empty-result'
    | 'invalid-result'
    | 'stale-result'
    | 'remote-disabled'
    | 'host-required';

  constructor(code: JoyAgentTaskError['code'], message: string) {
    super(message);
    this.name = 'JoyAgentTaskError';
    this.code = code;
  }
}

function newRunId(taskKind: JoyAgentTaskKind): string {
  const cryptoApi = globalThis.crypto as Crypto & { randomUUID?: () => string };
  return `${taskKind}-${cryptoApi.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

const CREDENTIAL_LIKE_PROMPT =
  /(?:bearer\s+[A-Za-z0-9._~-]{16,}|(?:api[_-]?key|secret|token)\s*[:=]\s*\S{12,}|sk-[A-Za-z0-9_-]{20,})/i;

/**
 * Run any registered entry point and return its terminal safe event.
 *
 * Structured edits stop at an approval boundary rather than completing. Their
 * terminal handoff carries only the opaque prepared-change identity from the
 * preceding preview event; operations and host context never cross this API.
 */
export async function runJoyAgentTask(input: RunJoyAgentTaskInput): Promise<JoyAgentSafeEvent> {
  if (input.allowRemote === false)
    throw new JoyAgentTaskError(
      'remote-disabled',
      'Remote JOY Agent processing is disabled by the Local only privacy policy.',
    );
  if (CREDENTIAL_LIKE_PROMPT.test(input.prompt))
    throw new JoyAgentTaskError(
      'failed',
      'JOY did not send this request because it looks like it contains a credential.',
    );
  const planOnly = input.taskKind === 'creative-brief';
  if (!planOnly && input.host === undefined)
    throw new JoyAgentTaskError(
      'host-required',
      'This JOY edit needs a trusted main-thread host before it can contact a model.',
    );
  const runId = newRunId(input.taskKind);
  input.onRunStart?.(runId);
  const request: Omit<JoyAgentRunRequest, 'runEpoch'> = {
    runId,
    taskKind: input.taskKind,
    prompt: input.prompt.trim().slice(0, 8_000),
    baseRevision: input.baseRevision,
    mode: planOnly ? 'plan-only' : 'tool-loop',
    ...(planOnly && input.context !== undefined ? { context: input.context } : {}),
  };
  let completed: JoyAgentSafeEvent | undefined;
  let awaitingApproval: JoyAgentSafeEvent | undefined;
  let preparedProposal: JoyAgentPreparedProposal | undefined;
  for await (const event of input.client.startRun(request, input.host)) {
    input.onEvent?.(event);
    if (event.phase === 'failed')
      throw new JoyAgentTaskError('failed', event.message ?? 'JOY Agent Engine failed');
    if (event.phase === 'cancelled')
      throw new JoyAgentTaskError('cancelled', 'JOY Agent Engine run cancelled');
    if (event.phase === 'previewing' && event.proposal !== undefined)
      preparedProposal = event.proposal;
    if (event.phase === 'awaiting-approval') awaitingApproval = event;
    if (event.phase === 'completed') completed = event;
  }
  if (completed !== undefined) return completed;
  if (awaitingApproval !== undefined) {
    if (planOnly)
      throw new JoyAgentTaskError(
        'invalid-result',
        'The plan-only JOY task unexpectedly requested edit approval.',
      );
    if (preparedProposal === undefined)
      throw new JoyAgentTaskError(
        'invalid-result',
        'JOY requested approval without an opaque prepared preview.',
      );
    return {
      ...awaitingApproval,
      proposal: {
        summary: preparedProposal.summary,
        baseRevision: preparedProposal.baseRevision,
        changeSetId: preparedProposal.changeSetId,
        operationDigest: preparedProposal.operationDigest,
        bindingDigest: preparedProposal.bindingDigest,
        operationCount: preparedProposal.operationCount,
      },
    };
  }
  throw new JoyAgentTaskError('empty-result', 'JOY returned no result');
}

export async function runCreativeBriefTask(input: {
  readonly client: JoyAgentEngineClient;
  readonly projectId: string;
  readonly revisionId: string;
  readonly request: string;
  readonly context: unknown;
  readonly onEvent?: (event: JoyAgentSafeEvent) => void;
  readonly onRunStart?: (runId: string) => void;
  readonly allowRemote?: boolean;
}): Promise<CreativeBriefV1> {
  const event = await runJoyAgentTask({
    client: input.client,
    taskKind: 'creative-brief',
    prompt: input.request,
    baseRevision: input.revisionId,
    context: input.context,
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
    ...(input.onRunStart === undefined ? {} : { onRunStart: input.onRunStart }),
    ...(input.allowRemote === undefined ? {} : { allowRemote: input.allowRemote }),
  });
  if (event.result === undefined)
    throw new JoyAgentTaskError('empty-result', 'JOY returned no Creative Brief');
  const validation = validateCreativeBrief(event.result);
  if (!validation.valid)
    throw new JoyAgentTaskError(
      'invalid-result',
      `JOY Creative Brief failed validation: ${validation.errors
        .slice(0, 3)
        .map((error) => error.message)
        .join('; ')}`,
    );
  const brief = event.result as CreativeBriefV1;
  if (brief.projectId !== input.projectId || brief.snapshotRevisionId !== input.revisionId)
    throw new JoyAgentTaskError(
      'stale-result',
      'JOY Creative Brief no longer matches this project',
    );
  return brief;
}

/**
 * List the R1 creative recipes with their availability. Availability is
 * computed from verified editor seams only, so an unwired adapter keeps its
 * recipe visible-but-unavailable rather than being a false promise.
 */
export function listCreativeSkills(
  seams: CreativeSkillSeamAvailability = R1_EDITOR_CREATIVE_SKILL_SEAMS,
): readonly CreativeSkillAvailability[] {
  return resolveCreativeSkillAvailability(createEditorCreativeSkillRuntime(seams));
}

export interface RunCreativeSkillInput {
  readonly skillId: string;
  readonly scope: CreativeSkillRunScope;
  /**
   * Trusted host primitives. Each delegates to the same one-Worker /
   * observation-bridge / canonical-compiler / staged-preview / verifier
   * infrastructure the direct tool-loop uses; there is no commit primitive.
   */
  readonly primitives: CreativeSkillHostPrimitives;
  /** Re-checked around every async checkpoint effect. */
  readonly isAuthorityCurrent: (scope: CreativeSkillRunScope) => boolean;
  readonly seams?: CreativeSkillSeamAvailability;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: CreativeSkillCheckpointEvent) => void;
}

/**
 * Run one creative recipe through the shared skill runner. The runner has no
 * `apply`: an edit recipe finishes `ready-for-approval` and the existing
 * approval envelope remains the only write path.
 */
export function runCreativeSkill(input: RunCreativeSkillInput): Promise<CreativeSkillRunResult> {
  const runner = createCreativeSkillRunner({
    runtime: createEditorCreativeSkillRuntime(input.seams ?? R1_EDITOR_CREATIVE_SKILL_SEAMS),
    adapter: createCreativeSkillHostAdapter(input.primitives),
    isAuthorityCurrent: input.isAuthorityCurrent,
  });
  return runner.run({
    skillId: input.skillId,
    scope: input.scope,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
  });
}

/**
 * Run one R1 creative recipe with the concrete editor-wired primitives. The
 * caller builds `deps` once per `App.tsx` mount
 * (`createCreativeSkillEditorPrimitiveDeps`); each run is isolated by its scope
 * and gets a fresh memoized tool-loop shared by `observe`/`propose`.
 */
export function runEditorCreativeSkill(input: {
  readonly skillId: string;
  readonly scope: CreativeSkillRunScope;
  readonly deps: CreativeSkillEditorPrimitiveDeps;
  readonly isAuthorityCurrent: (scope: CreativeSkillRunScope) => boolean;
  readonly seams?: CreativeSkillSeamAvailability;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: CreativeSkillCheckpointEvent) => void;
}): Promise<CreativeSkillRunResult> {
  return runCreativeSkill({
    skillId: input.skillId,
    scope: input.scope,
    primitives: createCreativeSkillEditorPrimitives(input.deps, input.scope),
    isAuthorityCurrent: input.isAuthorityCurrent,
    ...(input.seams === undefined ? {} : { seams: input.seams }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
  });
}

/**
 * Run one scoped recipe tool-loop through the same `runJoyAgentTask` path the
 * direct editor uses, and map its terminal event to the recipe result shape.
 * The recipe's tool allow-list is applied by the host the caller supplies;
 * this wrapper never widens it.
 */
export async function runScopedCreativeSkillToolLoop(input: {
  readonly client: JoyAgentEngineClient;
  readonly host: JoyAgentRunHost;
  readonly prompt: string;
  readonly baseRevision: string;
  readonly onEvent?: (event: JoyAgentSafeEvent) => void;
  /** Called with the Worker run id before the iterator starts (for the
   * recipe observation authority fence). */
  readonly onRunStart?: (runId: string) => void;
  readonly signal?: AbortSignal;
}): Promise<CreativeSkillScopedToolLoopResult> {
  // The Worker event iterator has no cancel input; aborting the recipe run
  // must reach the Worker through an explicit cancel on its captured run id.
  let workerRunId: string | undefined;
  const abort = (): void => {
    if (workerRunId !== undefined) void input.client.cancel(workerRunId);
  };
  if (input.signal !== undefined) {
    if (input.signal.aborted)
      return Promise.resolve({ kind: 'failed', message: 'The recipe run was cancelled.' });
    input.signal.addEventListener('abort', abort, { once: true });
  }
  try {
    const event = await runJoyAgentTask({
      client: input.client,
      host: input.host,
      taskKind: 'joy-code',
      prompt: input.prompt,
      baseRevision: input.baseRevision,
      ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
      onRunStart: (runId) => {
        workerRunId = runId;
        input.onRunStart?.(runId);
      },
    });
    if (event.phase === 'awaiting-approval' && event.proposal !== undefined) {
      return {
        kind: 'prepared',
        changeSetId: event.proposal.changeSetId,
        operationDigest: event.proposal.operationDigest,
        operationCount: event.proposal.operationCount,
        // The bounded tool-loop caps repair proposals internally; the terminal
        // event does not surface the count, so this is a conservative 0.
        repairAttempts: 0,
      };
    }
    if (event.phase === 'completed') {
      const result = event.result as
        { readonly kind?: string; readonly text?: unknown } | undefined;
      if (result?.kind === 'answer' && typeof result.text === 'string')
        return { kind: 'answer', text: result.text };
      return { kind: 'answer', text: 'The recipe run completed without a proposed edit.' };
    }
    return { kind: 'failed', message: 'The recipe run produced no prepared change or answer.' };
  } catch (error) {
    if (error instanceof JoyAgentTaskError && error.code === 'cancelled')
      return { kind: 'failed', message: 'The recipe run was cancelled.' };
    return {
      kind: 'failed',
      message: error instanceof Error ? error.message.slice(0, 480) : 'The recipe run failed.',
    };
  } finally {
    input.signal?.removeEventListener('abort', abort);
  }
}

import type { CreativeBriefV1 } from '@joy-media/agent-tools';
import { validateCreativeBrief } from '@joy-media/agent-tools';
import type { JoyAgentEngineClient } from './engine-client.js';
import type { JoyAgentRunRequest, JoyAgentSafeEvent, JoyAgentTaskKind } from './protocol.js';

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
  { id: '3d', taskKind: '3d', panelId: 'agent', sectionId: '3d', capability: 'render.preview' },
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
  readonly context?: unknown;
  readonly onEvent?: (event: JoyAgentSafeEvent) => void;
  /** Called after a run id is allocated and before the Worker iterator starts. */
  readonly onRunStart?: (runId: string) => void;
  /** Local-only policy must fail before any remote Worker/provider call. */
  readonly allowRemote?: boolean;
}

export class JoyAgentTaskError extends Error {
  readonly code:
    'failed' | 'cancelled' | 'empty-result' | 'invalid-result' | 'stale-result' | 'remote-disabled';

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

/** Run any registered entry point and return its terminal safe event. */
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
  const runId = newRunId(input.taskKind);
  input.onRunStart?.(runId);
  const request: JoyAgentRunRequest = {
    runId,
    taskKind: input.taskKind,
    prompt: input.prompt.trim().slice(0, 8_000),
    baseRevision: input.baseRevision,
    context: input.context,
    mode: input.taskKind === 'creative-brief' ? 'plan-only' : 'tool-loop',
  };
  let terminal: JoyAgentSafeEvent | undefined;
  for await (const event of input.client.startRun(request)) {
    input.onEvent?.(event);
    if (event.phase === 'failed')
      throw new JoyAgentTaskError('failed', event.message ?? 'JOY Agent Engine failed');
    if (event.phase === 'cancelled')
      throw new JoyAgentTaskError('cancelled', 'JOY Agent Engine run cancelled');
    if (event.phase === 'completed') terminal = event;
  }
  if (terminal === undefined) throw new JoyAgentTaskError('empty-result', 'JOY returned no result');
  return terminal;
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

/* global process, setTimeout, clearTimeout */
import {
  JoyAgentEngine,
  type JoyAgentSafeEvent,
  type JoyAgentTaskKind,
  type JoyDocumentOperation,
  type JoyTimelineOperation,
} from '@joy-media/joy-agent-engine';
import type { CliProjectDocument } from '../utils/project-loader.js';
import { c } from '../utils/logger.js';
import { CliJoyAgentToolBridge, type StagedOperationsSummary } from './bridge.js';
import { createAgentOutput, type AgentOutput } from './output.js';
import {
  createModelFromConfig,
  resolveByokConfig,
  type ProviderTraffic,
  type ResolveProviderOptions,
} from './provider.js';

export interface RunAgentOptions {
  readonly project: CliProjectDocument;
  readonly revision: number;
  readonly prompt: string;
  readonly taskKind?: JoyAgentTaskKind | undefined;
  readonly apply?: boolean | undefined;
  readonly providerOptions?: ResolveProviderOptions | undefined;
  readonly onEvent?: ((event: JoyAgentSafeEvent) => void) | undefined;
  readonly onStagedChange?: ((summary: StagedOperationsSummary) => void) | undefined;
  readonly output?: AgentOutput | undefined;
}

export interface ApplyOutcome {
  /** True only when EVERY staged operation applied cleanly. */
  readonly applied: boolean;
  /** The edited project when `applied`, otherwise the untouched input project. */
  readonly updatedProject: CliProjectDocument;
  readonly appliedCount: number;
  readonly errors: string[];
}

export interface RunAgentOutput extends ApplyOutcome {
  readonly resultText: string;
  readonly capability: string;
  readonly steps: number;
  readonly staged: StagedOperationsSummary;
  readonly modelId: string;
  readonly provider: string;
  /**
   * Apply exactly the operations this run staged (all-or-nothing, no new
   * model call). Used by the REPL once the user approves the proposal.
   */
  readonly applyStaged: () => ApplyOutcome;
}

/** A provider/model failure, with a human explanation (never a secret). */
export class AgentRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus?: number | undefined,
  ) {
    super(message);
    this.name = 'AgentRunError';
  }
}

const DEFAULT_TIMEOUT_MS = 180_000;

/** `JOY_AGENT_TIMEOUT_MS` bounds one agent run (the engine caps it at 180 s). */
export function agentTimeoutMs(): number {
  const raw = process.env.JOY_AGENT_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0
    ? Math.min(value, DEFAULT_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

function explainFailure(
  code: string,
  traffic: ProviderTraffic,
  baseUrl: string,
  modelId: string,
  timedOut: boolean,
  timeoutMs: number,
): string {
  const status = traffic.lastStatus;
  if (timedOut) {
    return `No complete answer from the provider within ${Math.round(timeoutMs / 1000)}s; gave up (set JOY_AGENT_TIMEOUT_MS to change the limit).`;
  }
  if (status !== undefined && status >= 400) {
    if (status === 401 || status === 403) {
      return `The provider rejected the API key (HTTP ${status}). Check the key configured for this provider.`;
    }
    if (status === 404) {
      return `The provider answered HTTP 404. Check that the URL is the API base (usually ending in /v1) and that model "${modelId}" exists.`;
    }
    if (status === 429) {
      return 'The provider is rate-limiting requests (HTTP 429). Wait a moment and retry.';
    }
    if (status >= 500) return `The provider had a server error (HTTP ${status}). Retry later.`;
    return `The provider answered HTTP ${status}.`;
  }
  if (traffic.networkErrorCode && traffic.lastStatus === undefined) {
    return `Could not reach the provider at ${new URL(baseUrl).origin} (${traffic.networkErrorCode}).`;
  }
  switch (code) {
    case 'JOY_AGENT_ABORTED':
      return 'The agent run was cancelled.';
    case 'JOY_AGENT_TIMEOUT':
      return 'The provider timed out.';
    case 'JOY_AGENT_RESPONSE_TOO_LARGE':
      return 'The provider response was too large.';
    case 'JOY_AGENT_INVALID_TOOL':
      return 'The model produced an invalid tool call or an oversized answer.';
    case 'JOY_AGENT_AUTH_FAILED':
      return 'The provider rejected the credentials.';
    case 'JOY_AGENT_CORS_OR_NETWORK':
      return 'A network error occurred while talking to the provider.';
    default:
      return 'The provider returned something JOY could not use (is it an OpenAI-compatible chat-completions endpoint, and does the model support tool calls?).';
  }
}

export async function probeAgent(
  providerOptions?: ResolveProviderOptions,
): Promise<{ capability: string; provider: string; modelId: string; httpStatus?: number }> {
  const config = resolveByokConfig(providerOptions);
  const traffic: ProviderTraffic = { requests: 0 };
  const model = createModelFromConfig(config, traffic);
  const bridge = new CliJoyAgentToolBridge(
    {
      schemaVersion: 1,
      id: 'probe',
      title: 'Probe',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rootCompositionId: 'root',
      settings: { defaultLocale: 'en' },
      compositions: {
        root: {
          id: 'root',
          name: 'Root',
          width: 1920,
          height: 1080,
          pixelAspectRatio: { num: 1, den: 1 },
          frameRate: { num: 30, den: 1 },
          durationUs: 1000000,
          background: '#000',
          tracks: [],
        },
      },
      assets: {},
      variables: {},
      markers: [],
      visualObjects: {},
      captionDocuments: {},
      pluginData: {},
    },
    1,
  );

  const engine = new JoyAgentEngine({ model, bridge });
  const probeResult = await engine.probe();
  if (probeResult.capability === 'incompatible') {
    // The engine swallows the cause; report what the HTTP layer saw.
    throw new AgentRunError(
      'JOY_AGENT_PROVIDER_INCOMPATIBLE',
      explainFailure(
        'JOY_AGENT_PROVIDER_INCOMPATIBLE',
        traffic,
        config.baseUrl,
        config.modelId,
        false,
        0,
      ),
      traffic.lastStatus !== undefined && traffic.lastStatus >= 400
        ? traffic.lastStatus
        : undefined,
    );
  }
  return {
    capability: probeResult.capability,
    provider: config.provider,
    modelId: config.modelId,
  };
}

/** One-line, human description of a staged operation. */
export function describeOperation(op: JoyTimelineOperation | JoyDocumentOperation): string {
  const sec = (us: number): string => `${(us / 1_000_000).toFixed(2)}s`;
  switch (op.kind) {
    case 'insert':
      return `insert clip ${op.id} (asset ${op.assetId}) on track ${op.trackId} at ${sec(op.startUs)} for ${sec(op.durationUs)}`;
    case 'remove':
      return `remove clip ${op.clipId}`;
    case 'move':
      return `move clip ${op.clipId} to track ${op.trackId} at ${sec(op.startUs)}`;
    case 'trim':
      return `trim clip ${op.clipId} to ${sec(op.startUs)}-${sec(op.endUs)}`;
    case 'split':
      return `split clip ${op.clipId} at ${sec(op.atUs)}`;
    case 'set-text':
      return `set text of ${op.objectId}`;
    case 'set-property':
      return `set ${op.property} of ${op.objectId}`;
    case 'add-effect':
      return `add effect ${op.effectId} to ${op.objectId}`;
  }
}

function applyAllOrNothing(
  bridge: CliJoyAgentToolBridge,
  original: CliProjectDocument,
): ApplyOutcome {
  const result = bridge.applyStaged();
  if (result.errors.length > 0) {
    return { applied: false, updatedProject: original, appliedCount: 0, errors: result.errors };
  }
  return {
    applied: true,
    updatedProject: result.updatedProject,
    appliedCount: result.appliedCount,
    errors: [],
  };
}

export async function runJoyAgent(options: RunAgentOptions): Promise<RunAgentOutput> {
  const out = options.output ?? createAgentOutput(false);
  const config = resolveByokConfig(options.providerOptions);
  const traffic: ProviderTraffic = { requests: 0 };
  const model = createModelFromConfig(config, traffic);

  const bridge = new CliJoyAgentToolBridge(
    options.project,
    options.revision,
    options.onStagedChange,
  );

  const eventLogger = (event: JoyAgentSafeEvent): void => {
    options.onEvent?.(event);
    if (event.type === 'activity') {
      out.step('Agent Phase', `${event.phase} (${event.activityCode})`);
    } else if (event.type === 'text-delta') {
      out.write(event.text);
    } else if (event.type === 'proposal') {
      out.line();
      out.info(`Staged proposal: ${event.operationCount} operations (hash: ${event.proposalHash})`);
    } else if (event.type === 'usage') {
      out.step(
        'Token Usage',
        `Prompt: ${event.inputTokens} | Output: ${event.outputTokens} | Total: ${event.totalTokens}`,
      );
    }
  };

  const engine = new JoyAgentEngine({ model, bridge, onEvent: eventLogger });

  const runId = `cli-${Date.now().toString(36)}`;
  out.info(
    `Connecting to Joy Agent with model ${c(config.modelId, 'bold')} (${config.provider})...`,
  );

  // Our own deadline (<= the engine's 180 s cap). The engine reports an abort
  // that lands mid-body as an unrelated error code, so remember it ourselves.
  const timeoutMs = agentTimeoutMs();
  const deadline = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, timeoutMs);
  let runResult;
  try {
    runResult = await engine.run(
      {
        taskKind: options.taskKind ?? 'joy-code-edit',
        runId,
        baseRevision: `rev-${options.revision}`,
        request: options.prompt,
        context: {
          projectId: options.project.id,
          title: options.project.title,
        },
      },
      deadline.signal,
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : 'JOY_AGENT_PROVIDER_INCOMPATIBLE';
    const status = traffic.lastStatus;
    throw new AgentRunError(
      timedOut ? 'JOY_AGENT_TIMEOUT' : code,
      explainFailure(code, traffic, config.baseUrl, config.modelId, timedOut, timeoutMs),
      status !== undefined && status >= 400 ? status : undefined,
    );
  } finally {
    clearTimeout(timer);
  }

  out.line(); // newline after text-deltas
  out.success(`Joy Agent finished in ${runResult.steps} step(s).`);

  const staged = bridge.getStagedOperations();
  const applyStaged = (): ApplyOutcome => applyAllOrNothing(bridge, options.project);

  let outcome: ApplyOutcome = {
    applied: false,
    updatedProject: options.project,
    appliedCount: 0,
    errors: [],
  };
  if (options.apply) {
    out.info('Applying staged operations to project...');
    outcome = applyStaged();
    if (outcome.errors.length > 0) {
      out.warn(
        `Refusing to apply: ${outcome.errors.length} staged operation(s) are invalid, so nothing was changed:`,
      );
      for (const err of outcome.errors) out.line(`  ${c('!', 'yellow')} ${err}`);
    } else {
      out.success(`Successfully applied ${outcome.appliedCount} operation(s).`);
    }
  }

  return {
    ...outcome,
    resultText: runResult.text,
    capability: runResult.capability,
    steps: runResult.steps,
    staged,
    modelId: config.modelId,
    provider: config.provider,
    applyStaged,
  };
}

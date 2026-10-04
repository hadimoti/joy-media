/* global console */
import {
  JoyAgentEngine,
  type JoyAgentSafeEvent,
  type JoyAgentTaskKind,
  type JoyAgentProbeResult,
  KILO_MODEL_PRESETS,
} from '@joy-media/joy-agent-engine';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { c, logInfo, logStep, logSuccess, logWarn } from '../utils/logger.js';
import {
  CliJoyAgentToolBridge,
  type AppliedTimelineSummary,
  type StagedOperationsSummary,
} from './bridge.js';
import {
  createModelFromConfig,
  resolveByokConfig,
  type ResolveProviderOptions,
} from './provider.js';

export interface RunAgentOptions {
  readonly project: JoyProjectV1;
  readonly revision: number;
  readonly prompt: string;
  readonly taskKind?: JoyAgentTaskKind | undefined;
  readonly apply?: boolean | undefined;
  readonly allowFrames?: boolean | undefined;
  readonly vision?: boolean | undefined;
  readonly providerOptions?: ResolveProviderOptions | undefined;
  readonly onEvent?: ((event: JoyAgentSafeEvent) => void) | undefined;
  readonly onStagedChange?: ((summary: StagedOperationsSummary) => void) | undefined;
}

export interface RunAgentOutput {
  readonly resultText: string;
  readonly capability: string;
  readonly steps: number;
  readonly staged: StagedOperationsSummary;
  readonly applied: boolean;
  readonly updatedProject: JoyProjectV1;
  readonly appliedCount: number;
  readonly errors: string[];
  readonly notes: string[];
  readonly placementSummary?: AppliedTimelineSummary;
  readonly resolvedModelId?: string;
}

export async function probeAgent(providerOptions?: ResolveProviderOptions): Promise<{
  capability: string;
  provider: string;
  modelId: string;
  resolvedModelId?: string;
  failure?: JoyAgentProbeResult['failure'];
}> {
  const config = await resolveByokConfig(providerOptions);
  const model = createModelFromConfig(config);
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

  const engine = new JoyAgentEngine({ model, bridge, apiKeyForRedaction: config.apiKey });
  const probeResult = await engine.probe();
  return {
    capability: probeResult.capability,
    provider: config.provider,
    modelId: config.modelId,
    ...(probeResult.resolvedModelId ? { resolvedModelId: probeResult.resolvedModelId } : {}),
    ...(probeResult.failure ? { failure: probeResult.failure } : {}),
  };
}

export async function runJoyAgent(options: RunAgentOptions): Promise<RunAgentOutput> {
  const config = await resolveByokConfig(options.providerOptions);
  const model = createModelFromConfig(config);

  const bridge = new CliJoyAgentToolBridge(
    options.project,
    options.revision,
    options.onStagedChange,
    options.apply ?? false,
  );

  const eventLogger = (event: JoyAgentSafeEvent): void => {
    options.onEvent?.(event);
    if (event.type === 'activity') {
      logStep('Agent Phase', `${event.phase} (${event.activityCode})`);
    } else if (event.type === 'text-delta') {
      // The model's prose is not authoritative about what was applied.
    } else if (event.type === 'proposal') {
      console.log();
      logInfo(`Staged proposal: ${event.operationCount} operations (hash: ${event.proposalHash})`);
    } else if (event.type === 'usage') {
      logStep(
        'Token Usage',
        `Prompt: ${event.inputTokens} | Output: ${event.outputTokens} | Total: ${event.totalTokens}`,
      );
    }
  };

  const engine = new JoyAgentEngine({
    model,
    bridge,
    modelId: config.modelId,
    allowFrames: options.allowFrames === true,
    vision:
      options.vision === true ||
      config.vision === true ||
      KILO_MODEL_PRESETS.some((preset) => preset.id === config.modelId && preset.vision),
    onEvent: eventLogger,
    apiKeyForRedaction: config.apiKey,
  });

  const runId = `cli-${Date.now().toString(36)}`;
  logInfo(
    `Connecting to Joy Agent with model ${c(config.modelId, 'bold')} (${config.provider})...`,
  );

  const runResult = await engine.run({
    taskKind: options.taskKind ?? 'joy-code-edit',
    runId,
    baseRevision: `rev-${options.revision}`,
    request: options.prompt,
    context: {
      projectId: options.project.id,
      title: options.project.title,
    },
  });

  console.log(); // newline after text-deltas
  logSuccess(`Joy Agent finished in ${runResult.steps} step(s).`);
  if (runResult.resolvedModelId && runResult.resolvedModelId !== config.modelId) {
    logInfo(`Model: ${config.modelId} → ${runResult.resolvedModelId}`);
  }

  const staged = bridge.getStagedOperations();

  let updatedProject = options.project;
  let appliedCount = 0;
  let errors: string[] = [];
  let notes: string[] = [];
  let applied = false;
  let placementSummary: AppliedTimelineSummary | undefined;

  if (options.apply) {
    logInfo('Applying staged operations to project...');
    const applyRes = bridge.applyStaged();
    updatedProject = applyRes.updatedProject;
    appliedCount = applyRes.appliedCount;
    errors = applyRes.errors;
    notes = applyRes.notes;
    placementSummary = applyRes.placementSummary;
    applied = applyRes.errors.length === 0 && applyRes.appliedCount > 0;
    if (errors.length > 0) {
      logWarn(
        applied
          ? `Applied with ${errors.length} warning(s):`
          : `Apply refused with ${errors.length} error(s):`,
      );
      for (const err of errors) console.log(`  ${c('!', 'yellow')} ${err}`);
    }
  }

  return {
    resultText: truthfulAgentSummary({
      applyRequested: options.apply === true,
      applied,
      appliedCount,
      errors,
      notes,
      staged,
    }),
    capability: runResult.capability,
    steps: runResult.steps,
    staged,
    applied,
    updatedProject,
    appliedCount,
    errors,
    notes,
    ...(placementSummary === undefined ? {} : { placementSummary }),
    ...(runResult.resolvedModelId ? { resolvedModelId: runResult.resolvedModelId } : {}),
  };
}

export function truthfulAgentSummary(input: {
  readonly applyRequested: boolean;
  readonly applied: boolean;
  readonly appliedCount: number;
  readonly errors: readonly string[];
  readonly notes: readonly string[];
  readonly staged: StagedOperationsSummary;
}): string {
  const operations = [...input.staged.timelineOps, ...input.staged.documentOps];
  const descriptions = operations.map((operation) => `${operation.kind} (${operation.id})`);
  if (input.applyRequested && input.applied) {
    if (input.appliedCount === 0) return 'No changes were applied.';
    const applied = descriptions.slice(0, input.appliedCount);
    return [`Applied ${input.appliedCount} change(s): ${applied.join(', ')}.`, ...input.notes].join(
      ' ',
    );
  }
  if (input.applyRequested && input.errors.length > 0)
    return `No changes were applied. The apply was rejected: ${input.errors.join('; ')}`;
  if (operations.length > 0)
    return `Prepared ${operations.length} change(s) for review: ${descriptions.join(', ')}. Nothing was applied.`;
  return 'No project changes were made.';
}

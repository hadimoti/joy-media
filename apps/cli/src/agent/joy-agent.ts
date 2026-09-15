/* global console, process */
import {
  JoyAgentEngine,
  type JoyAgentSafeEvent,
  type JoyAgentTaskKind,
} from '@joy-media/joy-agent-engine';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { c, logInfo, logStep, logSuccess, logWarn } from '../utils/logger.js';
import { CliJoyAgentToolBridge, type StagedOperationsSummary } from './bridge.js';
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
}

export async function probeAgent(
  providerOptions?: ResolveProviderOptions,
): Promise<{ capability: string; provider: string; modelId: string }> {
  const config = resolveByokConfig(providerOptions);
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

  const engine = new JoyAgentEngine({ model, bridge });
  const probeResult = await engine.probe();
  return {
    capability: probeResult.capability,
    provider: config.provider,
    modelId: config.modelId,
  };
}

export async function runJoyAgent(options: RunAgentOptions): Promise<RunAgentOutput> {
  const config = resolveByokConfig(options.providerOptions);
  const model = createModelFromConfig(config);

  const bridge = new CliJoyAgentToolBridge(
    options.project,
    options.revision,
    options.onStagedChange,
  );

  const eventLogger = (event: JoyAgentSafeEvent): void => {
    options.onEvent?.(event);
    if (event.type === 'activity') {
      logStep('Agent Phase', `${event.phase} (${event.activityCode})`);
    } else if (event.type === 'text-delta') {
      process.stdout.write(c(event.text, 'dim'));
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
    onEvent: eventLogger,
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

  const staged = bridge.getStagedOperations();

  let updatedProject = options.project;
  let appliedCount = 0;
  let errors: string[] = [];
  let applied = false;

  if (options.apply) {
    logInfo('Applying staged operations to project...');
    const applyRes = bridge.applyStaged();
    updatedProject = applyRes.updatedProject;
    appliedCount = applyRes.appliedCount;
    errors = applyRes.errors;
    applied = true;
    if (errors.length > 0) {
      logWarn(`Applied with ${errors.length} warning(s):`);
      for (const err of errors) console.log(`  ${c('!', 'yellow')} ${err}`);
    } else {
      logSuccess(`Successfully applied ${appliedCount} operation(s).`);
    }
  }

  return {
    resultText: runResult.text,
    capability: runResult.capability,
    steps: runResult.steps,
    staged,
    applied,
    updatedProject,
    appliedCount,
    errors,
  };
}

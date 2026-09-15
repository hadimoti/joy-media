/* global console */
import { probeAgent, runJoyAgent } from '../agent/joy-agent.js';
import { startAgentRepl } from '../agent/repl.js';
import { loadCliConfig, saveCliConfig } from '../utils/config.js';
import {
  c,
  logError,
  logInfo,
  logStep,
  logSuccess,
  logWarn,
  printBanner,
} from '../utils/logger.js';
import {
  createDefaultProject,
  listProjects,
  loadProject,
  saveProject,
} from '../utils/project-loader.js';

export interface AgentCommandFlags {
  project?: string | undefined;
  apply?: boolean | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}

export async function handleAgentCommand(
  args: string[],
  flags: AgentCommandFlags,
): Promise<number> {
  const sub = args[0] ?? 'chat';

  if (sub === 'probe') {
    printBanner();
    logInfo('Probing LLM provider capabilities...');
    try {
      const res = await probeAgent({
        provider: flags.provider,
        model: flags.model,
        apiKey: flags.apiKey,
        baseUrl: flags.baseUrl,
      });
      console.log();
      logSuccess(`Probe Successful!`);
      logStep('Provider', res.provider);
      logStep('Model ID', res.modelId);
      logStep('Capability', c(res.capability, res.capability === 'tool-loop' ? 'green' : 'yellow'));
      return 0;
    } catch (err) {
      logError(`Probe failed: ${String(err)}`);
      return 1;
    }
  }

  if (sub === 'config') {
    const current = loadCliConfig();
    if (flags.provider || flags.model || flags.baseUrl) {
      const updated = {
        ...current,
        ...(flags.provider ? { activeProvider: flags.provider } : {}),
        ...(flags.model ? { defaultModel: flags.model } : {}),
        ...(flags.baseUrl ? { customBaseUrl: flags.baseUrl } : {}),
      };
      saveCliConfig(updated);
      logSuccess('Updated CLI configuration.');
    }
    const finalCfg = loadCliConfig();
    console.log(`\n  ${c('Current Joy Agent Configuration:', 'bold')}`);
    logStep('Active Provider', finalCfg.activeProvider ?? 'openrouter (default)');
    logStep('Default Model', finalCfg.defaultModel ?? 'anthropic/claude-3.7-sonnet');
    logStep('Custom Base URL', finalCfg.customBaseUrl ?? 'none');
    return 0;
  }

  // Resolve target project
  let projectInfo;
  if (flags.project) {
    try {
      projectInfo = loadProject(flags.project);
    } catch (err) {
      logError(`Failed to load project "${flags.project}": ${String(err)}`);
      return 1;
    }
  } else {
    // Pick the newest project from SQLite or create a scratch project
    const available = listProjects();
    if (available.length > 0) {
      const newest = available[0]!;
      projectInfo = loadProject(newest.id);
      logInfo(
        `Using active project: ${c(projectInfo.project.title, 'bold')} (${projectInfo.project.id})`,
      );
    } else {
      logWarn('No existing projects found in database. Initializing default project...');
      const scratch = createDefaultProject('Default Project');
      projectInfo = {
        project: scratch,
        revision: 1,
        source: 'sqlite' as const,
        path: 'in-memory',
      };
    }
  }

  if (sub === 'chat') {
    await startAgentRepl({
      project: projectInfo.project,
      revision: projectInfo.revision,
      source: projectInfo.source,
      path: projectInfo.path,
      providerOptions: {
        provider: flags.provider,
        model: flags.model,
        apiKey: flags.apiKey,
        baseUrl: flags.baseUrl,
      },
    });
    return 0;
  }

  if (sub === 'run') {
    const prompt = args.slice(1).join(' ').trim();
    if (!prompt) {
      logError('Usage: joy-media agent run "<instruction>" [--project <id>] [--apply]');
      return 1;
    }

    printBanner();
    logInfo(`Running Joy Agent on project: ${c(projectInfo.project.title, 'bold')}`);
    logStep('Prompt', prompt);

    try {
      const output = await runJoyAgent({
        project: projectInfo.project,
        revision: projectInfo.revision,
        prompt,
        apply: flags.apply,
        providerOptions: {
          provider: flags.provider,
          model: flags.model,
          apiKey: flags.apiKey,
          baseUrl: flags.baseUrl,
        },
      });

      if (output.applied && projectInfo.source === 'sqlite') {
        const nextRev = saveProject(output.updatedProject, {
          source: projectInfo.source,
          path: projectInfo.path,
          revision: projectInfo.revision,
        });
        logSuccess(`Committed changes at project revision ${nextRev}.`);
      }

      return 0;
    } catch (err) {
      logError(`Joy Agent execution failed: ${String(err)}`);
      return 1;
    }
  }

  logError(`Unknown agent subcommand: ${sub}`);
  console.log(
    `Available: ${c('chat', 'cyan')}, ${c('run', 'cyan')}, ${c('probe', 'cyan')}, ${c('config', 'cyan')}`,
  );
  return 1;
}

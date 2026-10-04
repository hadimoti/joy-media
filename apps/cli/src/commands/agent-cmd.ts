/* global console */
import {
  DEFAULT_KILO_MODEL,
  KILO_GATEWAY_BASE_URL,
  KILO_MODEL_PRESETS,
  OPENROUTER_BASE_URL,
  canonicalKiloBaseUrl,
  defaultModelFor,
} from '@joy-media/joy-agent-engine';
import { JoyAgentRunError } from '@joy-media/joy-agent-engine';
import { describeEffectiveConfig } from '../agent/provider.js';
import type { CliFlags } from '../cli.js';
import { probeAgent, runJoyAgent } from '../agent/joy-agent.js';
import { startAgentRepl } from '../agent/repl.js';
import {
  deleteAiProvider,
  loadAiProviders,
  loadCliConfig,
  saveCliConfig,
  setAiProvider,
} from '../utils/config.js';
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
  name?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}

export function formatAgentRunFailure(error: unknown, debug: boolean): string {
  if (!(error instanceof JoyAgentRunError)) return 'Joy Agent execution failed: JOY_AGENT_UNKNOWN';
  return `Joy Agent execution failed: ${error.code}${debug ? `\nDebug detail: ${JSON.stringify(error.detail)}` : ''}`;
}

export async function handleAgentCommand(args: string[], flags: CliFlags): Promise<number> {
  const sub = args[0] ?? 'chat';

  if (sub === 'provider') {
    const action = args[1] ?? 'list';

    if (action === 'list' || action === 'ls') {
      const providers = loadAiProviders();
      const cfg = loadCliConfig();
      const active = cfg.activeProvider ?? 'openrouter';

      console.log(`\n  ${c('Configured AI Providers:', 'bold')}\n`);
      const keys = Object.keys(providers);
      if (keys.length === 0) {
        logInfo(
          'No custom providers configured yet. Use "joy-media agent provider add" to add one.',
        );
      } else {
        for (const key of keys) {
          const p = providers[key]!;
          const isActive = key === active || (p.name && p.name === active);
          const marker = isActive ? c('● [ACTIVE]', 'green') : c('○', 'dim');
          console.log(`  ${marker} ${c(key, 'bold')} (${p.provider ?? 'custom'})`);
          logStep('  Base URL', p.baseUrl ?? 'default');
          logStep('  Default Model', p.defaultModel ?? 'not-set');
          logStep(
            '  API Key',
            p.apiKey ? `${p.apiKey.slice(0, 4)}...${p.apiKey.slice(-4)}` : 'none',
          );
          if (p.cachedModels && p.cachedModels.length > 0) {
            logStep('  Discovered Models', `${p.cachedModels.length} models cached`);
          }
          console.log();
        }
      }
      return 0;
    }

    if (action === 'add') {
      const name = args[2] ?? flags.name;
      if (!name) {
        logError(
          'Provider name required. Usage: joy-media agent provider add <name> --url <url> --api-key <key> [--model <model>]',
        );
        return 1;
      }
      if (!flags.baseUrl) {
        logError('Base URL required. Specify --url <url>');
        return 1;
      }

      let cachedModels: string[] | undefined;
      // Try to discover models behind link
      try {
        const normalized = flags.baseUrl.replace(/\/+$/, '');
        const headers: Record<string, string> = {};
        if (flags.apiKey) headers['Authorization'] = `Bearer ${flags.apiKey}`;
        const res = await fetch(`${normalized}/models`, { headers });
        if (res.ok) {
          const json = (await res.json()) as { data?: unknown };
          const raw = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
          cachedModels = raw
            .map((item: { id?: string } | string) => (typeof item === 'string' ? item : item.id))
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
          if (cachedModels.length > 0) {
            logInfo(`Discovered ${cachedModels.length} models from endpoint.`);
          }
        }
      } catch {
        // Model discovery is optional
      }

      const providerType =
        flags.provider ??
        (flags.baseUrl.includes('kilo')
          ? 'kilo'
          : flags.baseUrl.includes('openrouter')
            ? 'openrouter'
            : 'custom');
      const defaultModel =
        flags.model ??
        (providerType === 'kilo'
          ? (cachedModels?.find((id) => KILO_MODEL_PRESETS.some((preset) => preset.id === id)) ??
            DEFAULT_KILO_MODEL)
          : (defaultModelFor(providerType) ?? cachedModels?.[0]));

      setAiProvider(name, {
        name,
        provider: providerType,
        baseUrl: providerType === 'kilo' ? canonicalKiloBaseUrl(flags.baseUrl) : flags.baseUrl,
        apiKey: flags.apiKey,
        defaultModel,
        cachedModels,
      });

      logSuccess(`Provider "${name}" configured successfully!`);
      logStep(
        'Base URL',
        providerType === 'kilo' ? canonicalKiloBaseUrl(flags.baseUrl) : flags.baseUrl,
      );
      if (defaultModel) {
        logStep('Default Model', defaultModel);
      }
      return 0;
    }

    if (action === 'use') {
      const name = args[2] ?? flags.name;
      if (!name) {
        logError('Provider name required. Usage: joy-media agent provider use <name>');
        return 1;
      }
      const providers = loadAiProviders();
      if (!providers[name] && name !== 'openrouter' && name !== 'kilo' && name !== 'openai') {
        logError(
          `Unknown provider "${name}". Run "joy-media agent provider list" to see available providers.`,
        );
        return 1;
      }
      const current = loadCliConfig();
      const updated = {
        ...current,
        activeProvider: name,
        ...(providers[name]?.defaultModel ? { defaultModel: providers[name]!.defaultModel } : {}),
      };
      saveCliConfig(updated);
      logSuccess(`Active provider set to "${name}".`);
      if (providers[name]?.defaultModel) {
        logStep('Default Model', providers[name]!.defaultModel);
      }
      return 0;
    }

    if (action === 'remove' || action === 'delete' || action === 'rm') {
      const name = args[2] ?? flags.name;
      if (!name) {
        logError('Provider name required. Usage: joy-media agent provider remove <name>');
        return 1;
      }
      if (deleteAiProvider(name)) {
        logSuccess(`Provider "${name}" removed.`);
        const cfg = loadCliConfig();
        if (cfg.activeProvider === name) {
          const { activeProvider: _, ...rest } = cfg;
          saveCliConfig(rest);
        }
        return 0;
      } else {
        logError(`Provider "${name}" not found.`);
        return 1;
      }
    }

    logError(`Unknown provider action "${action}". Available actions: list, add, use, remove`);
    return 1;
  }

  if (sub === 'models') {
    const targetProviderName =
      args[1] ?? flags.provider ?? loadCliConfig().activeProvider ?? 'openrouter';
    const providers = loadAiProviders();
    const providerConfig = providers[targetProviderName];

    let baseUrl = flags.baseUrl ?? providerConfig?.baseUrl;
    let apiKey = flags.apiKey ?? providerConfig?.apiKey;

    if (!baseUrl) {
      if (targetProviderName === 'kilo') {
        baseUrl = KILO_GATEWAY_BASE_URL;
        apiKey = apiKey ?? process.env.KILO_API_KEY;
      } else if (targetProviderName === 'openrouter') {
        baseUrl = OPENROUTER_BASE_URL;
        apiKey = apiKey ?? process.env.OPENROUTER_API_KEY;
      } else {
        logError(`No baseUrl found for provider "${targetProviderName}". Specify --url <url>`);
        return 1;
      }
    }

    printBanner();
    logInfo(`Fetching models from ${c(baseUrl, 'bold')}...`);

    try {
      const normalized = baseUrl.replace(/\/+$/, '');
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await fetch(`${normalized}/models`, { headers });
      if (!res.ok) {
        throw new Error(`Endpoint returned HTTP ${res.status}: ${res.statusText}`);
      }
      const json = (await res.json()) as { data?: unknown };
      const raw = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
      const modelIds: string[] = raw
        .map((item: { id?: string } | string) => (typeof item === 'string' ? item : item.id))
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      console.log(`\n  ${c(`Discovered ${modelIds.length} models:`, 'bold')}\n`);
      for (const id of modelIds) {
        console.log(`  • ${id}`);
      }
      console.log();

      // Save to cache
      if (providerConfig) {
        setAiProvider(targetProviderName, {
          ...providerConfig,
          cachedModels: modelIds,
        });
      }

      return 0;
    } catch (err) {
      logError(`Failed to fetch models: ${String(err)}`);
      return 1;
    }
  }

  if (sub === 'model') {
    const action = args[1] ?? 'get';
    if (action === 'set') {
      const modelId = args[2] ?? flags.model;
      if (!modelId) {
        logError('Model ID required. Usage: joy-media agent model set <model-id>');
        return 1;
      }
      const cfg = loadCliConfig();
      saveCliConfig({ ...cfg, defaultModel: modelId });
      logSuccess(`Default model set to "${modelId}".`);
      return 0;
    }
    const effective = describeEffectiveConfig({
      provider: flags.provider,
      model: flags.model,
      baseUrl: flags.baseUrl,
    });
    logInfo(`Effective model: ${effective.modelId} (source: ${effective.source})`);
    logStep('Provider', `${effective.provider} (source: ${effective.source})`);
    return 0;
  }

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
    const effective = describeEffectiveConfig();
    console.log(`\n  ${c('Current Joy Agent Configuration:', 'bold')}`);
    logStep('Active Provider', `${effective.provider} (source: ${effective.source})`);
    logStep('Default Model', `${effective.modelId} (source: ${effective.source})`);
    logStep('Effective Base URL', effective.baseUrl);
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
    if (flags.model) {
      console.log();
      logInfo(
        `${c('Dual-Brain:', 'bold')} ${c('Active', 'green')}  ` +
          `${c('Workhorse', 'cyan')}=openrouter/${c('openrouter/free', 'magenta')}  ` +
          `${c('Creative', 'cyan')}=kilo/${c(DEFAULT_KILO_MODEL, 'magenta')}`,
      );
      logStep('Override model', flags.model);
    }
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
      logError(formatAgentRunFailure(err, flags.debug || process.env.JOY_DEBUG === '1'));
      return 1;
    }
  }

  logError(`Unknown agent subcommand: ${sub}`);
  console.log(
    `Available: ${c('chat', 'cyan')}, ${c('run', 'cyan')}, ${c('probe', 'cyan')}, ${c('config', 'cyan')}`,
  );
  return 1;
}

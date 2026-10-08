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
import { AgentSetupError, describeEffectiveConfig } from '../agent/provider.js';
import type { CliFlags } from '../cli.js';
import {
  formatAgentTraceLine,
  probeAgent,
  runJoyAgent,
  truthfulAgentSummary,
  type RunAgentOutput,
} from '../agent/joy-agent.js';
import { startAgentRepl } from '../agent/repl.js';
import {
  deleteAiProvider,
  loadAiProviders,
  loadCliConfig,
  saveCliConfig,
  setAiProvider,
} from '../utils/config.js';
import { protectSecret } from '../utils/secret-store.js';
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
  keepPartial?: boolean | undefined;
  allowFrames?: boolean | undefined;
  name?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}

/** The JOY gateway's `{"error":{"code","message"}}`, read from a possibly truncated body. */
export function gatewayErrorFromBody(
  body: string,
): { readonly code: string; readonly message?: string } | undefined {
  const code = /"code"\s*:\s*"([A-Z0-9_]{1,64})"/.exec(body)?.[1];
  if (code === undefined) return undefined;
  const rawMessage = /"message"\s*:\s*"((?:[^"\\]|\\.){0,400})"/.exec(body)?.[1];
  let message: string | undefined;
  if (rawMessage !== undefined) {
    try {
      message = JSON.parse(`"${rawMessage}"`) as string;
    } catch {
      message = rawMessage;
    }
    const printable = [...message].filter((char) => {
      const point = char.codePointAt(0) ?? 0;
      // C0, DEL and C1 (0x80-0x9F, e.g. the 8-bit CSI 0x9B) would drive the terminal.
      return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
    });
    message = printable.join('').trim().slice(0, 200) || undefined;
  }
  return message === undefined ? { code } : { code, message };
}

export function formatAgentRunFailure(error: unknown, debug: boolean): string {
  if (error instanceof AgentSetupError) return `Joy Agent execution failed: ${error.message}`;
  if (!(error instanceof JoyAgentRunError)) {
    const message = error instanceof Error ? error.message : '';
    if (/^No API key for [^:]+:/.test(message))
      return `Joy Agent execution failed: JOY_AGENT_NO_API_KEY (${message})`;
    return 'Joy Agent execution failed: JOY_AGENT_UNKNOWN';
  }
  const debugSuffix = debug ? `\nDebug detail: ${JSON.stringify(error.detail)}` : '';
  const gateway = gatewayErrorFromBody(error.detail.responseBodySnippet);
  const status = error.detail.statusCode;
  const httpNote = status === undefined ? '' : `, HTTP ${status}`;
  if (status === 402 && gateway?.code === 'JOY_SUBSCRIPTION_REQUIRED') {
    return `Joy Agent execution failed: JOY_SUBSCRIPTION_REQUIRED (an active JOY Pro subscription is required)${debugSuffix}`;
  }
  if (error.code === 'JOY_AGENT_RATE_LIMITED') {
    return `Joy Agent execution failed: JOY_AGENT_RATE_LIMITED (${error.detail.message})${debugSuffix}`;
  }
  if (
    gateway?.code === 'JOY_AGENT_UPSTREAM_AUTH_FAILED' ||
    gateway?.code === 'JOY_AGENT_UNCONFIGURED'
  ) {
    const reason = gateway.message ?? 'the hosted model provider is not available';
    return `Joy Agent execution failed: JOY_AGENT_UPSTREAM_UNAVAILABLE (JOY hosted service: ${reason} (${gateway.code}${httpNote}); this is a JOY server problem, not a problem with your network or account)${debugSuffix}`;
  }
  if (gateway !== undefined) {
    const serverDetail = gateway.message ? `${gateway.code}: ${gateway.message}` : gateway.code;
    return `Joy Agent execution failed: ${error.code} (server: ${serverDetail}${httpNote})${debugSuffix}`;
  }
  return `Joy Agent execution failed: ${error.code}${debugSuffix}`;
}

export function printAgentHelp(): void {
  console.log(`Usage: joy-media agent <chat|run|probe|config|provider|models|model> [options]

Commands:
  chat                         Start the interactive assistant
  run <instruction>            Run an edit request (add --apply to save)
  probe                        Check provider tool-calling capability
  config                       Show or set provider/model defaults
  provider <list|add|use|remove>
    provider add <name> --base-url|--url <url> [--api-key|--api-key-env <VAR>]
  models                       Fetch available models
  model <get|set>              Show or change the model

  Options: --project <id|file> --apply --allow-frames --vision --provider <name> --model <id>
         --api-key-env <VAR> --base-url <url> --debug --json
         --keep-partial             Save successful operations from a partial checklist run (still exits 1)

On Linux/macOS, --api-key uses the system keyring. If unavailable, use --api-key-env <VAR>,
or explicitly opt in to plaintext with --insecure-file-store (mode 0600).`);
}

export async function handleAgentCommand(args: string[], flags: CliFlags): Promise<number> {
  const sub = args[0] ?? 'chat';

  if (sub === 'help') {
    printAgentHelp();
    return 0;
  }

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
          const apiKeyLabel = p.apiKeyEnv
            ? `from env $${p.apiKeyEnv}`
            : p.apiKeyProtected
              ? `stored (${p.apiKeyProtected.scheme === 'dpapi-user' ? 'DPAPI' : p.apiKeyProtected.scheme})`
              : p.apiKey
                ? 'stored (legacy; will migrate on load)'
                : 'none';
          logStep('  API Key', apiKeyLabel);
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
          'Provider name required. Usage: joy-media agent provider add <name> --base-url|--url <url> [--api-key <key>] [--model <model>]',
        );
        return 1;
      }
      if (!flags.baseUrl) {
        logError('Base URL required. Specify --base-url <url> (alias: --url <url>).');
        return 1;
      }

      let cachedModels: string[] | undefined;
      // Try to discover models behind link
      try {
        if (flags.apiKey) throw new Error('Skip network model discovery when a key is supplied.');
        const normalized = flags.baseUrl.replace(/\/+$/, '');
        const headers: Record<string, string> = {};
        const discoveryKey =
          flags.apiKey ?? (flags.apiKeyEnv ? process.env[flags.apiKeyEnv] : undefined);
        if (discoveryKey) headers['Authorization'] = `Bearer ${discoveryKey}`;
        const res = await fetch(`${normalized}/models`, { headers });
        if (res.ok) {
          const json = (await res.json()) as { data?: unknown };
          const raw = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
          cachedModels = raw
            .map((item: { id?: string } | string) => (typeof item === 'string' ? item : item.id))
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
          if (cachedModels.length > 0 && !flags.json) {
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

      try {
        setAiProvider(name, {
          name,
          provider: providerType,
          baseUrl: providerType === 'kilo' ? canonicalKiloBaseUrl(flags.baseUrl) : flags.baseUrl,
          apiKeyEnv: flags.apiKeyEnv,
          ...(flags.apiKey
            ? {
                apiKeyProtected: protectSecret(flags.apiKey, name, {
                  insecureFileStore: flags.insecureFileStore,
                }),
              }
            : {}),
          defaultModel,
          cachedModels,
        });
      } catch (error) {
        logError(error instanceof Error ? error.message : 'Unable to store API key safely.');
        return 1;
      }

      const warning =
        flags.apiKey && flags.insecureFileStore && process.platform !== 'win32'
          ? 'API key stored in a plaintext mode 0600 file by explicit opt-in.'
          : undefined;
      if (flags.json) {
        console.log(
          JSON.stringify({
            type: 'provider',
            name,
            provider: providerType,
            baseUrl: providerType === 'kilo' ? canonicalKiloBaseUrl(flags.baseUrl) : flags.baseUrl,
            ...(defaultModel === undefined ? {} : { defaultModel }),
            cachedModels: cachedModels ?? [],
          }),
        );
      } else {
        logSuccess(`Provider "${name}" configured successfully!`);
      }
      if (warning && flags.json) {
        console.log(JSON.stringify({ type: 'warning', warning }));
      } else if (warning) {
        console.error(`Warning: ${warning}`);
      }
      if (!flags.json) {
        logStep(
          'Base URL',
          providerType === 'kilo' ? canonicalKiloBaseUrl(flags.baseUrl) : flags.baseUrl,
        );
        if (defaultModel) {
          logStep('Default Model', defaultModel);
        }
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
      const updated = { ...current, activeProvider: name };
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
      let deleted: boolean;
      try {
        deleted = deleteAiProvider(name);
      } catch (error) {
        logError(error instanceof Error ? error.message : 'Unable to remove provider safely.');
        return 1;
      }
      if (deleted) {
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
      const provider = flags.provider ?? cfg.activeProvider ?? 'openrouter';
      saveCliConfig({
        ...cfg,
        defaultModels: { ...(cfg.defaultModels ?? {}), [provider]: modelId },
      });
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
        apiKeyEnv: flags.apiKeyEnv,
        baseUrl: flags.baseUrl,
      });
      console.log();
      logStep('Provider', res.provider);
      logStep('Model ID', res.modelId);
      if (res.resolvedModelId && res.resolvedModelId !== res.modelId) {
        logStep('Resolved model', res.resolvedModelId);
      }
      logStep('Capability', c(res.capability, res.capability === 'tool-loop' ? 'green' : 'yellow'));
      if (res.capability === 'incompatible') {
        logError('Probe failed: model is incompatible (no tool-calling capability).');
        return 1;
      }
      if (res.failure) {
        const detail = res.failure.detail;
        const providerMessage = detail?.message || detail?.responseBodySnippet || res.failure.code;
        const status = detail?.statusCode;
        logError(
          status === undefined
            ? `Probe failed: ${providerMessage}`
            : `Probe failed (HTTP ${status}): ${providerMessage}`,
        );
        return 1;
      }
      if (res.capability === 'plan-only') logWarn('Probe OK: plan-only (no tool calling)');
      else logSuccess('Probe Successful!');
      return 0;
    } catch (err) {
      logError(`Probe failed: ${String(err)}`);
      return 1;
    }
  }

  if (sub === 'config') {
    const current = loadCliConfig();
    if (flags.apiKey) {
      logError(
        'agent config does not store API keys. Use `joy-media agent provider add <name> --api-key <key>` or --api-key-env <VAR>.',
      );
      return 1;
    }
    if (flags.provider || flags.model || flags.baseUrl) {
      const provider = flags.provider ?? current.activeProvider ?? 'openrouter';
      const updated = {
        ...current,
        ...(flags.provider ? { activeProvider: flags.provider } : {}),
        ...(flags.model
          ? { defaultModels: { ...(current.defaultModels ?? {}), [provider]: flags.model } }
          : {}),
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
      if (!flags.json)
        logInfo(
          `Using active project: ${c(projectInfo.project.title, 'bold')} (${projectInfo.project.id})`,
        );
    } else {
      if (!flags.json)
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
        apiKeyEnv: flags.apiKeyEnv,
        baseUrl: flags.baseUrl,
      },
      allowFrames: flags.allowFrames,
      vision: flags.vision,
    });
    return 0;
  }

  if (sub === 'run') {
    const prompt = args.slice(1).join(' ').trim();
    if (!prompt) {
      logError('Usage: joy-media agent run "<instruction>" [--project <id>] [--apply]');
      return 1;
    }

    if (!flags.json) {
      printBanner();
      logInfo(`Running Joy Agent on project: ${c(projectInfo.project.title, 'bold')}`);
      logStep('Prompt', prompt);
    }

    try {
      const output = await runJoyAgent({
        project: projectInfo.project,
        revision: projectInfo.revision,
        prompt,
        apply: flags.apply,
        keepPartial: flags.keepPartial,
        json: flags.json,
        onTrace: (record) => {
          if (flags.json) console.log(JSON.stringify(record));
          else console.log(formatAgentTraceLine(record));
        },
        allowFrames: flags.allowFrames,
        vision: flags.vision,
        providerOptions: {
          provider: flags.provider,
          model: flags.model,
          apiKey: flags.apiKey,
          apiKeyEnv: flags.apiKeyEnv,
          baseUrl: flags.baseUrl,
        },
      });

      if (flags.json) {
        if (output.applied && projectInfo.path !== 'in-memory') {
          saveProject(output.updatedProject, {
            source: projectInfo.source,
            path: projectInfo.path,
            revision: projectInfo.revision,
          });
        }
        console.log(JSON.stringify({ type: 'model_text', text: output.modelText }));
        console.log(
          JSON.stringify({
            type: 'apply_result',
            applied: output.applied,
            appliedCount: output.appliedCount,
            operationIds: output.appliedOperationIds,
            errors: output.errors,
            notes: output.notes,
            modelNotes: output.modelNotes ?? [],
            summary: output.resultText,
            checklist: output.checklist ?? [],
            verified: output.verified ?? [],
          }),
        );
        console.log(
          JSON.stringify({
            type: 'status',
            status: output.status,
            steps: output.steps,
            checklist: output.checklist ?? [],
            verified: output.verified ?? [],
          }),
        );
      } else if (flags.apply && !output.applied && output.errors.length > 0) {
        logError(`Apply refused: ${output.errors.join('; ')}`);
        return 1;
      } else {
        if (output.applied && projectInfo.path === 'in-memory') {
          logSuccess(`Applied ${output.appliedCount} operation(s) (--apply)`);
          logWarn('Changes were applied in memory; nothing was saved.');
        } else if (output.applied) {
          const nextRev = saveProject(output.updatedProject, {
            source: projectInfo.source,
            path: projectInfo.path,
            revision: projectInfo.revision,
          });
          logSuccess(`Committed changes at project revision ${nextRev}.`);
          logSuccess(`Applied ${output.appliedCount} operation(s) (--apply)`);
        } else {
          logInfo(
            truthfulAgentSummary({
              applyRequested: flags.apply,
              applied: output.applied,
              appliedCount: output.appliedCount,
              appliedOperationIds: output.appliedOperationIds,
              errors: output.errors,
              notes: output.notes,
              staged: output.staged,
            }),
          );
        }
      }
      if (output.applied && !flags.json)
        logInfo(
          truthfulAgentSummary({
            applyRequested: flags.apply,
            applied: output.applied,
            appliedCount: output.appliedCount,
            appliedOperationIds: output.appliedOperationIds,
            errors: output.errors,
            notes: output.notes,
            staged: output.staged,
          }),
        );
      if (output.applied && !flags.json) printPlacementSummary(output.placementSummary);
      if ((output.verified?.length ?? 0) > 0 && !flags.json)
        logInfo(`Verified: ${output.verified!.join('; ')}`);

      return output.status === 'partial' || (flags.apply === true && !output.applied) ? 1 : 0;
    } catch (err) {
      const failure = formatAgentRunFailure(err, flags.debug || process.env.JOY_DEBUG === '1');
      if (flags.json)
        console.log(JSON.stringify({ type: 'status', status: 'failed', error: failure }));
      else logError(failure);
      return 1;
    }
  }

  logError(`Unknown agent subcommand: ${sub}`);
  console.log(
    `Available: ${c('chat', 'cyan')}, ${c('run', 'cyan')}, ${c('probe', 'cyan')}, ${c('config', 'cyan')}`,
  );
  return 1;
}

function printPlacementSummary(summary: RunAgentOutput['placementSummary']): void {
  if (!summary) return;
  logInfo('Verified timeline placement:');
  for (const clip of summary.clips) {
    const source =
      clip.sourceInUs === undefined || clip.sourceOutUs === undefined
        ? ''
        : `, source ${seconds(clip.sourceInUs)}–${seconds(clip.sourceOutUs)}`;
    logStep(
      clip.clipId,
      `${clip.track} (${clip.trackId}), timeline ${seconds(clip.startUs)}–${seconds(clip.endUs)}${source}`,
    );
  }
  for (const gap of summary.gaps) {
    logWarn(
      `Uncovered visual track ${gap.trackId}: ${seconds(gap.startUs)}–${seconds(gap.endUs)}.`,
    );
  }
  for (const region of summary.blackRegions) {
    const hasTextOverlay = summary.clips.some(
      (clip) =>
        clip.sourceInUs === undefined && clip.startUs < region.endUs && clip.endUs > region.startUs,
    );
    logWarn(
      `Black region${hasTextOverlay ? ' (text over black)' : ' (no visual track covers this span)'}: ${seconds(region.startUs)}–${seconds(region.endUs)}.`,
    );
  }
}

function seconds(microseconds: number): string {
  return `${(microseconds / 1_000_000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}s`;
}

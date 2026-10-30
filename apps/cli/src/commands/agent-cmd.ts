/* global console, process */
import {
  AGENT_SLOT_IDS,
  AGENT_SLOT_LABELS,
  CHATGPT_RESPONSES_BASE_URL,
  MINIMAX_OAUTH_ENDPOINTS,
  defaultBaseUrl,
  evaluateEndpoint,
  findRegistryProvider,
  isAgentSlotConfigured,
  isCustomProviderId,
  parseAgentSlotId,
} from '@joy-media/provider-sdk';
import { prepareChatGptModels, readChatGptModels } from '@joy-media/joy-agent-engine';
import type { CliFlags } from '../cli.js';
import {
  isMiniMaxRegion,
  isOAuthProfileProvider,
  oauthTokenExpiry,
  signInOAuthProfile,
} from '../agent/oauth.js';
import { clearAgentSlot, loadAgentSlot, saveAgentSlot } from '../agent/agent-slots.js';
import { probeAgent, runJoyAgent } from '../agent/joy-agent.js';
import { environmentKey, inferProviderType, isRetiredProvider } from '../agent/provider.js';
import {
  getDefaultOAuthTokenManager,
  OAuthProfileLockTimeoutError,
  OAuthRefreshFailedError,
} from '../agent/oauth-runtime.js';
import { startAgentRepl } from '../agent/repl.js';
import {
  deleteAiProvider,
  loadAiProviders,
  loadCliConfig,
  openCredentialStore,
  saveCliConfig,
  setAiProvider,
} from '../utils/config.js';
import { KIMI_CODE_BASE_URL, OAuthFlowError } from '@joy-media/provider-oauth';
import type { OAuthCredential } from '../utils/credential-store.js';
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

const OAUTH_RISK_NOTICE =
  'Signing in uses a third-party public app and may stop working or be deactivated by the provider at any time. An API key is the dependable way to connect.';

/** A number from a flag. A blank value is NaN, so the slot rules refuse it instead of reading it as zero. */
function numberFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return value.trim() === '' ? Number.NaN : Number(value);
}

function oauthProfileBaseUrl(
  provider: 'chatgpt' | 'minimax' | 'kimi' | 'xai',
  region: 'global' | 'cn',
): string | undefined {
  if (provider === 'chatgpt') return CHATGPT_RESPONSES_BASE_URL;
  if (provider === 'minimax') return MINIMAX_OAUTH_ENDPOINTS[region].inferenceBase;
  if (provider === 'kimi') return KIMI_CODE_BASE_URL;
  // The registry's xAI OAuth base remains a candidate until attended verification.
  return undefined;
}

async function addOAuthProvider(name: string, flags: CliFlags): Promise<number> {
  if (flags.baseUrl !== undefined) {
    logError('--url cannot be combined with --oauth.');
    return 1;
  }
  if (flags.apiKey !== undefined) {
    logError('--api-key cannot be combined with --oauth.');
    return 1;
  }
  if (!flags.provider) {
    logError('--provider is required with --oauth.');
    return 1;
  }
  if (!isOAuthProfileProvider(flags.provider)) {
    logError(`Provider "${flags.provider}" does not offer OAuth sign-in.`);
    return 1;
  }
  if (flags.region !== undefined && flags.provider !== 'minimax') {
    logError('--region is supported only for MiniMax OAuth.');
    return 1;
  }
  if (flags.region !== undefined && !isMiniMaxRegion(flags.region)) {
    logError('--region must be "global" or "cn" for MiniMax OAuth.');
    return 1;
  }

  const providers = loadAiProviders();
  const previous = providers[name];
  if (
    previous !== undefined &&
    (previous.authKind !== 'oauth' || previous.provider !== flags.provider)
  ) {
    logError(
      `Provider profile "${name}" uses a different authentication method or provider; remove it before changing authentication.`,
    );
    return 1;
  }

  const region = flags.region === 'cn' ? 'cn' : 'global';
  const model = flags.model ?? previous?.defaultModel;
  // This exact notice is printed after every validation and before the sign-in flow can send a request.
  console.error(OAUTH_RISK_NOTICE);
  let approvalStatusShown = false;
  let credential;
  try {
    credential = await signInOAuthProfile({
      profileId: name,
      provider: flags.provider,
      region,
      onAuthorization: ({ url, userCode, expiresAt }) => {
        console.log(`Approval URL: ${url}`);
        if (userCode) console.log(`User code: ${userCode}`);
        if (expiresAt !== undefined && Number.isFinite(expiresAt)) {
          console.log(`Code expires at: ${new Date(expiresAt).toISOString()}`);
        }
        if (flags.provider === 'chatgpt') {
          console.log(
            'Open the URL in a browser on this same machine. A remote CLI with no browser on that machine cannot complete it.',
          );
        } else {
          process.stdout.write('Waiting for approval. Press Ctrl+C to cancel.');
          approvalStatusShown = true;
        }
      },
      onSlowDown: () => {
        process.stdout.write(
          '\rWaiting for approval; the provider asked us to slow down. Press Ctrl+C to cancel.',
        );
        approvalStatusShown = true;
      },
    });
  } catch (error) {
    if (error instanceof OAuthFlowError) {
      const message =
        error.code === 'TIMEOUT'
          ? 'The sign-in code expired. Run the OAuth add command again'
          : error.code === 'ACCESS_DENIED'
            ? 'Sign-in was denied.'
            : error.message;
      logError(message);
      return error.code === 'CANCELLED' ? 130 : 1;
    }
    logError('OAuth sign-in failed. No profile was changed.');
    return 1;
  } finally {
    if (approvalStatusShown) console.log();
  }

  try {
    openCredentialStore().save(name, credential);
    setAiProvider(name, {
      name,
      provider: flags.provider,
      authKind: 'oauth',
      baseUrl: oauthProfileBaseUrl(flags.provider, region),
      defaultModel: model,
    });
  } catch {
    logError('OAuth credential could not be saved.');
    return 1;
  }

  logSuccess(`Provider "${name}" configured successfully!`);
  logStep('Provider', flags.provider);
  logStep('Auth', `OAuth (${flags.provider})`);
  if (model) logStep('Default Model', model);
  if (flags.provider === 'xai') {
    logStep('Inference', 'needs attended verification');
  }
  return 0;
}

async function listOAuthModels(
  profileId: string,
  profile: NonNullable<ReturnType<typeof loadAiProviders>[string]>,
): Promise<number> {
  const provider = profile.provider;
  if (provider === 'xai') {
    logError('Inference: needs attended verification for xAI OAuth.');
    return 1;
  }
  if (provider !== 'chatgpt' && provider !== 'kimi' && provider !== 'minimax') {
    logError(`OAuth profile "${profileId}" has no supported model-list route.`);
    return 1;
  }

  let credential: OAuthCredential;
  try {
    credential = await getDefaultOAuthTokenManager().current(profileId, provider);
  } catch (error) {
    if (error instanceof OAuthProfileLockTimeoutError) {
      logError(error.message);
    } else {
      logError(new OAuthRefreshFailedError(profileId, provider).message);
    }
    return 1;
  }

  const baseUrl =
    credential.provider === 'chatgpt'
      ? CHATGPT_RESPONSES_BASE_URL
      : credential.provider === 'minimax'
        ? MINIMAX_OAUTH_ENDPOINTS[credential.tokenRecord.region].inferenceBase
        : KIMI_CODE_BASE_URL;
  printBanner();
  logInfo(`Fetching models from ${c(baseUrl, 'bold')}...`);
  try {
    const chatGptRequest =
      credential.provider === 'chatgpt'
        ? prepareChatGptModels({ accessToken: credential.tokenRecord.accessToken })
        : undefined;
    const response = await fetch(
      chatGptRequest?.url ?? `${baseUrl.replace(/\/+$/, '')}/models`,
      chatGptRequest === undefined
        ? {
            method: 'GET',
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${credential.tokenRecord.accessToken}`,
            },
          }
        : {
            method: chatGptRequest.method,
            headers: chatGptRequest.headers,
            credentials: 'omit',
            redirect: 'error',
          },
    );
    if (!response.ok) throw new Error('model list request failed');
    const modelIds =
      credential.provider === 'chatgpt'
        ? (await readChatGptModels(await response.text()))
            .map((model) => model.id)
            .filter((id) =>
              ![credential.tokenRecord.accessToken, credential.tokenRecord.refreshToken].some(
                (token) => id.includes(token),
              ),
            )
        : await readOAuthModelIds(response, credential);

    console.log(`\n  ${c(`Discovered ${modelIds.length} models:`, 'bold')}\n`);
    for (const id of modelIds) console.log(`  • ${id}`);
    console.log();
    setAiProvider(profileId, { ...profile, cachedModels: modelIds });
    return 0;
  } catch {
    logError(`Failed to fetch models for OAuth profile "${profileId}".`);
    return 1;
  }
}

async function readOAuthModelIds(
  response: Response,
  credential: OAuthCredential,
): Promise<string[]> {
  const json = (await response.json()) as { data?: unknown };
  const raw = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
  return raw
    .map((item: { id?: string } | string) => (typeof item === 'string' ? item : item.id))
    .filter((id): id is string =>
      typeof id === 'string' &&
      id.length > 0 &&
      ![credential.tokenRecord.accessToken, credential.tokenRecord.refreshToken].some((token) =>
        id.includes(token),
      ),
    );
}

export async function handleAgentCommand(args: string[], flags: CliFlags): Promise<number> {
  const sub = args[0] ?? 'chat';

  if (sub === 'provider') {
    const action = args[1] ?? 'list';

    if (action === 'list' || action === 'ls') {
      const providers = loadAiProviders();
      const cfg = loadCliConfig();
      const active = cfg.activeProvider ?? 'none';

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
          if (!(p.authKind === 'oauth' && p.provider === 'xai')) {
            logStep('  Base URL', p.baseUrl ?? 'default');
          }
          logStep('  Default Model', p.defaultModel ?? 'not-set');
          if (p.authKind === 'oauth') {
            logStep('  Auth', `OAuth (${p.provider ?? 'unknown'})`);
            let expiry = 'OAuth credential unavailable';
            try {
              const credential = openCredentialStore().read(key);
              if (
                credential !== undefined &&
                'provider' in credential &&
                credential.provider === p.provider
              ) {
                expiry = oauthTokenExpiry(credential);
              }
            } catch {
              // A listing reports only whether the secret is readable, never the stored value.
            }
            logStep('  Access token', expiry);
            if (p.provider === 'xai') {
              logStep('  Inference', 'needs attended verification');
            }
          } else {
            // A key never appears in a listing, not even a part of one (PLAN-v4 §6d-1).
            logStep('  API Key', p.apiKey ? 'set (hidden)' : 'none');
          }
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
      if (flags.oauth) {
        return await addOAuthProvider(name, flags);
      }
      if (flags.region !== undefined) {
        logError('--region requires --oauth.');
        return 1;
      }
      if (!flags.baseUrl) {
        logError('Base URL required. Specify --url <url>');
        return 1;
      }
      const type = flags.provider ?? inferProviderType(flags.baseUrl);
      if (isRetiredProvider(type)) {
        logError(`The ${type} provider was retired from JOY Media. Add another provider instead.`);
        return 1;
      }
      if (findRegistryProvider(type) === undefined && !isCustomProviderId(type)) {
        logError(`Unknown provider type "${type}". Use a registry provider id or "custom".`);
        return 1;
      }
      // The endpoint is checked before anything is sent to it, the model list request included.
      // A public endpoint needs the owner's consent, given with --accept-public-endpoint (S8).
      const verdict = evaluateEndpoint(type, flags.baseUrl, {
        consentToPublicEndpoint: flags.acceptPublicEndpoint === true,
      });
      if (!verdict.allowed) {
        const hint =
          verdict.code === 'CONSENT_REQUIRED'
            ? ' To use a public endpoint, add --accept-public-endpoint after reading what it receives.'
            : '';
        logError(`The base URL is refused: ${verdict.reason}${hint}`);
        return 1;
      }
      const endpointConsent =
        verdict.kind === 'public' ? `${verdict.origin}${verdict.basePath}` : undefined;

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

      // No built-in model: the first one the endpoint lists, unless one is given.
      const defaultModel = flags.model ?? cachedModels?.[0];

      setAiProvider(name, {
        name,
        provider: type,
        baseUrl: flags.baseUrl,
        endpointConsent,
        apiKey: flags.apiKey,
        defaultModel,
        cachedModels,
      });

      logSuccess(`Provider "${name}" configured successfully!`);
      logStep('Base URL', flags.baseUrl);
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
      if (isRetiredProvider(name)) {
        logError(`The ${name} provider was retired from JOY Media. Choose another provider.`);
        return 1;
      }
      if (!providers[name] && findRegistryProvider(name) === undefined) {
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
    const targetProviderName = args[1] ?? flags.provider ?? loadCliConfig().activeProvider;
    if (targetProviderName === undefined) {
      logError('Choose a provider first: joy-media agent provider use <name>, or pass one.');
      return 1;
    }
    const providers = loadAiProviders();
    const providerConfig = providers[targetProviderName];
    if (isRetiredProvider(targetProviderName)) {
      logError(
        `The ${targetProviderName} provider was retired from JOY Media. Choose another provider.`,
      );
      return 1;
    }
    if (providerConfig?.authKind === 'oauth') {
      if (flags.baseUrl !== undefined || flags.apiKey !== undefined) {
        logError(
          `OAuth profile "${targetProviderName}" cannot be combined with --url or --api-key.`,
        );
        return 1;
      }
      return await listOAuthModels(targetProviderName, providerConfig);
    }

    let baseUrl = flags.baseUrl ?? providerConfig?.baseUrl;
    let apiKey = flags.apiKey ?? providerConfig?.apiKey;

    if (!baseUrl) {
      const registeredUrl = defaultBaseUrl(targetProviderName);
      if (registeredUrl === undefined) {
        logError(`No baseUrl found for provider "${targetProviderName}". Specify --url <url>`);
        return 1;
      }
      baseUrl = registeredUrl;
      apiKey = apiKey ?? environmentKey(targetProviderName);
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
    const cfg = loadCliConfig();
    logInfo(`Current default model: ${cfg.defaultModel ?? 'anthropic/claude-3.7-sonnet'}`);
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
      if (err instanceof OAuthRefreshFailedError || err instanceof OAuthProfileLockTimeoutError) {
        logError(err.message);
      } else {
        logError(`Probe failed: ${String(err)}`);
      }
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

  if (sub === 'slot') {
    const action = args[1] ?? 'list';
    if (action === 'list') {
      const providers = loadAiProviders();
      for (const id of AGENT_SLOT_IDS) {
        const slot = loadAgentSlot(id);
        const saved = slot.profileId === undefined ? undefined : providers[slot.profileId];
        const state = !isAgentSlotConfigured(slot)
          ? 'not set'
          : saved === undefined
            ? 'profile missing'
            : 'ready';
        console.log(`  ${c(slot.label, 'cyan')} (${id}): ${state}`);
        console.log(
          `    Profile: ${slot.profileId ?? 'not set'}   Model: ${slot.model ?? 'not set'}`,
        );
        console.log(
          `    Instructions: ${slot.instructions === '' ? 'none' : `${slot.instructions.length} characters`}`,
        );
        const settings = Object.entries(slot.settings)
          .map(([name, value]) => `${name}=${String(value)}`)
          .join(', ');
        console.log(`    Settings: ${settings === '' ? 'defaults' : settings}`);
      }
      return 0;
    }

    const id = parseAgentSlotId(args[2]);
    if (id === undefined) {
      logError(
        'Choose a slot: workhorse or creative. Usage: joy-media agent slot <list|set|clear> <workhorse|creative>',
      );
      return 1;
    }
    if (action === 'clear') {
      clearAgentSlot(id);
      logSuccess(`${AGENT_SLOT_LABELS[id]} cleared.`);
      return 0;
    }
    if (action === 'set') {
      if (flags.profile !== undefined && loadAiProviders()[flags.profile] === undefined) {
        logError(
          `No saved provider named "${flags.profile}". Add it first with: joy-media agent provider add ${flags.profile} --url <url>`,
        );
        return 1;
      }
      // Only the fields given change; the rest keep the slot's current values.
      const current = loadAgentSlot(id);
      const result = saveAgentSlot(id, {
        profileId: flags.profile ?? current.profileId,
        model: flags.model ?? current.model,
        instructions: flags.instructions ?? current.instructions,
        settings: {
          temperature: numberFlag(flags.temperature) ?? current.settings.temperature,
          maxOutputTokens: numberFlag(flags.maxOutputTokens) ?? current.settings.maxOutputTokens,
        },
      });
      if (!result.ok) {
        const where = result.field === undefined ? '' : ` (${result.field})`;
        logError(`The slot was not saved: ${result.issue}${where}.`);
        return 1;
      }
      logSuccess(`${result.slot.label} saved.`);
      logStep('Profile', result.slot.profileId ?? 'not set');
      logStep('Model', result.slot.model ?? 'not set');
      return 0;
    }
    logError(`Unknown slot action "${action}". Available actions: list, set, clear`);
    return 1;
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
        slot: parseAgentSlotId(flags.slot),
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
          slot: parseAgentSlotId(flags.slot),
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
      if (err instanceof OAuthRefreshFailedError || err instanceof OAuthProfileLockTimeoutError) {
        logError(err.message);
      } else {
        logError(`Joy Agent execution failed: ${String(err)}`);
      }
      return 1;
    }
  }

  logError(`Unknown agent subcommand: ${sub}`);
  console.log(
    `Available: ${c('chat', 'cyan')}, ${c('run', 'cyan')}, ${c('probe', 'cyan')}, ${c('config', 'cyan')}`,
  );
  return 1;
}

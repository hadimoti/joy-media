/* global process, fetch, AbortSignal, TextDecoder */
import type { CliFlags } from '../cli.js';
import {
  AGENT_SLOT_IDS,
  AGENT_SLOT_LABELS,
  CHATGPT_RESPONSES_BASE_URL,
  XAI_OAUTH_INFERENCE_BASE_URL,
  evaluateEndpoint,
  findRegistryProvider,
  isAgentSlotConfigured,
  isCustomProviderId,
  parseAgentSlotId,
} from '@joy-media/provider-sdk';
import { prepareChatGptModels, readChatGptModels } from '@joy-media/joy-agent-engine';
import {
  isOAuthProfileProvider,
  oauthTokenExpiry,
  signInOAuthProfile,
  type OAuthProfileProvider,
} from '../agent/oauth.js';
import { clearAgentSlot, loadAgentSlot, saveAgentSlot } from '../agent/agent-slots.js';
import {
  AgentRunError,
  describeOperation,
  probeAgent,
  runJoyAgent,
  type RunAgentOutput,
} from '../agent/joy-agent.js';
import { createAgentOutput, type AgentOutput } from '../agent/output.js';
import {
  AgentConfigError,
  inferProviderType,
  isRetiredProvider,
  normalizeCliBaseUrl,
  resolveAgentConfig,
  resolveProviderSettings,
  type ResolveProviderOptions,
  type ResolvedProviderSettings,
} from '../agent/provider.js';
import {
  getDefaultOAuthTokenManager,
  OAuthProfileLockTimeoutError,
  OAuthRefreshFailedError,
  withOAuthProfileLock,
} from '../agent/oauth-runtime.js';
import { startAgentRepl } from '../agent/repl.js';
import {
  ConfigFileError,
  clearPendingChatGptRegistrations,
  deleteAiProvider,
  getDefaultSqlitePath,
  hasAiProvider,
  loadAiProviders,
  loadCliConfig,
  openCredentialStore,
  pendingChatGptClientId,
  restoreAiProvider,
  StoredKeyRemovalError,
  setAiProvider,
  updateAiProviders,
  updateCliConfig,
  type AiProviderConfig,
  type CliConfig,
} from '../utils/config.js';
import {
  KIMI_CODE_BASE_URL as OAUTH_KIMI_CODE_BASE_URL,
  OAuthFlowError,
} from '@joy-media/provider-oauth';
import type { OAuthCredential } from '../utils/credential-store.js';
import { c } from '../utils/logger.js';
import {
  createDefaultProject,
  listProjects,
  loadProject,
  saveProject,
  type ProjectLoadResult,
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

/** Exit statuses: 1 = the command ran and failed, 2 = it was invoked wrongly. */
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

const PROVIDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_MAX_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_MODELS = 5_000;
const OAUTH_RISK_NOTICE =
  'Signing in uses a third-party public app, and the provider may disable it in the future. An API key is the better, more dependable way to connect.';

function numberFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return value.trim() === '' ? Number.NaN : Number(value);
}

function oauthProfileBaseUrl(provider: 'chatgpt' | 'kimi' | 'xai'): string {
  if (provider === 'chatgpt') return CHATGPT_RESPONSES_BASE_URL;
  if (provider === 'kimi') return OAUTH_KIMI_CODE_BASE_URL;
  return XAI_OAUTH_INFERENCE_BASE_URL;
}

async function addOAuthProvider(name: string, flags: CliFlags, out: AgentOutput): Promise<number> {
  if (flags.baseUrl !== undefined) throw failure('--url cannot be combined with --oauth.');
  if (flags.apiKey !== undefined) throw failure('--api-key cannot be combined with --oauth.');
  if (!flags.provider) throw failure('--provider is required with --oauth.');
  if (!isOAuthProfileProvider(flags.provider)) {
    throw failure(`Provider "${flags.provider}" does not offer OAuth sign-in.`);
  }
  const provider: OAuthProfileProvider = flags.provider;
  // One add at a time per profile. The lock covers the sign-in, its commit and any refresh of this profile.
  // It is the same lock the runtime takes to rotate tokens, so these writes cannot interleave with them.
  return underProfileLock(name, () => addOAuthProviderLocked(name, provider, flags, out));
}

/**
 * Runs fn under the profile lock, shared with token refresh and with every other write to this profile name.
 * Waiting past the lock timeout is reported as a retryable failure.
 */
async function underProfileLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withOAuthProfileLock(name, fn);
  } catch (error) {
    if (error instanceof OAuthProfileLockTimeoutError) {
      // A stuck file needs the user to remove it, so its path is shown instead of a retry hint.
      throw failure(
        error.stuckPath === undefined
          ? `Another sign-in or token refresh is using profile "${name}". Retry when it finishes.`
          : error.message,
      );
    }
    throw error;
  }
}

/** Names the way out when a kept ChatGPT registration may be the cause of a failed sign-in. Never throws. */
function pendingRegistrationHint(name: string, provider: OAuthProfileProvider): string {
  if (provider !== 'chatgpt') return '';
  try {
    if (pendingChatGptClientId(name) === undefined) return '';
  } catch {
    return '';
  }
  return ` A ChatGPT registration is kept for retry. If ChatGPT rejects it, discard it with: joy-media agent provider remove ${name}`;
}

/**
 * Puts the previous profile metadata back after a failed commit, then says what is now true. The message says the
 * profile is unchanged only when the restore itself succeeded.
 */
function rollbackFailedCommit(
  name: string,
  previous: AiProviderConfig | undefined,
): ReturnType<typeof failure> {
  try {
    restoreAiProvider(name, previous);
  } catch {
    return failure(
      'OAuth credential could not be saved, and the profile metadata could not be restored. Run the add command again.',
    );
  }
  return failure('OAuth credential could not be saved. The profile was left unchanged.');
}

/** Runs under the profile lock. The profile is written only after the sign-in has succeeded. */
async function addOAuthProviderLocked(
  name: string,
  provider: OAuthProfileProvider,
  flags: CliFlags,
  out: AgentOutput,
): Promise<number> {
  const previous = loadAiProviders()[name];
  if (previous !== undefined && (previous.authKind !== 'oauth' || previous.provider !== provider)) {
    throw failure(
      `Provider profile "${name}" uses a different authentication method or provider; remove it before changing authentication.`,
    );
  }
  const model = flags.model ?? previous?.defaultModel;
  if (provider !== 'chatgpt') console.error(OAUTH_RISK_NOTICE);
  let approvalStatusShown = false;
  let credential: OAuthCredential;
  try {
    credential = await signInOAuthProfile({
      profileId: name,
      provider,
      onAuthorization: ({ url, userCode, expiresAt }) => {
        out.line(`Approval URL: ${url}`);
        if (userCode) out.line(`User code: ${userCode}`);
        if (expiresAt !== undefined && Number.isFinite(expiresAt)) {
          out.line(`Code expires at: ${new Date(expiresAt).toISOString()}`);
        }
        if (provider === 'chatgpt') {
          out.line(
            'Open the URL in a browser on this same machine. A remote CLI with no browser on that machine cannot complete it.',
          );
        } else {
          out.line('Waiting for approval. Press Ctrl+C to cancel.');
          approvalStatusShown = true;
        }
      },
      onSlowDown: () => {
        out.line(
          'Waiting for approval; the provider asked us to slow down. Press Ctrl+C to cancel.',
        );
        approvalStatusShown = true;
      },
    });
  } catch (error) {
    const hint = pendingRegistrationHint(name, provider);
    if (error instanceof OAuthFlowError) {
      const message =
        error.code === 'TIMEOUT'
          ? 'The sign-in code expired. Run the OAuth add command again.'
          : error.code === 'ACCESS_DENIED'
            ? 'Sign-in was denied.'
            : error.message;
      throw error.code === 'CANCELLED'
        ? new AgentCommandError(message, 130, error.code)
        : failure(`${message}${hint}`, error.code);
    }
    throw failure(`OAuth sign-in failed. No profile was changed.${hint}`);
  } finally {
    if (approvalStatusShown) out.line();
  }
  // The profile metadata goes first. It is small and reversible, so a failure here leaves the saved sign-in as it was.
  try {
    setAiProvider(name, {
      name,
      provider,
      authKind: 'oauth',
      baseUrl: oauthProfileBaseUrl(provider),
      defaultModel: model,
    });
  } catch {
    throw rollbackFailedCommit(name, previous);
  }
  try {
    openCredentialStore().save(name, credential);
  } catch {
    throw rollbackFailedCommit(name, previous);
  }
  try {
    clearPendingChatGptRegistrations(name);
  } catch {
    out.warn('The provider is saved, but its pending registration could not be cleared.');
  }
  out.success(`Provider "${name}" configured successfully!`);
  out.step('Provider', provider);
  out.step('Auth', `OAuth (${provider})`);
  if (model) out.step('Default Model', model);
  out.result({
    ok: true,
    name,
    provider,
    authKind: 'oauth',
    defaultModel: model ?? null,
  });
  return 0;
}

async function listOAuthModels(
  profileId: string,
  profile: AiProviderConfig,
  out: AgentOutput,
): Promise<number> {
  const provider = profile.provider;
  if (provider !== 'chatgpt' && provider !== 'kimi' && provider !== 'xai') {
    throw failure(`OAuth profile "${profileId}" has no supported model-list route.`);
  }
  let credential: OAuthCredential;
  try {
    credential = await getDefaultOAuthTokenManager().current(profileId, provider);
  } catch (error) {
    if (error instanceof OAuthProfileLockTimeoutError) throw failure(error.message);
    throw failure(new OAuthRefreshFailedError(profileId, provider).message);
  }
  const baseUrl = oauthProfileBaseUrl(provider);
  out.banner();
  out.info(`Fetching models from ${c(baseUrl, 'bold')}...`);
  try {
    const chatGptRequest =
      provider === 'chatgpt'
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
      provider === 'chatgpt'
        ? (await readChatGptModels(await response.text()))
            .map((model) => model.id)
            .filter(
              (id) =>
                ![credential.tokenRecord.accessToken, credential.tokenRecord.refreshToken].some(
                  (token) => id.includes(token),
                ),
            )
        : await readOAuthModelIds(response, credential);
    out.line(`\n  ${c(`Discovered ${modelIds.length} models:`, 'bold')}\n`);
    for (const id of modelIds) out.line(`  • ${id}`);
    out.line();
    updateAiProviders((providers) => {
      if (hasAiProvider(providers, profileId))
        providers[profileId] = { ...providers[profileId], cachedModels: modelIds };
    });
    out.result({ ok: true, provider: profileId, models: modelIds });
    return 0;
  } catch {
    throw failure(`Failed to fetch models for OAuth profile "${profileId}".`);
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
    .filter(
      (id): id is string =>
        typeof id === 'string' &&
        id.length > 0 &&
        ![credential.tokenRecord.accessToken, credential.tokenRecord.refreshToken].some((token) =>
          id.includes(token),
        ),
    );
}

/** A command-level failure with its exit status and a stable machine code. */
class AgentCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AgentCommandError';
  }
}

const usage = (message: string): AgentCommandError =>
  new AgentCommandError(message, EXIT_USAGE, 'USAGE');
const failure = (message: string, code = 'FAILED'): AgentCommandError =>
  new AgentCommandError(message, EXIT_FAILURE, code);

export async function handleAgentCommand(args: string[], flags: CliFlags): Promise<number> {
  const out = createAgentOutput(flags.json);
  try {
    return await dispatch(args, flags, out);
  } catch (error) {
    return reportFailure(error, out);
  }
}

function reportFailure(error: unknown, out: AgentOutput): number {
  let exitCode: number;
  let code: string;
  let httpStatus: number | undefined;
  if (error instanceof AgentCommandError) {
    exitCode = error.exitCode;
    code = error.code;
  } else if (error instanceof AgentConfigError) {
    exitCode = EXIT_USAGE;
    code = 'AGENT_CONFIG_INVALID';
  } else if (error instanceof ConfigFileError) {
    exitCode = EXIT_FAILURE;
    code = 'CONFIG_FILE_CORRUPT';
  } else if (error instanceof AgentRunError) {
    exitCode = EXIT_FAILURE;
    code = error.code;
    httpStatus = error.httpStatus;
  } else if (
    error instanceof OAuthRefreshFailedError ||
    error instanceof OAuthProfileLockTimeoutError
  ) {
    exitCode = EXIT_FAILURE;
    code = error.name;
  } else {
    throw error;
  }
  const message = (error as Error).message;
  out.error(message);
  out.result({
    ok: false,
    error: { code, message, ...(httpStatus === undefined ? {} : { httpStatus }) },
  });
  return exitCode;
}

async function dispatch(args: string[], flags: CliFlags, out: AgentOutput): Promise<number> {
  const sub = args[0] ?? 'chat';
  switch (sub) {
    case 'provider':
      return handleProvider(args, flags, out);
    case 'models':
      return handleModels(args, flags, out);
    case 'model':
      return handleModel(args, flags, out);
    case 'probe':
      return handleProbe(flags, out);
    case 'config':
      return handleConfig(flags, out);
    case 'slot':
      return handleSlot(args, flags, out);
    case 'chat':
      if (args.length === 0 && !process.stdin.isTTY) {
        throw usage('agent chat needs a TTY when no script is piped to stdin.');
      }
      return handleChat(flags);
    case 'run':
      return handleRun(args, flags, out);
    default:
      out.error(`Unknown agent subcommand: ${sub}`);
      out.line(
        `Available: ${c('chat', 'cyan')}, ${c('run', 'cyan')}, ${c('probe', 'cyan')}, ${c('config', 'cyan')}, ${c('provider', 'cyan')}, ${c('model', 'cyan')}, ${c('models', 'cyan')}, ${c('slot', 'cyan')}`,
      );
      out.result({
        ok: false,
        error: { code: 'UNKNOWN_SUBCOMMAND', message: `Unknown agent subcommand: ${sub}` },
      });
      return EXIT_FAILURE;
  }
}

function handleSlot(args: string[], flags: CliFlags, out: AgentOutput): number {
  const action = args[1] ?? 'list';
  if (action === 'list') {
    const providers = loadAiProviders();
    const slots = AGENT_SLOT_IDS.map((id) => {
      const slot = loadAgentSlot(id);
      const saved = slot.profileId === undefined ? undefined : providers[slot.profileId];
      return {
        ...slot,
        state: !isAgentSlotConfigured(slot)
          ? 'not set'
          : saved === undefined
            ? 'profile missing'
            : 'ready',
      };
    });
    out.result({ slots });
    if (out.json) return 0;
    for (const slot of slots) {
      out.line(`  ${c(slot.label, 'cyan')} (${slot.id}): ${slot.state}`);
      out.line(`    Profile: ${slot.profileId ?? 'not set'}   Model: ${slot.model ?? 'not set'}`);
      out.line(
        `    Instructions: ${slot.instructions === '' ? 'none' : `${slot.instructions.length} characters`}`,
      );
      const settings = Object.entries(slot.settings)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(', ');
      out.line(`    Settings: ${settings === '' ? 'defaults' : settings}`);
    }
    return 0;
  }
  const id = parseAgentSlotId(args[2]);
  if (id === undefined)
    throw failure(
      'Choose a slot: workhorse or creative. Usage: joy-media agent slot <list|set|clear> <workhorse|creative>',
    );
  if (action === 'clear') {
    clearAgentSlot(id);
    out.success(`${AGENT_SLOT_LABELS[id]} cleared.`);
    out.result({ ok: true, cleared: id });
    return 0;
  }
  if (action === 'set') {
    if (flags.profile !== undefined && loadAiProviders()[flags.profile] === undefined) {
      throw failure(
        `No saved provider named "${flags.profile}". Add it first with: joy-media agent provider add ${flags.profile} --url <url>`,
      );
    }
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
    if (!result.ok)
      throw failure(
        `The slot was not saved: ${result.issue}${result.field === undefined ? '' : ` (${result.field})`}.`,
      );
    out.success(`${result.slot.label} saved.`);
    out.step('Profile', result.slot.profileId ?? 'not set');
    out.step('Model', result.slot.model ?? 'not set');
    out.result({ ok: true, slot: result.slot });
    return 0;
  }
  throw failure(
    `Unknown slot action "${action}". Available actions: list, set, clear`,
    'UNKNOWN_SUBCOMMAND',
  );
}

// ---------------------------------------------------------------------------
// Secrets from argv / stdin
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `--api-key -` reads the key from piped stdin, so it never appears in the
 * process list or shell history (`--api-key <key>` on argv does).
 */
async function resolveApiKeyFlag(flags: CliFlags): Promise<string | undefined> {
  if (flags.apiKey !== '-') return flags.apiKey;
  if (process.stdin.isTTY) {
    throw usage(
      '--api-key - reads the key from piped stdin, e.g. `printenv MY_KEY | joy-media agent ... --api-key -`.',
    );
  }
  const key = (await readStdin()).split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!key) throw usage('--api-key - was given but stdin did not contain a key.');
  return key.trim();
}

async function providerOptionsFrom(flags: CliFlags): Promise<ResolveProviderOptions> {
  const slot = flags.slot === undefined ? undefined : parseAgentSlotId(flags.slot);
  if (flags.slot !== undefined && slot === undefined) {
    throw usage('--slot must be "workhorse" or "creative".');
  }
  return {
    provider: flags.provider,
    model: flags.model,
    apiKey: await resolveApiKeyFlag(flags),
    baseUrl: flags.baseUrl,
    slot,
  };
}

// ---------------------------------------------------------------------------
// provider list | add | use | remove
// ---------------------------------------------------------------------------

function isKnownProvider(providers: Record<string, AiProviderConfig>, name: string): boolean {
  return hasAiProvider(providers, name) || findRegistryProvider(name) !== undefined;
}

function providerType(baseUrl: string, explicit: string | undefined): string {
  return explicit ?? inferProviderType(baseUrl);
}

async function handleProvider(args: string[], flags: CliFlags, out: AgentOutput): Promise<number> {
  const action = args[1] ?? 'list';

  if (action === 'list' || action === 'ls') {
    const providers = loadAiProviders();
    const active = loadCliConfig().activeProvider;
    const entries = Object.keys(providers).map((name) => {
      const p = providers[name]!;
      const oauthExpiry =
        p.authKind === 'oauth'
          ? (() => {
              try {
                const credential = openCredentialStore().read(name);
                return credential !== undefined &&
                  'provider' in credential &&
                  credential.provider === p.provider
                  ? oauthTokenExpiry(credential)
                  : 'OAuth credential unavailable';
              } catch {
                return 'OAuth credential unavailable';
              }
            })()
          : undefined;
      return {
        name,
        provider: p.provider ?? 'custom',
        baseUrl: p.authKind === 'oauth' && p.provider === 'xai' ? null : (p.baseUrl ?? null),
        defaultModel: p.defaultModel ?? null,
        apiKeySet: Boolean(p.apiKey),
        authKind: p.authKind ?? 'api-key',
        cachedModelCount: p.cachedModels?.length ?? 0,
        active: name === active,
        ...(oauthExpiry === undefined ? {} : { expiresAt: oauthExpiry }),
      };
    });
    out.result({ activeProvider: active ?? null, providers: entries });
    if (out.json) return 0;

    out.line(`\n  ${c('Configured AI Providers:', 'bold')}\n`);
    if (entries.length === 0) {
      out.info(
        'No custom providers configured yet. Use "joy-media agent provider add" to add one.',
      );
    }
    for (const entry of entries) {
      const marker = entry.active ? c('● [ACTIVE]', 'green') : c('○', 'dim');
      out.line(`  ${marker} ${c(entry.name, 'bold')} (${entry.provider})`);
      out.step('  Base URL', entry.baseUrl ?? 'default');
      out.step('  Default Model', entry.defaultModel ?? 'not-set');
      if (entry.authKind === 'oauth') {
        out.step('  Auth', `OAuth (${entry.provider})`);
        out.step('  Access token', entry.expiresAt ?? 'OAuth credential unavailable');
      } else {
        out.step('  API Key', entry.apiKeySet ? 'set (hidden)' : 'none');
      }
      if (entry.cachedModelCount > 0) {
        out.step('  Discovered Models', `${entry.cachedModelCount} models cached`);
      }
      out.line();
    }
    if (!active) {
      out.info('No provider selected. Configure a provider with "joy-media agent provider add".');
    }
    return 0;
  }

  if (action === 'add') {
    const name = args[2] ?? flags.name;
    if (!name) {
      throw usage(
        'Provider name required. Usage: joy-media agent provider add <name> --url <url> [--api-key <key>|-] [--model <model>]',
      );
    }
    if (!PROVIDER_NAME_RE.test(name)) {
      throw usage(
        `Invalid provider name "${name}": use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit.`,
      );
    }
    if (flags.oauth) return await addOAuthProvider(name, flags, out);
    if (!flags.baseUrl) throw usage('Base URL required. Specify --url <url>');
    const { url: baseUrl } = normalizeCliBaseUrl(flags.baseUrl);
    const type = providerType(baseUrl, flags.provider);
    if (isRetiredProvider(type)) {
      throw failure(
        `The ${type} provider was retired from JOY Media. Add another provider instead.`,
      );
    }
    if (findRegistryProvider(type) === undefined && !isCustomProviderId(type)) {
      throw failure(`Unknown provider type "${type}". Use a registry provider id or "custom".`);
    }
    const verdict = evaluateEndpoint(type, baseUrl, {
      consentToPublicEndpoint: flags.acceptPublicEndpoint === true,
    });
    if (!verdict.allowed) {
      const hint =
        verdict.code === 'CONSENT_REQUIRED'
          ? ' To use a public endpoint, add --accept-public-endpoint after reading what it receives.'
          : '';
      throw failure(`The base URL is refused: ${verdict.reason}${hint}`);
    }
    const endpointConsent =
      verdict.kind === 'public' ? `${verdict.origin}${verdict.basePath}` : undefined;
    const apiKey = await resolveApiKeyFlag(flags);

    const discovery = await discoverModels(baseUrl, apiKey);
    let cachedModels: string[] | undefined;
    if (discovery.ok) {
      cachedModels = discovery.ids.length > 0 ? discovery.ids : undefined;
      if (discovery.listed > 0) out.info(`Discovered ${discovery.listed} models from endpoint.`);
      if (discovery.listed > discovery.ids.length) {
        out.warn(`Cached the first ${discovery.ids.length} model ids only.`);
      }
    } else {
      out.warn(`Model discovery skipped: ${discovery.problem}. The provider is saved anyway.`);
    }

    const defaultModel = flags.model ?? cachedModels?.[0];
    const entry: AiProviderConfig = {
      name,
      provider: type,
      baseUrl,
      ...(endpointConsent ? { endpointConsent } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(defaultModel ? { defaultModel } : {}),
      ...(cachedModels ? { cachedModels } : {}),
    };
    // Under the profile lock, so this write cannot interleave with an OAuth sign-in or removal of the same name.
    const replaced = await underProfileLock(name, async () =>
      updateAiProviders((providers) => {
        const existed = hasAiProvider(providers, name);
        providers[name] = entry;
        return existed;
      }),
    );

    out.success(
      replaced
        ? `Provider "${name}" already existed and was replaced.`
        : `Provider "${name}" configured successfully!`,
    );
    out.step('Base URL', baseUrl);
    if (defaultModel) out.step('Default Model', defaultModel);
    out.step('API Key', apiKey ? 'set (hidden)' : 'none');
    out.result({
      ok: true,
      replaced,
      provider: {
        name,
        provider: entry.provider,
        baseUrl,
        defaultModel,
        apiKeySet: Boolean(apiKey),
        cachedModelCount: cachedModels?.length ?? 0,
      },
    });
    return 0;
  }

  if (action === 'use') {
    const name = args[2] ?? flags.name;
    if (!name) throw usage('Provider name required. Usage: joy-media agent provider use <name>');
    if (isRetiredProvider(name)) {
      throw failure(`The ${name} provider was retired from JOY Media. Choose another provider.`);
    }
    // Under the profile lock, so the check and the selection cannot interleave with a removal of this profile.
    const model = await underProfileLock(name, async () => {
      const providers = loadAiProviders();
      if (
        providers[name]?.provider !== undefined &&
        isRetiredProvider(providers[name]!.provider!)
      ) {
        throw failure(
          `The ${providers[name]!.provider} provider was retired from JOY Media. Choose another provider.`,
        );
      }
      if (!isKnownProvider(providers, name)) {
        throw failure(
          `Unknown provider "${name}". Run "joy-media agent provider list" to see available providers.`,
          'UNKNOWN_PROVIDER',
        );
      }
      const selectedModel = hasAiProvider(providers, name)
        ? providers[name]!.defaultModel
        : undefined;
      updateCliConfig((current) => {
        // The model / URL overrides belonged to the previously active provider.
        const { defaultModel: _model, customBaseUrl: _url, ...rest } = current;
        return {
          ...rest,
          activeProvider: name,
          ...(selectedModel ? { defaultModel: selectedModel } : {}),
        };
      });
      return selectedModel;
    });
    out.success(`Active provider set to "${name}".`);
    if (model) out.step('Default Model', model);
    out.result({ ok: true, activeProvider: name, defaultModel: model ?? null });
    return 0;
  }

  if (action === 'remove' || action === 'delete' || action === 'rm') {
    const name = args[2] ?? flags.name;
    if (!name) throw usage('Provider name required. Usage: joy-media agent provider remove <name>');
    // Under the profile lock, so removal waits for an in-flight sign-in or refresh of this profile.
    // Removing a name also discards any kept ChatGPT registration for it. That is the supported way to drop
    // a registration ChatGPT rejects, and it works even when no profile was saved.
    const outcome = await underProfileLock(name, async () => {
      const providers = loadAiProviders();
      const profileExisted = hasAiProvider(providers, name);
      const removedModel = profileExisted ? providers[name]?.defaultModel : undefined;
      const discardedPending = pendingChatGptClientId(name) !== undefined;
      // Each step below can fail. They run in an order where a failure leaves a state that a retry finishes:
      // the pending registration, then the active-provider setting, then the key, then the profile.
      clearPendingChatGptRegistrations(name);
      let wasActive = false;
      if (profileExisted) {
        updateCliConfig((cfg) => {
          if (cfg.activeProvider !== name) return cfg;
          wasActive = true;
          const { activeProvider: _active, customBaseUrl: _url, ...rest } = cfg;
          if (rest.defaultModel !== undefined && rest.defaultModel === removedModel) {
            delete rest.defaultModel;
          }
          return rest;
        });
      }
      let removedProfile = false;
      if (profileExisted) {
        try {
          removedProfile = deleteAiProvider(name);
        } catch (error) {
          if (error instanceof StoredKeyRemovalError) {
            throw failure(
              `The stored key for "${name}" could not be deleted, so the profile was kept. Repair the credential store and run the remove command again.`,
            );
          }
          throw error;
        }
      }
      return { removedProfile, discardedPending, wasActive };
    });
    if (!outcome.removedProfile && !outcome.discardedPending) {
      throw failure(`Provider "${name}" not found.`, 'UNKNOWN_PROVIDER');
    }
    if (!outcome.removedProfile) {
      out.success(`Pending ChatGPT registration for "${name}" discarded.`);
      out.result({ ok: true, removed: null, discardedPending: name, wasActive: false });
      return 0;
    }
    out.success(`Provider "${name}" removed.`);
    if (outcome.wasActive) {
      out.warn(
        'It was the active provider; no provider is selected now. ' +
          'Pick one with "joy-media agent provider use <name>".',
      );
    }
    out.result({ ok: true, removed: name, wasActive: outcome.wasActive });
    return 0;
  }

  throw failure(
    `Unknown provider action "${action}". Available actions: list, add, use, remove`,
    'UNKNOWN_SUBCOMMAND',
  );
}

// ---------------------------------------------------------------------------
// Model discovery (GET <base>/models)
// ---------------------------------------------------------------------------

type Discovery =
  | { readonly ok: true; readonly ids: string[]; readonly listed: number }
  | { readonly ok: false; readonly problem: string };

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let textValue = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('too large');
    }
    textValue += decoder.decode(value, { stream: true });
  }
  return textValue + decoder.decode();
}

/**
 * List the endpoint's models. Bounded in time and size, never follows a
 * redirect with the API key, and never throws: discovery is optional.
 */
async function discoverModels(baseUrl: string, apiKey: string | undefined): Promise<Discovery> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, problem: `no answer within ${DISCOVERY_TIMEOUT_MS / 1000}s` };
    }
    const cause = (error as { cause?: { code?: unknown } }).cause;
    return {
      ok: false,
      problem: `could not connect (${typeof cause?.code === 'string' ? cause.code : name})`,
    };
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    return {
      ok: false,
      problem: `the endpoint redirected (HTTP ${response.status}); not following it with the API key`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, problem: `the endpoint rejected the API key (HTTP ${response.status})` };
  }
  if (!response.ok) return { ok: false, problem: `the endpoint answered HTTP ${response.status}` };

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedText(response, DISCOVERY_MAX_BYTES));
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, problem: `no answer within ${DISCOVERY_TIMEOUT_MS / 1000}s` };
    }
    return {
      ok: false,
      problem:
        (error as Error).message === 'too large'
          ? 'the model list is larger than 8 MB'
          : 'the response is not JSON',
    };
  }
  const raw: unknown =
    parsed !== null && typeof parsed === 'object' && 'data' in parsed
      ? (parsed as { data: unknown }).data
      : parsed;
  if (!Array.isArray(raw)) return { ok: false, problem: 'unexpected response shape' };
  const ids = [
    ...new Set(
      raw
        .map((item: unknown) =>
          typeof item === 'string'
            ? item
            : item !== null && typeof item === 'object'
              ? (item as { id?: unknown }).id
              : undefined,
        )
        .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256),
    ),
  ];
  return { ok: true, ids: ids.slice(0, MAX_CACHED_MODELS), listed: ids.length };
}

async function handleModels(args: string[], flags: CliFlags, out: AgentOutput): Promise<number> {
  const target = args[1] ?? flags.provider ?? loadCliConfig().activeProvider;
  if (target !== undefined && isRetiredProvider(target)) {
    throw failure(`The ${target} provider was retired from JOY Media. Choose another provider.`);
  }
  const profile = target === undefined ? undefined : loadAiProviders()[target];
  if (profile?.provider !== undefined && isRetiredProvider(profile.provider)) {
    throw failure(
      `The ${profile.provider} provider was retired from JOY Media. Choose another provider.`,
    );
  }
  if (target !== undefined && profile?.authKind === 'oauth') {
    if (flags.baseUrl !== undefined || flags.apiKey !== undefined) {
      throw failure(`OAuth profile "${target}" cannot be combined with --url or --api-key.`);
    }
    return await listOAuthModels(target, profile, out);
  }
  const settings = resolveProviderSettings({
    provider: target,
    baseUrl: flags.baseUrl,
    apiKey: await resolveApiKeyFlag(flags),
  });
  out.banner();
  out.info(`Fetching models from ${c(settings.baseUrl, 'bold')}...`);
  const discovery = await discoverModels(settings.baseUrl, settings.apiKey);
  if (!discovery.ok) {
    throw failure(`Failed to fetch models: ${discovery.problem}.`, 'DISCOVERY_FAILED');
  }
  const apiKey = settings.apiKey;
  const modelIds =
    apiKey === undefined || apiKey.length === 0
      ? discovery.ids
      : discovery.ids.filter((id) => !id.includes(apiKey));
  out.line(`\n  ${c(`Discovered ${discovery.listed} models:`, 'bold')}\n`);
  for (const id of modelIds) out.line(`  • ${id}`);
  out.line();
  updateAiProviders((providers) => {
    if (hasAiProvider(providers, settings.providerName)) {
      providers[settings.providerName] = {
        ...providers[settings.providerName],
        cachedModels: modelIds,
      };
    }
  });
  out.result({ ok: true, provider: settings.providerName, models: modelIds });
  return 0;
}

// ---------------------------------------------------------------------------
// model | config | probe
// ---------------------------------------------------------------------------

function tryResolve(
  options: ResolveProviderOptions = {},
): { settings: ResolvedProviderSettings } | { problem: string } {
  try {
    return { settings: resolveProviderSettings(options) };
  } catch (error) {
    if (error instanceof AgentConfigError) return { problem: error.message };
    throw error;
  }
}

function effectiveJson(resolved: ReturnType<typeof tryResolve>): unknown {
  if ('problem' in resolved) return null;
  const s = resolved.settings;
  return {
    provider: s.providerName,
    kind: s.kind,
    baseUrl: s.baseUrl,
    model: s.modelId,
    apiKeySet: Boolean(s.apiKey),
    apiKeySource: s.apiKeySource,
    local: s.local,
  };
}

async function handleModel(args: string[], flags: CliFlags, out: AgentOutput): Promise<number> {
  const action = args[1] ?? 'get';
  if (action === 'set') {
    const modelId = (args[2] ?? flags.model)?.trim();
    if (!modelId) throw usage('Model ID required. Usage: joy-media agent model set <model-id>');
    if (modelId.length > 256) throw usage('The model id must be at most 256 characters long.');
    updateCliConfig((cfg) => ({ ...cfg, defaultModel: modelId }));
    out.success(`Default model set to "${modelId}".`);
    out.result({ ok: true, defaultModel: modelId });
    return 0;
  }
  if (action !== 'get') {
    throw failure(
      `Unknown model action "${action}". Available actions: get, set`,
      'UNKNOWN_SUBCOMMAND',
    );
  }
  const resolved = tryResolve();
  const model = 'settings' in resolved ? resolved.settings.modelId : loadCliConfig().defaultModel;
  out.info(`Current default model: ${model ?? 'not set'}`);
  out.result({ defaultModel: loadCliConfig().defaultModel ?? null, effectiveModel: model ?? null });
  return 0;
}

async function handleConfig(flags: CliFlags, out: AgentOutput): Promise<number> {
  if (flags.provider || flags.model || flags.baseUrl) {
    const baseUrl = flags.baseUrl ? normalizeCliBaseUrl(flags.baseUrl).url : undefined;
    if (flags.provider && !baseUrl && !isKnownProvider(loadAiProviders(), flags.provider)) {
      throw failure(
        `Unknown provider "${flags.provider}". Add it first with "joy-media agent provider add".`,
        'UNKNOWN_PROVIDER',
      );
    }
    updateCliConfig((current): CliConfig => ({
      ...current,
      ...(flags.provider ? { activeProvider: flags.provider } : {}),
      ...(flags.model ? { defaultModel: flags.model } : {}),
      ...(baseUrl ? { customBaseUrl: baseUrl } : {}),
    }));
    out.success('Updated CLI configuration.');
  }
  const cfg = loadCliConfig();
  const resolved = tryResolve();
  out.result({
    activeProvider: cfg.activeProvider ?? null,
    defaultModel: cfg.defaultModel ?? null,
    customBaseUrl: cfg.customBaseUrl ?? null,
    effective: effectiveJson(resolved),
    ...('problem' in resolved ? { problem: resolved.problem } : {}),
  });
  if (out.json) return 0;

  out.line(`\n  ${c('Current Joy Agent Configuration:', 'bold')}`);
  out.step('Active Provider', cfg.activeProvider ?? 'none selected');
  out.step('Default Model', cfg.defaultModel ?? 'provider default');
  out.step('Custom Base URL', cfg.customBaseUrl ?? 'none');
  out.line(`\n  ${c('A run would use:', 'bold')}`);
  if ('problem' in resolved) {
    out.warn(resolved.problem);
  } else {
    const s = resolved.settings;
    out.step('Provider', `${s.providerName} (${s.kind})`);
    out.step('Base URL', s.baseUrl);
    out.step('Model', s.modelId);
    out.step('API Key', s.apiKey ? 'set (hidden)' : s.local ? 'none (local endpoint)' : 'MISSING');
  }
  return 0;
}

async function handleProbe(flags: CliFlags, out: AgentOutput): Promise<number> {
  const options = await providerOptionsFrom(flags);
  await resolveAgentConfig(options); // fail fast, before the banner and any network traffic
  out.banner();
  out.info('Probing LLM provider capabilities...');
  const res = await probeAgent(options);
  out.line();
  out.success('Probe Successful!');
  out.step('Provider', res.provider);
  out.step('Model ID', res.modelId);
  out.step('Capability', c(res.capability, res.capability === 'tool-loop' ? 'green' : 'yellow'));
  if (res.capability === 'plan-only') {
    out.warn('This model cannot call tools; Joy Agent can only produce plans with it.');
  }
  out.result({
    ok: true,
    provider: res.provider,
    modelId: res.modelId,
    capability: res.capability,
  });
  return 0;
}

// ---------------------------------------------------------------------------
// chat | run
// ---------------------------------------------------------------------------

/**
 * The project an agent command works on. Without --project this is the most
 * recently updated project (deterministic), or a new "Default Project" that is
 * only written to the database if changes are actually applied.
 */
function resolveTargetProject(flags: CliFlags, out: AgentOutput): ProjectLoadResult {
  if (flags.project) {
    try {
      return loadProject(flags.project, flags.sqlitePath);
    } catch (err) {
      throw failure(
        `Failed to load project "${flags.project}": ${err instanceof Error ? err.message : String(err)}`,
        'PROJECT_NOT_FOUND',
      );
    }
  }
  const available = [...listProjects(flags.sqlitePath)].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const newest = available[0];
  if (newest) {
    const info = loadProject(newest.id, flags.sqlitePath);
    out.info(
      `Using the most recently updated project: ${c(info.project.title, 'bold')} (${info.project.id})` +
        (available.length > 1
          ? ` — pass --project <id> to pick one of the other ${available.length - 1}`
          : ''),
    );
    return info;
  }
  out.warn(
    'No existing projects found in database. Using a new "Default Project" (saved only if changes are applied).',
  );
  return {
    project: createDefaultProject('Default Project'),
    revision: 0,
    source: 'sqlite',
    path: flags.sqlitePath ?? getDefaultSqlitePath(),
  };
}

async function handleChat(flags: CliFlags): Promise<number> {
  if (flags.json) {
    throw usage(
      'agent chat is interactive and has no --json mode; use "joy-media agent run --json".',
    );
  }
  if (flags.apiKey === '-') {
    throw usage(
      'agent chat reads your messages from stdin, so --api-key - cannot be used with it.',
    );
  }
  const out = createAgentOutput(false);
  const providerOptions: ResolveProviderOptions = {
    provider: flags.provider,
    model: flags.model,
    apiKey: flags.apiKey,
    baseUrl: flags.baseUrl,
    slot: flags.slot === undefined ? undefined : parseAgentSlotId(flags.slot),
  };
  if (flags.slot !== undefined && providerOptions.slot === undefined) {
    throw usage('--slot must be "workhorse" or "creative".');
  }
  await resolveAgentConfig(providerOptions);
  const projectInfo = resolveTargetProject(flags, out);
  if (flags.model) {
    out.line();
    out.step('Override model', flags.model);
  }
  await startAgentRepl({
    project: projectInfo.project,
    revision: projectInfo.revision,
    source: projectInfo.source,
    path: projectInfo.path,
    providerOptions,
  });
  return 0;
}

function printProposal(out: AgentOutput, result: RunAgentOutput): void {
  const ops = [...result.staged.timelineOps, ...result.staged.documentOps];
  if (ops.length === 0) {
    out.info('The agent proposed no changes.');
    return;
  }
  out.line(`\n  ${c(`Proposed changes (${ops.length}):`, 'bold')}`);
  for (const op of ops) out.line(`    ${c('+', 'green')} ${describeOperation(op)}`);
}

async function handleRun(args: string[], flags: CliFlags, out: AgentOutput): Promise<number> {
  const prompt = args.slice(1).join(' ').trim();
  if (!prompt) throw usage('Usage: joy-media agent run "<instruction>" [--project <id>] [--apply]');

  const providerOptions = await providerOptionsFrom(flags);
  // Fail fast and locally on a bad / missing provider configuration.
  await resolveAgentConfig(providerOptions);

  const projectInfo = resolveTargetProject(flags, out);
  out.banner();
  out.info(`Running Joy Agent on project: ${c(projectInfo.project.title, 'bold')}`);
  out.step('Prompt', prompt);

  const result = await runJoyAgent({
    project: projectInfo.project,
    revision: projectInfo.revision,
    prompt,
    apply: flags.apply,
    providerOptions,
    output: out,
  });
  printProposal(out, result);

  const operations = {
    timeline: result.staged.timelineOps,
    document: result.staged.documentOps,
  };
  const base = {
    project: { id: projectInfo.project.id, title: projectInfo.project.title },
    provider: result.provider,
    model: result.modelId,
    baseRevision: projectInfo.revision,
    text: result.resultText,
    steps: result.steps,
    operations,
  };

  if (!flags.apply) {
    if (operations.timeline.length + operations.document.length > 0) {
      out.info('Dry run: nothing was saved. Re-run with --apply to commit these changes.');
    }
    out.result({ ok: true, dryRun: true, applied: false, revision: projectInfo.revision, ...base });
    return 0;
  }

  if (result.errors.length > 0) {
    out.result({
      ok: false,
      dryRun: false,
      applied: false,
      revision: projectInfo.revision,
      ...base,
      errors: result.errors,
      error: {
        code: 'INVALID_PROPOSAL',
        message: 'Some proposed operations are invalid; nothing was changed.',
      },
    });
    out.error(
      `Nothing was changed: ${result.errors.length} proposed operation(s) could not be applied.`,
    );
    return EXIT_FAILURE;
  }

  if (result.appliedCount === 0) {
    out.info(`No changes to commit; project stays at revision ${projectInfo.revision}.`);
    out.result({
      ok: true,
      dryRun: false,
      applied: false,
      revision: projectInfo.revision,
      ...base,
    });
    return 0;
  }

  let nextRev: number;
  try {
    nextRev = saveProject(result.updatedProject, {
      source: projectInfo.source,
      path: projectInfo.path,
      revision: projectInfo.revision,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw failure(
      /constraint|unique/i.test(message)
        ? 'The project was modified by someone else while the agent was running; nothing was saved. Re-run the command.'
        : `Could not save the project: ${message}`,
      /constraint|unique/i.test(message) ? 'REVISION_CONFLICT' : 'SAVE_FAILED',
    );
  }
  out.success(`Committed changes at project revision ${nextRev}.`);
  out.result({ ok: true, dryRun: false, applied: true, revision: nextRev, ...base });
  return 0;
}

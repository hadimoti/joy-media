/* global process, fetch, AbortSignal, TextDecoder */
import type { CliFlags } from '../cli.js';
import {
  AgentRunError,
  describeOperation,
  probeAgent,
  runJoyAgent,
  type RunAgentOutput,
} from '../agent/joy-agent.js';
import { createAgentOutput, maskSecret, type AgentOutput } from '../agent/output.js';
import {
  AgentConfigError,
  BUILTIN_PROVIDERS,
  normalizeCliBaseUrl,
  resolveByokConfig,
  resolveProviderSettings,
  type ResolveProviderOptions,
  type ResolvedProviderSettings,
} from '../agent/provider.js';
import { startAgentRepl } from '../agent/repl.js';
import {
  ConfigFileError,
  deleteAiProvider,
  getDefaultSqlitePath,
  hasAiProvider,
  loadAiProviders,
  loadCliConfig,
  updateAiProviders,
  updateCliConfig,
  type AiProviderConfig,
  type CliConfig,
} from '../utils/config.js';
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
    case 'chat':
      return handleChat(flags);
    case 'run':
      return handleRun(args, flags, out);
    default:
      out.error(`Unknown agent subcommand: ${sub}`);
      out.line(
        `Available: ${c('chat', 'cyan')}, ${c('run', 'cyan')}, ${c('probe', 'cyan')}, ${c('config', 'cyan')}, ${c('provider', 'cyan')}, ${c('model', 'cyan')}, ${c('models', 'cyan')}`,
      );
      out.result({
        ok: false,
        error: { code: 'UNKNOWN_SUBCOMMAND', message: `Unknown agent subcommand: ${sub}` },
      });
      return EXIT_FAILURE;
  }
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
  return {
    provider: flags.provider,
    model: flags.model,
    apiKey: await resolveApiKeyFlag(flags),
    baseUrl: flags.baseUrl,
  };
}

// ---------------------------------------------------------------------------
// provider list | add | use | remove
// ---------------------------------------------------------------------------

function isKnownProvider(providers: Record<string, AiProviderConfig>, name: string): boolean {
  return (
    hasAiProvider(providers, name) || Object.prototype.hasOwnProperty.call(BUILTIN_PROVIDERS, name)
  );
}

function providerType(baseUrl: string, explicit: string | undefined): string {
  if (explicit) return explicit;
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (host === 'openrouter.ai') return 'openrouter';
  if (host === 'kilo.ai' || host.endsWith('.kilo.ai')) return 'kilo';
  return 'custom';
}

async function handleProvider(args: string[], flags: CliFlags, out: AgentOutput): Promise<number> {
  const action = args[1] ?? 'list';

  if (action === 'list' || action === 'ls') {
    const providers = loadAiProviders();
    const active = loadCliConfig().activeProvider;
    const entries = Object.keys(providers).map((name) => {
      const p = providers[name]!;
      return {
        name,
        provider: p.provider ?? 'custom',
        baseUrl: p.baseUrl ?? null,
        defaultModel: p.defaultModel ?? null,
        apiKey: maskSecret(p.apiKey),
        cachedModelCount: p.cachedModels?.length ?? 0,
        active: name === active,
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
      out.step('  API Key', entry.apiKey ?? 'none');
      if (entry.cachedModelCount > 0) {
        out.step('  Discovered Models', `${entry.cachedModelCount} models cached`);
      }
      out.line();
    }
    if (!active) {
      out.info(
        'No provider selected; runs use the built-in default (see "joy-media agent config").',
      );
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
    if (!flags.baseUrl) throw usage('Base URL required. Specify --url <url>');
    const { url: baseUrl } = normalizeCliBaseUrl(flags.baseUrl);
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

    const defaultModel = flags.model ?? cachedModels?.[0] ?? 'minimax/minimax-m3';
    const entry: AiProviderConfig = {
      name,
      provider: providerType(baseUrl, flags.provider),
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      defaultModel,
      ...(cachedModels ? { cachedModels } : {}),
    };
    const replaced = updateAiProviders((providers) => {
      const existed = hasAiProvider(providers, name);
      providers[name] = entry;
      return existed;
    });

    out.success(
      replaced
        ? `Provider "${name}" already existed and was replaced.`
        : `Provider "${name}" configured successfully!`,
    );
    out.step('Base URL', baseUrl);
    out.step('Default Model', defaultModel);
    out.step('API Key', maskSecret(apiKey) ?? 'none');
    out.result({
      ok: true,
      replaced,
      provider: {
        name,
        provider: entry.provider,
        baseUrl,
        defaultModel,
        apiKey: maskSecret(apiKey),
        cachedModelCount: cachedModels?.length ?? 0,
      },
    });
    return 0;
  }

  if (action === 'use') {
    const name = args[2] ?? flags.name;
    if (!name) throw usage('Provider name required. Usage: joy-media agent provider use <name>');
    const providers = loadAiProviders();
    if (!isKnownProvider(providers, name)) {
      throw failure(
        `Unknown provider "${name}". Run "joy-media agent provider list" to see available providers.`,
        'UNKNOWN_PROVIDER',
      );
    }
    const model = hasAiProvider(providers, name) ? providers[name]!.defaultModel : undefined;
    updateCliConfig((current) => {
      // The model / URL overrides belonged to the previously active provider.
      const { defaultModel: _model, customBaseUrl: _url, ...rest } = current;
      return { ...rest, activeProvider: name, ...(model ? { defaultModel: model } : {}) };
    });
    out.success(`Active provider set to "${name}".`);
    if (model) out.step('Default Model', model);
    out.result({ ok: true, activeProvider: name, defaultModel: model ?? null });
    return 0;
  }

  if (action === 'remove' || action === 'delete' || action === 'rm') {
    const name = args[2] ?? flags.name;
    if (!name) throw usage('Provider name required. Usage: joy-media agent provider remove <name>');
    const removedModel = hasAiProvider(loadAiProviders(), name)
      ? loadAiProviders()[name]?.defaultModel
      : undefined;
    if (!deleteAiProvider(name)) {
      throw failure(`Provider "${name}" not found.`, 'UNKNOWN_PROVIDER');
    }
    let wasActive = false;
    updateCliConfig((cfg) => {
      if (cfg.activeProvider !== name) return cfg;
      wasActive = true;
      const { activeProvider: _active, customBaseUrl: _url, ...rest } = cfg;
      if (rest.defaultModel !== undefined && rest.defaultModel === removedModel) {
        delete rest.defaultModel;
      }
      return rest;
    });
    out.success(`Provider "${name}" removed.`);
    if (wasActive) {
      out.warn(
        'It was the active provider; no provider is selected now, so runs fall back to the built-in default. ' +
          'Pick one with "joy-media agent provider use <name>".',
      );
    }
    out.result({ ok: true, removed: name, wasActive });
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
  const settings = resolveProviderSettings({
    provider: args[1] ?? flags.provider,
    baseUrl: flags.baseUrl,
    apiKey: await resolveApiKeyFlag(flags),
  });
  out.banner();
  out.info(`Fetching models from ${c(settings.baseUrl, 'bold')}...`);
  const discovery = await discoverModels(settings.baseUrl, settings.apiKey);
  if (!discovery.ok) {
    throw failure(`Failed to fetch models: ${discovery.problem}.`, 'DISCOVERY_FAILED');
  }
  out.line(`\n  ${c(`Discovered ${discovery.listed} models:`, 'bold')}\n`);
  for (const id of discovery.ids) out.line(`  • ${id}`);
  out.line();
  updateAiProviders((providers) => {
    if (hasAiProvider(providers, settings.providerName)) {
      providers[settings.providerName] = {
        ...providers[settings.providerName],
        cachedModels: discovery.ids,
      };
    }
  });
  out.result({ ok: true, provider: settings.providerName, models: discovery.ids });
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
    apiKey: maskSecret(s.apiKey),
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
    out.step(
      'API Key',
      s.apiKey
        ? `${maskSecret(s.apiKey)} (from ${s.apiKeySource})`
        : s.local
          ? 'none (local endpoint)'
          : 'MISSING',
    );
  }
  return 0;
}

async function handleProbe(flags: CliFlags, out: AgentOutput): Promise<number> {
  const options = await providerOptionsFrom(flags);
  resolveByokConfig(options); // fail fast, before the banner and any network traffic
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
  };
  try {
    resolveByokConfig(providerOptions);
  } catch (error) {
    if (!(error instanceof AgentConfigError)) throw error;
    out.warn(`${error.message} Slash commands still work; agent prompts will fail.`);
  }
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
  resolveByokConfig(providerOptions);

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

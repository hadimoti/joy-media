import {
  findRegistryProvider,
  getOAuthClient,
  signInProviders,
  type RegistryProviderId,
} from '@joy-media/provider-sdk';
import { parseChatModels } from '../providers/adapters/chat-completions.js';
import {
  CHATGPT_RESPONSES_BASE_URL,
  prepareChatGptModels,
  readChatGptModels,
} from '../providers/adapters/chatgpt-responses.js';
import { holdsCredential } from '../providers/credential-screen.js';
import {
  type ChatGptTokenRecord,
  encodeTokenRecord,
  isExtAgentHostId,
  newExtAgentHostId,
  signInWithChatGpt,
  XAI_OAUTH_INFERENCE_BASE_URL,
  encodeXaiTokenRecord,
  signInWithXai,
  type XaiTokenRecord,
  KIMI_CODE_BASE_URL,
  encodeKimiTokenRecord,
  signInWithKimiCode,
  type KimiTokenRecord,
  PROVIDER_REQUEST_TIMEOUT_MS,
  OAuthFlowError,
  MAX_CATALOG_CHARS,
  type FetchLike,
  replyText,
} from '@joy-media/provider-oauth';

/** The setting that holds this install's ChatGPT ID, created once (PLAN-v4 §6d). */
export const INSTALL_ID_SETTING = 'chatgpt.ext_agent_host_id';

/**
 * A provider the renderer may ask to sign in to. The registry reflects the owner's local, per-user route decision:
 * ChatGPT, Kimi Code, and xAI use their dedicated desktop sign-in flows; all other providers use APIs.
 */
export type SignInProvider = RegistryProviderId;

/** What a finished sign-in saves as a profile. The secret is a key, or for ChatGPT the token record. */
export interface SignInResult {
  readonly provider: SignInProvider;
  readonly baseUrl: string;
  readonly modelId: string;
  /** The model ids the account lists, when the sign-in read them. Saved with the profile, so the choice needs no new read. */
  readonly cachedModels?: readonly string[];
  readonly secret: string;
}

/** Main-process-only identity used to reauthorize an existing ChatGPT profile. */
export interface ProviderSignInContext {
  readonly savedChatGptAccount?: {
    readonly clientId: string;
    readonly accountId: string;
  };
}

export interface ProviderSignInDeps {
  readonly openExternal: (url: string) => void | Promise<void>;
  readonly fetch: FetchLike;
  readonly now: () => number;
  /** The client of a saved ChatGPT account, to sign in to it again. Undefined registers a new client (SIWC). */
  readonly chatGptClientId: string | undefined;
  /** Reads local OAuth client overrides from app settings. Production injects the local database setting reader. */
  readonly getSetting?: (key: string) => string | undefined;
  /** This install's ChatGPT ID, from loadOrCreateInstallId. */
  readonly installId: () => string;
  /** The loopback port for ChatGPT. Absent means the fixed port; tests pass 0. */
  readonly chatGptPort?: number;
}

/**
 * Runs one sign-in and returns what to save. Nothing is saved here: the caller saves the result through the profile
 * route, so it is checked and bound like any other profile.
 */
export function createProviderSignIn(
  deps: ProviderSignInDeps,
): (provider: SignInProvider, context?: ProviderSignInContext) => Promise<SignInResult> {
  return async (provider, context) => {
    // D20: only a provider whose registry row permits a subscription sign-in may be signed in to (PLAN-v4 §6d-1 rule 5).
    // Every other provider, OpenRouter included, is set up with an API key instead.
    if (!signInProviders().includes(provider)) {
      throw new OAuthFlowError(
        'NOT_CONFIGURED',
        `${providerLabel(provider)} is set up with an API key and does not offer a sign-in.`,
      );
    }
    if (provider === 'xai') {
      const clientId = configuredOAuthClientId('xai');
      const record = await signInWithXai({
        ...(clientId === undefined ? {} : { clientId }),
        openExternal: deps.openExternal,
        fetch: deps.fetch,
        now: deps.now,
      });
      const modelId = await firstXaiModel(record, deps.fetch);
      return {
        provider,
        baseUrl: XAI_OAUTH_INFERENCE_BASE_URL,
        modelId,
        secret: encodeXaiTokenRecord(record),
      };
    }
    if (provider === 'kimi') {
      const clientId = configuredOAuthClientId('kimi');
      const record = await signInWithKimiCode({
        ...(clientId === undefined ? {} : { clientId }),
        openExternal: deps.openExternal,
        fetch: deps.fetch,
        now: deps.now,
      });
      const modelId = await firstKimiCodeModel(record, deps.fetch);
      return {
        provider,
        baseUrl: KIMI_CODE_BASE_URL,
        modelId,
        secret: encodeKimiTokenRecord(record),
      };
    }
    if (provider !== 'chatgpt') {
      throw new OAuthFlowError(
        'NOT_CONFIGURED',
        `${providerLabel(provider)} sign-in is not available in this build yet.`,
      );
    }
    const record = await signInWithChatGpt({
      issuedClientId: context?.savedChatGptAccount?.clientId ?? configuredOAuthClientId('chatgpt'),
      extAgentHostId: deps.installId(),
      openExternal: deps.openExternal,
      fetch: deps.fetch,
      now: deps.now,
      ...(deps.chatGptPort === undefined ? {} : { port: deps.chatGptPort }),
    });
    const choice = await chatGptModelChoice(record, deps.fetch);
    return {
      provider,
      baseUrl: CHATGPT_RESPONSES_BASE_URL,
      modelId: choice.modelId,
      cachedModels: choice.models,
      secret: encodeTokenRecord(record),
    };
  };

  /** Local app settings override the public OAuth client IDs recorded in the provider SDK. */
  function configuredOAuthClientId(provider: 'chatgpt' | 'kimi' | 'xai'): string | undefined {
    if (deps.getSetting === undefined) {
      if (provider === 'chatgpt') return deps.chatGptClientId;
    }
    const client = getOAuthClient(provider, deps.getSetting?.(`oauth.client_id.${provider}`));
    return client?.clientId;
  }
}

/** The name a provider is shown under. */
function providerLabel(provider: string): string {
  return findRegistryProvider(provider)?.label ?? provider;
}

/** The model a new ChatGPT profile starts on when the account lists it. Every other listed model stays selectable. */
const PREFERRED_CHATGPT_MODEL = 'gpt-6-luna';

/**
 * The models the account may list, and the model a new ChatGPT profile starts on: gpt-6-luna when it is listed,
 * otherwise the first usable model. The profile returns its id to the renderer, so an id that holds either token is
 * never offered.
 */
async function chatGptModelChoice(
  record: ChatGptTokenRecord,
  fetch: FetchLike,
): Promise<{ readonly modelId: string; readonly models: readonly string[] }> {
  const listing = await chatGptCatalogText(
    prepareChatGptModels({ accessToken: record.accessToken }),
    fetch,
  );
  const listed = listedChatGptModels(listing);
  if (listed.length === 0) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'ChatGPT lists no models for this account.');
  }
  const tokens = [record.accessToken, record.refreshToken];
  const models = listed.filter(
    (model) => !tokens.some((token) => holdsCredential(model.id, token)),
  );
  const chosen = models.find((model) => model.id === PREFERRED_CHATGPT_MODEL) ?? models[0];
  if (chosen === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'ChatGPT lists no usable model for this account.');
  }
  return { modelId: chosen.id, models: models.map((model) => model.id) };
}

/**
 * The ChatGPT model catalog as text. The request is bounded from the send until the body is read, so a stalled list
 * fails as unreachable instead of holding the sign-in open.
 */
async function chatGptCatalogText(
  call: ReturnType<typeof prepareChatGptModels>,
  fetch: FetchLike,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(call.url, {
        method: call.method,
        headers: call.headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      throw new OAuthFlowError('EXCHANGE_FAILED', 'ChatGPT could not be reached.');
    }
    if (!response.ok) {
      throw new OAuthFlowError(
        'EXCHANGE_FAILED',
        `ChatGPT did not list models (HTTP ${response.status}).`,
      );
    }
    try {
      return await replyText(response, MAX_CATALOG_CHARS);
    } catch (error) {
      if (error instanceof OAuthFlowError) throw error;
      throw new OAuthFlowError('EXCHANGE_FAILED', 'ChatGPT could not be reached.');
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A provider's model list, read under one timer from the send until the body is read, like the ChatGPT list. A stalled
 * or refused list fails with the given message instead of holding the sign-in open.
 */
async function boundedModelList(
  fetch: FetchLike,
  url: string,
  accessToken: string,
  failure: string,
): Promise<ReturnType<typeof parseChatModels>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('model list request failed');
    return parseChatModels(await replyText(response, MAX_CATALOG_CHARS));
  } catch {
    throw new OAuthFlowError('EXCHANGE_FAILED', failure);
  } finally {
    clearTimeout(timer);
  }
}

/** The first usable model xAI lists for this account; token values can never become model IDs. */
export async function firstXaiModel(record: XaiTokenRecord, fetch: FetchLike): Promise<string> {
  const models = await boundedModelList(
    fetch,
    `${XAI_OAUTH_INFERENCE_BASE_URL}/models`,
    record.accessToken,
    'xAI lists no usable model for this account.',
  );
  const tokens = [record.accessToken, record.refreshToken];
  const first = models.find((model) => !tokens.some((token) => holdsCredential(model.id, token)));
  if (first === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'xAI lists no usable model for this account.');
  }
  return first.id;
}

/** The first Kimi Code model listed for the signed-in account; token values can never become model IDs. */
export async function firstKimiCodeModel(
  record: KimiTokenRecord,
  fetch: FetchLike,
): Promise<string> {
  const models = await boundedModelList(
    fetch,
    `${KIMI_CODE_BASE_URL}/models`,
    record.accessToken,
    'Kimi lists no usable model for this account.',
  );
  const tokens = [record.accessToken, record.refreshToken];
  const first = models.find((model) => !tokens.some((token) => holdsCredential(model.id, token)));
  if (first === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'Kimi lists no usable model for this account.');
  }
  return first.id;
}

/** The models of a ChatGPT list. A list this build cannot read is a sign-in failure the person can see. */
function listedChatGptModels(text: string): ReturnType<typeof readChatGptModels> {
  try {
    return readChatGptModels(text);
  } catch {
    throw new OAuthFlowError(
      'EXCHANGE_FAILED',
      'ChatGPT returned a model list this app cannot read.',
    );
  }
}

/**
 * This install's ChatGPT host ID (PLAN-v4 §6d). A saved ID in the form ChatGPT accepts is kept. Any other saved value was
 * never accepted, so a new ID is created once and saved in its place.
 */
export function loadOrCreateInstallId(
  settings: {
    getSetting(key: string): string | undefined;
    setSetting(key: string, value: string): void;
  },
  newId: () => string = newExtAgentHostId,
): string {
  const saved = settings.getSetting(INSTALL_ID_SETTING);
  if (saved !== undefined && isExtAgentHostId(saved)) return saved;
  const created = newId();
  if (!isExtAgentHostId(created)) {
    throw new OAuthFlowError(
      'HOST_ID_INVALID',
      'This app could not create a valid ChatGPT host ID.',
    );
  }
  settings.setSetting(INSTALL_ID_SETTING, created);
  return created;
}

import {
  CHATGPT_RESPONSES_BASE_URL,
  prepareChatGptModels,
  readChatGptModels,
} from '../providers/adapters/chatgpt-responses.js';
import { encodeTokenRecord, signInWithChatGpt } from './chatgpt.js';
import { OAuthFlowError } from './errors.js';
import { type FetchLike, replyText } from './http.js';
import { OPENROUTER_BASE_URL, signInWithOpenRouter } from './openrouter.js';

/** The model a new OpenRouter profile uses. It is the same default the settings dialog offers. */
export const OPENROUTER_DEFAULT_MODEL = 'openrouter/auto';
/** The setting that holds this install's ChatGPT ID, created once (PLAN-v4 §6d). */
export const INSTALL_ID_SETTING = 'chatgpt.ext_agent_host_id';

export type SignInProvider = 'openrouter' | 'chatgpt';

/** What a finished sign-in saves as a profile. The secret is a key, or for ChatGPT the token record. */
export interface SignInResult {
  readonly provider: SignInProvider;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly secret: string;
}

export interface ProviderSignInDeps {
  readonly openExternal: (url: string) => void | Promise<void>;
  readonly fetch: FetchLike;
  readonly now: () => number;
  /** The OAuth client ChatGPT signs in with. Undefined until the owner decides it (PLAN-v4 §6d). */
  readonly chatGptClientId: string | undefined;
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
): (provider: SignInProvider) => Promise<SignInResult> {
  return async (provider) => {
    if (provider === 'openrouter') {
      const key = await signInWithOpenRouter({
        openExternal: deps.openExternal,
        fetch: deps.fetch,
      });
      return {
        provider,
        baseUrl: OPENROUTER_BASE_URL,
        modelId: OPENROUTER_DEFAULT_MODEL,
        secret: key,
      };
    }
    const record = await signInWithChatGpt({
      clientId: deps.chatGptClientId,
      extAgentHostId: deps.installId(),
      openExternal: deps.openExternal,
      fetch: deps.fetch,
      now: deps.now,
      ...(deps.chatGptPort === undefined ? {} : { port: deps.chatGptPort }),
    });
    const modelId = await firstChatGptModel(record.accessToken, deps.fetch);
    return {
      provider,
      baseUrl: CHATGPT_RESPONSES_BASE_URL,
      modelId,
      secret: encodeTokenRecord(record),
    };
  };
}

/** The first model the account may list. A new ChatGPT profile starts on it. */
async function firstChatGptModel(accessToken: string, fetch: FetchLike): Promise<string> {
  const call = prepareChatGptModels({ accessToken });
  let response: Response;
  try {
    response = await fetch(call.url, {
      method: call.method,
      headers: call.headers,
      redirect: 'manual',
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
  const first = readChatGptModels(await replyText(response))[0];
  if (first === undefined) {
    throw new OAuthFlowError('EXCHANGE_FAILED', 'ChatGPT lists no models for this account.');
  }
  return first.id;
}

/** This install's ChatGPT ID: the saved one, or a new one saved the first time (PLAN-v4 §6d). */
export function loadOrCreateInstallId(
  settings: {
    getSetting(key: string): string | undefined;
    setSetting(key: string, value: string): void;
  },
  newId: () => string,
): string {
  const saved = settings.getSetting(INSTALL_ID_SETTING);
  if (saved !== undefined && saved.length > 0) return saved;
  const created = newId();
  settings.setSetting(INSTALL_ID_SETTING, created);
  return created;
}

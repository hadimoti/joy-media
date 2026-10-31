import {
  getOAuthClient,
  signInProviders,
} from '@joy-media/provider-sdk';
import {
  newExtAgentHostId,
  signInWithChatGpt,
  signInWithKimiCode,
  signInWithXai,
  type OAuthAuthorizationPresentation,
} from '@joy-media/provider-oauth';
import { loadCliConfig, openCredentialStore, saveCliConfig } from '../utils/config.js';
import type { OAuthCredential } from '../utils/credential-store.js';

export type OAuthProfileProvider = 'chatgpt' | 'kimi' | 'xai';

export interface OAuthProfileSignInInput {
  readonly profileId: string;
  readonly provider: OAuthProfileProvider;
  /** The CLI presents device-code fields in the terminal and never launches a browser. */
  readonly onAuthorization: (presentation: OAuthAuthorizationPresentation) => void;
  readonly onSlowDown?: () => void;
}

/** Runs one shared provider flow without opening a browser or writing its token. */
export async function signInOAuthProfile(
  input: OAuthProfileSignInInput,
): Promise<OAuthCredential> {
  const client = getOAuthClient(input.provider);
  const fetchFromProvider = (url: string, init: RequestInit): Promise<Response> =>
    globalThis.fetch(url, init);
  const openChatGptAuthorization = (url: string): void => input.onAuthorization({ url });
  const doNotOpenBrowser = (): void => undefined;
  const now = (): number => Date.now();

  switch (input.provider) {
    case 'chatgpt': {
      const config = loadCliConfig();
      const extAgentHostId = config.chatgptExtAgentHostId ?? newExtAgentHostId();
      if (config.chatgptExtAgentHostId === undefined) {
        saveCliConfig({ ...config, chatgptExtAgentHostId: extAgentHostId });
      }
      const existing = openCredentialStore().read(input.profileId);
      const issuedClientId =
        existing !== undefined && 'provider' in existing && existing.provider === 'chatgpt'
          ? existing.tokenRecord.clientId
          : client?.clientId;
      const tokenRecord = await signInWithChatGpt({
        issuedClientId,
        extAgentHostId,
        openExternal: openChatGptAuthorization,
        fetch: fetchFromProvider,
        now,
      });
      return { provider: 'chatgpt', tokenRecord };
    }
    case 'kimi': {
      const tokenRecord = await signInWithKimiCode({
        ...(client?.clientId === undefined ? {} : { clientId: client.clientId }),
        openExternal: doNotOpenBrowser,
        onAuthorization: input.onAuthorization,
        ...(input.onSlowDown === undefined ? {} : { onSlowDown: input.onSlowDown }),
        fetch: fetchFromProvider,
        now,
      });
      return { provider: 'kimi', tokenRecord };
    }
    case 'xai': {
      // The shared registry records the OAuth base and model access confirmed by the attended probe.
      // Source: D22 step 4 probe evidence (2026-10-31).
      const tokenRecord = await signInWithXai({
        ...(client?.clientId === undefined ? {} : { clientId: client.clientId }),
        openExternal: doNotOpenBrowser,
        onAuthorization: input.onAuthorization,
        ...(input.onSlowDown === undefined ? {} : { onSlowDown: input.onSlowDown }),
        fetch: fetchFromProvider,
        now,
      });
      return { provider: 'xai', tokenRecord };
    }
  }
}

export function isOAuthProfileProvider(provider: string): provider is OAuthProfileProvider {
  return signInProviders().includes(provider as OAuthProfileProvider);
}

export function oauthTokenExpiry(credential: OAuthCredential, now = Date.now()): string {
  const expiresAt = credential.tokenRecord.accessExpiresAt;
  if (expiresAt <= now) return 'expired; refresh on next use';
  const minutes = Math.floor((expiresAt - now) / 60_000);
  return `expires in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

import {
  getOAuthClient,
  signInProviders,
  type MiniMaxRegion,
} from '@joy-media/provider-sdk';
import {
  newExtAgentHostId,
  signInWithChatGpt,
  signInWithKimiCode,
  signInWithMiniMax,
  signInWithXai,
  type ChatGptTokenRecord,
  type KimiTokenRecord,
  type MiniMaxTokenRecord,
  type XaiTokenRecord,
} from '@joy-media/provider-oauth';
import { loadCliConfig, openCredentialStore, saveCliConfig } from '../utils/config.js';
import type { OAuthCredential } from '../utils/credential-store.js';

export type OAuthProfileProvider = 'chatgpt' | 'minimax' | 'kimi' | 'xai';

export interface OAuthProfileSignInInput {
  readonly profileId: string;
  readonly provider: OAuthProfileProvider;
  readonly region: MiniMaxRegion;
  /** The CLI presents this URL in the terminal and never launches a browser. */
  readonly onAuthorization: (url: string) => void;
}

/** Runs one shared provider flow without opening a browser or writing its token. */
export async function signInOAuthProfile(
  input: OAuthProfileSignInInput,
): Promise<OAuthCredential> {
  const client = getOAuthClient(input.provider);
  const fetchFromProvider = (url: string, init: RequestInit): Promise<Response> =>
    globalThis.fetch(url, init);
  const openExternal = (url: string): void => input.onAuthorization(url);
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
        openExternal,
        fetch: fetchFromProvider,
        now,
      });
      return { provider: 'chatgpt', tokenRecord };
    }
    case 'minimax': {
      if (client?.clientId === undefined) {
        throw new Error('MiniMax OAuth is not configured in this build.');
      }
      const tokenRecord = await signInWithMiniMax({
        clientId: client.clientId,
        region: input.region,
        openExternal,
        fetch: fetchFromProvider,
        now,
      });
      return { provider: 'minimax', tokenRecord };
    }
    case 'kimi': {
      const tokenRecord: KimiTokenRecord = await signInWithKimiCode({
        ...(client?.clientId === undefined ? {} : { clientId: client.clientId }),
        openExternal,
        fetch: fetchFromProvider,
        now,
      });
      return { provider: 'kimi', tokenRecord };
    }
    case 'xai': {
      // The shared registry still marks xAI's route and account access unverified; saving is pending only.
      const tokenRecord: XaiTokenRecord = await signInWithXai({
        ...(client?.clientId === undefined ? {} : { clientId: client.clientId }),
        openExternal,
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

export function isMiniMaxRegion(region: string | undefined): region is MiniMaxRegion {
  return region === 'global' || region === 'cn';
}

export function oauthTokenExpiry(credential: OAuthCredential, now = Date.now()): string {
  const expiresAt = credential.tokenRecord.accessExpiresAt;
  if (expiresAt <= now) return 'expired; refresh on next use';
  const minutes = Math.floor((expiresAt - now) / 60_000);
  return `expires in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

export type OAuthTokenRecord =
  | ChatGptTokenRecord
  | MiniMaxTokenRecord
  | KimiTokenRecord
  | XaiTokenRecord;

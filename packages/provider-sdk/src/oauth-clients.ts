/** An OAuth provider whose public client ID can be replaced through app settings. */
export type OAuthClientProviderId = 'chatgpt' | 'minimax' | 'kimi' | 'xai';

/** One provider's default OAuth client and the source for that public client identity. */
export interface OAuthClient {
  readonly clientId: string | undefined;
  readonly source: string;
  readonly configurable: boolean;
}

const OAUTH_CLIENTS: Readonly<Record<OAuthClientProviderId, OAuthClient>> = {
  chatgpt: {
    clientId: undefined,
    source: 'OpenAI Sign in with ChatGPT dynamic client registration (PLAN-v4 §6d-3).',
    configurable: true,
  },
  minimax: {
    clientId: '78257093-7e40-4613-99e0-527b14b39113',
    source:
      'OpenClaw public client, confirmed in the D22 step 1 brief and MiniMax OAuth retest checkpoint at session-handoff/mcode-p4b/p4b-checkpoint-2026-10-30-minimax-oauth-retest.md.',
    configurable: true,
  },
  kimi: {
    clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
    source:
      'Kimi Code CLI public client, https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/guides/getting-started.md.',
    configurable: true,
  },
  xai: {
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
    source:
      'Grok Build public CLI client, https://github.com/xai-org/grok-build/tree/main/crates/codegen/xai-grok-shell/src/auth, as named in the D22 step 1 brief.',
    configurable: true,
  },
};

/** Returns the configured client metadata, using a non-empty app-settings value before its public default. */
export function getOAuthClient(
  provider: string,
  settingsOverride?: string,
): OAuthClient | undefined {
  if (!Object.hasOwn(OAUTH_CLIENTS, provider)) return undefined;
  const base = OAUTH_CLIENTS[provider as OAuthClientProviderId];
  const override = typeof settingsOverride === 'string' ? settingsOverride.trim() : '';
  return {
    ...base,
    clientId: override.length > 0 ? override : base.clientId,
  };
}

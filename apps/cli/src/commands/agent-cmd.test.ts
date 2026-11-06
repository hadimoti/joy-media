import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli.js';
import { resolveAgentConfig } from '../agent/provider.js';
import { oauthProfileLockPath } from '../agent/oauth-runtime.js';
import type { OAuthCredential } from '../utils/credential-store.js';
import type * as ConfigModule from '../utils/config.js';
import {
  loadAiProviders,
  getAiProvidersPath,
  loadCliConfig,
  openCredentialStore,
  setAiProvider,
  updateCliConfig,
} from '../utils/config.js';

const { signInOAuthProfileMock, failPendingClear } = vi.hoisted(() => ({
  signInOAuthProfileMock: vi.fn(),
  failPendingClear: { on: false },
}));
vi.mock('../agent/oauth.js', async (importOriginal) => ({
  ...(await importOriginal()),
  signInOAuthProfile: signInOAuthProfileMock,
}));
// Passes through to the real config, except that a test can make the pending-registration write fail.
vi.mock('../utils/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return {
    ...actual,
    clearPendingChatGptRegistrations: (profileId: string) => {
      if (failPendingClear.on) throw new Error('config write failed');
      return actual.clearPendingChatGptRegistrations(profileId);
    },
  };
});

/** The key the listing must never show, not even a part of one (PLAN-v4 §6d-1). */
const SECRET = 'sk-or-cli-secret-0123456789abcdef';

/** Each test runs against its own home directory, so the owner's real configuration is never read or written. */
const savedEnvironment = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  JOY_MEDIA_HOME: process.env.JOY_MEDIA_HOME,
};

describe('the CLI provider listing', () => {
  let home = '';
  let printed: string[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'joy-provider-list-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.JOY_MEDIA_HOME = join(home, '.joy-media');
    printed = [];
    const record = (...args: unknown[]): void => {
      printed.push(args.map(String).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'warn').mockImplementation(record);
    vi.spyOn(console, 'error').mockImplementation(record);
    setAiProvider('openrouter', {
      name: 'openrouter',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: SECRET,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('lists a provider with a key without printing any character of that key', async () => {
    const code = await runCli(['agent', 'provider', 'list']);
    expect(code).toBe(0);
    const output = printed.join('\n');
    // The provider is listed, and the key is reported as present, so this cannot pass vacuously.
    expect(output).toContain('openrouter');
    expect(output).toContain('API Key');
    expect(output).toContain('set (hidden)');
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(SECRET.slice(0, 4));
    expect(output).not.toContain(SECRET.slice(-4));
    expect(signInOAuthProfileMock).not.toHaveBeenCalled();
  });
});

describe('OAuth provider profiles', () => {
  let home = '';
  let printed: string[] = [];
  let errors: string[] = [];
  let order: string[] = [];
  let terminalWrites: string[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'joy-oauth-profile-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.JOY_MEDIA_HOME = join(home, '.joy-media');
    printed = [];
    errors = [];
    order = [];
    terminalWrites = [];
    signInOAuthProfileMock.mockReset();
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const text = args.map(String).join(' ');
      printed.push(text);
      order.push(`stdout:${text}`);
    });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const text = args.map(String).join(' ');
      errors.push(text);
      order.push(`stderr:${text}`);
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      terminalWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('The OAuth profile command must not discover models.');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('creates a Kimi OAuth profile after the one approved notice and keeps tokens out of output', async () => {
    const accessToken = 'kimi-access-secret-for-cli-test';
    const refreshToken = 'kimi-refresh-secret-for-cli-test';
    const expiresAt = Date.UTC(2026, 10, 1, 12);
    signInOAuthProfileMock.mockImplementation(
      async (input: {
        readonly onAuthorization: (presentation: {
          readonly url: string;
          readonly userCode: string;
          readonly expiresAt: number;
        }) => void;
        readonly onSlowDown?: () => void;
      }) => {
        order.push('sign-in');
        input.onAuthorization({
          url: 'https://www.kimi.ai/code/authorize_device?user_code=KIMI-CODE-TEST',
          userCode: 'KIMI-CODE-TEST',
          expiresAt,
        });
        input.onSlowDown?.();
        return {
          provider: 'kimi',
          tokenRecord: {
            version: 1,
            clientId: 'kimi-client-test',
            accessToken,
            refreshToken,
            accessExpiresAt: Date.now() + 3_600_000,
            scope: 'kimi-code',
          },
        };
      },
    );

    const code = await runCli([
      'agent',
      'provider',
      'add',
      'kimi-profile',
      '--provider',
      'kimi',
      '--oauth',
      '--model',
      'kimi-code-model',
    ]);

    expect(code).toBe(0);
    expect(signInOAuthProfileMock).toHaveBeenCalledTimes(1);
    const notice =
      'Signing in uses a third-party public app, and the provider may disable it in the future. An API key is the better, more dependable way to connect.';
    expect(errors).toEqual([notice]);
    expect(order.indexOf(`stderr:${notice}`)).toBeLessThan(order.indexOf('sign-in'));
    expect(printed.join('\n')).toContain(
      'Approval URL: https://www.kimi.ai/code/authorize_device?user_code=KIMI-CODE-TEST',
    );
    expect(printed.join('\n')).toContain('User code: KIMI-CODE-TEST');
    expect(printed.join('\n')).toContain(`Code expires at: ${new Date(expiresAt).toISOString()}`);
    expect(printed.join('\n')).toContain('Waiting for approval. Press Ctrl+C to cancel.');
    expect(printed.join('\n')).toContain(
      'Waiting for approval; the provider asked us to slow down. Press Ctrl+C to cancel.',
    );
    expect(printed.join('\n')).toContain('Provider "kimi-profile" configured successfully');
    expect(printed.join('\n')).toContain('Auth: OAuth (kimi)');
    expect(printed.join('\n')).toContain('kimi-code-model');
    expect(printed.join('\n')).not.toContain(accessToken);
    expect(printed.join('\n')).not.toContain(refreshToken);
    expect(errors.join('\n')).not.toContain('KIMI-CODE-TEST');
    expect(loadAiProviders()['kimi-profile']).toMatchObject({
      authKind: 'oauth',
      provider: 'kimi',
      defaultModel: 'kimi-code-model',
    });
    expect(openCredentialStore().read('kimi-profile')).toEqual({
      provider: 'kimi',
      tokenRecord: expect.objectContaining({ accessToken, refreshToken }),
    });
    expect(loadCliConfig().activeProvider).toBeUndefined();
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('creates an xAI OAuth profile with the verified base and keeps tokens out of output', async () => {
    const accessToken = 'xai-access-secret-for-cli-test';
    const refreshToken = 'xai-refresh-secret-for-cli-test';
    signInOAuthProfileMock.mockResolvedValue({
      provider: 'xai',
      tokenRecord: {
        version: 1,
        clientId: 'xai-client-test',
        accessToken,
        refreshToken,
        accessExpiresAt: Date.now() + 3_600_000,
        scope: 'openid profile api:access',
      },
    });

    expect(
      await runCli(['agent', 'provider', 'add', 'xai-profile', '--provider', 'xai', '--oauth']),
    ).toBe(0);
    expect(loadAiProviders()['xai-profile']).toMatchObject({
      provider: 'xai',
      authKind: 'oauth',
      baseUrl: 'https://api.x.ai/v1',
    });
    expect(printed.join('\n')).not.toContain(accessToken);
    expect(printed.join('\n')).not.toContain(refreshToken);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('rejects missing provider, unsupported regions and mixed auth flags before sign-in', async () => {
    const cases = [
      {
        args: ['agent', 'provider', 'add', 'missing-provider', '--oauth'],
        message: '--provider',
      },
      {
        args: ['agent', 'provider', 'add', 'minimax-profile', '--provider', 'minimax', '--oauth'],
        message: 'Provider "minimax" does not offer OAuth sign-in.',
      },
      {
        args: [
          'agent',
          'provider',
          'add',
          'mixed-auth',
          '--provider',
          'kimi',
          '--oauth',
          '--api-key',
          'key-test',
        ],
        message: '--api-key',
      },
      {
        args: [
          'agent',
          'provider',
          'add',
          'mixed-auth-url',
          '--provider',
          'kimi',
          '--oauth',
          '--url',
          'https://provider.example/v1',
        ],
        message: '--url',
      },
    ];

    for (const testCase of cases) {
      errors = [];
      expect(await runCli(testCase.args)).toBe(1);
      expect(errors.join('\n')).toContain(testCase.message);
    }
    expect(signInOAuthProfileMock).not.toHaveBeenCalled();
    expect(errors.join('\n')).not.toContain('third-party public app');
  });

  it('no longer accepts the MiniMax-only --region flag', async () => {
    expect(
      await runCli([
        'agent',
        'provider',
        'add',
        'region-removed',
        '--provider',
        'kimi',
        '--oauth',
        '--region',
        'global',
      ]),
    ).toBe(2);

    expect(errors.join('\n')).toContain('Unknown option --region');
    expect(signInOAuthProfileMock).not.toHaveBeenCalled();
  });

  it('reauthorizes the same OAuth provider and stores the replacement only after sign-in', async () => {
    const previous = {
      provider: 'kimi' as const,
      tokenRecord: {
        version: 1 as const,
        clientId: 'kimi-client-test',
        accessToken: 'kimi-old-access-secret',
        refreshToken: 'kimi-old-refresh-secret',
        accessExpiresAt: Date.now() + 60_000,
        scope: 'kimi-code',
      },
    };
    setAiProvider('kimi-profile', {
      name: 'kimi-profile',
      provider: 'kimi',
      authKind: 'oauth',
      defaultModel: 'old-model',
    });
    openCredentialStore().save('kimi-profile', previous);
    signInOAuthProfileMock.mockResolvedValue({
      provider: 'kimi',
      tokenRecord: {
        version: 1,
        clientId: 'kimi-client-test',
        accessToken: 'kimi-new-access-secret',
        refreshToken: 'kimi-new-refresh-secret',
        accessExpiresAt: Date.now() + 3_600_000,
        scope: 'kimi-code',
      },
    });

    expect(
      await runCli([
        'agent',
        'provider',
        'add',
        'kimi-profile',
        '--provider',
        'kimi',
        '--oauth',
        '--model',
        'new-model',
      ]),
    ).toBe(0);

    expect(openCredentialStore().read('kimi-profile')).toMatchObject({
      provider: 'kimi',
      tokenRecord: {
        accessToken: 'kimi-new-access-secret',
        refreshToken: 'kimi-new-refresh-secret',
      },
    });
    expect(loadAiProviders()['kimi-profile']?.defaultModel).toBe('new-model');
  });

  it('refuses to change an API-key profile into OAuth before making a provider request', async () => {
    setAiProvider('existing-key', {
      name: 'existing-key',
      provider: 'openrouter',
      authKind: 'api-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'api-key-secret-test',
    });

    expect(
      await runCli(['agent', 'provider', 'add', 'existing-key', '--provider', 'kimi', '--oauth']),
    ).toBe(1);
    expect(errors.join('\n')).toContain('remove it before changing authentication');
    expect(signInOAuthProfileMock).not.toHaveBeenCalled();
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('preserves an existing credential if saving reauthorization metadata fails', async () => {
    const oldCredential = {
      provider: 'chatgpt' as const,
      tokenRecord: {
        version: 1 as const,
        clientId: 'oaiapp_old',
        accountId: 'account-old',
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        accessExpiresAt: Date.now() + 3600000,
      },
    };
    setAiProvider('chatgpt-profile', {
      name: 'chatgpt-profile',
      provider: 'chatgpt',
      authKind: 'oauth',
    });
    openCredentialStore().save('chatgpt-profile', oldCredential);
    signInOAuthProfileMock.mockImplementation(async () => {
      writeFileSync(getAiProvidersPath(), '{broken');
      return {
        provider: 'chatgpt',
        tokenRecord: { ...oldCredential.tokenRecord, accessToken: 'new-access' },
      };
    });
    expect(
      await runCli([
        'agent',
        'provider',
        'add',
        'chatgpt-profile',
        '--provider',
        'chatgpt',
        '--oauth',
      ]),
    ).toBe(1);
    expect(openCredentialStore().read('chatgpt-profile')).toEqual(oldCredential);
  });

  it('holds the profile lock from sign-in until the profile is stored, then releases it', async () => {
    const lockPath = oauthProfileLockPath('chatgpt-profile');
    let heldDuringSignIn = false;
    signInOAuthProfileMock.mockImplementation(async () => {
      heldDuringSignIn = existsSync(lockPath);
      return {
        provider: 'chatgpt',
        tokenRecord: {
          version: 1,
          clientId: 'oaiapp_locked',
          accountId: 'account-test',
          accessToken: 'access-test',
          refreshToken: 'refresh-test',
          accessExpiresAt: Date.now() + 3600000,
        },
      };
    });
    expect(
      await runCli([
        'agent',
        'provider',
        'add',
        'chatgpt-profile',
        '--provider',
        'chatgpt',
        '--oauth',
      ]),
    ).toBe(0);
    expect(heldDuringSignIn).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('restores the previous profile settings when the new credential cannot be saved', async () => {
    setAiProvider('chatgpt-profile', {
      name: 'chatgpt-profile',
      provider: 'chatgpt',
      authKind: 'oauth',
      defaultModel: 'old-model',
    });
    signInOAuthProfileMock.mockResolvedValue({
      provider: 'chatgpt',
      tokenRecord: { version: 1 },
    } as unknown as OAuthCredential);
    expect(
      await runCli([
        'agent',
        'provider',
        'add',
        'chatgpt-profile',
        '--provider',
        'chatgpt',
        '--oauth',
        '--model',
        'new-model',
      ]),
    ).toBe(1);
    expect(loadAiProviders()['chatgpt-profile']?.defaultModel).toBe('old-model');
  });

  it('a failed pending-registration clear is reported before the profile is removed', async () => {
    setAiProvider('chatgpt-profile', {
      name: 'chatgpt-profile',
      provider: 'chatgpt',
      authKind: 'oauth',
    });
    failPendingClear.on = true;
    try {
      expect(await runCli(['agent', 'provider', 'remove', 'chatgpt-profile'])).not.toBe(0);
    } finally {
      failPendingClear.on = false;
    }
    expect(loadAiProviders()['chatgpt-profile']?.authKind).toBe('oauth');
  });

  it('keeps the profile when its stored key cannot be deleted, so no orphaned key can reattach', async () => {
    setAiProvider('chatgpt-profile', {
      name: 'chatgpt-profile',
      provider: 'chatgpt',
      authKind: 'oauth',
    });
    writeFileSync(join(process.env.JOY_MEDIA_HOME!, 'credentials.json'), '{broken');
    expect(await runCli(['agent', 'provider', 'remove', 'chatgpt-profile'])).not.toBe(0);
    expect(loadAiProviders()['chatgpt-profile']?.authKind).toBe('oauth');
  });

  it('removing a name discards its kept ChatGPT registration even when no profile was saved', async () => {
    updateCliConfig((config) => ({
      ...config,
      chatgptPendingRegistrations: [
        { profileId: 'ghost', clientId: 'oaiapp_ghost' },
        { profileId: 'other', clientId: 'oaiapp_other' },
      ],
    }));
    expect(await runCli(['agent', 'provider', 'remove', 'ghost'])).toBe(0);
    expect(loadCliConfig().chatgptPendingRegistrations).toEqual([
      { profileId: 'other', clientId: 'oaiapp_other' },
    ]);
  });

  it('clears the matching pending ChatGPT registration only after storing the profile', async () => {
    updateCliConfig((config) => ({
      ...config,
      chatgptPendingRegistrations: [
        { profileId: 'chatgpt-profile', clientId: 'oaiapp_pending' },
        { profileId: 'other', clientId: 'oaiapp_other' },
      ],
    }));
    signInOAuthProfileMock.mockResolvedValue({
      provider: 'chatgpt',
      tokenRecord: {
        version: 1,
        clientId: 'oaiapp_pending',
        accountId: 'account-test',
        accessToken: 'access-test',
        refreshToken: 'refresh-test',
        accessExpiresAt: Date.now() + 3600000,
      },
    });
    expect(
      await runCli([
        'agent',
        'provider',
        'add',
        'chatgpt-profile',
        '--provider',
        'chatgpt',
        '--oauth',
      ]),
    ).toBe(0);
    expect(loadAiProviders()['chatgpt-profile']?.authKind).toBe('oauth');
    expect(loadCliConfig().chatgptPendingRegistrations).toEqual([
      { profileId: 'other', clientId: 'oaiapp_other' },
    ]);
  });

  it('explains the ChatGPT loopback and remote-machine limitation without launching a browser', async () => {
    const authorizationUrl = 'https://auth.openai.com/api/accounts/authorize?state=cli-test';
    signInOAuthProfileMock.mockImplementation(
      async (input: {
        readonly onAuthorization: (presentation: { readonly url: string }) => void;
      }) => {
        input.onAuthorization({ url: authorizationUrl });
        return {
          provider: 'chatgpt',
          tokenRecord: {
            version: 1,
            clientId: 'chatgpt-client-test',
            accountId: 'account-test',
            accessToken: 'chatgpt-access-secret',
            refreshToken: 'chatgpt-refresh-secret',
            accessExpiresAt: Date.now() + 3_600_000,
          },
        };
      },
    );

    expect(
      await runCli([
        'agent',
        'provider',
        'add',
        'chatgpt-profile',
        '--provider',
        'chatgpt',
        '--oauth',
      ]),
    ).toBe(0);
    expect(printed.join('\n')).toContain(`Approval URL: ${authorizationUrl}`);
    expect(printed.join('\n')).toContain(
      'A remote CLI with no browser on that machine cannot complete it.',
    );
    expect(errors.join('\n')).not.toContain('Signing in uses a third-party public app');
    expect(printed.join('\n')).not.toContain('chatgpt-access-secret');
    expect(printed.join('\n')).not.toContain('chatgpt-refresh-secret');
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('lists xAI OAuth without displaying its base or token', async () => {
    setAiProvider('xai-profile', {
      name: 'xai-profile',
      provider: 'xai',
      authKind: 'oauth',
    });
    openCredentialStore().save('xai-profile', {
      provider: 'xai',
      tokenRecord: {
        version: 1,
        clientId: 'xai-client-test',
        accessToken: 'xai-access-secret',
        refreshToken: 'xai-refresh-secret',
        accessExpiresAt: Date.now() + 2_430_000,
        scope: 'openid profile api:access',
      },
    });

    expect(await runCli(['agent', 'provider', 'list'])).toBe(0);
    const output = printed.join('\n');
    expect(output).toContain('Auth: OAuth (xai)');
    expect(output).toContain('Access token: expires in 40 minutes');
    expect(output).not.toContain('Inference: needs attended verification');
    expect(output).not.toContain('https://api.x.ai/v1');
    expect(output).not.toContain('xai-access-secret');
    expect(output).not.toContain('xai-refresh-secret');
    expect(output).not.toContain('xai-access');
    expect(output).not.toContain('xai-refresh');
    expect(output).not.toContain('ess-secret');
    expect(output).not.toContain('esh-secret');
    expect(output).not.toContain('API Key');
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('lists models with a Kimi bearer token from the OAuth profile', async () => {
    const accessToken = 'kimi-model-list-access-token';
    setAiProvider('kimi-profile', {
      name: 'kimi-profile',
      provider: 'kimi',
      authKind: 'oauth',
      baseUrl: 'https://api.kimi.ai/coding/v1',
      defaultModel: 'kimi-model',
    });
    openCredentialStore().save('kimi-profile', {
      provider: 'kimi',
      tokenRecord: {
        version: 1,
        clientId: 'kimi-client-test',
        accessToken,
        refreshToken: 'kimi-model-list-refresh-token',
        accessExpiresAt: Date.now() + 3_600_000,
        scope: 'kimi-code',
      },
    });
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'kimi-code-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(await runCli(['agent', 'models', 'kimi-profile'])).toBe(0);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(url).toBe('https://api.kimi.ai/coding/v1/models');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${accessToken}`);
    expect(printed.join('\n')).toContain('kimi-code-model');
  });

  it('resolves a saved OAuth profile to a typed bearer token and rejects API-key override', async () => {
    const accessToken = 'kimi-chat-access-token';
    setAiProvider('kimi-profile', {
      name: 'kimi-profile',
      provider: 'kimi',
      authKind: 'oauth',
      baseUrl: 'https://api.kimi.ai/coding/v1',
      defaultModel: 'kimi-code-model',
    });
    openCredentialStore().save('kimi-profile', {
      provider: 'kimi',
      tokenRecord: {
        version: 1,
        clientId: 'kimi-client-test',
        accessToken,
        refreshToken: 'kimi-chat-refresh-token',
        accessExpiresAt: Date.now() + 3_600_000,
        scope: 'kimi-code',
      },
    });

    const config = await resolveAgentConfig({ provider: 'kimi-profile' });

    expect(config).toMatchObject({
      provider: 'openai-compatible',
      baseUrl: 'https://api.kimi.ai/coding/v1',
      modelId: 'kimi-code-model',
      auth: { kind: 'bearer-token', token: accessToken },
    });
    expect('apiKey' in config).toBe(false);
    await expect(
      resolveAgentConfig({ provider: 'kimi-profile', apiKey: 'api-key-override-must-not-be-used' }),
    ).rejects.toThrow('cannot use --api-key');
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('resolves a ChatGPT OAuth profile to the fixed Responses bridge with typed bearer auth', async () => {
    const accessToken = 'chatgpt-chat-access-token';
    setAiProvider('chatgpt-profile', {
      name: 'chatgpt-profile',
      provider: 'chatgpt',
      authKind: 'oauth',
      defaultModel: 'gpt-test',
    });
    openCredentialStore().save('chatgpt-profile', {
      provider: 'chatgpt',
      tokenRecord: {
        version: 1,
        clientId: 'chatgpt-client-test',
        accountId: 'chatgpt-account-test',
        accessToken,
        refreshToken: 'chatgpt-chat-refresh-token',
        accessExpiresAt: Date.now() + 3_600_000,
      },
    });

    const config = await resolveAgentConfig({ provider: 'chatgpt-profile' });

    expect(config).toMatchObject({
      provider: 'chatgpt-responses',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-test',
      auth: { kind: 'bearer-token', token: accessToken },
    });
    expect('apiKey' in config).toBe(false);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('lists the ChatGPT account models with the OAuth bearer route', async () => {
    const accessToken = 'chatgpt-model-access-test';
    setAiProvider('chatgpt-profile', {
      name: 'chatgpt-profile',
      provider: 'chatgpt',
      authKind: 'oauth',
      defaultModel: 'gpt-visible',
    });
    openCredentialStore().save('chatgpt-profile', {
      provider: 'chatgpt',
      tokenRecord: {
        version: 1,
        clientId: 'chatgpt-client-test',
        accountId: 'chatgpt-account-test',
        accessToken,
        refreshToken: 'chatgpt-model-refresh-test',
        accessExpiresAt: Date.now() + 3_600_000,
      },
    });
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            { slug: 'gpt-visible', display_name: 'Visible GPT', visibility: 'list' },
            { slug: 'gpt-hidden', display_name: 'Hidden GPT', visibility: 'hide' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    expect(await runCli(['agent', 'models', 'chatgpt-profile'])).toBe(0);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/models');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${accessToken}`);
    expect(printed.join('\n')).toContain('gpt-visible');
    expect(printed.join('\n')).not.toContain('gpt-hidden');
  });

  it('gives up on a model list whose reply never arrives, after 30 seconds', async () => {
    setAiProvider('chatgpt-profile', {
      name: 'chatgpt-profile',
      provider: 'chatgpt',
      authKind: 'oauth',
      defaultModel: 'gpt-visible',
    });
    openCredentialStore().save('chatgpt-profile', {
      provider: 'chatgpt',
      tokenRecord: {
        version: 1,
        clientId: 'chatgpt-client-test',
        accountId: 'chatgpt-account-test',
        accessToken: 'chatgpt-stall-access-test',
        refreshToken: 'chatgpt-stall-refresh-test',
        accessExpiresAt: Date.now() + 3_600_000,
      },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
        // The clock runs 30 seconds while the list stays silent, as a stalled connection does.
        await vi.advanceTimersByTimeAsync(30_000);
        if (init?.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
        return new Response(
          JSON.stringify({ models: [{ slug: 'gpt-late', visibility: 'list' }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      });
      expect(await runCli(['agent', 'models', 'chatgpt-profile'])).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stores a rotated token before making the OAuth model-list request', async () => {
    const expired: OAuthCredential = {
      provider: 'kimi',
      tokenRecord: {
        version: 1,
        clientId: 'kimi-client-test',
        accessToken: 'kimi-before-refresh-access',
        refreshToken: 'kimi-before-refresh-token',
        accessExpiresAt: Date.now() + 1_000,
        scope: 'kimi-code',
      },
    };
    setAiProvider('kimi-profile', {
      name: 'kimi-profile',
      provider: 'kimi',
      authKind: 'oauth',
      baseUrl: 'https://api.kimi.ai/coding/v1',
      defaultModel: 'kimi-model',
    });
    openCredentialStore().save('kimi-profile', expired);
    const calls: Array<{ url: string; authorization: string | null }> = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      if (url.includes('/api/oauth/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'kimi-after-refresh-access',
            refresh_token: 'kimi-after-refresh-token',
            expires_in: 1800,
            scope: 'kimi-code',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ data: [{ id: 'kimi-code-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    expect(await runCli(['agent', 'models', 'kimi-profile'])).toBe(0);
    expect(calls).toEqual([
      expect.objectContaining({ url: expect.stringContaining('/api/oauth/token') }),
      {
        url: 'https://api.kimi.ai/coding/v1/models',
        authorization: 'Bearer kimi-after-refresh-access',
      },
    ]);
    expect(openCredentialStore().read('kimi-profile')).toMatchObject({
      provider: 'kimi',
      tokenRecord: {
        accessToken: 'kimi-after-refresh-access',
        refreshToken: 'kimi-after-refresh-token',
      },
    });
  });

  it('does not request models or fall back to a key when OAuth refresh fails', async () => {
    const expired: OAuthCredential = {
      provider: 'kimi',
      tokenRecord: {
        version: 1,
        clientId: 'kimi-client-test',
        accessToken: 'kimi-expired-access-token',
        refreshToken: 'kimi-expired-refresh-token',
        accessExpiresAt: Date.now() + 1_000,
        scope: 'kimi-code',
      },
    };
    setAiProvider('kimi-profile', {
      name: 'kimi-profile',
      provider: 'kimi',
      authKind: 'oauth',
      baseUrl: 'https://api.kimi.ai/coding/v1',
      defaultModel: 'kimi-model',
    });
    openCredentialStore().save('kimi-profile', expired);
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant', detail: 'provider-body-secret' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(await runCli(['agent', 'models', 'kimi-profile'])).toBe(1);
    const message =
      'OAuth refresh failed for kimi-profile. No provider request was sent. Reauthorize with: joy-media agent provider add kimi-profile --provider kimi --oauth.';
    expect(errors[0]).toBe(`✖ ${message}`);
    expect(errors.join('\n')).not.toContain('provider-body-secret');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0])).toContain('/api/oauth/token');
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0])).not.toContain('/models');
    expect(openCredentialStore().read('kimi-profile')).toEqual(expired);
  });

  it('lists models with an xAI bearer token from the OAuth profile', async () => {
    const accessToken = 'xai-model-list-access-secret';
    const refreshToken = 'xai-model-list-refresh-secret';
    setAiProvider('xai-profile', {
      name: 'xai-profile',
      provider: 'xai',
      authKind: 'oauth',
    });
    openCredentialStore().save('xai-profile', {
      provider: 'xai',
      tokenRecord: {
        version: 1,
        clientId: 'xai-client-test',
        accessToken,
        refreshToken,
        accessExpiresAt: Date.now() + 3_600_000,
        scope: 'openid profile api:access',
      },
    });
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'grok-test-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(await runCli(['agent', 'models', 'xai-profile'])).toBe(0);
    expect(errors).toEqual([]);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(url).toBe('https://api.x.ai/v1/models');
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${accessToken}`);
    const output = printed.join('\n');
    expect(output).toContain('grok-test-model');
    expect(output).not.toContain(accessToken);
    expect(output).not.toContain(refreshToken);
  });

  it('resolves an xAI OAuth profile to a bearer session config at the verified base', async () => {
    const accessToken = 'xai-inference-access-secret';
    setAiProvider('xai-profile', {
      name: 'xai-profile',
      provider: 'xai',
      authKind: 'oauth',
      defaultModel: 'grok-test',
    });
    openCredentialStore().save('xai-profile', {
      provider: 'xai',
      tokenRecord: {
        version: 1,
        clientId: 'xai-client-test',
        accessToken,
        refreshToken: 'xai-inference-refresh-secret',
        accessExpiresAt: Date.now() + 3_600_000,
        scope: 'openid profile api:access',
      },
    });

    const config = await resolveAgentConfig({ provider: 'xai-profile' });

    expect(config).toMatchObject({
      provider: 'openai-compatible',
      baseUrl: 'https://api.x.ai/v1',
      modelId: 'grok-test',
      auth: { kind: 'bearer-token', token: accessToken },
    });
    expect('apiKey' in config).toBe(false);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});

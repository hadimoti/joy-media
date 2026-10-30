import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli.js';
import {
  loadAiProviders,
  loadCliConfig,
  openCredentialStore,
  setAiProvider,
} from '../utils/config.js';

const { signInOAuthProfileMock } = vi.hoisted(() => ({ signInOAuthProfileMock: vi.fn() }));
vi.mock('../agent/oauth.js', async (importOriginal) => ({
  ...(await importOriginal()),
  signInOAuthProfile: signInOAuthProfileMock,
}));

/** The key the listing must never show, not even a part of one (PLAN-v4 §6d-1). */
const SECRET = 'sk-or-cli-secret-0123456789abcdef';

/** Each test runs against its own home directory, so the owner's real configuration is never read or written. */
const savedEnvironment = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

describe('the CLI provider listing', () => {
  let home = '';
  let printed: string[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'joy-provider-list-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
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
  });
});

describe('OAuth provider profiles', () => {
  let home = '';
  let printed: string[] = [];
  let errors: string[] = [];
  let order: string[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'joy-oauth-profile-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    printed = [];
    errors = [];
    order = [];
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
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
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
    signInOAuthProfileMock.mockImplementation(async (input: {
      readonly onAuthorization: (url: string) => void;
    }) => {
      order.push('sign-in');
      input.onAuthorization('https://www.kimi.ai/code/authorize_device?user_code=KIMI-CODE-TEST');
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
    });

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
      'Signing in uses a third-party public app and may stop working or be deactivated by the provider at any time. An API key is the dependable way to connect.';
    expect(errors).toEqual([notice]);
    expect(order.indexOf(`stderr:${notice}`)).toBeLessThan(order.indexOf('sign-in'));
    expect(printed.join('\n')).toContain('Approval URL: https://www.kimi.ai/code/authorize_device?user_code=KIMI-CODE-TEST');
    expect(printed.join('\n')).toContain('User code: KIMI-CODE-TEST');
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

  it('rejects missing provider, unsupported regions and mixed auth flags before sign-in', async () => {
    const cases = [
      {
        args: ['agent', 'provider', 'add', 'missing-provider', '--oauth'],
        message: '--provider',
      },
      {
        args: [
          'agent',
          'provider',
          'add',
          'bad-region',
          '--provider',
          'minimax',
          '--oauth',
          '--region',
          'us',
        ],
        message: '--region',
      },
      {
        args: [
          'agent',
          'provider',
          'add',
          'wrong-provider-region',
          '--provider',
          'kimi',
          '--oauth',
          '--region',
          'global',
        ],
        message: '--region',
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
      await runCli([
        'agent',
        'provider',
        'add',
        'existing-key',
        '--provider',
        'kimi',
        '--oauth',
      ]),
    ).toBe(1);
    expect(errors.join('\n')).toContain('remove it before changing authentication');
    expect(signInOAuthProfileMock).not.toHaveBeenCalled();
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('explains the ChatGPT loopback and remote-machine limitation without launching a browser', async () => {
    const authorizationUrl = 'https://auth.openai.com/api/accounts/authorize?state=cli-test';
    signInOAuthProfileMock.mockImplementation(async (input: {
      readonly onAuthorization: (url: string) => void;
    }) => {
      input.onAuthorization(authorizationUrl);
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
    expect(printed.join('\n')).toContain(`Approval URL: ${authorizationUrl}`);
    expect(printed.join('\n')).toContain(
      'A remote CLI with no browser on that machine cannot complete it.',
    );
    expect(printed.join('\n')).not.toContain('chatgpt-access-secret');
    expect(printed.join('\n')).not.toContain('chatgpt-refresh-secret');
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('lists xAI OAuth as pending without displaying its candidate base or token', async () => {
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
    expect(output).toContain('Inference: needs attended verification');
    expect(output).not.toContain('cli-chat-proxy.grok.com');
    expect(output).not.toContain('xai-access-secret');
    expect(output).not.toContain('xai-refresh-secret');
    expect(output).not.toContain('API Key');
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});

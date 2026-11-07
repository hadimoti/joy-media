import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ProviderOAuth from '@joy-media/provider-oauth';
import { signInOAuthProfile } from './oauth.js';
import { getCliConfigPath, loadCliConfig } from '../utils/config.js';

const { signInMock } = vi.hoisted(() => ({ signInMock: vi.fn() }));
vi.mock('@joy-media/provider-oauth', async (original) => ({
  ...(await original<typeof ProviderOAuth>()),
  signInWithChatGpt: signInMock,
}));

describe('CLI ChatGPT pending registration', () => {
  let home = '';
  const originalHome = process.env.JOY_MEDIA_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'joy-chatgpt-registration-'));
    process.env.JOY_MEDIA_HOME = home;
    signInMock.mockReset();
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.JOY_MEDIA_HOME;
    else process.env.JOY_MEDIA_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('reuses the issued client for this profile after a failed exchange', async () => {
    signInMock.mockImplementationOnce(async (options) => {
      expect(options.issuedClientId).toBeUndefined();
      await options.onRegistration('oaiapp_issued-cli');
      throw new Error('exchange failed');
    });
    signInMock.mockImplementationOnce(async (options) => {
      expect(options.issuedClientId).toBe('oaiapp_issued-cli');
      throw new Error('stop after checking retry');
    });
    const input = { profileId: 'one', provider: 'chatgpt' as const, onAuthorization: () => {} };
    await expect(signInOAuthProfile(input)).rejects.toThrow('exchange failed');
    expect(JSON.stringify(loadCliConfig())).toContain('oaiapp_issued-cli');
    await expect(signInOAuthProfile(input)).rejects.toThrow('stop after checking retry');
  });

  it('does not reuse one profile registration for another profile', async () => {
    signInMock.mockImplementationOnce(async (options) => {
      await options.onRegistration('oaiapp_profile-one');
      throw new Error('exchange failed');
    });
    signInMock.mockImplementationOnce(async (options) => {
      expect(options.issuedClientId).toBeUndefined();
      throw new Error('other profile checked');
    });
    await expect(
      signInOAuthProfile({ profileId: 'one', provider: 'chatgpt', onAuthorization: () => {} }),
    ).rejects.toThrow('exchange failed');
    await expect(
      signInOAuthProfile({ profileId: 'two', provider: 'chatgpt', onAuthorization: () => {} }),
    ).rejects.toThrow('other profile checked');
  });
  it('does not rewrite an existing config just to read its saved host ID', async () => {
    const hostId = 'urn:uuid:11111111-1111-4111-8111-111111111111';
    const original = `{"chatgptExtAgentHostId":"${hostId}"}`;
    writeFileSync(getCliConfigPath(), original);
    signInMock.mockImplementationOnce(async (options) => {
      expect(options.extAgentHostId).toBe(hostId);
      throw new Error('stop after host check');
    });
    await expect(
      signInOAuthProfile({ profileId: 'one', provider: 'chatgpt', onAuthorization: () => {} }),
    ).rejects.toThrow('stop after host check');
    expect(readFileSync(getCliConfigPath(), 'utf8')).toBe(original);
  });

  it('does not replace a different pending client for the same profile', async () => {
    signInMock.mockImplementationOnce(async (options) => {
      await options.onRegistration('oaiapp_first');
      await options.onRegistration('oaiapp_second');
    });
    await expect(
      signInOAuthProfile({ profileId: 'one', provider: 'chatgpt', onAuthorization: () => {} }),
    ).rejects.toThrow('Another ChatGPT registration is pending');
    expect(JSON.stringify(loadCliConfig())).toContain('oaiapp_first');
    expect(JSON.stringify(loadCliConfig())).not.toContain('oaiapp_second');
  });
});

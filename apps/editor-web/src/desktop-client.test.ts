// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkForDesktopUpdate,
  getDesktopWorkerStatus,
  isDesktopHost,
  selectDesktopFile,
  saveDesktopProviderProfile,
  listDesktopProviderProfiles,
  deleteDesktopProviderProfile,
  beginDesktopProviderSession,
  testDesktopProviderProfile,
  getDesktopAssetLibrarySettings,
  setDesktopAssetLibraryDirectory,
  selectDesktopAssetLibraryDirectory,
  getDesktopAssetLibraryCatalog,
  resolveDesktopAssetUrl,
  type DesktopUpdateCheckRequest,
  type SaveDesktopProviderProfileRequest,
  type DesktopProviderProfile,
} from './desktop-client.js';

afterEach(() => {
  delete window.joyDesktop;
});

describe('isDesktopHost', () => {
  it('is false when window.joyDesktop is absent (every browser context)', () => {
    expect(isDesktopHost()).toBe(false);
  });

  it('is true once the preload bridge has installed window.joyDesktop', () => {
    window.joyDesktop = { channels: [], invoke: vi.fn() };
    expect(isDesktopHost()).toBe(true);
  });
});

describe('getDesktopWorkerStatus', () => {
  it('rejects outside the desktop host instead of touching window.joyDesktop', async () => {
    await expect(getDesktopWorkerStatus()).rejects.toThrow('unavailable outside the desktop host');
  });

  it('invokes desktop.worker-status with no payload and returns the bridge data verbatim', async () => {
    const status = {
      connection: 'online' as const,
      workerId: 'worker-1',
      capabilities: ['transcode'],
      lastSeenAt: '2026-09-15T00:00:00.000Z',
    };
    const invoke = vi.fn().mockResolvedValue(status);
    window.joyDesktop = { channels: ['desktop.worker-status'], invoke };

    await expect(getDesktopWorkerStatus()).resolves.toEqual(status);
    expect(invoke).toHaveBeenCalledWith('desktop.worker-status');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('selectDesktopFile', () => {
  it('rejects outside the desktop host', async () => {
    await expect(selectDesktopFile()).rejects.toThrow('unavailable outside the desktop host');
  });

  it('invokes desktop.select-file and returns the selected file reference', async () => {
    const ref = { kind: 'local-file' as const, id: 'ref-1', displayName: 'clip.mp4' };
    const invoke = vi.fn().mockResolvedValue(ref);
    window.joyDesktop = { channels: ['desktop.select-file'], invoke };

    await expect(selectDesktopFile()).resolves.toEqual(ref);
    expect(invoke).toHaveBeenCalledWith('desktop.select-file');
  });

  it('resolves to undefined when the user cancels the native dialog', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    window.joyDesktop = { channels: ['desktop.select-file'], invoke };

    await expect(selectDesktopFile()).resolves.toBeUndefined();
  });
});

describe('checkForDesktopUpdate', () => {
  const request: DesktopUpdateCheckRequest = {
    manifest: {
      payload: {
        channel: 'stable',
        version: '1.2.3',
        downloadUrl: 'https://joyst.ir/releases/1.2.3.exe',
        sha256: 'a'.repeat(64),
      },
      signature: 'sig',
    },
    subscriptionActive: true,
  };

  it('rejects outside the desktop host', async () => {
    await expect(checkForDesktopUpdate(request)).rejects.toThrow(
      'unavailable outside the desktop host',
    );
  });

  it('forwards the manifest and subscription flag to desktop.check-for-update', async () => {
    const decision = { status: 'current' as const, reason: 'not-newer' as const };
    const invoke = vi.fn().mockResolvedValue(decision);
    window.joyDesktop = { channels: ['desktop.check-for-update'], invoke };

    await expect(checkForDesktopUpdate(request)).resolves.toEqual(decision);
    expect(invoke).toHaveBeenCalledWith('desktop.check-for-update', request);
  });
});

describe('saveDesktopProviderProfile', () => {
  const request: SaveDesktopProviderProfileRequest = {
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelId: 'anthropic/claude-3.5-sonnet',
    apiKey: 'sk-or-test-key-12345',
  };

  it('rejects outside the desktop host', async () => {
    await expect(saveDesktopProviderProfile(request)).rejects.toThrow(
      'unavailable outside the desktop host',
    );
  });

  it('invokes desktop.provider-profile.save and returns the saved profile', async () => {
    const profile: DesktopProviderProfile = {
      id: 'prof-1',
      provider: request.provider,
      baseUrl: request.baseUrl,
      modelId: request.modelId,
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
    };
    const invoke = vi.fn().mockResolvedValue(profile);
    window.joyDesktop = { channels: ['desktop.provider-profile.save'], invoke };

    await expect(saveDesktopProviderProfile(request)).resolves.toEqual(profile);
    expect(invoke).toHaveBeenCalledWith('desktop.provider-profile.save', request);
  });
});

describe('listDesktopProviderProfiles', () => {
  it('rejects outside the desktop host', async () => {
    await expect(listDesktopProviderProfiles()).rejects.toThrow(
      'unavailable outside the desktop host',
    );
  });

  it('invokes desktop.provider-profile.list and returns the profiles list', async () => {
    const profiles: readonly DesktopProviderProfile[] = [
      {
        id: 'prof-1',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-3.5-sonnet',
        createdAt: '2026-09-15T00:00:00.000Z',
        updatedAt: '2026-09-15T00:00:00.000Z',
      },
    ];
    const invoke = vi.fn().mockResolvedValue(profiles);
    window.joyDesktop = { channels: ['desktop.provider-profile.list'], invoke };

    await expect(listDesktopProviderProfiles()).resolves.toEqual(profiles);
    expect(invoke).toHaveBeenCalledWith('desktop.provider-profile.list');
  });
});

describe('deleteDesktopProviderProfile', () => {
  it('rejects outside the desktop host', async () => {
    await expect(deleteDesktopProviderProfile('prof-1')).rejects.toThrow(
      'unavailable outside the desktop host',
    );
  });

  it('invokes desktop.provider-profile.delete with the profile id', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    window.joyDesktop = { channels: ['desktop.provider-profile.delete'], invoke };

    await expect(deleteDesktopProviderProfile('prof-1')).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('desktop.provider-profile.delete', { id: 'prof-1' });
  });
});

describe('beginDesktopProviderSession', () => {
  it('rejects outside the desktop host', async () => {
    await expect(beginDesktopProviderSession('prof-1')).rejects.toThrow(
      'unavailable outside the desktop host',
    );
  });

  it('invokes desktop.provider-profile.begin-session with the profile id and returns session config', async () => {
    const sessionData = {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'anthropic/claude-3.5-sonnet',
      apiKey: 'sk-or-session-key',
    };
    const invoke = vi.fn().mockResolvedValue(sessionData);
    window.joyDesktop = { channels: ['desktop.provider-profile.begin-session'], invoke };

    await expect(beginDesktopProviderSession('prof-1')).resolves.toEqual(sessionData);
    expect(invoke).toHaveBeenCalledWith('desktop.provider-profile.begin-session', { id: 'prof-1' });
  });
});

describe('testDesktopProviderProfile', () => {
  it('rejects outside the desktop host', async () => {
    await expect(testDesktopProviderProfile('prof-1')).rejects.toThrow(
      'unavailable outside the desktop host',
    );
  });

  it('invokes desktop.provider-profile.test with the profile id and returns the probe report', async () => {
    const probeReport = {
      modelId: 'anthropic/claude-3.5-sonnet',
      capability: 'tool-loop',
      status: 'ok',
    };
    const invoke = vi.fn().mockResolvedValue(probeReport);
    window.joyDesktop = { channels: ['desktop.provider-profile.test'], invoke };

    await expect(testDesktopProviderProfile('prof-1')).resolves.toEqual(probeReport);
    expect(invoke).toHaveBeenCalledWith('desktop.provider-profile.test', { id: 'prof-1' });
  });
});

describe('asset library helpers', () => {
  it('getDesktopAssetLibrarySettings rejects outside desktop host and invokes IPC inside', async () => {
    await expect(getDesktopAssetLibrarySettings()).rejects.toThrow(
      'unavailable outside the desktop host',
    );

    const settings = {
      directory: 'H:\\VPS-DATA\\joy-media-assets',
      exists: true,
      hasCatalog: true,
      isDefault: true,
      counts: { total: 3075, audio: 1805, image: 1270 },
    };
    const invoke = vi.fn().mockResolvedValue(settings);
    window.joyDesktop = { channels: ['desktop.asset-library.get-settings'], invoke };

    await expect(getDesktopAssetLibrarySettings()).resolves.toEqual(settings);
    expect(invoke).toHaveBeenCalledWith('desktop.asset-library.get-settings');
  });

  it('setDesktopAssetLibraryDirectory invokes desktop.asset-library.set-directory', async () => {
    const invoke = vi.fn().mockResolvedValue({ directory: 'D:\\custom' });
    window.joyDesktop = { channels: ['desktop.asset-library.set-directory'], invoke };

    await expect(setDesktopAssetLibraryDirectory('D:\\custom')).resolves.toEqual({
      directory: 'D:\\custom',
    });
    expect(invoke).toHaveBeenCalledWith('desktop.asset-library.set-directory', {
      directory: 'D:\\custom',
    });
  });

  it('selectDesktopAssetLibraryDirectory invokes desktop.asset-library.select-directory', async () => {
    const invoke = vi.fn().mockResolvedValue({ directory: 'H:\\new-path' });
    window.joyDesktop = { channels: ['desktop.asset-library.select-directory'], invoke };

    await expect(selectDesktopAssetLibraryDirectory()).resolves.toEqual({
      directory: 'H:\\new-path',
    });
    expect(invoke).toHaveBeenCalledWith('desktop.asset-library.select-directory');
  });

  it('getDesktopAssetLibraryCatalog invokes desktop.asset-library.get-catalog', async () => {
    const catalog = {
      version: 1,
      counts: { total: 1, audio: 1, image: 0 },
      assets: [{ id: 'a1' }],
    };
    const invoke = vi.fn().mockResolvedValue(catalog);
    window.joyDesktop = { channels: ['desktop.asset-library.get-catalog'], invoke };

    await expect(getDesktopAssetLibraryCatalog()).resolves.toEqual(catalog);
    expect(invoke).toHaveBeenCalledWith('desktop.asset-library.get-catalog');
  });

  it('resolveDesktopAssetUrl formats joy-asset:// protocol URLs cleanly', () => {
    expect(resolveDesktopAssetUrl('audio/test.wav')).toBe('joy-asset://library/audio/test.wav');
    expect(resolveDesktopAssetUrl('/images/logo.png')).toBe('joy-asset://library/images/logo.png');
    expect(resolveDesktopAssetUrl('joy-asset://library/audio/test.wav')).toBe(
      'joy-asset://library/audio/test.wav',
    );
  });
});

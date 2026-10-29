// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getDesktopWorkerStatus,
  retryDesktopWorker,
  isDesktopHost,
  selectDesktopFile,
  saveDesktopProviderProfile,
  listDesktopProviderProfiles,
  deleteDesktopProviderProfile,
  requestAgentCompletion,
  testDesktopProviderProfile,
  getDesktopAssetLibrarySettings,
  setDesktopAssetLibraryDirectory,
  selectDesktopAssetLibraryDirectory,
  resetDesktopAssetLibraryDirectory,
  getDesktopAssetLibraryCatalog,
  resolveDesktopAssetUrl,
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

describe('retryDesktopWorker', () => {
  it('invokes desktop.worker-retry with no payload and returns the status it reports', async () => {
    const status = {
      connection: 'starting' as const,
      capabilities: [],
      lastError: 'Worker exited with code 137',
    };
    const invoke = vi.fn().mockResolvedValue(status);
    window.joyDesktop = { channels: ['desktop.worker-retry'], invoke };

    await expect(retryDesktopWorker()).resolves.toEqual(status);
    expect(invoke).toHaveBeenCalledWith('desktop.worker-retry');
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

describe('testDesktopProviderProfile', () => {
  it('rejects outside the desktop host', async () => {
    await expect(testDesktopProviderProfile('prof-1')).rejects.toThrow(
      'unavailable outside the desktop host',
    );
  });

  it('invokes desktop.provider.test with the profile id and returns the probe report', async () => {
    const probeReport = {
      modelId: 'anthropic/claude-3.5-sonnet',
      capability: 'tool-loop',
      status: 'ok',
    };
    const invoke = vi.fn().mockResolvedValue(probeReport);
    window.joyDesktop = { channels: ['desktop.provider.test'], invoke };

    await expect(testDesktopProviderProfile('prof-1')).resolves.toEqual(probeReport);
    expect(invoke).toHaveBeenCalledWith('desktop.provider.test', { id: 'prof-1' });
  });
});

describe('asset library helpers', () => {
  it('getDesktopAssetLibrarySettings rejects outside desktop host and invokes IPC inside', async () => {
    await expect(getDesktopAssetLibrarySettings()).rejects.toThrow(
      'unavailable outside the desktop host',
    );

    const settings = {
      directory: '/test-assets/custom-dir',
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
    const invoke = vi.fn().mockResolvedValue({ directory: '/test-assets/custom' });
    window.joyDesktop = { channels: ['desktop.asset-library.set-directory'], invoke };

    await expect(setDesktopAssetLibraryDirectory('/test-assets/custom')).resolves.toEqual({
      directory: '/test-assets/custom',
    });
    expect(invoke).toHaveBeenCalledWith('desktop.asset-library.set-directory', {
      directory: '/test-assets/custom',
    });
  });

  it('selectDesktopAssetLibraryDirectory invokes desktop.asset-library.select-directory', async () => {
    const invoke = vi.fn().mockResolvedValue({ directory: '/test-assets/new-path' });
    window.joyDesktop = { channels: ['desktop.asset-library.select-directory'], invoke };

    await expect(selectDesktopAssetLibraryDirectory()).resolves.toEqual({
      directory: '/test-assets/new-path',
    });
    expect(invoke).toHaveBeenCalledWith('desktop.asset-library.select-directory');
  });

  it('resetDesktopAssetLibraryDirectory invokes the reset channel with no path argument', async () => {
    const defaultSettings = {
      directory: '/test-assets/default-dir',
      exists: true,
      hasCatalog: true,
      isDefault: true,
      counts: { total: 0, audio: 0, image: 0 },
    };
    const invoke = vi.fn().mockResolvedValue(defaultSettings);
    window.joyDesktop = {
      channels: ['desktop.asset-library.reset-directory'],
      invoke,
    };

    await expect(resetDesktopAssetLibraryDirectory()).resolves.toEqual(defaultSettings);
    expect(invoke).toHaveBeenCalledWith('desktop.asset-library.reset-directory');
    expect(invoke).toHaveBeenCalledTimes(1);
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

describe('requestAgentCompletion', () => {
  const request = {
    profileId: 'prof-1',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelId: 'openai/gpt-4o-mini',
    body: { messages: [{ role: 'user', content: 'hi' }] },
  };

  it('sends the request to the broker and returns the reply text', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, text: '{"choices":[]}' });
    window.joyDesktop = { channels: ['desktop.agent.request'], invoke };

    await expect(requestAgentCompletion(request)).resolves.toBe('{"choices":[]}');
    expect(invoke).toHaveBeenCalledWith('desktop.agent.request', {
      ...request,
      requestId: expect.stringMatching(/^agent-[0-9a-f-]{36}$/),
    });
  });

  it('rejects with the broker code and message when the broker refuses', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: false,
      code: 'BINDING_MISMATCH',
      message: 'Save this profile again to confirm its endpoint.',
    });
    window.joyDesktop = { channels: ['desktop.agent.request'], invoke };

    await expect(requestAgentCompletion(request)).rejects.toMatchObject({
      code: 'BINDING_MISMATCH',
      message: 'Save this profile again to confirm its endpoint.',
    });
  });

  it('refuses outside the desktop host without sending anything', async () => {
    delete (window as { joyDesktop?: unknown }).joyDesktop;

    await expect(requestAgentCompletion(request)).rejects.toThrow(
      'unavailable outside the desktop host',
    );
  });

  it('cancels the desktop call when the caller aborts, and sends no signal across the bridge', async () => {
    let finish: ((reply: unknown) => void) | undefined;
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.agent.request') {
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      if (channel === 'desktop.agent.cancel') {
        // The desktop answers a cancelled call promptly, as the broker does.
        finish?.({ ok: false, code: 'NETWORK_ERROR', message: 'The request was cancelled.' });
      }
      return undefined;
    });
    window.joyDesktop = { channels: ['desktop.agent.request', 'desktop.agent.cancel'], invoke };
    const controller = new AbortController();

    const pending = requestAgentCompletion({ ...request, signal: controller.signal });
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('desktop.agent.request', expect.anything()),
    );
    const sent = invoke.mock.calls.find(
      ([channel]) => channel === 'desktop.agent.request',
    )?.[1] as {
      requestId: string;
    };
    expect(sent).not.toHaveProperty('signal');
    controller.abort();

    expect(invoke).toHaveBeenCalledWith('desktop.agent.cancel', { requestId: sent.requestId });
    await expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('gives every call its own request id, so an old page cannot match a new call', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, text: '{"choices":[]}' });
    window.joyDesktop = { channels: ['desktop.agent.request'], invoke };

    await requestAgentCompletion(request);
    await requestAgentCompletion(request);

    const ids = invoke.mock.calls.map(
      ([, payload]) => (payload as { requestId: string }).requestId,
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('does not return a reply that arrives after the caller aborted', async () => {
    let reply: ((value: unknown) => void) | undefined;
    const invoke = vi.fn().mockImplementation(async (channel: string) => {
      if (channel === 'desktop.agent.request') {
        return new Promise((resolve) => {
          reply = resolve;
        });
      }
      return undefined;
    });
    window.joyDesktop = { channels: ['desktop.agent.request', 'desktop.agent.cancel'], invoke };
    const controller = new AbortController();

    const pending = requestAgentCompletion({ ...request, signal: controller.signal });
    await vi.waitFor(() => expect(reply).toBeDefined());
    controller.abort();
    // The desktop's reply loses the race with the abort, so the caller never sees its text.
    reply?.({ ok: true, text: 'a reply that arrived too late' });

    await expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('starts no desktop call for a request that is already cancelled', async () => {
    const invoke = vi.fn();
    window.joyDesktop = { channels: ['desktop.agent.request'], invoke };
    const controller = new AbortController();
    controller.abort();

    await expect(
      requestAgentCompletion({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

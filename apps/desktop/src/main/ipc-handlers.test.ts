import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIpcHandlers, dispatchIpcRequest } from './ipc-handlers.js';
import { createFileRegistry } from './file-registry.js';
import { createWorkerSupervisor } from './worker-supervisor.js';
import type { SupervisedChild } from './worker-supervisor.js';
import { LocalDatabase } from '../store/local-database.js';
import { createMemorySecretStore, findRegistryProvider } from '@joy-media/provider-sdk';
import { createProviderBroker } from './providers/provider-broker.js';
import { createElectronSecretStore } from './secrets/electron-secret-store.js';

function deps() {
  const fileRegistry = createFileRegistry(() => 'ref-1');
  const workerSupervisor = createWorkerSupervisor({
    spawn: (): SupervisedChild => ({ once: () => {}, kill: () => true }),
    command: 'node',
    workerId: () => 'w-1',
  });
  const showOpenDialog = vi.fn(async () => ({ canceled: false, path: 'C:\\Media\\clip.mp4' }));
  const localDatabase = new LocalDatabase({
    filePath: ':memory:',
    idFactory: () => 'job-1',
    now: () => 'T0',
  });
  const probeMedia = vi.fn(async () => ({
    checksum: 'sha-abc',
    byteSize: 123,
    kind: 'video' as const,
  }));
  const secretStore = createMemorySecretStore();
  // The broker is the real one, wired to this database and a fake provider reply.
  const providerFetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
  );
  const providerBroker = createProviderBroker({
    store: {
      getProfile: (id) => localDatabase.getProviderProfile(id),
      isDisabledLegacy: (id) =>
        localDatabase
          .listProfileStates()
          .some((s) => s.profileId === id && s.state === 'disabled-legacy'),
      markCredentialUnavailable: (id) => localDatabase.markProfileCredentialUnavailable(id),
      secretVersion: (handleId) => localDatabase.secretVersion(handleId),
    },
    secrets: secretStore,
    fetch: providerFetch,
    resolveHost: async () => ['127.0.0.1'],
  });
  let idCount = 0;
  return {
    fileRegistry,
    workerSupervisor,
    showOpenDialog,
    localDatabase,
    probeMedia,
    secretStore,
    providerFetch,
    providerBroker,
    now: () => 'T0',
    newId: () => `id-${++idCount}`,
  };
}

describe('IPC dispatch', () => {
  it('rejects requests from an origin outside the allow-list before any handler runs', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://evil.example',
      channel: 'desktop.worker-status',
    });
    expect(result.ok).toBe(false);
    expect(d.showOpenDialog).not.toHaveBeenCalled();
  });

  it('rejects an unknown channel even from an allowed origin', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.execute',
    });
    expect(result.ok).toBe(false);
  });

  it('select-file registers the chosen path and returns only the opaque ref', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.select-file',
    });
    expect(result).toEqual({
      ok: true,
      data: { kind: 'local-file', id: 'ref-1', displayName: 'clip.mp4' },
    });
  });

  it('select-file records the probed media into the manifest, keyed by the new ref', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.select-file',
    });
    expect(d.probeMedia).toHaveBeenCalledWith('C:\\Media\\clip.mp4');
    expect(d.localDatabase.getMedia('ref-1')).toEqual({
      refId: 'ref-1',
      checksum: 'sha-abc',
      kind: 'video',
      byteSize: 123,
      lastVerifiedAt: 'T0',
    });
  });

  it('revoke-file also forgets the media manifest entry', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const selected = await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.select-file',
    });
    await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.revoke-file',
      payload: selected.data,
    });
    expect(d.localDatabase.getMedia('ref-1')).toBeUndefined();
  });

  it('request-derivative rejects a forged ref', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.request-derivative',
      payload: { ref: { kind: 'local-file', id: 'forged', displayName: 'x' }, kind: 'thumbnail' },
    });
    expect(result.ok).toBe(false);
  });

  it('request-derivative enqueues a queued job and returns its id alongside the approval', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const selected = await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.select-file',
    });
    const result = await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.request-derivative',
      payload: { ref: selected.data, kind: 'thumbnail' },
    });
    expect(result).toEqual({
      ok: true,
      data: { refId: 'ref-1', kind: 'thumbnail', jobId: 'job-1' },
    });
    expect(d.localDatabase.getJob('job-1')).toMatchObject({
      kind: 'derivative:thumbnail',
      refId: 'ref-1',
      status: 'queued',
    });
  });

  it('worker-status reflects the supervisor state', async () => {
    const d = deps();
    d.workerSupervisor.start();
    const handlers = createIpcHandlers(d);
    const result = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.worker-status',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ connection: 'online', workerId: 'w-1', capabilities: [] });
  });

  it('startup-preference fails closed on garbage input and starts nothing', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.startup-preference',
      payload: 'not-a-real-preference',
    });
    expect(result).toEqual({ ok: true, data: 'leave-worker-alone' });
  });

  it('job-status reports an unknown job id as an error, not a thrown exception', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.job-status',
      payload: { jobId: 'missing' },
    });
    expect(result.ok).toBe(false);
  });

  it('job-status round-trips a real queued job', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    d.localDatabase.enqueueJob('export', 'ref-9');
    const result = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.job-status',
      payload: { jobId: 'job-1' },
    });
    expect(result).toEqual({
      ok: true,
      data: {
        id: 'job-1',
        kind: 'export',
        refId: 'ref-9',
        status: 'queued',
        createdAt: 'T0',
        updatedAt: 'T0',
      },
    });
  });

  it('cancel-job moves a queued job to cancelled', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    d.localDatabase.enqueueJob('export', 'ref-9');
    const result = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.cancel-job',
      payload: { jobId: 'job-1' },
    });
    expect(result.ok).toBe(true);
    expect(d.localDatabase.getJob('job-1')).toMatchObject({
      status: 'cancelled',
      error: 'cancelled by user',
    });
  });

  it('cancel-job refuses to cancel an already-finished job', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    d.localDatabase.enqueueJob('export', 'ref-9');
    d.localDatabase.updateJobStatus('job-1', 'done');
    const result = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.cancel-job',
      payload: { jobId: 'job-1' },
    });
    expect(result.ok).toBe(false);
    expect(d.localDatabase.getJob('job-1')?.status).toBe('done');
  });

  it('provider-profile.save rejects an invalid profile and stores nothing', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const result = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openai-compatible',
        baseUrl: 'not-a-url',
        modelId: 'gpt-4o-mini',
        apiKey: 'sk-secret',
      },
    });
    expect(result.ok).toBe(false);
    expect(d.localDatabase.listProviderProfiles()).toEqual([]);
  });

  it('provider-profile.save creates a profile, stores the key in the secret store, and never returns it', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const result = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1234/v1',
        modelId: 'gpt-4o-mini',
        apiKey: 'sk-secret',
      },
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain('sk-secret');
    const saved = d.localDatabase.listProviderProfiles();
    expect(saved).toHaveLength(1);
    expect(await d.secretStore.get(saved[0]!.secretHandleId)).toBe('sk-secret');
  });

  it('provider-profile.save with an unknown id is rejected rather than creating a forged profile', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        id: 'forged-id',
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'gpt-4o-mini',
        apiKey: 'sk-secret',
      },
    });
    expect(result.ok).toBe(false);
  });

  it('provider-profile.save with a real id rotates the key and keeps the same profile id', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const created = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1234/v1',
        modelId: 'gpt-4o-mini',
        apiKey: 'sk-old',
      },
    });
    const id = (created.data as { id: string }).id;
    const updated = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        id,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1234/v1',
        modelId: 'gpt-4o',
        apiKey: 'sk-new',
      },
    });
    expect(updated.ok).toBe(true);
    expect((updated.data as { id: string }).id).toBe(id);
    expect(d.localDatabase.listProviderProfiles()).toHaveLength(1);
    const profile = d.localDatabase.getProviderProfile(id)!;
    expect(await d.secretStore.get(profile.secretHandleId)).toBe('sk-new');
  });

  it('provider-profile.list never includes a secret value', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'x',
        apiKey: 'sk-secret',
      },
    });
    const list = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.list',
    });
    expect(list.ok).toBe(true);
    expect(JSON.stringify(list.data)).not.toContain('sk-secret');
  });

  it('provider-profile.delete removes both the profile and its secret', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const created = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'x',
        apiKey: 'sk-secret',
      },
    });
    const profile = created.data as { id: string; secretHandleId: string };
    const result = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.delete',
      payload: { id: profile.id },
    });
    expect(result.ok).toBe(true);
    expect(d.localDatabase.getProviderProfile(profile.id)).toBeUndefined();
    expect(await d.secretStore.get(profile.secretHandleId)).toBeNull();
  });

  it('desktop.provider.test probes a saved profile and never returns its key', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const created = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1234/v1',
        modelId: 'gpt-4o-mini',
        apiKey: 'sk-secret',
      },
    });
    const id = (created.data as { id: string }).id;
    const result = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider.test',
      payload: { id },
    });
    expect(result).toEqual({ ok: true, data: { ok: true, modelId: 'gpt-4o-mini' } });
    expect(d.providerFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:1234/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.stringify(result)).not.toContain('sk-secret');
  });
  it('desktop.provider.models lists a draft through the broker and never returns its key', async () => {
    const d = deps();
    d.providerFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), { status: 200 }),
    );
    const handlers = createIpcHandlers(d);
    const result = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider.models',
      payload: {
        draft: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-draft' },
      },
    });
    expect(result).toEqual({ ok: true, data: [{ id: 'gpt-4o-mini', name: 'gpt-4o-mini' }] });
    expect(d.providerFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer sk-draft' }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain('sk-draft');
  });
  it('handles desktop window control actions', async () => {
    const handleWindowControl = vi.fn(async (action: string) => {
      if (action === 'maximize') return true;
      if (action === 'is-maximized') return false;
      return undefined;
    });
    const d = { ...deps(), handleWindowControl };
    const handlers = createIpcHandlers(d);

    const minRes = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.window-minimize',
    });
    expect(minRes).toEqual({ ok: true, data: undefined });
    expect(handleWindowControl).toHaveBeenCalledWith('minimize');

    const maxRes = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.window-maximize',
    });
    expect(maxRes).toEqual({ ok: true, data: true });
    expect(handleWindowControl).toHaveBeenCalledWith('maximize');

    const closeRes = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.window-close',
    });
    expect(closeRes).toEqual({ ok: true, data: undefined });
    expect(handleWindowControl).toHaveBeenCalledWith('close');

    const isMaxRes = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.window-is-maximized',
    });
    expect(isMaxRes).toEqual({ ok: true, data: false });
    expect(handleWindowControl).toHaveBeenCalledWith('is-maximized');
  });

  it('handles asset library settings, directory selection, and catalog reading', async () => {
    const showOpenDirectoryDialog = vi.fn(async () => ({
      canceled: false,
      path: '/test-assets/selected-dir',
    }));
    const d = { ...deps(), showOpenDirectoryDialog };
    const handlers = createIpcHandlers(d);

    const getSettingsRes = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.asset-library.get-settings',
    });
    expect(getSettingsRes.ok).toBe(true);
    expect((getSettingsRes.data as { directory: string }).directory).toBeDefined();

    const setDirRes = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.asset-library.set-directory',
      payload: { directory: '/test-assets/my-assets' },
    });
    expect(setDirRes.ok).toBe(true);
    expect((setDirRes.data as { directory: string }).directory).toBe('/test-assets/my-assets');

    const selectDirRes = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.asset-library.select-directory',
    });
    expect(selectDirRes.ok).toBe(true);
    expect((selectDirRes.data as { directory: string }).directory).toBe(
      '/test-assets/selected-dir',
    );
    expect(showOpenDirectoryDialog).toHaveBeenCalled();

    const catalogRes = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.asset-library.get-catalog',
    });
    expect(catalogRes.ok).toBe(true);
    expect((catalogRes.data as { assets: unknown[] }).assets).toBeDefined();
  });

  it('reselects a prior library for an unconfigured install without moving or deleting files', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'joy-media-library-upgrade-'));
    try {
      const previousLibrary = path.join(tempRoot, 'previous-library');
      const nextDefault = path.join(tempRoot, 'new-default');
      const audioPath = path.join(previousLibrary, 'audio', 'ambience.wav');
      const imagePath = path.join(previousLibrary, 'images', 'cover.png');
      fs.mkdirSync(path.dirname(audioPath), { recursive: true });
      fs.mkdirSync(path.dirname(imagePath), { recursive: true });
      fs.writeFileSync(audioPath, 'fixture audio bytes');
      fs.writeFileSync(imagePath, 'fixture image bytes');
      const catalog = {
        version: 1,
        counts: { total: 2, audio: 1, image: 1 },
        assets: [
          { id: 'fixture-audio', kind: 'audio', path: 'audio/ambience.wav' },
          { id: 'fixture-image', kind: 'image', path: 'images/cover.png' },
        ],
      };
      fs.writeFileSync(path.join(previousLibrary, 'catalog.json'), JSON.stringify(catalog));

      const d = deps();
      d.localDatabase.getDefaultAssetLibraryDirectory = () => nextDefault;
      const showOpenDirectoryDialog = vi.fn(async () => ({
        canceled: false,
        path: previousLibrary,
      }));
      const handlers = createIpcHandlers({ ...d, showOpenDirectoryDialog });
      const snapshot = (root: string) => {
        const entries: [string, string][] = [];
        const visit = (directory: string) => {
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolutePath = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(absolutePath);
            else
              entries.push([
                path.relative(root, absolutePath),
                fs.readFileSync(absolutePath, 'base64'),
              ]);
          }
        };
        visit(root);
        return entries.sort(([left], [right]) => left.localeCompare(right));
      };
      const filesBeforeReselect = snapshot(previousLibrary);

      const initial = await dispatchIpcRequest(handlers, {
        origin: 'joy-media-app://renderer',
        channel: 'desktop.asset-library.get-settings',
      });
      expect(initial.ok).toBe(true);
      expect(initial.data).toMatchObject({
        directory: nextDefault,
        isDefault: true,
        hasCatalog: false,
        counts: { total: 0, audio: 0, image: 0 },
      });
      expect(d.localDatabase.getSetting('asset_library_directory')).toBeUndefined();

      const selected = await dispatchIpcRequest(handlers, {
        origin: 'joy-media-app://renderer',
        channel: 'desktop.asset-library.select-directory',
      });
      expect(selected.ok).toBe(true);
      expect(selected.data).toMatchObject({
        directory: previousLibrary,
        isDefault: false,
        hasCatalog: true,
        counts: { total: 2, audio: 1, image: 1 },
      });
      expect(d.localDatabase.getSetting('asset_library_directory')).toBe(previousLibrary);
      expect(showOpenDirectoryDialog).toHaveBeenCalledTimes(1);

      const catalogResult = await dispatchIpcRequest(handlers, {
        origin: 'joy-media-app://renderer',
        channel: 'desktop.asset-library.get-catalog',
      });
      expect(catalogResult).toEqual({ ok: true, data: catalog });
      expect(snapshot(previousLibrary)).toEqual(filesBeforeReselect);
      expect(fs.existsSync(nextDefault)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('asset-library.reset-directory clears the override and returns the default settings', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);

    d.localDatabase.setAssetLibraryDirectory('/custom/path');

    const resetRes = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.asset-library.reset-directory',
    });
    expect(resetRes.ok).toBe(true);
    const info = resetRes.data as { directory: string; isDefault: boolean };
    expect(info.directory).toBe(d.localDatabase.getDefaultAssetLibraryDirectory());
    expect(info.isDefault).toBe(true);
  });
});

describe('legacy provider profiles (v1.1.0)', () => {
  const renderer = 'joy-media-app://renderer';

  it('list shows a legacy profile as disabled-legacy and a current one as active', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    d.localDatabase.saveProviderProfile({
      id: 'p-kilo',
      provider: 'kilo',
      baseUrl: 'https://kilo.example.com/v1',
      modelId: 'm',
      secretHandleId: 'h-kilo',
      createdAt: 'T0',
      updatedAt: 'T0',
    });
    d.localDatabase.saveProviderProfile({
      id: 'p-custom',
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'm',
      secretHandleId: 'h-custom',
      createdAt: 'T0',
      updatedAt: 'T0',
    });
    d.localDatabase.markLegacyProfiles();
    const result = await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.provider-profile.list',
    });
    const states = Object.fromEntries(
      (result.data as { id: string; state: string }[]).map((p) => [p.id, p.state]),
    );
    expect(states).toEqual({ 'p-kilo': 'disabled-legacy', 'p-custom': 'active' });
  });

  it('"Later" is accepted for a legacy profile and recorded in the list', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    d.localDatabase.saveProviderProfile({
      id: 'p-kilo',
      provider: 'kilo',
      baseUrl: 'https://kilo.example.com/v1',
      modelId: 'm',
      secretHandleId: 'h-kilo',
      createdAt: 'T0',
      updatedAt: 'T0',
    });
    d.localDatabase.markLegacyProfiles();
    const later = await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.provider-profile.later',
      payload: { id: 'p-kilo' },
    });
    expect(later.ok).toBe(true);
    const list = await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.provider-profile.list',
    });
    expect((list.data as { decision?: string }[])[0]?.decision).toBe('later');
  });

  it('"Later" is refused for a profile that is not a legacy provider', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    d.localDatabase.saveProviderProfile({
      id: 'p-custom',
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'm',
      secretHandleId: 'h-custom',
      createdAt: 'T0',
      updatedAt: 'T0',
    });
    const result = await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.provider-profile.later',
      payload: { id: 'p-custom' },
    });
    expect(result.ok).toBe(false);
  });

  it('desktop.provider.test and desktop.provider.models refuse a disabled legacy profile', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    d.localDatabase.saveProviderProfile({
      id: 'p-kilo',
      provider: 'kilo',
      baseUrl: 'https://kilo.example.com/v1',
      modelId: 'm',
      secretHandleId: 'h-kilo',
      createdAt: 'T0',
      updatedAt: 'T0',
    });
    d.localDatabase.markLegacyProfiles();
    const test = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider.test',
      payload: { id: 'p-kilo' },
    });
    const models = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider.models',
      payload: { id: 'p-kilo' },
    });
    expect(test).toEqual({
      ok: true,
      data: {
        ok: false,
        modelId: 'm',
        errorCode: 'PROVIDER_INCOMPATIBLE',
        message: expect.any(String),
      },
    });
    expect(models.ok).toBe(false);
    expect(d.providerFetch).not.toHaveBeenCalled();
  });
  it('save refuses to create a new profile under a legacy provider', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'kilo',
        baseUrl: 'https://kilo.example.com/v1',
        modelId: 'm',
        apiKey: 'k',
      },
    });
    expect(result.ok).toBe(false);
  });

  it('keeps the endpoint binding out of the profile list, and refuses a public custom endpoint on save', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const saved = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'm',
        apiKey: 'sk-1',
      },
    });
    const id = (saved.data as { id: string }).id;
    expect(d.localDatabase.getProviderProfile(id)?.bindingDigest).toMatch(/^[0-9a-f]{64}$/);
    const listed = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.list',
    });
    expect(JSON.stringify(listed)).not.toContain('bindingDigest');
    const refused = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'm',
        apiKey: 'sk-2',
      },
    });
    expect(refused).toEqual({
      ok: false,
      error: expect.stringContaining('not available in this build'),
    });
  });

  it('keeps the stored key when only the model changes, and refuses an endpoint change without a key', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const saved = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1234/v1',
        modelId: 'openai/gpt-4o-mini',
        apiKey: 'sk-kept',
      },
    });
    const id = (saved.data as { id: string }).id;
    const secretHandle = d.localDatabase.getProviderProfile(id)?.secretHandleId ?? '';

    const modelOnly = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        id,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1234/v1',
        modelId: 'openai/gpt-4o',
      },
    });
    expect(modelOnly.ok).toBe(true);
    expect(await d.secretStore.get(secretHandle)).toBe('sk-kept');

    const moved = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        id,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9999/v1',
        modelId: 'openai/gpt-4o',
      },
    });
    expect(moved).toEqual({ ok: false, error: 'Enter the key again to change the endpoint' });
    expect(await d.secretStore.get(secretHandle)).toBe('sk-kept');
  });

  it('saves a new key to a new handle, and removes the old key only after the profile points at it', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const saved = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'm',
        apiKey: 'sk-old-key',
      },
    });
    const id = (saved.data as { id: string }).id;
    const oldHandle = d.localDatabase.getProviderProfile(id)?.secretHandleId ?? '';

    const resaved = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        id,
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'm',
        apiKey: 'sk-new-key',
      },
    });

    expect(resaved.ok).toBe(true);
    const newHandle = d.localDatabase.getProviderProfile(id)?.secretHandleId ?? '';
    expect(newHandle).not.toBe(oldHandle);
    expect(await d.secretStore.get(newHandle)).toBe('sk-new-key');
    expect(await d.secretStore.get(oldHandle)).toBeNull();
  });

  it('saves a keyless local profile with the placeholder, and refuses a keyless remote one', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const local = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1234/v1',
        modelId: 'llama3',
      },
    });

    expect(local.ok).toBe(true);
    const handle =
      d.localDatabase.getProviderProfile((local.data as { id: string }).id)?.secretHandleId ?? '';
    expect(await d.secretStore.get(handle)).toBe('not-provided');

    const remote = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', modelId: 'm' },
    });
    expect(remote).toEqual({ ok: false, error: 'An API key is required for this endpoint' });
  });

  it('keeps a profile unbound when its key is kept, and binds it once the key is entered again', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    // A v1.0.x profile, saved with no binding.
    d.localDatabase.saveProviderProfile({
      id: 'p-legacy',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'm',
      secretHandleId: 'h-legacy',
      createdAt: 'T0',
      updatedAt: 'T0',
    });
    await d.secretStore.set('h-legacy', 'sk-legacy');
    const payload = {
      id: 'p-legacy',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'm',
    };

    const kept = await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.provider-profile.save',
      payload,
    });
    expect(kept).toMatchObject({ ok: true, data: { id: 'p-legacy', bound: false } });
    expect(d.localDatabase.getProviderProfile('p-legacy')?.bindingDigest).toBeUndefined();

    const entered = await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.provider-profile.save',
      payload: { ...payload, apiKey: 'sk-entered' },
    });
    expect(entered).toMatchObject({ ok: true, data: { id: 'p-legacy', bound: true } });
    expect(d.localDatabase.getProviderProfile('p-legacy')?.bindingDigest).toBeDefined();
  });

  it('lists a profile as unbound once its stored key was written again by another build', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const saved = await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'm',
        apiKey: 'sk-first',
      },
    });
    const id = (saved.data as { id: string }).id;
    const handle = d.localDatabase.getProviderProfile(id)?.secretHandleId ?? '';
    const list = () =>
      dispatchIpcRequest(handlers, { origin: renderer, channel: 'desktop.provider-profile.list' });
    expect((await list()).data).toEqual([expect.objectContaining({ id, bound: true })]);

    // An older build rewrites the key under the same handle, so the stored record changes.
    d.localDatabase.setSecretCiphertext(handle, 'written-by-an-older-build');
    const listed = await list();

    expect(listed.data).toEqual([expect.objectContaining({ id, bound: false })]);
    expect(JSON.stringify(listed)).not.toContain('bindingDigest');
    expect(JSON.stringify(listed)).not.toContain('bindingSecretDigest');
  });

  it('removes the key a failed save wrote, and keeps the key the profile had', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const saved = await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'm',
        apiKey: 'sk-old-key',
      },
    });
    const id = (saved.data as { id: string }).id;
    const oldHandle = d.localDatabase.getProviderProfile(id)?.secretHandleId ?? '';
    const deleteSpy = vi.spyOn(d.secretStore, 'delete');
    vi.spyOn(d.localDatabase, 'saveProviderProfile').mockImplementationOnce(() => {
      throw new Error('write failed');
    });

    await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.provider-profile.save',
      payload: {
        id,
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'm',
        apiKey: 'sk-new-key',
      },
    }).catch(() => undefined);

    const removed = deleteSpy.mock.calls.map((call) => call[0]);
    expect(removed).toHaveLength(1);
    expect(removed[0]).not.toBe(oldHandle);
    expect(d.localDatabase.getProviderProfile(id)?.secretHandleId).toBe(oldHandle);
    expect(await d.secretStore.get(oldHandle)).toBe('sk-old-key');
  });

  it('cancels a provider call the renderer names, and the provider request it began is ended', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const saved = await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'openai/gpt-4o-mini',
        apiKey: 'sk-cancel',
      },
    });
    const id = (saved.data as { id: string }).id;
    let providerSignal: AbortSignal | undefined;
    d.providerFetch.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          providerSignal = init.signal ?? undefined;
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );

    const call = dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.agent.request',
      payload: {
        profileId: id,
        baseUrl: 'https://openrouter.ai/api/v1',
        body: { messages: [{ role: 'user', content: 'hi' }] },
        requestId: 'call-1',
      },
    });
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    const cancelled = await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.agent.cancel',
      payload: { requestId: 'call-1' },
    });

    expect(cancelled.ok).toBe(true);
    expect(providerSignal?.aborted).toBe(true);
    await expect(call).resolves.toMatchObject({
      ok: true,
      data: { ok: false, code: 'NETWORK_ERROR' },
    });
  });

  it('refuses a cancel request whose id is not a plain call id', async () => {
    const handlers = createIpcHandlers(deps());

    const refused = await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.agent.cancel',
      payload: { requestId: '../../other' },
    });

    expect(refused.ok).toBe(false);
  });

  it('lists a profile as unbound when its endpoint changed without its binding', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    // Two registry endpoints, both allowed, so only the binding tells them apart.
    const [international, china] = findRegistryProvider('minimax')?.regions ?? [];
    const saved = await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'minimax',
        baseUrl: international?.baseUrl,
        modelId: 'm',
        apiKey: 'sk-moved',
      },
    });
    const id = (saved.data as { id: string }).id;
    const stored = d.localDatabase.getProviderProfile(id);
    if (stored === undefined) throw new Error('expected the saved profile');
    // The URL changes in the record, but its binding does not: a change made outside the app.
    if (china === undefined) throw new Error('expected a second MiniMax region');
    d.localDatabase.saveProviderProfile({ ...stored, baseUrl: china.baseUrl });

    const listed = await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.provider-profile.list',
    });

    expect(listed.data).toEqual([expect.objectContaining({ id, bound: false })]);
  });

  it('refuses a profile whose stored key was overwritten, through the real secret store', async () => {
    const d = deps();
    // The OS-protected store, with a stand-in for the OS cipher: its ciphertext is what a version reads.
    const secrets = createElectronSecretStore(d.localDatabase, {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (encrypted: Buffer) => encrypted.toString('utf8').replace(/^enc:/, ''),
    });
    const broker = createProviderBroker({
      store: {
        getProfile: (id) => d.localDatabase.getProviderProfile(id),
        isDisabledLegacy: () => false,
        markCredentialUnavailable: () => undefined,
        secretVersion: (handleId) => d.localDatabase.secretVersion(handleId),
      },
      secrets,
      fetch: d.providerFetch,
      resolveHost: async () => ['127.0.0.1'],
    });
    const handlers = createIpcHandlers({ ...d, secretStore: secrets, providerBroker: broker });
    const saved = await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'openai/gpt-4o-mini',
        apiKey: 'sk-first-key',
      },
    });
    const id = (saved.data as { id: string }).id;
    const handle = d.localDatabase.getProviderProfile(id)?.secretHandleId ?? '';
    const call = () =>
      dispatchIpcRequest(handlers, {
        origin: renderer,
        channel: 'desktop.agent.request',
        payload: {
          profileId: id,
          baseUrl: 'https://openrouter.ai/api/v1',
          body: { messages: [{ role: 'user', content: 'hi' }] },
        },
      });
    d.providerFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        {
          status: 200,
        },
      ),
    );
    expect(await call()).toMatchObject({ ok: true, data: { ok: true } });

    // An older build writes another key under the same handle.
    await secrets.set(handle, 'sk-written-by-an-older-build');

    expect(await call()).toMatchObject({ ok: true, data: { ok: false, code: 'BINDING_MISMATCH' } });
    const listed = await dispatchIpcRequest(handlers, {
      origin: renderer,
      channel: 'desktop.provider-profile.list',
    });
    expect(listed.data).toEqual([expect.objectContaining({ id, bound: false })]);
  });

  it('desktop.agent.request sends the request through the broker and returns the reply text only', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const saved = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'openai/gpt-4o-mini',
        apiKey: 'sk-agent',
      },
    });
    const id = (saved.data as { id: string }).id;
    d.providerFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' } }] }),
        {
          status: 200,
        },
      ),
    );
    const result = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.agent.request',
      payload: {
        profileId: id,
        baseUrl: 'https://openrouter.ai/api/v1',
        body: { messages: [{ role: 'user', content: 'hi' }] },
      },
    });
    expect(result).toEqual({ ok: true, data: { ok: true, text: expect.any(String) } });
    const text = (result.data as { text: string }).text;
    expect(JSON.parse(text)).toMatchObject({ choices: [{ message: { content: 'hello' } }] });
    expect(JSON.stringify(result)).not.toContain('sk-agent');
    expect(d.providerFetch.mock.calls[0]?.[0]).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
  });

  it('desktop.agent.request refuses a payload without a profile id before any request', async () => {
    const d = deps();
    const result = await dispatchIpcRequest(createIpcHandlers(d), {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.agent.request',
      payload: { body: { messages: [{ role: 'user', content: 'hi' }] } },
    });
    expect(result).toEqual({ ok: false, error: 'Invalid agent request' });
    expect(d.providerFetch).not.toHaveBeenCalled();
  });
});

describe('IPC failures', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers a handler that throws with a fixed message and logs the detail in the main process', async () => {
    const d = deps();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(d.providerBroker, 'probe').mockRejectedValueOnce(
      new Error('EACCES: C:\\Users\\HadiMoti\\secret-path'),
    );
    const handlers = createIpcHandlers(d);

    const result = await dispatchIpcRequest(handlers, {
      origin: 'joy-media-app://renderer',
      channel: 'desktop.provider.test',
      payload: { id: 'p-any' },
    });

    expect(result).toEqual({ ok: false, error: 'The request failed' });
    expect(JSON.stringify(result)).not.toContain('secret-path');
    expect(logged).toHaveBeenCalledWith(
      '[joy-desktop] IPC desktop.provider.test failed',
      expect.any(Error),
    );
  });
});

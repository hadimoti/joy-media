import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createIpcHandlers, dispatchIpcRequest } from './ipc-handlers.js';
import { createFileRegistry } from './file-registry.js';
import { createWorkerSupervisor } from './worker-supervisor.js';
import type { SupervisedChild } from './worker-supervisor.js';
import { LocalDatabase } from '../store/local-database.js';
import { createMemorySecretStore } from '@joy-media/provider-sdk';

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
  const probeProvider = vi.fn(async () => ({ ok: true, modelId: 'gpt-4o-mini' }));
  const checkForUpdate = vi.fn((): { status: 'current'; reason: 'not-newer' } => ({
    status: 'current',
    reason: 'not-newer',
  }));
  let idCount = 0;
  return {
    fileRegistry,
    workerSupervisor,
    showOpenDialog,
    localDatabase,
    probeMedia,
    secretStore,
    probeProvider,
    checkForUpdate,
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
      origin: 'https://joyst.ir',
      channel: 'desktop.worker-status',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ connection: 'online', workerId: 'w-1', capabilities: [] });
  });

  it('startup-preference fails closed on garbage input and starts nothing', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.startup-preference',
      payload: 'not-a-real-preference',
    });
    expect(result).toEqual({ ok: true, data: 'leave-worker-alone' });
  });

  it('job-status reports an unknown job id as an error, not a thrown exception', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
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
      origin: 'https://joyst.ir',
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
      origin: 'https://joyst.ir',
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
      origin: 'https://joyst.ir',
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
      origin: 'https://joyst.ir',
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
      origin: 'https://joyst.ir',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
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
      origin: 'https://joyst.ir',
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
      origin: 'https://joyst.ir',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'gpt-4o-mini',
        apiKey: 'sk-old',
      },
    });
    const id = (created.data as { id: string }).id;
    const updated = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.provider-profile.save',
      payload: {
        id,
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
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
      origin: 'https://joyst.ir',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'x',
        apiKey: 'sk-secret',
      },
    });
    const list = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.provider-profile.list',
    });
    expect(list.ok).toBe(true);
    expect(JSON.stringify(list.data)).not.toContain('sk-secret');
  });

  it('provider-profile.delete removes both the profile and its secret', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const created = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
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
      origin: 'https://joyst.ir',
      channel: 'desktop.provider-profile.delete',
      payload: { id: profile.id },
    });
    expect(result.ok).toBe(true);
    expect(d.localDatabase.getProviderProfile(profile.id)).toBeUndefined();
    expect(await d.secretStore.get(profile.secretHandleId)).toBeNull();
  });

  it('provider-profile.begin-session hands back the plaintext key once, ByokSessionConfig-shaped', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const created = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'gpt-4o-mini',
        apiKey: 'sk-secret',
      },
    });
    const id = (created.data as { id: string }).id;
    const session = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.provider-profile.begin-session',
      payload: { id },
    });
    expect(session).toEqual({
      ok: true,
      data: {
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'gpt-4o-mini',
        apiKey: 'sk-secret',
      },
    });
  });

  it('provider-profile.begin-session fails for an unknown id', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.provider-profile.begin-session',
      payload: { id: 'missing' },
    });
    expect(result.ok).toBe(false);
  });

  it('provider-profile.test probes with the resolved key but never returns it to the caller', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const created = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.provider-profile.save',
      payload: {
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'gpt-4o-mini',
        apiKey: 'sk-secret',
      },
    });
    const id = (created.data as { id: string }).id;
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.provider-profile.test',
      payload: { id },
    });
    expect(result).toEqual({ ok: true, data: { ok: true, modelId: 'gpt-4o-mini' } });
    expect(d.probeProvider).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-secret',
      modelId: 'gpt-4o-mini',
    });
    expect(JSON.stringify(result)).not.toContain('sk-secret');
  });

  it('provider-profile.fetch-models queries /models and returns parsed models list', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'byteplus-coding/dola-seed-2.0-pro', name: 'Dola Seed 2.0 Pro' },
          { id: 'byteplus-coding/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);
    try {
      const result = await dispatchIpcRequest(handlers, {
        origin: 'https://joyst.ir',
        channel: 'desktop.provider-profile.fetch-models',
        payload: {
          baseUrl: 'https://api.kilo.ai/api/gateway',
          apiKey: 'test-key',
        },
      });
      expect(result).toEqual({
        ok: true,
        data: [
          { id: 'byteplus-coding/dola-seed-2.0-pro', name: 'Dola Seed 2.0 Pro' },
          { id: 'byteplus-coding/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        ],
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.kilo.ai/api/gateway/models',
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-key' },
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('check-for-update forwards a well-shaped request to the injected policy check', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const manifest = {
      payload: {
        channel: 'stable' as const,
        version: '1.2.0',
        downloadUrl: 'https://joyst.ir/downloads/joy-media-1.2.0.exe',
        sha256: 'a'.repeat(64),
      },
      signature: 'sig',
    };
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.check-for-update',
      payload: { manifest, subscriptionActive: true },
    });
    expect(result).toEqual({ ok: true, data: { status: 'current', reason: 'not-newer' } });
    expect(d.checkForUpdate).toHaveBeenCalledWith({ manifest, subscriptionActive: true });
  });

  it('check-for-update rejects a malformed request without calling the injected policy check', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.check-for-update',
      payload: { manifest: { payload: {}, signature: 'sig' }, subscriptionActive: true },
    });
    expect(result.ok).toBe(false);
    expect(d.checkForUpdate).not.toHaveBeenCalled();
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
      origin: 'https://joyst.ir',
      channel: 'desktop.window-minimize',
    });
    expect(minRes).toEqual({ ok: true, data: undefined });
    expect(handleWindowControl).toHaveBeenCalledWith('minimize');

    const maxRes = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.window-maximize',
    });
    expect(maxRes).toEqual({ ok: true, data: true });
    expect(handleWindowControl).toHaveBeenCalledWith('maximize');

    const closeRes = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.window-close',
    });
    expect(closeRes).toEqual({ ok: true, data: undefined });
    expect(handleWindowControl).toHaveBeenCalledWith('close');

    const isMaxRes = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
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
      origin: 'https://joyst.ir',
      channel: 'desktop.asset-library.get-settings',
    });
    expect(getSettingsRes.ok).toBe(true);
    expect((getSettingsRes.data as { directory: string }).directory).toBeDefined();

    const setDirRes = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.asset-library.set-directory',
      payload: { directory: '/test-assets/my-assets' },
    });
    expect(setDirRes.ok).toBe(true);
    expect((setDirRes.data as { directory: string }).directory).toBe('/test-assets/my-assets');

    const selectDirRes = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.asset-library.select-directory',
    });
    expect(selectDirRes.ok).toBe(true);
    expect((selectDirRes.data as { directory: string }).directory).toBe(
      '/test-assets/selected-dir',
    );
    expect(showOpenDirectoryDialog).toHaveBeenCalled();

    const catalogRes = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
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
        origin: 'https://joyst.ir',
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
        origin: 'https://joyst.ir',
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
        origin: 'https://joyst.ir',
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
      origin: 'https://joyst.ir',
      channel: 'desktop.asset-library.reset-directory',
    });
    expect(resetRes.ok).toBe(true);
    const info = resetRes.data as { directory: string; isDefault: boolean };
    expect(info.directory).toBe(d.localDatabase.getDefaultAssetLibraryDirectory());
    expect(info.isDefault).toBe(true);
  });
});

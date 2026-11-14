/**
 * Real Electron main-process entrypoint. This file is intentionally thin: it only wires
 * the `electron` module to the pure, unit-tested modules in this directory. Nothing here
 * has its own unit-test coverage — verifying it requires an actual Electron runtime.
 * `pnpm --filter @joy-media/desktop test:smoke` (wave 9, `--smoke` branch below) launches this
 * file under the real Electron binary as a headless runtime check; see
 * docs/joy-media-final-migration-progress.md for what that does and does not prove.
 *
 * Do not add business logic here. Add it to a testable sibling module and call it from
 * here instead.
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  safeStorage,
  session,
  shell,
} from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path, { dirname, join } from 'node:path';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseProjectDeepLink } from '../deep-link.js';
import { createFileRegistry } from './file-registry.js';
import { createWorkerSupervisor } from './worker-supervisor.js';
import { resolveWorkerEntry } from './worker-entry.js';
import { installGpuEncodeFallback } from './gpu-encode-fallback.js';
import { createIpcHandlers, dispatchIpcRequest } from './ipc-handlers.js';
import { AgentRequestRegistry, cancelWhenPageGoes } from './agent-requests.js';
import { registerJoyProtocol } from './protocol-registration.js';
import type { IpcRequest } from '../ipc.js';
import { isAllowedEditorOrigin, originOfPageUrl } from '../origin-policy.js';
import {
  DEV_LOADING_BAR_MS,
  DEV_RENDERER_RETRY_MS,
  DEV_RENDERER_URL,
  PACKAGED_LOADING_DELAY_MS,
  PACKAGED_RENDERER_SCHEME,
  buildSecureWebPreferences,
  devLoadingPageHtml,
  resolveRendererTarget,
} from './window.js';
import { registerShutdownHooks } from './shutdown.js';
import { resolveDesktopPaths } from '../store/paths.js';
import { LocalDatabase } from '../store/local-database.js';
import { createJobOrchestrator } from '../jobs/job-orchestrator.js';
import { startLocalJobApi, type LocalJobApi } from '../jobs/local-job-api.js';
import { localWorkerEnv } from '../jobs/worker-env.js';
import { createLocalOriginalWriter } from './local-originals.js';
import { createMediaChannelHandlers } from './media-channel.js';
import { createDroppedMediaImportService } from './dropped-media-import.js';
import { createAssetLibrary } from '../store/asset-library.js';
import { checksumFile, classifyMediaKind } from './media-checksum.js';
import { classifyDriveOfDirectory } from './drive-type-probe.js';
import { createElectronSecretStore } from './secrets/electron-secret-store.js';
import { createProviderBroker } from './providers/provider-broker.js';
import { pinnedFetch } from './providers/pinned-transport.js';
import { createProviderSignIn, loadOrCreateInstallId } from './oauth/sign-in.js';
import { createSignInAttempts } from './oauth/sign-in-attempts.js';
import { CALLBACK_TIMEOUT_MS } from '@joy-media/provider-oauth';
import { revokeChatGptRefreshToken } from './oauth/chatgpt.js';
import { createWorkerCompletion } from './providers/worker-completion.js';
import { checkProfileCredentials } from './profile-credential-check.js';
import {
  createGenerationJobs,
  createPinnedGenerationDownloader,
  probeGeneratedMedia,
} from './generation-jobs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged && process.env['NODE_ENV'] !== 'production';
const DROP_FILES_ENDPOINT = 'joy-desktop-drop-files';
const DROPPED_IMPORT_PROGRESS_CHANNEL = 'joy-desktop-dropped-import-progress';

/**
 * The JOY brand mark for the loading pages (undefined when no copy is found, so the page shows the wordmark alone).
 * A packaged app stages the editor build as `renderer/` beside `dist/`, and Vite publishes the editor's public
 * `assets/` folder inside that build. A development run reads the same file from the editor's public folder.
 */
function readLoadingLogoDataUrl(): string | undefined {
  const candidates = [
    join(__dirname, '..', '..', 'renderer', 'assets', 'JoyCodeNew_128x128.png'),
    join(__dirname, '..', '..', '..', 'editor-web', 'public', 'assets', 'JoyCodeNew_128x128.png'),
  ];
  for (const candidate of candidates) {
    try {
      return `data:image/png;base64,${readFileSync(candidate).toString('base64')}`;
    } catch {
      // Not at this location; try the next one.
    }
  }
  return undefined;
}

/**
 * A packaged window stays hidden until its renderer has loaded. If that takes longer than
 * PACKAGED_LOADING_DELAY_MS, a small JOY Media loading window (a data: page, so no network) shows until then.
 * A quick start never shows it. The renderer's load is the signal: `did-finish-load` on the packaged page.
 */
function showPackagedWindowWhenLoaded(win: BrowserWindow): void {
  let splash: BrowserWindow | undefined;
  let loaded = false;
  const closeSplash = (): void => {
    if (splash !== undefined && !splash.isDestroyed()) splash.destroy();
    splash = undefined;
  };
  const openSplash = (): void => {
    if (loaded || win.isDestroyed() || splash !== undefined) return;
    const loadingWindow = new BrowserWindow({
      width: 360,
      height: 240,
      frame: false,
      resizable: false,
      show: false,
      center: true,
      backgroundColor: '#000000',
      // No preload: the loading page is static and must not get the IPC bridge.
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
      },
    });
    splash = loadingWindow;
    loadingWindow.once('ready-to-show', () => {
      if (!loadingWindow.isDestroyed() && !loaded) loadingWindow.show();
    });
    const page = devLoadingPageHtml(readLoadingLogoDataUrl());
    void loadingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  };
  const timer = setTimeout(openSplash, PACKAGED_LOADING_DELAY_MS);
  const showEditor = (): void => {
    loaded = true;
    clearTimeout(timer);
    closeSplash();
    if (!win.isDestroyed()) win.show();
  };
  win.webContents.once('did-finish-load', showEditor);
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, _errorDescription, _validatedUrl, isMainFrame) => {
      // -3 is an aborted navigation. A failed main frame still shows its error page, as it did before the wait.
      if (errorCode === -3 || !isMainFrame) return;
      showEditor();
    },
  );
  win.on('closed', () => {
    clearTimeout(timer);
    closeSplash();
  });
}
// Automated runtime smoke check (`pnpm --filter @joy-media/desktop test:smoke`, wave 9): a real
// `electron .` launch that proves app.whenReady, window construction, and IPC registration all
// actually happen in this runtime, then exits on its own — closing the wave 1 gap documented in
// docs/joy-media-final-migration-progress.md (no prior session ever opened a real Electron
// window). Never shows a window and never touches production data.
const isSmokeMode = process.argv.includes('--smoke');

// Privileged so the packaged renderer behaves like https:// (fetch, CSP, secure context)
// instead of the restricted "file://"-style origin Electron gives unregistered schemes.
protocol.registerSchemesAsPrivileged([
  {
    scheme: PACKAGED_RENDERER_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: 'joy-asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | undefined;
  const paths = resolveDesktopPaths(app.getPath('userData'));
  mkdirSync(paths.mediaRoot, { recursive: true });
  const localDatabase = new LocalDatabase({ filePath: paths.databaseFile });
  // Anything still `queued`/`running` from a previous process is stale by definition: the
  // Worker that would have finished it is gone. Do this before any new job can be enqueued.
  localDatabase.recoverInterrupted();

  const fileRegistry = createFileRegistry();
  const jobOrchestrator = createJobOrchestrator({ store: localDatabase.jobDispatch });
  const workerRoot = join(app.getPath('userData'), 'worker');
  mkdirSync(workerRoot, { recursive: true });
  // Started in app.whenReady, before any window loads. The Worker gets its loopback URL and token
  // only once it has started, so its environment is read at spawn time.
  let localJobApi: LocalJobApi | undefined;
  let localJobApiStart: Promise<LocalJobApi> | undefined;
  let shuttingDown = false;
  let quitting = false;
  const workerEntry = resolveWorkerEntry({ mainDirname: __dirname, execPath: process.execPath });
  const workerSupervisor = createWorkerSupervisor({
    spawn: (command, args, options) => spawn(command, args, options),
    command: workerEntry.command,
    args: workerEntry.args,
    env: () =>
      localJobApi === undefined
        ? undefined
        : {
            ...localWorkerEnv(process.env, { apiEnv: localJobApi.workerEnv, workerRoot }),
            ...workerEntry.env,
          },
  });
  const secretStore = createElectronSecretStore(localDatabase, safeStorage);
  // Public custom endpoints are reached only at the addresses vetted before each request (S8 item 4).
  const publicHostPins = new Map<string, readonly string[]>();
  const providerBroker = createProviderBroker({
    store: {
      getProfile: (id) => localDatabase.getProviderProfile(id),
      isDisabledLegacy: (id) =>
        localDatabase
          .listProfileStates()
          .some((s) => s.profileId === id && s.state === 'disabled-legacy'),
      markCredentialUnavailable: (id) => localDatabase.markProfileCredentialUnavailable(id),
      secretVersion: (handleId) => localDatabase.secretVersion(handleId),
      rebindSecretVersion: (profileId, version) =>
        localDatabase.rebindProfileSecret(profileId, version),
    },
    secrets: secretStore,
    fetch: pinnedFetch(publicHostPins, (url, init) => fetch(url, init)),
    pinPublicHost: (hostname, addresses) => {
      publicHostPins.set(hostname, addresses);
    },
  });
  const generationJobs = createGenerationJobs({
    store: localDatabase.generationJobs,
    getProfile: (id) => localDatabase.getProviderProfile(id),
    broker: providerBroker,
    generatedDirectory: join(app.getPath('userData'), 'generated'),
    download: createPinnedGenerationDownloader(),
    probe: probeGeneratedMedia,
  });
  // The provider calls in progress. A reload of the page ends them, since nothing will read their replies.
  const agentRequests = new AgentRequestRegistry();
  const originals = createLocalOriginalWriter({
    directory: join(paths.mediaRoot, 'originals'),
    assets: localDatabase.localAssets,
  });
  const assetLibrary = createAssetLibrary({
    directory: () => localDatabase.getAssetLibraryDirectory(),
    registrations: localDatabase.localAssets,
  });
  const droppedMediaImports = createDroppedMediaImportService({
    fileRegistry,
    assets: localDatabase.localAssets,
    originals,
    library: assetLibrary,
    onProgress: (progress) => {
      const win = mainWindow;
      if (win !== undefined && !win.isDestroyed()) {
        win.webContents.send(DROPPED_IMPORT_PROGRESS_CHANNEL, progress);
      }
    },
  });
  // The sign-in runner and its attempt registry (T-J03). Created before the IPC dependencies that use them.
  const signInRunner = createProviderSignIn({
    openExternal: (url) => shell.openExternal(url),
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    // No saved client: each ChatGPT sign-in registers one with ChatGPT (SIWC dynamic registration, PLAN-v4 §6d).
    chatGptClientId: undefined,
    getSetting: (key) => localDatabase.getSetting(key),
    installId: () => loadOrCreateInstallId(localDatabase),
  });
  const signInAttempts = createSignInAttempts({
    now: () => Date.now(),
    waitMs: CALLBACK_TIMEOUT_MS,
    openExternal: (url) => shell.openExternal(url),
  });
  const ipcHandlers = createIpcHandlers({
    agentRequests,
    fileRegistry,
    workerSupervisor,
    localDatabase,
    generationJobs,
    mediaChannel: createMediaChannelHandlers({
      orchestrator: jobOrchestrator,
      jobStore: localDatabase.jobDispatch,
      projectDocuments: localDatabase.projectDocuments,
      assets: localDatabase.localAssets,
      originals,
      library: assetLibrary,
      droppedMediaImports,
      whisper: {
        getEndpoint: () => {
          const profile = localDatabase
            .listProviderProfiles()
            .find(
              (candidate) =>
                candidate.provider === 'custom' || candidate.provider === 'openai-compatible',
            );
          return profile === undefined
            ? undefined
            : { endpoint: profile.baseUrl, modelId: profile.modelId };
        },
      },
    }),
    probeMedia: async (path) => {
      const probe = await checksumFile(path);
      return { ...probe, kind: classifyMediaKind(path) };
    },
    showOpenDialog: async () => {
      const win =
        BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0];
      const result = win
        ? await dialog.showOpenDialog(win, { properties: ['openFile'] })
        : await dialog.showOpenDialog({ properties: ['openFile'] });
      return { canceled: result.canceled, path: result.filePaths[0] };
    },
    showOpenDirectoryDialog: async () => {
      const win =
        BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0];
      const result = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return { canceled: result.canceled, path: result.filePaths[0] };
    },
    // Opens the asset library folder in the OS file browser. shell.openPath
    // resolves with the reason it failed, or an empty string when it worked.
    openDirectory: async (directory) => shell.openPath(directory),
    // Works out whether the library sits on a drive that is always there.
    classifyDrive: async (directory) => classifyDriveOfDirectory(directory),
    secretStore,
    providerBroker,
    providerSignIn: (provider, context, call) => signInRunner(provider, context, call),
    openExternal: (url) => shell.openExternal(url),
    signInAttempts,
    providerSignOut: (record) =>
      revokeChatGptRefreshToken({ record, fetch: (url, init) => fetch(url, init) }),
    handleWindowControl: (action) => {
      const win =
        BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0];
      if (!win) return false;
      switch (action) {
        case 'minimize':
          win.minimize();
          return true;
        case 'maximize':
          if (win.isMaximized()) win.unmaximize();
          else win.maximize();
          return win.isMaximized();
        case 'close':
          win.close();
          return true;
        case 'is-maximized':
          return win.isMaximized();
      }
    },
  });

  ipcMain.handle(DROP_FILES_ENDPOINT, async (event, files: unknown) => {
    if (shuttingDown) return { ok: false, error: 'Application is shutting down' };
    const senderOrigin = originOfPageUrl(event.senderFrame?.url ?? '');
    if (senderOrigin === undefined || !isAllowedEditorOrigin(senderOrigin)) {
      console.error(`[joy-desktop] refused IPC from ${senderOrigin ?? 'an unreadable frame'}`);
      return { ok: false, error: 'Blocked IPC request' };
    }
    try {
      return { ok: true, data: await droppedMediaImports.prepareDroppedPaths(files) };
    } catch {
      return { ok: false, error: 'Dropped files could not be prepared' };
    }
  });

  // The sender frame is what the browser reports, so it decides whether a page may call at all.
  // The origin inside the request is the renderer's own claim, and dispatch checks it as well.
  ipcMain.handle('joy-desktop-ipc', (event, request: IpcRequest) => {
    if (shuttingDown) return { ok: false, error: 'Application is shutting down' };
    const senderOrigin = originOfPageUrl(event.senderFrame?.url ?? '');
    if (senderOrigin === undefined || !isAllowedEditorOrigin(senderOrigin)) {
      console.error(`[joy-desktop] refused IPC from ${senderOrigin ?? 'an unreadable frame'}`);
      return { ok: false, error: 'Blocked IPC request' };
    }
    return dispatchIpcRequest(ipcHandlers, request);
  });

  app.on('second-instance', (_event, argv) => {
    const link = argv.find((arg) => arg.startsWith('joy://'));
    const deepLink = link ? parseProjectDeepLink(link) : undefined;
    if (deepLink) {
      // Wave 2: forward to the renderer's project-open command once the local project
      // store exists. For now, focusing the existing window is the safe no-op.
    }
    // Focus the main window itself: the loading window may be the first window in the list.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // A render source is either a registered local asset (its stored original) or a file the user
  // selected in this session. Both are resolved here, in the main process, and never sent out.
  const resolveSourcePath = (refId: string): string =>
    localDatabase.localAssets.storedPath(refId) ??
    fileRegistry.resolvePath({ kind: 'local-file', id: refId, displayName: '' });

  const shutdown = registerShutdownHooks({
    onAppEvent: (event, listener) => {
      if (event === 'before-quit') app.on('before-quit', (quitEvent) => listener(quitEvent));
      else app.on('window-all-closed', () => listener());
    },
    onProcessSignal: (signalName, listener) => process.on(signalName, listener),
    stopWorker: async () => {
      shuttingDown = true;
      generationJobs.stop();
      await localJobApiStart?.catch(() => undefined);
      await workerSupervisor.stopAndWait();
    },
    discardUploads: () => originals.abortAllOriginalUploads(),
    flush: async () => {
      await localJobApi?.close().catch(() => undefined);
      localDatabase.close();
    },
    quit: () => app.quit(),
    onQuitRequested: () => {
      quitting = true;
    },
    onError: (error) => console.error('Shutdown failed', error),
  });

  // Crash-triggered fallback for the Media Foundation video encoder (see gpu-encode-fallback.ts). It
  // must be installed before the app is ready, because Chromium reads switches at startup.
  installGpuEncodeFallback(
    {
      commandLine: app.commandLine,
      shutdown,
      isQuitting: () => quitting,
      quit: () => app.quit(),
      relaunch: (options) => app.relaunch(options),
      exit: (code) => app.exit(code),
      onChildProcessGone: (listener) =>
        app.on('child-process-gone', (_event, details) => listener(details)),
      log: (message) => console.error(message),
    },
    process.argv,
  );

  app.whenReady().then(async () => {
    if (shuttingDown) return;
    generationJobs.resume();
    void assetLibrary.removeInternalEntries().catch((error) => {
      console.error('Internal asset startup cleanup failed', error);
    });
    // Marks, but never deletes, any profile whose stored key cannot be read (PLAN-v4 §9c).
    // Keys are read only after ready: safeStorage is not guaranteed to work before it.
    void checkProfileCredentials(localDatabase, secretStore).catch(() => undefined);
    try {
      localJobApiStart = startLocalJobApi({
        orchestrator: jobOrchestrator,
        derivativeDirectory: join(paths.mediaRoot, 'derivatives'),
        sourceSize: async (refId) => statSync(resolveSourcePath(refId)).size,
        openSource: (refId) => createReadStream(resolveSourcePath(refId)),
        onWarning: (message) => console.warn(message),
        completeAi: createWorkerCompletion(providerBroker),
      });
      localJobApi = await localJobApiStart;
    } catch (error) {
      // Without the local API the Worker cannot connect. The rest of the app still opens.
      console.error('local job API did not start', error);
    }
    if (shuttingDown) return;
    // The Worker starts with the app, once the loopback job API it connects to is listening.
    if (localJobApi !== undefined) workerSupervisor.start();
    Menu.setApplicationMenu(null);
    // Only the installed copy claims the joy:// scheme (see registerJoyProtocol). A smoke run leaves the host alone.
    if (!isSmokeMode) {
      registerJoyProtocol(app, {
        execPath: process.execPath,
        localAppData: process.env['LOCALAPPDATA'],
      });
    }

    if (!isDev) {
      protocol.handle(PACKAGED_RENDERER_SCHEME, (request) => {
        const url = new URL(request.url);
        const rendererRoot = join(__dirname, '..', '..', 'renderer');
        const filePath = join(rendererRoot, url.pathname === '/' ? 'index.html' : url.pathname);
        // The global `fetch` (Node/undici) this used to call has no `file:` scheme support and
        // always rejects with "not implemented... yet..." — Electron's own `net.fetch` is the
        // documented way to serve a local file from `protocol.handle`, and the only one of the
        // two that actually works here.
        return net.fetch(pathToFileURL(filePath).toString());
      });
    }

    protocol.handle('joy-asset', async (request) => {
      try {
        if (request.method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
              'Access-Control-Allow-Headers': '*',
            },
          });
        }
        const url = new URL(request.url);
        let relPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
        if (relPath.startsWith('library/')) {
          relPath = relPath.slice('library/'.length);
        }
        const baseDir = localDatabase.getAssetLibraryDirectory();
        const resolvedPath = path.normalize(path.join(baseDir, relPath));
        const normalizedBase = path.normalize(baseDir);
        if (!resolvedPath.startsWith(normalizedBase)) {
          return new Response('Forbidden', {
            status: 403,
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        }
        if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
          return new Response('Not Found', {
            status: 404,
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        }
        const response = await net.fetch(pathToFileURL(resolvedPath).toString(), {
          headers: request.headers,
        });
        const headers = new Headers(response.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch {
        return new Response('Server Error', {
          status: 500,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }
    });

    // Deny any permission the desktop shell has no product reason to grant (camera/mic
    // access, if ever needed for capture, is a deliberate future decision, not a default).
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });

    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      // A packaged window is shown once its renderer has loaded (see showPackagedWindowWhenLoaded).
      show: isDev && !isSmokeMode,
      frame: false,
      titleBarStyle: 'hidden',
      backgroundColor: '#000000',
      webPreferences: buildSecureWebPreferences(join(__dirname, '..', 'preload', 'preload.cjs')),
    });
    mainWindow = win;
    cancelWhenPageGoes(agentRequests, win);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    void win.loadURL(resolveRendererTarget(isDev));
    if (!isDev && !isSmokeMode) showPackagedWindowWhenLoaded(win);
    if (isDev) {
      // A development window loads the editor dev server. While it does not answer, the window shows the JOY Media
      // loading page and checks the server every few seconds, then opens the editor as soon as it answers.
      const loadingPage = `data:text/html;charset=utf-8,${encodeURIComponent(
        devLoadingPageHtml(readLoadingLogoDataUrl()),
      )}`;
      let loadingShownAt = 0;
      let poll: ReturnType<typeof setInterval> | undefined;
      const stopPolling = (): void => {
        if (poll !== undefined) clearInterval(poll);
        poll = undefined;
      };
      const startPolling = (): void => {
        if (poll !== undefined) return;
        poll = setInterval(() => {
          void fetch(DEV_RENDERER_URL, { signal: AbortSignal.timeout(1500) })
            .then((response) => {
              if (!response.ok || win.isDestroyed()) return;
              stopPolling();
              // The bar gets to finish before the editor opens.
              const wait = Math.max(0, loadingShownAt + DEV_LOADING_BAR_MS - Date.now());
              setTimeout(() => {
                if (!win.isDestroyed()) void win.loadURL(DEV_RENDERER_URL);
              }, wait);
            })
            .catch(() => undefined);
        }, DEV_RENDERER_RETRY_MS);
      };
      win.on('closed', stopPolling);
      win.webContents.on(
        'did-fail-load',
        (_event, errorCode, _errorDescription, _validatedUrl, isMainFrame) => {
          // -3 is an aborted navigation, not a missing server, and a subframe failure is not the page itself.
          if (errorCode === -3 || !isMainFrame || win.isDestroyed()) return;
          loadingShownAt = Date.now();
          void win.loadURL(loadingPage);
          startPolling();
        },
      );
    }

    if (isSmokeMode && isDev) {
      // By this point `app.whenReady()` has resolved, the window above is constructed, and
      // `ipcMain.handle('joy-desktop-ipc', ...)` was registered unconditionally above (before
      // this smoke branch even exists) — so the three claims in this log line are all already
      // true, not aspirational. The delay just gives the log line time to flush before quit.
      console.log(
        '[joy-desktop] electron runtime smoke passed: app ready, window initialized, IPC wired',
      );
      setTimeout(() => {
        app.quit();
      }, 300);
    } else if (isSmokeMode) {
      // Packaged smoke (`test:smoke-packaged`): unlike the dev-mode branch above, this waits
      // for the real `joy-media-app://renderer/index.html` load to actually finish before
      // declaring success, so a missing/broken `apps/desktop/renderer` staging
      // (`package-release.mjs --unpacked`/`--staging`) or a broken preload bridge fails the
      // check with a non-zero exit instead of a false-positive log line.
      let failureReason: string | undefined;
      win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        failureReason ??= `did-fail-load: ${errorCode} ${errorDescription}`;
      });
      win.webContents.on('preload-error', (_event, preloadPath, error) => {
        failureReason ??= `preload-error: ${preloadPath}: ${error.message}`;
      });
      win.webContents.on('render-process-gone', (_event, details) => {
        failureReason ??= `render-process-gone: ${details.reason}`;
      });
      const finishSmoke = () => {
        setTimeout(() => {
          // `app.exit` skips the before-quit shutdown hooks. Stop the Worker here: a staged app
          // has one, and left running it outlives the smoke and holds the caller's output pipes.
          workerSupervisor.stop();
          if (failureReason) {
            console.error(`[joy-desktop] packaged renderer smoke failed: ${failureReason}`);
            app.exit(1);
          } else {
            console.log(
              `[joy-desktop] packaged renderer smoke passed: loaded ${resolveRendererTarget(isDev)} cleanly`,
            );
            app.exit(0);
          }
        }, 300);
      };
      win.webContents.once('did-finish-load', finishSmoke);
      // `did-finish-load` never fires on a hard load failure - fail on our own timeout instead
      // of hanging forever.
      setTimeout(() => {
        if (!win.isDestroyed()) {
          failureReason ??= 'timed out waiting for did-finish-load';
          finishSmoke();
        }
      }, 5000);
    }
  });
}

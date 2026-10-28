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
} from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path, { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseProjectDeepLink } from '../deep-link.js';
import { createFileRegistry } from './file-registry.js';
import { createWorkerSupervisor } from './worker-supervisor.js';
import { resolveWorkerEntry } from './worker-entry.js';
import { createIpcHandlers, dispatchIpcRequest } from './ipc-handlers.js';
import { registerJoyProtocol } from './protocol-registration.js';
import type { IpcRequest } from '../ipc.js';
import { isAllowedEditorOrigin, originOfPageUrl } from '../origin-policy.js';
import {
  PACKAGED_RENDERER_SCHEME,
  buildSecureWebPreferences,
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
import { checksumFile, classifyMediaKind } from './media-checksum.js';
import { createElectronSecretStore } from './secrets/electron-secret-store.js';
import { probeOpenAiCompatibleProvider } from '@joy-media/provider-sdk';
import { checkProfileCredentials } from './profile-credential-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged && process.env['NODE_ENV'] !== 'production';
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
  const workerEntry = resolveWorkerEntry({ mainDirname: __dirname, execPath: process.execPath });
  const workerSupervisor = createWorkerSupervisor({
    spawn: (command, args, options) => spawn(command, args, options),
    command: workerEntry.command,
    args: workerEntry.args,
    env: () =>
      localJobApi === undefined
        ? undefined
        : localWorkerEnv(process.env, { apiEnv: localJobApi.workerEnv, workerRoot }),
  });
  const secretStore = createElectronSecretStore(localDatabase, safeStorage);
  // Marks, but never deletes, any profile whose stored key cannot be read (PLAN-v4 §9c).
  const ipcHandlers = createIpcHandlers({
    fileRegistry,
    workerSupervisor,
    localDatabase,
    mediaChannel: createMediaChannelHandlers({
      orchestrator: jobOrchestrator,
      jobStore: localDatabase.jobDispatch,
      projectDocuments: localDatabase.projectDocuments,
      assets: localDatabase.localAssets,
      originals: createLocalOriginalWriter({
        directory: join(paths.mediaRoot, 'originals'),
        assets: localDatabase.localAssets,
      }),
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
    secretStore,
    probeProvider: (request) => probeOpenAiCompatibleProvider(request, fetch),
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

  // The sender frame is what the browser reports, so it decides whether a page may call at all.
  // The origin inside the request is the renderer's own claim, and dispatch checks it as well.
  ipcMain.handle('joy-desktop-ipc', (event, request: IpcRequest) => {
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
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // A render source is either a registered local asset (its stored original) or a file the user
  // selected in this session. Both are resolved here, in the main process, and never sent out.
  const resolveSourcePath = (refId: string): string =>
    localDatabase.localAssets.storedPath(refId) ??
    fileRegistry.resolvePath({ kind: 'local-file', id: refId, displayName: '' });

  app.whenReady().then(async () => {
    // Keys are read only after ready: safeStorage is not guaranteed to work before it.
    void checkProfileCredentials(localDatabase, secretStore).catch(() => undefined);
    try {
      localJobApi = await startLocalJobApi({
        orchestrator: jobOrchestrator,
        derivativeDirectory: join(paths.mediaRoot, 'derivatives'),
        sourceSize: async (refId) => statSync(resolveSourcePath(refId)).size,
        readSource: async (refId) => readFileSync(resolveSourcePath(refId)),
        onWarning: (message) => console.warn(message),
      });
    } catch (error) {
      // Without the local API the Worker cannot connect. The rest of the app still opens.
      console.error('local job API did not start', error);
    }
    Menu.setApplicationMenu(null);
    // Only the installed app claims the joy:// scheme. A development run would otherwise point
    // it at the Electron binary in the source tree.
    registerJoyProtocol(app);

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
      show: !isSmokeMode,
      frame: false,
      titleBarStyle: 'hidden',
      webPreferences: buildSecureWebPreferences(join(__dirname, '..', 'preload', 'preload.cjs')),
    });
    mainWindow = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    void win.loadURL(resolveRendererTarget(isDev));

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

    registerShutdownHooks({
      onAppEvent: (event, listener) => {
        // electron's `app.on` overloads are keyed to each literal event name, so a union-typed
        // `event` variable can't be forwarded directly - dispatch per literal instead.
        if (event === 'before-quit') app.on('before-quit', listener);
        else app.on('window-all-closed', listener);
      },
      onProcessSignal: (signalName, listener) => process.on(signalName, listener),
      stopWorker: () => workerSupervisor.stop(),
      flush: () => {
        // SqliteProjectStore (packages/project-persistence's desktop subpath) is not yet
        // wired here: no IPC channel opens/saves a project through it yet (see
        // docs/joy-media-final-migration-progress.md's wave 2 entry). LocalDatabase is the
        // one open handle this process holds today.
        void localJobApi?.close().catch(() => undefined);
        localDatabase.close();
      },
      quit: () => app.quit(),
    });
  });
}

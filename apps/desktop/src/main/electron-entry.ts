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
import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, session } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseProjectDeepLink } from '../deep-link.js';
import { createFileRegistry } from './file-registry.js';
import { createWorkerSupervisor } from './worker-supervisor.js';
import { resolveWorkerEntry } from './worker-entry.js';
import { createIpcHandlers, dispatchIpcRequest } from './ipc-handlers.js';
import type { IpcRequest } from '../ipc.js';
import {
  PACKAGED_RENDERER_SCHEME,
  buildSecureWebPreferences,
  resolveRendererTarget,
} from './window.js';
import { registerShutdownHooks } from './shutdown.js';
import { resolveDesktopPaths } from '../store/paths.js';
import { LocalDatabase } from '../store/local-database.js';
import { checksumFile, classifyMediaKind } from './media-checksum.js';
import { createElectronSecretStore } from './secrets/electron-secret-store.js';
import { probeOpenAiCompatibleProvider } from '@joy-media/provider-sdk';
import { evaluateAutoUpdate } from './auto-update-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = process.env['NODE_ENV'] !== 'production';
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
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const paths = resolveDesktopPaths(app.getPath('userData'));
  mkdirSync(paths.mediaRoot, { recursive: true });
  const localDatabase = new LocalDatabase({ filePath: paths.databaseFile });
  // Anything still `queued`/`running` from a previous process is stale by definition: the
  // Worker that would have finished it is gone. Do this before any new job can be enqueued.
  localDatabase.recoverInterrupted();

  const fileRegistry = createFileRegistry();
  const workerEntry = resolveWorkerEntry({ mainDirname: __dirname, execPath: process.execPath });
  const workerSupervisor = createWorkerSupervisor({
    spawn: (command, args, options) => spawn(command, args, options),
    command: workerEntry.command,
    args: workerEntry.args,
  });
  const secretStore = createElectronSecretStore(localDatabase, safeStorage);
  const ipcHandlers = createIpcHandlers({
    fileRegistry,
    workerSupervisor,
    localDatabase,
    probeMedia: async (path) => {
      const probe = await checksumFile(path);
      return { ...probe, kind: classifyMediaKind(path) };
    },
    showOpenDialog: async () => {
      const win = BrowserWindow.getFocusedWindow();
      const result = win
        ? await dialog.showOpenDialog(win, { properties: ['openFile'] })
        : await dialog.showOpenDialog({ properties: ['openFile'] });
      return { canceled: result.canceled, path: result.filePaths[0] };
    },
    secretStore,
    probeProvider: (request) => probeOpenAiCompatibleProvider(request, fetch),
    // Pure, network-free decision (see auto-update-policy.ts). The renderer fetches the
    // manifest from the public `GET /v1/releases/:channel` route and its own subscription
    // status from `GET /v1/account/subscription` itself; the pinned public key and the app's
    // actual running version — trust material a compromised renderer must never be able to
    // supply itself — come only from the main process's own environment and `app.getVersion()`,
    // never from the IPC payload.
    checkForUpdate: (request) => {
      const pinnedPublicKeyPem = process.env['JOY_MEDIA_RELEASE_SIGNING_PUBLIC_KEY'];
      return evaluateAutoUpdate({
        ...request,
        currentVersion: app.getVersion(),
        ...(pinnedPublicKeyPem === undefined ? {} : { pinnedPublicKeyPem }),
      });
    },
  });

  ipcMain.handle('joy-desktop-ipc', (_event, request: IpcRequest) =>
    dispatchIpcRequest(ipcHandlers, request),
  );

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

  app.whenReady().then(() => {
    app.setAsDefaultProtocolClient('joy');

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

    // Deny any permission the desktop shell has no product reason to grant (camera/mic
    // access, if ever needed for capture, is a deliberate future decision, not a default).
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });

    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: !isSmokeMode,
      webPreferences: buildSecureWebPreferences(join(__dirname, '..', 'preload', 'preload.cjs')),
    });
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
        localDatabase.close();
      },
      quit: () => app.quit(),
    });
  });
}

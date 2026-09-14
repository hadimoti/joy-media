/**
 * Real Electron main-process entrypoint. This file is intentionally thin: it only wires
 * the `electron` module to the pure, unit-tested modules in this directory. Nothing here
 * has its own test coverage — verifying it requires an actual Electron runtime (see
 * docs/joy-media-final-migration-progress.md for the wave 1 smoke-test gap).
 *
 * Do not add business logic here. Add it to a testable sibling module and call it from
 * here instead.
 */
import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, session } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseProjectDeepLink } from '../deep-link.js';
import { createFileRegistry } from './file-registry.js';
import { createWorkerSupervisor } from './worker-supervisor.js';
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = process.env['NODE_ENV'] !== 'production';

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
  const workerSupervisor = createWorkerSupervisor({
    spawn: (command, args, options) => spawn(command, args, options),
    // Wave 1 dev default: run the worker package's TS entry directly via tsx. Wave 2 swaps
    // this for the built apps/worker/dist entry and a real job-protocol handshake.
    command: process.execPath,
    args: [join(__dirname, '..', '..', '..', 'worker', 'src', 'index.ts')],
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
        return fetch(`file://${filePath.replace(/\\/g, '/')}`);
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
      webPreferences: buildSecureWebPreferences(join(__dirname, '..', 'preload', 'preload.cjs')),
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    void win.loadURL(resolveRendererTarget(isDev));

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

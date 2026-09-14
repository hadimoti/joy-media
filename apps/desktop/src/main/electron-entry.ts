/**
 * Real Electron main-process entrypoint. This file is intentionally thin: it only wires
 * the `electron` module to the pure, unit-tested modules in this directory. Nothing here
 * has its own test coverage — verifying it requires an actual Electron runtime (see
 * docs/joy-media-final-migration-progress.md for the wave 1 smoke-test gap).
 *
 * Do not add business logic here. Add it to a testable sibling module and call it from
 * here instead.
 */
import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
  const fileRegistry = createFileRegistry();
  const workerSupervisor = createWorkerSupervisor({
    spawn: (command, args, options) => spawn(command, args, options),
    // Wave 1 dev default: run the worker package's TS entry directly via tsx. Wave 2 swaps
    // this for the built apps/worker/dist entry and a real job-protocol handshake.
    command: process.execPath,
    args: [join(__dirname, '..', '..', '..', 'worker', 'src', 'index.ts')],
  });
  const ipcHandlers = createIpcHandlers({
    fileRegistry,
    workerSupervisor,
    showOpenDialog: async () => {
      const win = BrowserWindow.getFocusedWindow();
      const result = win
        ? await dialog.showOpenDialog(win, { properties: ['openFile'] })
        : await dialog.showOpenDialog({ properties: ['openFile'] });
      return { canceled: result.canceled, path: result.filePaths[0] };
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
        // Wave 2: flush the local project store here before the process exits.
      },
      quit: () => app.quit(),
    });
  });
}

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createJobOrchestrator } from '../../../apps/desktop/src/jobs/job-orchestrator.js';
import { startLocalJobApi } from '../../../apps/desktop/src/jobs/local-job-api.js';
import { localWorkerEnv } from '../../../apps/desktop/src/jobs/worker-env.js';
import { createLocalOriginalWriter } from '../../../apps/desktop/src/main/local-originals.js';
import { createMediaChannelHandlers } from '../../../apps/desktop/src/main/media-channel.js';
import { LocalDatabase } from '../../../apps/desktop/src/store/local-database.js';
import { UNHANDLED, type ChannelHandler } from './joy-desktop-bridge.js';

/**
 * The desktop media host, running inside the Playwright process.
 *
 * The e2e browser has no Electron app, so the editor's `window.joyDesktop` bridge is answered
 * here by the desktop's own Node modules:
 *
 *  - `LocalDatabase` owns the SQLite file: project documents, local asset registrations and the
 *    job dispatch store.
 *  - `createLocalOriginalWriter` stores uploads and enforces the registered size and checksum.
 *  - `createMediaChannelHandlers` implements the `desktop.media.*` channel semantics.
 *  - `createJobOrchestrator` and `startLocalJobApi` run the job stack on a loopback port.
 *  - `apps/worker/dist/index.js` is the real Worker process, started with the desktop's own
 *    `localWorkerEnv`.
 *
 * Not reproduced here, so no passing test covers it:
 *  - The preload and IPC layer. Channels are called directly; only the envelope mapping is ours.
 *  - Listing imported assets. `desktop.asset-library.get-catalog` reads `catalog.json` from the
 *    library folder and nothing else, as the desktop does. No channel lists registered local
 *    assets yet, so an imported asset is not listed. That needs the owner's decision on a
 *    twelfth channel.
 *  - The Electron Worker supervisor. Worker status comes from the job store's presence and the
 *    process state. A retry starts a Worker that has exited.
 */

// Playwright runs from the repository root, and its CommonJS transform has no `import.meta`.
const REPO_ROOT = resolve(process.cwd());
const DEFAULT_WORKER_ENTRY = join(REPO_ROOT, 'apps', 'worker', 'dist', 'index.js');

export interface DesktopJobHarnessOptions {
  /** The Worker build to run. Defaults to `apps/worker/dist/index.js`. */
  readonly workerEntry?: string;
  /**
   * Extra environment for the Worker. The route the harness owns (the API URL, its token, the
   * Worker state paths and `JOY_MEDIA_HOME`) is applied last and cannot be overridden.
   */
  readonly env?: NodeJS.ProcessEnv;
}

export interface DesktopJobHarness {
  /** The channel handler `installJoyDesktopBridge` takes. */
  readonly handler: ChannelHandler;
  /** The temporary user-data directory. Removed by `stop()`. */
  readonly root: string;
  /** The loopback URL the Worker talks to. */
  readonly apiUrl: string;
  /** The last lines the Worker printed, so a failing test can say what it said. */
  readonly workerLog: () => string;
  /** Closes the API, ends the Worker tree and removes the temporary directory. Safe to call twice. */
  stop(): Promise<void>;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Ends the Worker and every process it started. On Windows `taskkill /T` takes the whole tree, so
 * an `ffmpeg` child left by a render dies with it. Elsewhere the Worker leads its own process
 * group (it is spawned detached), and the group is killed.
 */
async function killWorkerTree(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || hasExited(child)) return;
  const pid = child.pid;
  if (pid === undefined) return;
  await new Promise<void>((resolveKill) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolveKill());
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    resolveKill();
  });
  await new Promise<void>((resolveExit) => {
    if (hasExited(child)) {
      resolveExit();
      return;
    }
    child.once('exit', () => resolveExit());
    setTimeout(resolveExit, 2_000).unref();
  });
}

/**
 * Starts the desktop host: the SQLite database, the job orchestrator, the loopback job API and
 * the real Worker process. A failure part-way through closes whatever was already started.
 */
export async function startDesktopJobHarness(
  options: DesktopJobHarnessOptions = {},
): Promise<DesktopJobHarness> {
  const root = mkdtempSync(join(tmpdir(), 'joy-media-e2e-desktop-'));
  const resources: {
    database?: LocalDatabase;
    api?: Awaited<ReturnType<typeof startLocalJobApi>>;
    worker?: ChildProcess;
  } = {};
  const workerTail: string[] = [];
  let stopping: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      await killWorkerTree(resources.worker);
      await resources.api?.close();
      resources.database?.close();
      rmSync(root, { recursive: true, force: true });
    })();
    return stopping;
  };

  try {
    const assetLibraryDirectory = join(root, 'asset-library');
    const originalsDirectory = join(root, 'originals');
    const derivativeDirectory = join(root, 'derivatives');
    const workerDirectory = join(root, 'worker');
    const workerRoot = join(root, 'worker-state');
    for (const directory of [assetLibraryDirectory, workerDirectory, workerRoot]) {
      mkdirSync(directory, { recursive: true });
    }

    const database = new LocalDatabase({ filePath: join(root, 'joy-media.sqlite') });
    resources.database = database;
    // The library folder stays inside the temporary directory, so a test never reads the real one.
    database.setAssetLibraryDirectory(assetLibraryDirectory);
    const orchestrator = createJobOrchestrator({ store: database.jobDispatch });
    const originals = createLocalOriginalWriter({
      directory: originalsDirectory,
      assets: database.localAssets,
    });
    const media = createMediaChannelHandlers({
      orchestrator,
      jobStore: database.jobDispatch,
      projectDocuments: database.projectDocuments,
      assets: database.localAssets,
      originals,
    });

    const api = await startLocalJobApi({
      orchestrator,
      derivativeDirectory,
      sourceSize: async (refId) => {
        const path = database.localAssets.storedPath(refId);
        if (path === undefined) throw new Error('Unknown local asset');
        return (await stat(path)).size;
      },
      readSource: async (refId) => {
        const path = database.localAssets.storedPath(refId);
        if (path === undefined) throw new Error('Unknown local asset');
        return readFile(path);
      },
      onWarning: (message) => console.warn(`[desktop-job-harness] ${message}`),
    });
    resources.api = api;

    const workerEntry = options.workerEntry ?? DEFAULT_WORKER_ENTRY;
    if (!existsSync(workerEntry)) {
      throw new Error(
        `Worker build missing at ${workerEntry}; build it with "node node_modules/typescript/bin/tsc -b apps/worker"`,
      );
    }

    const startWorker = (): ChildProcess => {
      const child = spawn(process.execPath, [workerEntry], {
        cwd: workerDirectory,
        detached: process.platform !== 'win32',
        env: {
          ...localWorkerEnv(
            { ...process.env, ...(options.env ?? {}) },
            { apiEnv: api.workerEnv, workerRoot },
          ),
          JOY_MEDIA_HOME: join(root, 'joy-media-home'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const keepTail = (chunk: Buffer): void => {
        workerTail.push(chunk.toString('utf8'));
        while (workerTail.length > 40) workerTail.shift();
      };
      child.stdout?.on('data', keepTail);
      child.stderr?.on('data', keepTail);
      child.on('error', (error) => {
        console.warn(`[desktop-job-harness] worker failed to start: ${error.message}`);
      });
      return child;
    };
    resources.worker = startWorker();

    const workerAlive = (): boolean =>
      resources.worker !== undefined && !hasExited(resources.worker);
    const workerStatus = () => {
      // A Worker that has exited is offline, whatever the job store still remembers about it.
      const presence = workerAlive() ? database.jobDispatch.presence() : undefined;
      return {
        connection: !workerAlive() ? 'offline' : presence === undefined ? 'starting' : 'online',
        workerId: presence?.workerId,
        capabilities: presence === undefined ? [] : [...presence.capabilities],
        lastSeenAt: presence?.lastHelloAt,
      };
    };

    const handler: ChannelHandler = async (channel, payload) => {
      if (channel.startsWith('desktop.media.')) {
        const mediaHandler = media[channel as keyof typeof media];
        if (mediaHandler === undefined) return UNHANDLED;
        const result = await mediaHandler(payload);
        // The preload passes `data` through and throws on a failure, so the bridge does the same.
        if (!result.ok) throw new Error(result.error ?? 'The media request failed');
        return result.data;
      }
      if (channel === 'desktop.asset-library.get-catalog') {
        // The desktop's own reader: a missing catalog is an empty library, not an error.
        const catalogPath = join(database.getAssetLibraryDirectory(), 'catalog.json');
        if (!existsSync(catalogPath)) {
          return { version: 1, counts: { total: 0, audio: 0, image: 0 }, assets: [] };
        }
        return JSON.parse(readFileSync(catalogPath, 'utf8')) as unknown;
      }
      if (channel === 'desktop.asset-library.get-settings') {
        return database.getAssetLibraryInfo();
      }
      if (channel === 'desktop.worker-status') return workerStatus();
      if (channel === 'desktop.worker-retry') {
        if (!workerAlive()) resources.worker = startWorker();
        return workerStatus();
      }
      return UNHANDLED;
    };

    return {
      handler,
      root,
      apiUrl: api.url,
      workerLog: () => workerTail.join(''),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

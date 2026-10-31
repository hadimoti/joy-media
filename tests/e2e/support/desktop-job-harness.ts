import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { inspectImageAnimation } from '../../../apps/editor-web/src/animated-image-metadata.js';
import { createJobOrchestrator } from '../../../apps/desktop/src/jobs/job-orchestrator.js';
import { startLocalJobApi } from '../../../apps/desktop/src/jobs/local-job-api.js';
import { localWorkerEnv } from '../../../apps/desktop/src/jobs/worker-env.js';
import { createLocalOriginalWriter } from '../../../apps/desktop/src/main/local-originals.js';
import { createMediaChannelHandlers } from '../../../apps/desktop/src/main/media-channel.js';
import { LocalDatabase } from '../../../apps/desktop/src/store/local-database.js';
import { UNHANDLED, type ChannelHandler } from './joy-desktop-bridge.js';

/**
 * The real desktop host, running inside the Playwright process.
 *
 * The e2e browser has no Electron app, so the editor's `window.joyDesktop` bridge used to be
 * answered by an in-memory fake. That fake could not run a job, could not check a revision, and
 * could not tell an animated GIF from a still. This harness replaces it with the desktop's own
 * machinery:
 *
 *  - `LocalDatabase` (apps/desktop/src/store/local-database.ts) owns the SQLite file, the project
 *    documents, the local asset registrations and the job dispatch store.
 *  - `createJobOrchestrator` (apps/desktop/src/jobs/job-orchestrator.ts) owns the job stack.
 *  - `createMediaChannelHandlers` (apps/desktop/src/main/media-channel.ts) owns the
 *    `desktop.media.*` channel semantics.
 *  - `createLocalOriginalWriter` (apps/desktop/src/main/local-originals.ts) owns the original
 *    upload, including the size and checksum checks.
 *  - `startLocalJobApi` (apps/desktop/src/jobs/local-job-api.ts) serves the loopback route and
 *    `apps/worker/dist/index.js` runs the real Worker against it.
 *
 * Nothing here is Electron-bound: every module above is plain Node. The two Electron-only
 * surfaces (`desktop.asset-library.get-catalog` and `get-settings`) are re-implemented below with
 * the same semantics as `createIpcHandlers` in apps/desktop/src/main/ipc-handlers.ts, because that
 * factory also needs the Electron file registry and the Worker supervisor.
 */

// Playwright runs from the repository root, and its CommonJS transform has no `import.meta`.
const REPO_ROOT = resolve(process.cwd());
const DEFAULT_WORKER_ENTRY = join(REPO_ROOT, 'apps', 'worker', 'dist', 'index.js');

/** The media kinds the editor's catalog uses. */
type CatalogKind = 'video' | 'audio' | 'image';

interface CatalogAsset {
  readonly id: string;
  readonly projectId: string;
  readonly kind: CatalogKind;
  readonly displayName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: {
    readonly mimeType: string;
    readonly durationUs?: number;
    readonly width?: number;
    readonly height?: number;
    readonly animation?: {
      readonly frameCount: number;
      readonly cycleDurationUs: number;
      readonly loopCount: number;
      readonly hasAlpha: boolean;
    };
  };
  readonly createdAt: number;
  readonly cloudBacked: boolean;
  readonly relativePath?: string;
}

interface CatalogFile {
  readonly version: number;
  readonly counts: { readonly total: number; readonly audio: number; readonly image: number };
  readonly assets: readonly CatalogAsset[];
}

interface LocalAssetRow {
  readonly asset_id: string;
  readonly kind: string;
  readonly display_name: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly stored_path: string | null;
  readonly created_at: string;
}

export interface DesktopJobHarnessOptions {
  /** The Worker build to run. Defaults to `apps/worker/dist/index.js`. */
  readonly workerEntry?: string;
  /** Extra environment for the Worker. `PATH` is inherited, so ffmpeg/ffprobe stay available. */
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
  /** Closes the API, kills the Worker and removes the temporary directory. */
  stop(): Promise<void>;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function extensionMimeType(displayName: string): string {
  const match = /\.([^.\\/]+)$/.exec(displayName);
  const extension = match?.[1]?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let text = '';
  for (let index = start; index < end; index += 1) text += String.fromCharCode(bytes[index] ?? 0);
  return text;
}

/**
 * The mime type the editor's `sniffMediaMimeType` (apps/editor-web/src/media-import.ts) picks
 * for an image. The bytes decide, so an animated GIF is never mistaken for a still. It is
 * mirrored here so the harness does not pull the editor's browser bundle into the Node process.
 */
function sniffImageMimeType(bytes: Uint8Array, declaredMimeType: string): string {
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === '\x89PNG') return 'image/png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return declaredMimeType;
}

function catalogKind(kind: string): CatalogKind {
  if (kind === 'video' || kind === 'audio') return kind;
  return 'image';
}

interface ProbeResult {
  readonly durationSeconds?: number;
  readonly width?: number;
  readonly height?: number;
}

/**
 * The facts ffprobe reads out of the stored original. The Worker uses the same tool, so the
 * catalog agrees with what a render will actually see.
 */
async function probeMedia(path: string): Promise<ProbeResult> {
  const raw = await new Promise<string>((resolveText, rejectText) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
      { maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          rejectText(error);
          return;
        }
        resolveText(stdout);
      },
    );
  });
  const parsed = JSON.parse(raw) as {
    readonly streams?: readonly {
      readonly codec_type?: string;
      readonly width?: number;
      readonly height?: number;
      readonly duration?: string;
    }[];
    readonly format?: { readonly duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const durationSeconds = Number(parsed.format?.duration ?? video?.duration ?? Number.NaN);
  const width = video?.width;
  const height = video?.height;
  return {
    ...(Number.isFinite(durationSeconds) && durationSeconds > 0 ? { durationSeconds } : {}),
    ...(typeof width === 'number' && width > 0 ? { width } : {}),
    ...(typeof height === 'number' && height > 0 ? { height } : {}),
  };
}

/**
 * The descriptor the editor computes for an image (media-import.ts `describeImage`): the
 * animation facts come from the real bytes, and the duration is the animation cycle.
 */
function imageDescriptor(
  bytes: Uint8Array,
  mimeType: string,
  probe: ProbeResult,
): CatalogAsset['descriptor'] {
  const animation = inspectImageAnimation(bytes, mimeType);
  return {
    mimeType,
    ...(probe.width === undefined ? {} : { width: probe.width }),
    ...(probe.height === undefined ? {} : { height: probe.height }),
    ...(animation === undefined ? {} : { animation, durationUs: animation.cycleDurationUs }),
  };
}

/** The descriptor the editor computes for audio and video (media-import.ts `describeTimedMedia`). */
function timedDescriptor(
  mimeType: string,
  kind: CatalogKind,
  probe: ProbeResult,
): CatalogAsset['descriptor'] {
  const durationUs =
    probe.durationSeconds === undefined ? undefined : Math.round(probe.durationSeconds * 1_000_000);
  return {
    mimeType,
    ...(durationUs === undefined ? {} : { durationUs }),
    ...(kind !== 'video' || probe.width === undefined ? {} : { width: probe.width }),
    ...(kind !== 'video' || probe.height === undefined ? {} : { height: probe.height }),
  };
}

/**
 * Starts the desktop host: the SQLite database, the job orchestrator, the loopback job API and
 * the real Worker process.
 */
export async function startDesktopJobHarness(
  options: DesktopJobHarnessOptions = {},
): Promise<DesktopJobHarness> {
  const root = mkdtempSync(join(tmpdir(), 'joy-media-e2e-desktop-'));
  const databasePath = join(root, 'joy-media.sqlite');
  const originalsDirectory = join(root, 'originals');
  const assetLibraryDirectory = join(root, 'asset-library');
  const workerDirectory = join(root, 'worker');
  const derivativeDirectory = join(root, 'derivatives');
  const workerRoot = join(root, 'worker-state');
  mkdirSync(assetLibraryDirectory, { recursive: true });
  mkdirSync(workerDirectory, { recursive: true });
  mkdirSync(workerRoot, { recursive: true });

  const database = new LocalDatabase({ filePath: databasePath });
  // The asset library stays inside the temporary directory, so a test never reads the real one.
  database.setAssetLibraryDirectory(assetLibraryDirectory);
  // A second connection to the same SQLite file is safe under WAL for one process
  // (see the note on LocalDatabase). It is only used to list the real registrations.
  const reader = new DatabaseSync(databasePath);

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

  const workerEntry = options.workerEntry ?? DEFAULT_WORKER_ENTRY;
  if (!existsSync(workerEntry)) {
    await api.close();
    reader.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      `Worker build missing at ${workerEntry}; build it with "node node_modules/typescript/bin/tsc -b apps/worker"`,
    );
  }

  const workerTail: string[] = [];
  const worker: ChildProcess = spawn(process.execPath, [workerEntry], {
    cwd: workerDirectory,
    env: {
      ...localWorkerEnv(process.env, { apiEnv: api.workerEnv, workerRoot }),
      JOY_MEDIA_HOME: join(root, 'joy-media-home'),
      ...(options.env ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keepTail = (chunk: Buffer): void => {
    workerTail.push(chunk.toString('utf8'));
    while (workerTail.length > 40) workerTail.shift();
  };
  worker.stdout?.on('data', keepTail);
  worker.stderr?.on('data', keepTail);
  worker.on('error', (error) => {
    console.warn(`[desktop-job-harness] worker failed to start: ${error.message}`);
  });

  const stopped = { value: false };
  const stop = async (): Promise<void> => {
    if (stopped.value) return;
    stopped.value = true;
    if (worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGKILL');
      await new Promise<void>((resolveExit) => {
        const done = (): void => resolveExit();
        worker.once('exit', done);
        setTimeout(done, 2_000).unref();
      });
    }
    await api.close();
    reader.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  };

  /**
   * The catalog is the desktop's own `catalog.json`, in the asset library directory the database
   * points at. It is rebuilt from the real local asset registrations and the real stored
   * originals, never from the payload the editor sent.
   */
  const rebuildCatalog = async (): Promise<CatalogFile> => {
    const rows = reader
      .prepare(
        `SELECT asset_id, kind, display_name, sha256, bytes, stored_path, created_at
           FROM local_assets ORDER BY created_at, asset_id`,
      )
      .all() as unknown as LocalAssetRow[];
    const assets: CatalogAsset[] = [];
    for (const row of rows) {
      const kind = catalogKind(row.kind);
      const mimeType = extensionMimeType(row.display_name);
      let descriptor: CatalogAsset['descriptor'] = { mimeType };
      if (row.stored_path !== null) {
        const bytes = await readFile(row.stored_path);
        const probe = await probeMedia(row.stored_path).catch(() => ({}) as ProbeResult);
        const sniffed = kind === 'image' ? sniffImageMimeType(bytes, mimeType) : mimeType;
        descriptor =
          kind === 'image'
            ? imageDescriptor(bytes, sniffed, probe)
            : timedDescriptor(sniffed, kind, probe);
      }
      assets.push({
        id: row.asset_id,
        projectId: '',
        kind,
        displayName: row.display_name,
        sha256: row.sha256,
        bytes: row.bytes,
        descriptor,
        createdAt: Date.parse(row.created_at),
        cloudBacked: false,
        relativePath: `${kind === 'audio' ? 'audio' : kind === 'image' ? 'images' : 'video'}/${row.asset_id}`,
      });
    }
    const catalog: CatalogFile = {
      version: 1,
      counts: {
        total: assets.length,
        audio: assets.filter((asset) => asset.kind === 'audio').length,
        image: assets.filter((asset) => asset.kind === 'image').length,
      },
      assets,
    };
    writeFileSync(
      join(assetLibraryDirectory, 'catalog.json'),
      `${JSON.stringify(catalog, null, 2)}\n`,
      'utf8',
    );
    return catalog;
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
      return rebuildCatalog();
    }
    if (channel === 'desktop.asset-library.get-settings') {
      await rebuildCatalog();
      return database.getAssetLibraryInfo();
    }
    if (channel === 'desktop.worker-status' || channel === 'desktop.worker-retry') {
      // The desktop's Worker supervisor owns this state. The harness owns the Worker process,
      // so the presence the job store holds is the real answer: a Worker that said hello is
      // online, and one that has not is still starting.
      const presence = database.jobDispatch.presence();
      const alive = worker.exitCode === null && worker.signalCode === null;
      const connection = presence !== undefined ? 'online' : alive ? 'starting' : 'offline';
      return {
        connection,
        workerId: presence?.workerId,
        capabilities: presence === undefined ? [] : [...presence.capabilities],
        lastSeenAt: presence?.lastHelloAt,
      };
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
}

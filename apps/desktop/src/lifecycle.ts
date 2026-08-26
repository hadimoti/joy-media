import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DesktopConfig } from './config.js';
import { discoverMediaTools, type MediaTools } from './media-tools.js';
import { redactLogLine } from './redaction.js';

export type WorkerState =
  'stopped' | 'starting' | 'running' | 'waiting-for-pairing' | 'failed' | 'stopping';
export interface WorkerStatus {
  readonly state: WorkerState;
  readonly workerId?: string;
  readonly pairingCode?: string;
  readonly mediaTools: MediaTools;
  readonly logs: readonly string[];
  readonly exitCode?: number | null;
  readonly message?: string;
}

export interface WorkerControllerOptions {
  readonly config: DesktopConfig;
  readonly userDataPath: string;
  readonly electronPath?: string;
  readonly workerEntry?: string;
  readonly platform?: NodeJS.Platform;
  readonly packaged?: boolean;
  /** Maximum time allowed for a worker process tree to exit during shutdown. */
  readonly shutdownTimeoutMs?: number;
  /** Test seam for asserting the platform-specific process-tree termination. */
  readonly terminateProcessTree?: (child: ChildProcess) => Promise<void>;
  /** Path to the generated SHA-256 manifest for the packaged Worker entrypoint. */
  readonly workerIntegrityManifest?: string;
  /** Test seam for the child process creation. */
  readonly spawnWorker?: typeof spawn;
  /** Test seam for media-tool discovery. */
  readonly discoverMediaTools?: (config: DesktopConfig, platform?: NodeJS.Platform) => MediaTools;
}

export class WorkerController {
  readonly #options: WorkerControllerOptions;
  readonly #logs: string[] = [];
  #child: ChildProcess | undefined;
  #status: WorkerStatus;
  #onStatus: ((status: WorkerStatus) => void) | undefined;

  constructor(options: WorkerControllerOptions) {
    this.#options = options;
    const mediaTools = (options.discoverMediaTools ?? discoverMediaTools)(
      options.config,
      options.platform,
    );
    this.#status = { state: 'stopped', mediaTools, logs: [] };
  }

  status(): WorkerStatus {
    return { ...this.#status, logs: [...this.#logs] };
  }
  onStatus(listener: (status: WorkerStatus) => void): void {
    this.#onStatus = listener;
  }

  async start(): Promise<WorkerStatus> {
    if (this.#child !== undefined) return this.status();
    if (this.#options.config.apiUrl.trim() === '')
      return this.update({
        state: 'failed',
        mediaTools: this.#status.mediaTools,
        message: 'API URL is required before starting the Worker',
      });
    const tools = (this.#options.discoverMediaTools ?? discoverMediaTools)(
      this.#options.config,
      this.#options.platform,
    );
    if (!tools.ready)
      return this.update({
        state: 'failed',
        mediaTools: tools,
        ...(tools.reason === undefined ? {} : { message: tools.reason }),
      });
    const workerEntry =
      this.#options.workerEntry ?? defaultWorkerEntry(this.#options.packaged === true);
    const electronPath = this.#options.electronPath ?? process.execPath;
    if (!existsSync(workerEntry))
      return this.update({
        state: 'failed',
        mediaTools: tools,
        message: 'Packaged Worker entrypoint is missing',
      });
    const integrityManifest =
      this.#options.workerIntegrityManifest ??
      (this.#options.packaged === true
        ? join(dirname(workerEntry), 'worker-integrity.json')
        : undefined);
    if (integrityManifest !== undefined) {
      try {
        verifyWorkerIntegrity(workerEntry, integrityManifest);
      } catch (error) {
        return this.update({
          state: 'failed',
          mediaTools: tools,
          message: error instanceof Error ? error.message : 'Worker integrity verification failed',
        });
      }
    }
    this.update({ state: 'starting', mediaTools: tools });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      JOY_MEDIA_API_URL: this.#options.config.apiUrl,
    };
    if (this.#options.config.workerStatePath !== undefined)
      env.JOY_MEDIA_WORKER_STATE_PATH = this.#options.config.workerStatePath;
    if (this.#options.config.localAssetsJson !== undefined)
      env.JOY_MEDIA_LOCAL_ASSETS_JSON = this.#options.config.localAssetsJson;
    if (tools.ffmpegPath !== undefined) env.JOY_MEDIA_FFMPEG_PATH = tools.ffmpegPath;
    if (tools.ffprobePath !== undefined) env.JOY_MEDIA_FFPROBE_PATH = tools.ffprobePath;
    const toolDirectories = [tools.ffmpegPath, tools.ffprobePath]
      .filter(
        (path): path is string => path !== undefined && (path.includes('/') || path.includes('\\')),
      )
      .map((path) => dirname(path));
    if (toolDirectories.length > 0)
      env.PATH = [...new Set([...toolDirectories, env.PATH ?? ''])].join(delimiter);
    const child = (this.#options.spawnWorker ?? spawn)(electronPath, [workerEntry], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#child = child;
    child.stdout?.on('data', (data: Buffer) => this.consumeOutput(data.toString('utf8')));
    child.stderr?.on('data', (data: Buffer) => this.appendLog(data.toString('utf8')));
    child.once('error', (error) => {
      if (this.#child !== child) return;
      if (this.#status.state === 'stopping') {
        // An error is not proof that the process (or its descendants) exited.
        // Keep ownership until the exit event so a retry cannot overlap it.
        this.update({
          state: 'stopping',
          mediaTools: tools,
          message: `Worker shutdown encountered an error; waiting for process exit before allowing restart: ${redactLogLine(error.message)}`,
        });
        return;
      }
      this.#child = undefined;
      this.update({ state: 'failed', mediaTools: tools, message: redactLogLine(error.message) });
    });
    child.once('exit', (code) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      if (this.#status.state !== 'stopping')
        this.update(
          {
            state: code === 0 ? 'stopped' : 'failed',
            mediaTools: tools,
            exitCode: code,
          },
          true,
        );
      else this.update({ state: 'stopped', mediaTools: tools, exitCode: code }, true);
    });
    return this.status();
  }

  async stop(): Promise<WorkerStatus> {
    const child = this.#child;
    if (child === undefined) return this.status();
    this.update({ state: 'stopping', mediaTools: this.#status.mediaTools });
    let exitObserved = false;
    const exited = new Promise<void>((resolvePromise) => {
      child.once('exit', () => {
        exitObserved = true;
        resolvePromise();
      });
      child.once('error', resolvePromise);
    });
    const terminate =
      this.#options.terminateProcessTree ??
      ((processToStop) =>
        terminateWorkerProcessTree(processToStop, this.#options.platform ?? process.platform));
    await terminate(child);
    const timeout = this.#options.shutdownTimeoutMs ?? 5_000;
    await Promise.race([
      exited,
      new Promise<void>((resolvePromise) => setTimeout(resolvePromise, timeout)),
    ]);
    if (this.#child === child && !exitObserved) {
      // A timeout only bounds this call; it does not prove that the process
      // tree is gone. Keep the child owned by the controller until its exit is
      // observed so start/restart cannot create a second Worker alongside it.
      this.update({
        state: 'stopping',
        mediaTools: this.#status.mediaTools,
        message:
          this.#status.message ??
          'Worker shutdown timed out; waiting for process exit before allowing restart',
      });
    }
    return this.status();
  }
  async restart(): Promise<WorkerStatus> {
    await this.stop();
    return this.start();
  }
  async dispose(): Promise<void> {
    await this.stop();
  }

  private consumeOutput(output: string): void {
    for (const rawLine of output.split(/\r?\n/).filter(Boolean)) {
      const line = redactLogLine(rawLine);
      this.appendLog(line);
      try {
        const event = JSON.parse(rawLine) as Record<string, unknown>;
        if (typeof event.workerId === 'string')
          this.update({ workerId: event.workerId, state: 'running' });
      } catch {
        const match = line.match(/pairing code:\s*([A-Z0-9-]+)/i);
        if (match?.[1] !== undefined)
          this.update({ pairingCode: match[1], state: 'waiting-for-pairing' });
      }
    }
  }
  private appendLog(line: string): void {
    this.#logs.push(...line.split(/\r?\n/).filter(Boolean).map(redactLogLine));
    if (this.#logs.length > 200) this.#logs.splice(0, this.#logs.length - 200);
    this.#status = { ...this.#status, logs: [...this.#logs] };
    this.#onStatus?.(this.status());
  }
  private update(patch: Partial<WorkerStatus>, clearMessage = false): WorkerStatus {
    this.#status = { ...this.#status, ...patch, logs: [...this.#logs] };
    if (clearMessage) {
      const statusWithoutMessage = { ...this.#status };
      delete statusWithoutMessage.message;
      this.#status = statusWithoutMessage;
    }
    this.#onStatus?.(this.status());
    return this.status();
  }
}

type TaskkillRunner = (
  command: string,
  args: readonly string[],
  options: { readonly windowsHide: boolean; readonly stdio: 'ignore'; readonly shell: false },
) => ChildProcess;

/** Terminate the Worker and all descendants on Windows; ChildProcess.kill is not tree-wide. */
export function terminateWorkerProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  taskkill: TaskkillRunner = spawn,
): Promise<void> {
  if (platform !== 'win32' || child.pid === undefined || child.pid === null) {
    try {
      child.kill();
    } catch {
      // The process may have exited between inspection and termination.
    }
    return Promise.resolve();
  }
  return new Promise<void>((resolvePromise) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolvePromise();
    };
    try {
      const killer = taskkill('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        shell: false,
      });
      killer.once('error', finish);
      killer.once('exit', finish);
      setTimeout(finish, 2_000);
    } catch {
      finish();
    }
  });
}

export function verifyWorkerIntegrity(workerEntry: string, manifestPath: string): void {
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    algorithm?: unknown;
    file?: unknown;
    sha256?: unknown;
  };
  if (raw.algorithm !== 'sha256' || raw.file !== 'worker.js' || typeof raw.sha256 !== 'string')
    throw new Error('Worker integrity manifest is invalid');
  if (workerEntry.toLowerCase().endsWith('worker.js') === false)
    throw new Error('Worker integrity manifest does not describe the Worker entrypoint');
  const digest = createHash('sha256').update(readFileSync(workerEntry)).digest('hex');
  if (digest.toLowerCase() !== raw.sha256.toLowerCase())
    throw new Error('Worker integrity verification failed; refusing to start an untrusted Worker');
}

function defaultWorkerEntry(packaged: boolean): string {
  const packagedPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (packaged && typeof packagedPath === 'string' && packagedPath.length > 0)
    return join(packagedPath, 'worker-runtime', 'worker.js');
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../worker/dist/index.js');
}

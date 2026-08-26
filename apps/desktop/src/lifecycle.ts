import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
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
}

export class WorkerController {
  readonly #options: WorkerControllerOptions;
  readonly #logs: string[] = [];
  #child: ChildProcess | undefined;
  #status: WorkerStatus;
  #onStatus: ((status: WorkerStatus) => void) | undefined;

  constructor(options: WorkerControllerOptions) {
    this.#options = options;
    const mediaTools = discoverMediaTools(options.config, options.platform);
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
    const tools = discoverMediaTools(this.#options.config, this.#options.platform);
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
    this.update({ state: 'starting', mediaTools: tools });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      JOY_MEDIA_API_URL: this.#options.config.apiUrl,
    };
    env.JOY_MEDIA_WORKER_STATE_PATH =
      this.#options.config.workerStatePath ?? join(this.#options.userDataPath, 'worker-state.json');
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
    this.#child = spawn(electronPath, [workerEntry], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#child.stdout?.on('data', (data: Buffer) => this.consumeOutput(data.toString('utf8')));
    this.#child.stderr?.on('data', (data: Buffer) => this.appendLog(data.toString('utf8')));
    this.#child.once('error', (error) => {
      this.#child = undefined;
      this.update({ state: 'failed', mediaTools: tools, message: redactLogLine(error.message) });
    });
    this.#child.once('exit', (code) => {
      this.#child = undefined;
      if (this.#status.state !== 'stopping')
        this.update({
          state: code === 0 ? 'stopped' : 'failed',
          mediaTools: tools,
          exitCode: code,
        });
      else this.update({ state: 'stopped', mediaTools: tools, exitCode: code });
    });
    return this.status();
  }

  async stop(): Promise<WorkerStatus> {
    const child = this.#child;
    if (child === undefined) return this.status();
    this.update({ state: 'stopping', mediaTools: this.#status.mediaTools });
    child.kill();
    await new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()));
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
  private update(patch: Partial<WorkerStatus>): WorkerStatus {
    this.#status = { ...this.#status, ...patch, logs: [...this.#logs] };
    this.#onStatus?.(this.status());
    return this.status();
  }
}

function defaultWorkerEntry(packaged: boolean): string {
  const packagedPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (packaged && typeof packagedPath === 'string' && packagedPath.length > 0)
    return join(packagedPath, 'worker-runtime', 'worker.js');
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../worker/dist/index.js');
}

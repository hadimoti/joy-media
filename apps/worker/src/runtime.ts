import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  renameSync,
  writeFileSync,
  mkdtempSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { WorkerCapability, WorkerHello } from '@joy-media/job-protocol';
import { WORKER_PROTOCOL_VERSION } from '@joy-media/job-protocol';
import {
  readGpuDerivative,
  runAudioMlDenoiseJob,
  runImageComfyJob,
  type LocalGpuReceipt,
} from './local-gpu.js';
import {
  loadAiProviderConfigs,
  runAiJob,
  getConfiguredProviders,
  type LocalAiReceipt,
  type AiProvider,
} from './local-ai.js';

export interface DeviceIdentity {
  readonly workerId: string;
  readonly createdAt: string;
}
export interface IdentityStore {
  load(): DeviceIdentity | undefined;
  save(identity: DeviceIdentity): void;
}
export interface PersistentWorkerStore extends IdentityStore {
  loadWorkerSession(): string | undefined;
  saveWorkerSession(sessionToken: string): void;
  clearWorkerSession(): void;
  loadPendingPairing(): { readonly code: string; readonly expiresAt: number } | undefined;
  savePendingPairing(code: string, expiresAt: number): void;
  clearPendingPairing(): void;
}

export class JsonFileWorkerStore implements PersistentWorkerStore {
  constructor(private readonly path = join(homedir(), '.joy-media', 'worker-state.json')) {}

  load(): DeviceIdentity | undefined {
    return this.read().identity;
  }
  save(identity: DeviceIdentity): void {
    this.write({ ...this.read(), identity });
  }
  loadWorkerSession(): string | undefined {
    return this.read().sessionToken;
  }
  saveWorkerSession(sessionToken: string): void {
    this.write({ ...this.read(), sessionToken });
  }
  clearWorkerSession(): void {
    const { identity } = this.read();
    this.write(identity === undefined ? {} : { identity });
  }
  loadPendingPairing(): { readonly code: string; readonly expiresAt: number } | undefined {
    const pending = this.read().pendingPairing;
    return pending === undefined || pending.expiresAt <= Date.now() ? undefined : pending;
  }
  savePendingPairing(code: string, expiresAt: number): void {
    this.write({ ...this.read(), pendingPairing: { code, expiresAt } });
  }
  clearPendingPairing(): void {
    const { identity, sessionToken } = this.read();
    this.write({
      ...(identity === undefined ? {} : { identity }),
      ...(sessionToken === undefined ? {} : { sessionToken }),
    });
  }

  private read(): {
    readonly identity?: DeviceIdentity;
    readonly sessionToken?: string;
    readonly pendingPairing?: { readonly code: string; readonly expiresAt: number };
  } {
    if (!existsSync(this.path)) return {};
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
      const raw = value as Record<string, unknown>;
      const identity = raw.identity;
      return {
        ...(isDeviceIdentity(identity) ? { identity } : {}),
        ...(typeof raw.sessionToken === 'string' ? { sessionToken: raw.sessionToken } : {}),
        ...(isPendingPairing(raw.pendingPairing) ? { pendingPairing: raw.pendingPairing } : {}),
      };
    } catch {
      return {};
    }
  }

  private write(state: {
    readonly identity?: DeviceIdentity;
    readonly sessionToken?: string;
    readonly pendingPairing?: { readonly code: string; readonly expiresAt: number };
  }): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp-${randomUUID()}`;
    writeFileSync(temporaryPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, this.path);
  }
}
export function getDeviceIdentity(store: IdentityStore, now = new Date()): DeviceIdentity {
  const existing = store.load();
  if (existing !== undefined) return existing;
  const identity = { workerId: `worker-${randomUUID()}`, createdAt: now.toISOString() };
  store.save(identity);
  return identity;
}
export class BoundedLog {
  readonly #lines: string[] = [];
  constructor(private readonly limit = 200) {}
  write(line: string): void {
    this.#lines.push(line);
    if (this.#lines.length > this.limit) this.#lines.splice(0, this.#lines.length - this.limit);
  }
  lines(): readonly string[] {
    return [...this.#lines];
  }
}
export interface ToolAvailability {
  readonly ffmpeg: boolean;
  readonly ffprobe: boolean;
  /** Local ComfyUI (or JOY_MEDIA_LOCAL_COMFY_URL) on the Worker PC — ADR-0018. */
  readonly comfy: boolean;
  /** Local ML denoise tool/env on the Worker PC — ADR-0018. */
  readonly mlDenoise: boolean;
  /** AI providers configured via ~/.joy-media/ai-providers.json — never on the VPS. */
  readonly aiProviders: readonly AiProvider[];
}

/** Private mapping held only by the Worker; it is never serialized to the API. */
export interface LocalAssetSourceRegistry {
  assetIds(): readonly string[];
  resolve(assetId: string): string | undefined;
}

export class StaticLocalAssetSourceRegistry implements LocalAssetSourceRegistry {
  readonly #paths = new Map<string, string>();

  constructor(entries: Readonly<Record<string, string>>) {
    for (const [assetId, sourcePath] of Object.entries(entries))
      this.#paths.set(assetId, sourcePath);
  }
  assetIds(): readonly string[] {
    return [...this.#paths.keys()].sort();
  }
  resolve(assetId: string): string | undefined {
    return this.#paths.get(assetId);
  }
}

/**
 * Parses the Worker-only `JOY_MEDIA_LOCAL_ASSETS_JSON` map. Paths stay in this
 * process: hello advertises only the opaque IDs and the API never receives a
 * value from this map. Invalid or missing local files fail closed instead of
 * advertising an asset the Worker cannot actually process.
 */
export function localAssetSourcesFromEnvironment(
  value: string | undefined,
  exists: (path: string) => boolean = existsSync,
): LocalAssetSourceRegistry | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('JOY_MEDIA_LOCAL_ASSETS_JSON must be a JSON object');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('JOY_MEDIA_LOCAL_ASSETS_JSON must be a JSON object');
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 1_000)
    throw new Error('JOY_MEDIA_LOCAL_ASSETS_JSON must contain 1–1000 assets');
  const sources: Record<string, string> = {};
  for (const [assetId, sourcePath] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(assetId))
      throw new Error('JOY_MEDIA_LOCAL_ASSETS_JSON has an invalid asset ID');
    if (typeof sourcePath !== 'string' || sourcePath.length === 0 || !exists(sourcePath))
      throw new Error(`Worker source is unavailable for asset ${assetId}`);
    sources[assetId] = sourcePath;
  }
  return new StaticLocalAssetSourceRegistry(sources);
}
export function detectMediaTools(run: (tool: string) => boolean = canRun): ToolAvailability {
  const comfyUrl = (process.env.JOY_MEDIA_LOCAL_COMFY_URL ?? '').trim();
  return {
    ffmpeg: run('ffmpeg'),
    ffprobe: run('ffprobe'),
    // Opt-in: owner PC has ComfyUI listening locally (never the VPS).
    comfy: comfyUrl.length > 0,
    // Opt-in: owner PC has ML denoise tooling installed.
    mlDenoise: (process.env.JOY_MEDIA_LOCAL_ML_DENOISE ?? '').trim() === '1',
    // AI providers configured via ~/.joy-media/ai-providers.json
    aiProviders: getConfiguredProviders(),
  };
}
function canRun(tool: string): boolean {
  const result = spawnSync(tool, ['-version'], { shell: false, stdio: 'ignore' });
  return result.status === 0;
}

function isDeviceIdentity(value: unknown): value is DeviceIdentity {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).workerId === 'string' &&
    typeof (value as Record<string, unknown>).createdAt === 'string'
  );
}
function isPendingPairing(
  value: unknown,
): value is { readonly code: string; readonly expiresAt: number } {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).code === 'string' &&
    typeof (value as Record<string, unknown>).expiresAt === 'number' &&
    Number.isSafeInteger((value as Record<string, unknown>).expiresAt)
  );
}
export class WorkerRuntime {
  readonly log = new BoundedLog();
  constructor(
    readonly identity: DeviceIdentity,
    readonly tools: ToolAvailability,
    private readonly options: {
      readonly sources?: LocalAssetSourceRegistry;
      readonly derivativeDirectory?: string;
    } = {},
  ) {}
  hello(platform: string, architecture: string): WorkerHello {
    const capabilities: WorkerCapability[] = [];
    if (this.tools.ffmpeg && this.tools.ffprobe) capabilities.push('asset.thumbnail');
    if (this.tools.comfy) capabilities.push('image.comfy');
    if (this.tools.mlDenoise) capabilities.push('audio.ml-denoise');
    if (this.tools.aiProviders.includes('lm-studio')) capabilities.push('text.lm-studio');
    if (this.tools.aiProviders.includes('openrouter')) capabilities.push('text.openrouter');
    if (this.tools.aiProviders.includes('runway')) capabilities.push('video.runway');
    if (this.tools.aiProviders.includes('higgsfield')) capabilities.push('edit.higgsfield');
    return {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      workerId: this.identity.workerId,
      workerVersion: '0.1.0',
      platform,
      architecture,
      capabilities,
      localAssetIds: this.localAssetIds(),
      maxConcurrentJobs: 1,
    };
  }
  async run(
    job: {
      readonly id: string;
      readonly type: string;
      readonly assetId?: string;
      readonly payload?: {
        readonly prompt?: string;
        readonly model?: string;
        readonly negativePrompt?: string;
        readonly imageAssetId?: string;
        readonly params?: Record<string, unknown>;
      };
    },
    options: {
      readonly cancelled: () => boolean;
      readonly progress: (progress: number) => Promise<void>;
    },
  ): Promise<
    | {
        readonly state: 'completed';
        readonly result: WorkerDerivativeReceipt;
      }
    | { readonly state: 'canceled' }
  > {
    if (job.type === 'image.comfy') {
      if (!this.tools.comfy) throw new Error('ComfyUI is not enabled on this Worker');
      if (options.cancelled()) return { state: 'canceled' };
      const derivativeDirectory =
        this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
      this.log.write(`job ${job.id} started (image.comfy)`);
      try {
        const sourcePath =
          job.assetId === undefined ? undefined : this.options.sources?.resolve(job.assetId);
        const result = await runImageComfyJob({
          jobId: job.id,
          ...(job.assetId === undefined ? {} : { assetId: job.assetId }),
          ...(sourcePath === undefined ? {} : { sourcePath }),
          derivativeDirectory,
          cancelled: options.cancelled,
          progress: options.progress,
        });
        this.log.write(`job ${job.id} completed`);
        return { state: 'completed', result };
      } catch (error) {
        if (error instanceof Error && error.message === 'canceled') {
          this.log.write(`job ${job.id} canceled`);
          return { state: 'canceled' };
        }
        throw error;
      }
    }
    if (job.type === 'audio.ml-denoise') {
      if (!this.tools.mlDenoise) throw new Error('ML denoise is not enabled on this Worker');
      if (options.cancelled()) return { state: 'canceled' };
      const derivativeDirectory =
        this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
      this.log.write(`job ${job.id} started (audio.ml-denoise)`);
      try {
        const sourcePath =
          job.assetId === undefined ? undefined : this.options.sources?.resolve(job.assetId);
        const result = await runAudioMlDenoiseJob({
          jobId: job.id,
          ...(job.assetId === undefined ? {} : { assetId: job.assetId }),
          ...(sourcePath === undefined ? {} : { sourcePath }),
          derivativeDirectory,
          cancelled: options.cancelled,
          progress: options.progress,
        });
        this.log.write(`job ${job.id} completed`);
        return { state: 'completed', result };
      } catch (error) {
        if (error instanceof Error && error.message === 'canceled') {
          this.log.write(`job ${job.id} canceled`);
          return { state: 'canceled' };
        }
        throw error;
      }
    }
    // AI provider jobs (LM Studio, OpenRouter, Runway, Higgsfield)
    if (
      job.type.startsWith('text.') ||
      job.type.startsWith('video.') ||
      job.type.startsWith('edit.')
    ) {
      const provider = job.type.replace(/^(text\.|video\.|edit\.)/, '') as AiProvider;
      const derivativeDirectory =
        this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
      this.log.write(`job ${job.id} started (${job.type})`);
      try {
        const result = await runAiJob({
          jobId: job.id,
          provider,
          model: job.payload?.model ?? '',
          prompt: job.payload?.prompt ?? '',
          derivativeDirectory,
          cancelled: options.cancelled,
          progress: options.progress,
        });
        this.log.write(`job ${job.id} completed`);
        return { state: 'completed', result };
      } catch (error) {
        if (error instanceof Error && error.message === 'canceled') {
          this.log.write(`job ${job.id} canceled`);
          return { state: 'canceled' };
        }
        throw error;
      }
    }
    if (job.type !== 'asset.thumbnail' || job.assetId === undefined)
      throw new Error(`unsupported Worker job ${job.type}`);
    if (!this.tools.ffmpeg || !this.tools.ffprobe)
      throw new Error('FFmpeg and FFprobe are required');
    if (options.cancelled()) return { state: 'canceled' };
    const sourcePath = this.options.sources?.resolve(job.assetId);
    if (sourcePath === undefined)
      throw new Error(`asset ${job.assetId} is not available on this Worker`);
    const tempDir = mkdtempSync(join(tmpdir(), `joy-media-${job.id}-`));
    const temporaryOutput = join(tempDir, 'thumbnail.jpg');
    this.log.write(`job ${job.id} started`);
    try {
      if (options.cancelled()) return { state: 'canceled' };
      await options.progress(5);
      await options.progress(25);
      const transcoded = await runBounded(
        'ffmpeg',
        [
          '-y',
          '-nostdin',
          '-v',
          'error',
          '-ss',
          '0',
          '-i',
          sourcePath,
          '-frames:v',
          '1',
          '-vf',
          'scale=640:-2:force_original_aspect_ratio=decrease',
          '-q:v',
          '3',
          temporaryOutput,
        ],
        options.cancelled,
      );
      if (!transcoded || options.cancelled()) {
        this.log.write(`job ${job.id} canceled`);
        return { state: 'canceled' };
      }
      await options.progress(75);
      const descriptor = probeThumbnail(temporaryOutput);
      await options.progress(90);
      const bytes = readFileSync(temporaryOutput);
      if (bytes.length < 1) throw new Error('thumbnail output is empty');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const localRef = `thumb-${job.id}-${sha256.slice(0, 16)}`;
      const derivativeDirectory =
        this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
      mkdirSync(derivativeDirectory, { recursive: true });
      const finalOutput = join(derivativeDirectory, `${localRef}.jpg`);
      rmSync(finalOutput, { force: true });
      renameSync(temporaryOutput, finalOutput);
      await options.progress(100);
      this.log.write(`job ${job.id} completed`);
      return {
        state: 'completed',
        result: {
          kind: 'asset.thumbnail',
          assetId: job.assetId,
          sha256,
          bytes: bytes.length,
          localRef,
          descriptor,
        },
      };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  localAssetIds(): readonly string[] {
    return this.options.sources?.assetIds() ?? [];
  }

  /** Reads a retained derivative only after re-checking its receipt integrity. */
  readDerivative(result: WorkerDerivativeReceipt): Uint8Array {
    if (result.kind === 'image.comfy' || result.kind === 'audio.ml-denoise') {
      const directory =
        this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
      return readGpuDerivative(directory, result);
    }
    if (result.kind === 'text' || result.kind === 'image' || result.kind === 'video') {
      if (result.localRef === undefined) throw new Error('AI derivative has no local reference');
      const ext = result.kind === 'video' ? 'mp4' : result.kind === 'text' ? 'txt' : 'png';
      const directory =
        this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
      const bytes = readFileSync(join(directory, `${result.localRef}.${ext}`));
      if (result.sha256 !== undefined && result.bytes !== undefined) {
        if (
          bytes.length !== result.bytes ||
          createHash('sha256').update(bytes).digest('hex') !== result.sha256
        )
          throw new Error('retained AI derivative integrity check failed');
      }
      return bytes;
    }
    if (!/^thumb-[A-Za-z0-9._-]{1,110}$/.test(result.localRef!))
      throw new Error('derivative local reference is invalid');
    const directory =
      this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
    const bytes = readFileSync(join(directory, `${result.localRef!}.jpg`));
    if (
      bytes.length !== result.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== result.sha256
    )
      throw new Error('retained derivative integrity check failed');
    return bytes;
  }
}

export type WorkerDerivativeReceipt = RealThumbnailReceipt | LocalGpuReceipt | LocalAiReceipt;

export interface RealThumbnailReceipt {
  readonly kind: 'asset.thumbnail';
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly localRef: string;
  readonly descriptor: {
    readonly mimeType: 'image/jpeg';
    readonly width: number;
    readonly height: number;
  };
}

async function runBounded(
  command: string,
  args: readonly string[],
  cancelled: () => boolean,
): Promise<boolean> {
  const child = spawn(command, args, { shell: false, stdio: 'ignore' });
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  while (child.exitCode === null) {
    if (cancelled()) {
      child.kill();
      await completed.catch(() => undefined);
      return false;
    }
    await sleep(20);
  }
  return (await completed) === 0;
}

function probeThumbnail(path: string): RealThumbnailReceipt['descriptor'] {
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height',
      '-of',
      'json',
      path,
    ],
    { shell: false, encoding: 'utf8' },
  );
  if (probe.status !== 0) throw new Error('FFprobe could not inspect thumbnail output');
  const value: unknown = JSON.parse(probe.stdout);
  const stream =
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { streams?: unknown }).streams)
      ? (value as { streams: readonly unknown[] }).streams[0]
      : undefined;
  if (stream === null || typeof stream !== 'object' || Array.isArray(stream))
    throw new Error('FFprobe thumbnail stream is missing');
  const fields = stream as Record<string, unknown>;
  if (
    fields.codec_name !== 'mjpeg' ||
    !Number.isSafeInteger(fields.width) ||
    !Number.isSafeInteger(fields.height) ||
    (fields.width as number) < 1 ||
    (fields.height as number) < 1
  ) {
    throw new Error('FFprobe thumbnail descriptor is invalid');
  }
  return { mimeType: 'image/jpeg', width: fields.width as number, height: fields.height as number };
}

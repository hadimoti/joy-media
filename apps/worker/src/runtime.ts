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
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { WorkerCapability, WorkerHello, WorkerModelInventory } from '@joy-media/job-protocol';
import { WORKER_PROTOCOL_VERSION } from '@joy-media/job-protocol';
import {
  readGpuDerivative,
  runAudioMlDenoiseJob,
  runImageComfyJob,
  type LocalGpuReceipt,
} from './local-gpu.js';
import {
  runAiJob,
  getConfiguredProviders,
  type LocalAiReceipt,
  type AiProvider,
} from './local-ai.js';
import {
  maskingAvailabilityFromEnvironment,
  readMaskDerivative,
  runMaskingJob,
  type MaskingAvailability,
  type MaskWorkerDerivative,
} from './local-masking.js';
import {
  readUpscaleDerivative,
  runUpscaleJob,
  upscalingAvailabilityFromEnvironment,
  type UpscaleWorkerDerivative,
  type UpscalingAvailability,
} from './local-upscaling.js';
import { executeLeasedExport, exportJobPayload } from './export-job.js';
import { verifyExport } from '@joy-media/export-core';

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

/** Protects Worker-only secrets before they leave process memory. */
export interface WorkerSecretProtector {
  protect(value: string): string;
  unprotect(value: string): string | undefined;
}

/** A cold powershell.exe plus `Add-Type System.Security` is slow on Windows
 * Server Core containers; 5s was short enough to abort routine pairings. */
const DPAPI_HELPER_TIMEOUT_MS = 30_000;
/** Bounds the in-process plaintext cache for a long-lived unpaired Worker that
 * re-protects a pairing code every few minutes. */
const DPAPI_CACHE_LIMIT = 32;

/**
 * The protector itself could not run, so the ciphertext is still unjudged.
 *
 * This is deliberately distinct from `unprotect` returning `undefined`: that
 * answer means "this machine/user cannot decrypt these bytes" and correctly
 * fails closed into a fresh pairing, while this error means the Worker learned
 * nothing and must not present itself as unpaired.
 */
export class WorkerSecretProtectorUnavailableError extends Error {
  constructor(action: 'protect' | 'unprotect', detail: string) {
    super(`Worker secret protector could not ${action}: ${detail}`);
    this.name = 'WorkerSecretProtectorUnavailableError';
  }
}

/**
 * Uses the Windows user DPAPI through PowerShell without placing a secret in
 * command-line arguments or logs. The portable JSON store remains injectable
 * for non-Windows/test environments; the packaged Windows Worker selects this
 * protector from index.ts and fails closed if DPAPI cannot complete an action.
 */
export class WindowsDpapiSecretProtector implements WorkerSecretProtector {
  /**
   * Ciphertext to plaintext for this process only. Pairing reads and writes the
   * state file several times, and every uncached read cost another cold
   * powershell.exe. The process already holds these secrets in memory, and the
   * map is never serialized.
   */
  readonly #decrypted = new Map<string, string>();

  protect(value: string): string {
    const result = this.#run(
      '$plain=[Console]::In.ReadToEnd(); Add-Type -AssemblyName System.Security; $bytes=[Text.Encoding]::UTF8.GetBytes($plain); $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($protected))',
      value,
      'protect',
    );
    const encrypted = result.status === 0 ? result.stdout.trim() : '';
    if (encrypted.length === 0) throw new Error('Windows DPAPI protection failed');
    this.#remember(encrypted, value);
    return encrypted;
  }

  unprotect(value: string): string | undefined {
    const cached = this.#decrypted.get(value);
    if (cached !== undefined) return cached;
    const result = this.#run(
      '$encrypted=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); Add-Type -AssemblyName System.Security; $plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($plain))',
      value,
      'unprotect',
    );
    // A non-zero exit means PowerShell ran and DPAPI refused the ciphertext
    // (foreign user or migrated profile), which must fail closed into a fresh
    // pairing. A helper that never ran is reported by #run instead, because
    // treating it as "undecryptable" silently downgrades a paired Worker.
    if (result.status !== 0) return undefined;
    const encoded = result.stdout;
    if (encoded.length === 0) return undefined;
    let plain: string;
    try {
      plain = Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
    this.#remember(value, plain);
    return plain;
  }

  #run(
    command: string,
    input: string,
    action: 'protect' | 'unprotect',
  ): ReturnType<typeof spawnSync<string>> {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        command,
      ],
      { input, encoding: 'utf8', timeout: DPAPI_HELPER_TIMEOUT_MS, windowsHide: true },
    );
    if (result.error !== undefined)
      throw new WorkerSecretProtectorUnavailableError(action, result.error.message);
    // spawnSync reports a timeout or an external kill as a signal with no exit
    // status; neither says anything about the secret it was handed.
    if (result.status === null)
      throw new WorkerSecretProtectorUnavailableError(
        action,
        `powershell.exe exited on ${result.signal ?? 'an unknown signal'} after ${DPAPI_HELPER_TIMEOUT_MS}ms`,
      );
    return result;
  }

  #remember(ciphertext: string, plain: string): void {
    if (this.#decrypted.size >= DPAPI_CACHE_LIMIT) {
      const oldest = this.#decrypted.keys().next();
      if (!oldest.done) this.#decrypted.delete(oldest.value);
    }
    this.#decrypted.set(ciphertext, plain);
  }
}

export class JsonFileWorkerStore implements PersistentWorkerStore {
  constructor(
    private readonly path = join(homedir(), '.joy-media', 'worker-state.json'),
    private readonly options: { readonly secretProtector?: WorkerSecretProtector } = {},
  ) {}

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

  /** Rewrite pre-DPAPI state once during Windows Worker startup. */
  migrateLegacySecrets(): void {
    if (this.options.secretProtector === undefined || !existsSync(this.path)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      // A malformed/locked state is handled by the ordinary fail-closed reads.
      return;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
    const record = raw as Record<string, unknown>;
    const hasLegacySession = typeof record.sessionToken === 'string';
    const hasLegacyPairing = isPendingPairing(record.pendingPairing);
    // Deliberately let protection errors surface: retaining plaintext would be
    // worse than refusing to start the packaged Worker.
    if (hasLegacySession || hasLegacyPairing) {
      const legacyState = this.read(true);
      if (
        (hasLegacySession && typeof legacyState.sessionToken !== 'string') ||
        (hasLegacyPairing && legacyState.pendingPairing === undefined)
      )
        throw new Error('Unable to protect legacy Worker state');
      this.write(legacyState);
    }
  }

  private read(allowLegacyPlaintext = false): {
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
      const protectedSessionToken =
        typeof raw.protectedSessionToken === 'string'
          ? this.options.secretProtector?.unprotect(raw.protectedSessionToken)
          : undefined;
      const protectedPairing = raw.protectedPendingPairing;
      const protectedPairingCode =
        protectedPairing !== null &&
        typeof protectedPairing === 'object' &&
        !Array.isArray(protectedPairing) &&
        typeof (protectedPairing as Record<string, unknown>).ciphertext === 'string'
          ? this.options.secretProtector?.unprotect(
              (protectedPairing as Record<string, unknown>).ciphertext as string,
            )
          : undefined;
      const protectedPairingExpiresAt =
        protectedPairing !== null &&
        typeof protectedPairing === 'object' &&
        !Array.isArray(protectedPairing) &&
        typeof (protectedPairing as Record<string, unknown>).expiresAt === 'number'
          ? ((protectedPairing as Record<string, unknown>).expiresAt as number)
          : undefined;
      return {
        ...(isDeviceIdentity(identity) ? { identity } : {}),
        ...(protectedSessionToken !== undefined
          ? { sessionToken: protectedSessionToken }
          : (this.options.secretProtector === undefined || allowLegacyPlaintext) &&
              typeof raw.sessionToken === 'string'
            ? { sessionToken: raw.sessionToken }
            : {}),
        ...(protectedPairingCode !== undefined &&
        protectedPairingExpiresAt !== undefined &&
        Number.isSafeInteger(protectedPairingExpiresAt)
          ? {
              pendingPairing: {
                code: protectedPairingCode,
                expiresAt: protectedPairingExpiresAt,
              },
            }
          : (this.options.secretProtector === undefined || allowLegacyPlaintext) &&
              isPendingPairing(raw.pendingPairing)
            ? { pendingPairing: raw.pendingPairing }
            : {}),
      };
    } catch (error) {
      // Missing, locked, or malformed state legitimately reads as "no state".
      // A protector that could not run does not: swallowing it here is what
      // makes a paired Worker look like it never paired at all.
      if (error instanceof WorkerSecretProtectorUnavailableError) throw error;
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
    const persisted: Record<string, unknown> = {
      ...(state.identity === undefined ? {} : { identity: state.identity }),
    };
    if (state.sessionToken !== undefined) {
      if (this.options.secretProtector === undefined) persisted.sessionToken = state.sessionToken;
      else
        persisted.protectedSessionToken = this.options.secretProtector.protect(state.sessionToken);
    }
    if (state.pendingPairing !== undefined) {
      if (this.options.secretProtector === undefined)
        persisted.pendingPairing = state.pendingPairing;
      else
        persisted.protectedPendingPairing = {
          ciphertext: this.options.secretProtector.protect(state.pendingPairing.code),
          expiresAt: state.pendingPairing.expiresAt,
        };
    }
    writeFileSync(temporaryPath, JSON.stringify(persisted), { encoding: 'utf8', mode: 0o600 });
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
  /** Explicit local model runners; omitted means masking is unavailable. */
  readonly masking?: MaskingAvailability;
  /** Explicit image/video upscaling runners; omitted means enhancement is unavailable. */
  readonly upscaling?: UpscalingAvailability;
}

/** A queued provider job cannot run until the API can durably verify its result. */
export class UnsupportedWorkerJobError extends Error {
  readonly code = 'JOB_TYPE_UNSUPPORTED';

  constructor(readonly jobType: string) {
    super(`${jobType} is unavailable until its durable Worker result contract is implemented`);
    this.name = 'UnsupportedWorkerJobError';
  }
}

const UNSUPPORTED_PROVIDER_JOB_TYPES = new Set([
  'text.openrouter',
  'video.runway',
  'edit.higgsfield',
]);

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
    masking: maskingAvailabilityFromEnvironment(),
    upscaling: upscalingAvailabilityFromEnvironment(),
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
      readonly gpuPreviewAvailable?: boolean;
      readonly downloadJobAsset?: (jobId: string, leaseToken?: string) => Promise<Uint8Array>;
    } = {},
  ) {}
  hello(platform: string, architecture: string): WorkerHello {
    const capabilities: WorkerCapability[] = [];
    const inventory = modelInventory(this.tools.upscaling, this.tools.masking);
    if (this.tools.ffmpeg && this.tools.ffprobe) capabilities.push('asset.thumbnail');
    if (this.tools.ffmpeg && this.tools.ffprobe && this.options.downloadJobAsset !== undefined)
      capabilities.push('render.export');
    if (this.options.gpuPreviewAvailable === true) capabilities.push('render.preview.gpu');
    if (this.tools.comfy) capabilities.push('image.comfy');
    if (this.tools.ffprobe && this.tools.upscaling?.image?.modelReady === true)
      capabilities.push('upscale.image');
    if (this.tools.ffprobe && this.tools.upscaling?.image !== undefined)
      capabilities.push('model.manage');
    if (this.tools.ffprobe && this.tools.masking?.image !== undefined)
      capabilities.push('mask.image');
    if (this.tools.ffprobe && this.tools.masking?.video !== undefined)
      capabilities.push('mask.video');
    if (this.tools.mlDenoise && mlDenoiseRunnable()) capabilities.push('audio.ml-denoise');
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
      ...(inventory === undefined ? {} : { modelInventory: inventory }),
    };
  }
  async run(
    job: {
      readonly id: string;
      readonly type: string;
      readonly assetId?: string;
      readonly leaseToken?: string;
      readonly payload?: {
        readonly prompt?: string;
        readonly model?: string;
        readonly negativePrompt?: string;
        readonly imageAssetId?: string;
        readonly fixture?: boolean;
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
    if (UNSUPPORTED_PROVIDER_JOB_TYPES.has(job.type)) throw new UnsupportedWorkerJobError(job.type);
    if (job.type === 'fixture.thumbnail') return this.runFixtureThumbnail(job.id, options);
    if (job.type === 'render.export') {
      if (!this.tools.ffmpeg || !this.tools.ffprobe)
        throw new Error('FFmpeg and FFprobe are required for render.export');
      if (job.assetId === undefined) throw new Error('render.export requires a staged input asset');
      if (this.options.downloadJobAsset === undefined)
        throw new Error('render.export requires a staged source downloader');
      if (options.cancelled()) return { state: 'canceled' };
      const payload = exportJobPayload(job.payload);
      const derivativeDirectory =
        this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
      const tempDir = mkdtempSync(join(tmpdir(), `joy-media-export-${job.id}-`));
      const sourcePath = join(tempDir, 'source.mp4');
      const outputPath = join(tempDir, 'export.mp4');
      this.log.write(`job ${job.id} started (render.export)`);
      try {
        await options.progress(5);
        const sourceBytes = await this.options.downloadJobAsset(job.id, job.leaseToken);
        writeFileSync(sourcePath, Buffer.from(sourceBytes), { mode: 0o600 });
        await options.progress(40);
        executeLeasedExport(
          { complete: () => undefined },
          this.identity.workerId,
          job.id,
          { sourcePath, payload },
          outputPath,
          job.leaseToken,
        );
        await options.progress(80);
        const bytes = readFileSync(outputPath);
        if (bytes.length < 1) throw new Error('render.export output is empty');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const localRef = `export-${job.id}-${sha256.slice(0, 16)}`;
        mkdirSync(derivativeDirectory, { recursive: true });
        const finalOutput = join(derivativeDirectory, `${localRef}.mp4`);
        rmSync(finalOutput, { force: true });
        renameSync(outputPath, finalOutput);
        await options.progress(90);
        const verified = verifyExport(finalOutput);
        await options.progress(100);
        this.log.write(`job ${job.id} completed`);
        return {
          state: 'completed',
          result: {
            kind: 'render.export',
            assetId: job.assetId,
            sha256,
            bytes: bytes.length,
            localRef,
            descriptor: {
              mimeType: 'video/mp4',
              width: verified.width,
              height: verified.height,
              durationUs: verified.durationUs,
            },
          },
        };
      } catch (error) {
        if (error instanceof Error && error.message === 'canceled') {
          this.log.write(`job ${job.id} canceled`);
          return { state: 'canceled' };
        }
        throw error;
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
    if (job.type === 'upscale.image' || job.type === 'upscale.video') {
      if (!this.tools.ffprobe) throw new Error('FFprobe is required for upscaling outputs');
      if (job.assetId === undefined) throw new Error(job.type + ' requires an input asset');
      const sourcePath = this.options.sources?.resolve(job.assetId);
      if (sourcePath === undefined)
        throw new Error('local source unavailable for asset ' + job.assetId);
      const derivativeDirectory =
        this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
      this.log.write('job ' + job.id + ' started (' + job.type + ')');
      try {
        const result = await runUpscaleJob({
          jobId: job.id,
          type: job.type,
          assetId: job.assetId,
          sourcePath,
          payload: job.payload,
          availability: this.tools.upscaling ?? {},
          derivativeDirectory,
          cancelled: options.cancelled,
          progress: options.progress,
        });
        this.log.write('job ' + job.id + ' completed');
        return { state: 'completed', result };
      } catch (error) {
        if (error instanceof Error && error.message === 'canceled') {
          this.log.write('job ' + job.id + ' canceled');
          return { state: 'canceled' };
        }
        throw error;
      }
    }
    if (job.type === 'mask.image' || job.type === 'mask.video') {
      if (!this.tools.ffprobe) throw new Error('FFprobe is required for masking outputs');
      const runner =
        job.type === 'mask.image' ? this.tools.masking?.image : this.tools.masking?.video;
      if (runner === undefined) throw new Error(`${job.type} is not enabled on this Worker`);
      if (job.assetId === undefined) throw new Error(`${job.type} requires an input asset`);
      const sourcePath = this.options.sources?.resolve(job.assetId);
      if (sourcePath === undefined)
        throw new Error(`local source unavailable for asset ${job.assetId}`);
      const derivativeDirectory =
        this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
      this.log.write(`job ${job.id} started (${job.type})`);
      try {
        const result = await runMaskingJob({
          jobId: job.id,
          type: job.type,
          assetId: job.assetId,
          sourcePath,
          payload: job.payload,
          runner,
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
        if (job.assetId !== undefined && sourcePath === undefined)
          throw new Error(`local source unavailable for asset ${job.assetId}`);
        if (job.assetId === undefined && job.payload?.fixture !== true)
          throw new Error('audio.ml-denoise requires a selected local asset');
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

  private async runFixtureThumbnail(
    jobId: string,
    options: {
      readonly cancelled: () => boolean;
      readonly progress: (progress: number) => Promise<void>;
    },
  ): Promise<
    | { readonly state: 'completed'; readonly result: FixtureThumbnailReceipt }
    | { readonly state: 'canceled' }
  > {
    if (options.cancelled()) return { state: 'canceled' };
    const bytes = Buffer.from('P6\n1 1\n255\n\x20\x80\xe0', 'binary');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const tempDir = mkdtempSync(join(tmpdir(), `joy-media-fixture-${jobId}-`));
    try {
      const output = join(tempDir, 'thumbnail.ppm');
      writeFileSync(output, bytes, { mode: 0o600 });
      await options.progress(5);
      if (options.cancelled()) return { state: 'canceled' };
      await options.progress(50);
      await options.progress(90);
      if (options.cancelled()) return { state: 'canceled' };
      await options.progress(100);
      this.log.write(`job ${jobId} completed (fixture.thumbnail)`);
      return {
        state: 'completed',
        result: { kind: 'fixture.thumbnail', sha256, bytes: bytes.length },
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
    if (result.kind === 'mask.image' || result.kind === 'mask.video') {
      const directory =
        this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
      return readMaskDerivative(directory, result);
    }
    if (result.kind === 'upscale.image' || result.kind === 'upscale.video') {
      const directory =
        this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
      return readUpscaleDerivative(directory, result);
    }
    if (result.kind === 'image.comfy' || result.kind === 'audio.ml-denoise') {
      const directory =
        this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
      return readGpuDerivative(directory, result);
    }
    if (result.kind === 'render.export') {
      const directory =
        this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
      const bytes = readFileSync(join(directory, `${result.localRef}.mp4`));
      if (
        bytes.length !== result.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== result.sha256
      )
        throw new Error('retained export derivative integrity check failed');
      return bytes;
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
    if (result.kind === 'fixture.thumbnail') {
      throw new Error('fixture thumbnail has no retained derivative');
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

function mlDenoiseRunnable(): boolean {
  if ((process.env.JOY_MEDIA_LOCAL_ML_DENOISE ?? '').trim() !== '1') return false;
  if ((process.env.JOY_MEDIA_ML_DENOISE_CMD ?? '').trim().length > 0) return true;
  const model =
    process.env.JOY_MEDIA_RNNOISE_MODEL?.trim() || '/opt/joy-media/data/rnnoise/cb.rnnn';
  return existsSync(model);
}

export type WorkerDerivativeReceipt =
  | RealThumbnailReceipt
  | FixtureThumbnailReceipt
  | RenderExportReceipt
  | LocalGpuReceipt
  | LocalAiReceipt
  | MaskWorkerDerivative
  | UpscaleWorkerDerivative;

function modelInventory(
  upscaling: UpscalingAvailability | undefined,
  masking: MaskingAvailability | undefined,
): WorkerModelInventory | undefined {
  if (
    upscaling?.image === undefined &&
    masking?.image === undefined &&
    masking?.video === undefined
  )
    return undefined;
  const maskingModelRoot = process.env.JOY_MEDIA_BIREFNET_MODEL_DIR?.trim() ?? '';
  const birefnetReady =
    maskingModelRoot.length > 0 &&
    existsSync(join(maskingModelRoot, 'BiRefNet-general-epoch_244.onnx')) &&
    existsSync(join(maskingModelRoot, 'BiRefNet-portrait-epoch_150.onnx'));
  const sam2Ready =
    (process.env.JOY_MEDIA_SAM2_RUNTIME_READY ?? '').trim() === '1' &&
    existsSync(process.env.JOY_MEDIA_SAM2_MODEL?.trim() ?? '') &&
    existsSync(process.env.JOY_MEDIA_GROUNDING_MODEL?.trim() ?? '');
  const models = [
    ...(upscaling?.image === undefined
      ? []
      : [
          {
            modelId: upscaling.image.modelId,
            version: upscaling.image.modelVersion,
            state: upscaling.image.modelReady ? ('ready' as const) : ('not-installed' as const),
          },
        ]),
    ...(masking?.image === undefined && masking?.video === undefined
      ? []
      : [
          {
            modelId: 'birefnet',
            version: 'local-onnx',
            state: birefnetReady ? ('ready' as const) : ('not-installed' as const),
          },
          {
            modelId: 'sam2-grounded',
            version: '2.1-local',
            state: sam2Ready ? ('ready' as const) : ('not-installed' as const),
          },
          {
            modelId: 'sam3',
            version: '3.1-external',
            state: 'not-installed' as const,
          },
        ]),
  ];
  return {
    managerVersion: '0.1.0',
    cacheStatus: 'ready',
    models,
  };
}

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

export interface FixtureThumbnailReceipt {
  readonly kind: 'fixture.thumbnail';
  readonly sha256: string;
  readonly bytes: number;
}

export interface RenderExportReceipt {
  readonly kind: 'render.export';
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly localRef: string;
  readonly descriptor: {
    readonly mimeType: 'video/mp4';
    readonly width: number;
    readonly height: number;
    readonly durationUs: number;
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

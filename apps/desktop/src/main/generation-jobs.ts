import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { isPrivateOrInternalHost } from '@joy-media/provider-sdk';
import { MINIMAX_GENERATION_SETTINGS } from './providers/generation/minimax-settings.js';
import { pinnedFetch, type PinnedFetch } from './providers/pinned-transport.js';
import type { ProviderBroker } from './providers/provider-broker.js';
import {
  GENERATION_DOWNLOAD_IDLE_TIMEOUT_MS,
  GENERATION_DOWNLOAD_TIMEOUT_MS,
  GENERATION_STATUS_ERROR_LIMIT,
  MAX_ACTIVE_GENERATED_IMAGE_JOBS,
  MAX_ACTIVE_GENERATED_VIDEO_JOBS,
  MAX_GENERATED_IMAGE_BYTES,
  MAX_GENERATED_VIDEO_BYTES,
} from './providers/generation/limits.js';
import type {
  GenerationJobKind,
  GenerationJobRecord,
  GenerationJobState,
  GenerationJobStore,
} from '../store/generation-job-store.js';
import type { ProviderProfile } from '../store/local-database.js';

const execFileAsync = promisify(execFile);
const COST_NOTE = 'Provider pricing applies; JOY Media does not estimate the charge.';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'mov',
  'mkv',
  'webm',
  'avi',
  'mpeg',
  'mpg',
  'ts',
  'flv',
  '3gp',
  'asf',
  'ogg',
]);

export interface GenerationDownload {
  readonly body: AsyncIterable<Uint8Array>;
  readonly contentLength?: number | undefined;
}

export interface ProbedGeneratedMedia {
  readonly kind: 'image' | 'video';
  readonly extension: string;
}

export interface GenerationJobsOptions {
  readonly store: GenerationJobStore;
  readonly getProfile: (profileId: string) => ProviderProfile | undefined;
  readonly broker: Pick<
    ProviderBroker,
    'generateImage' | 'startVideo' | 'videoStatus' | 'cancelVideo' | 'videoFileLink'
  >;
  readonly generatedDirectory: string;
  readonly download: (url: string, signal: AbortSignal) => Promise<GenerationDownload>;
  readonly probe: (filePath: string, signal?: AbortSignal) => Promise<ProbedGeneratedMedia>;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly maxImageBytes?: number;
  readonly maxVideoBytes?: number;
  readonly pollIntervalMs?: number;
  readonly videoTimeoutMs?: number;
}

export interface GenerationJobs {
  start(request: {
    readonly profileId: string;
    readonly kind: GenerationJobKind;
    readonly prompt: string;
  }): Promise<GenerationJobRecord>;
  status(jobId: string): GenerationJobRecord | undefined;
  cancel(jobId: string): Promise<GenerationJobRecord | undefined>;
  list(): readonly GenerationJobRecord[];
  resume(): void;
  stop(): void;
}

export interface PinnedGenerationDownloaderOptions {
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  readonly fallbackFetch?: PinnedFetch;
}

/** A video URL is temporary and points outside the provider registry, so resolve and pin its public host per request. */
export function createPinnedGenerationDownloader(
  options: PinnedGenerationDownloaderOptions = {},
): (url: string, signal: AbortSignal) => Promise<GenerationDownload> {
  const resolveHost =
    options.resolveHost ??
    (async (hostname: string): Promise<readonly string[]> =>
      (await lookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address));
  const fallbackFetch = options.fallbackFetch ?? ((url, init) => fetch(url, init));
  const pins = new Map<string, readonly string[]>();
  const fetchPinned = pinnedFetch(pins, fallbackFetch);

  return async (url, signal) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new Error('The video download address is invalid.');
    }
    const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (
      target.protocol !== 'https:' ||
      target.username !== '' ||
      target.password !== '' ||
      target.port !== '' ||
      hostname === '' ||
      isPrivateOrInternalHost(hostname)
    ) {
      throw new Error('The video download address was refused.');
    }

    let addresses: readonly string[];
    try {
      addresses = isIP(hostname) === 0 ? await resolveHost(hostname) : [hostname];
    } catch {
      throw new Error('The video download host could not be checked.');
    }
    if (
      addresses.length === 0 ||
      addresses.some((address) => address.includes('%') || isPrivateOrInternalHost(address))
    ) {
      throw new Error('The video download host did not resolve to public addresses.');
    }

    pins.set(hostname, addresses);
    let response: Response;
    try {
      response = await fetchPinned(url, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { accept: 'video/*,application/octet-stream' },
      });
    } finally {
      pins.delete(hostname);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('The video download redirected and was refused.');
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('The video download could not be read.');
    }

    const contentLengthText = response.headers.get('content-length');
    const contentLength =
      contentLengthText !== null && /^\d+$/.test(contentLengthText)
        ? Number(contentLengthText)
        : undefined;
    return {
      body: Readable.fromWeb(response.body as NodeReadableStream),
      ...(contentLength === undefined ? {} : { contentLength }),
    };
  };
}

/** Classifies a finished file from ffprobe output, never from the provider's Content-Type header or filename. */
export async function probeGeneratedMedia(
  filePath: string,
  signal?: AbortSignal,
): Promise<ProbedGeneratedMedia> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name:format=format_name',
        '-of',
        'json',
        filePath,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        ...(signal === undefined ? {} : { signal }),
      },
    ));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error('The media check tool is missing: ffprobe was not found.');
    }
    throw new Error('The generated file could not be verified by ffprobe.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('ffprobe returned an unreadable media result.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('ffprobe returned an unreadable media result.');
  }
  const result = parsed as {
    streams?: unknown;
    format?: { format_name?: unknown };
  };
  const streams = Array.isArray(result.streams) ? result.streams : [];
  const videoCodecs = streams.flatMap((stream) => {
    if (typeof stream !== 'object' || stream === null) return [];
    const typed = stream as { codec_type?: unknown; codec_name?: unknown };
    return typed.codec_type === 'video' && typeof typed.codec_name === 'string'
      ? [typed.codec_name.toLowerCase()]
      : [];
  });
  const formats =
    typeof result.format?.format_name === 'string'
      ? result.format.format_name.toLowerCase().split(',')
      : [];

  const imageCodecExtensions: Readonly<Record<string, string>> = {
    png: 'png',
    mjpeg: 'jpg',
    webp: 'webp',
  };
  const imageCodec = videoCodecs.find((codec) => imageCodecExtensions[codec] !== undefined);
  if (
    imageCodec !== undefined &&
    formats.every((format) => !['avi', 'mov', 'mp4'].includes(format))
  ) {
    return { kind: 'image', extension: imageCodecExtensions[imageCodec] ?? 'png' };
  }

  const videoFormats: Readonly<Record<string, string>> = {
    mov: 'mov',
    mp4: 'mp4',
    matroska: 'mkv',
    webm: 'webm',
    avi: 'avi',
    mpeg: 'mpeg',
    mpegts: 'ts',
    flv: 'flv',
    '3gp': '3gp',
    asf: 'asf',
    ogg: 'ogg',
  };
  const videoFormat = formats.find((format) => videoFormats[format] !== undefined);
  const hasMovingVideo = videoCodecs.some(
    (codec) => codec !== 'png' && codec !== 'mjpeg' && codec !== 'webp',
  );
  if (videoFormat !== undefined && hasMovingVideo) {
    return { kind: 'video', extension: videoFormats[videoFormat] ?? 'mp4' };
  }
  if (hasMovingVideo) return { kind: 'video', extension: 'mp4' };
  throw new Error('The generated file is not a supported picture or video.');
}

export function createGenerationJobs(options: GenerationJobsOptions): GenerationJobs {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const maxImageBytes = options.maxImageBytes ?? MAX_GENERATED_IMAGE_BYTES;
  const maxVideoBytes = options.maxVideoBytes ?? MAX_GENERATED_VIDEO_BYTES;
  const pollIntervalMs = options.pollIntervalMs ?? MINIMAX_GENERATION_SETTINGS.video.pollIntervalMs;
  const videoTimeoutMs = options.videoTimeoutMs ?? 15 * 60 * 1000;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const operations = new Map<string, AbortController>();
  const statusFailures = new Map<string, number>();

  const read = (jobId: string): GenerationJobRecord | undefined => options.store.get(jobId);
  const save = (
    job: GenerationJobRecord,
    state: GenerationJobState,
    changes: Partial<GenerationJobRecord> = {},
  ): GenerationJobRecord => {
    const updated: GenerationJobRecord = {
      ...job,
      ...changes,
      state,
      updatedAt: new Date(now()).toISOString(),
    };
    options.store.save(updated);
    return updated;
  };
  const active = (job: GenerationJobRecord | undefined): job is GenerationJobRecord =>
    job !== undefined &&
    (job.state === 'queued' || job.state === 'running' || job.state === 'downloading');
  const clearTimer = (jobId: string): void => {
    const timer = timers.get(jobId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(jobId);
  };
  const clearTimeoutTimer = (jobId: string): void => {
    const timer = timeoutTimers.get(jobId);
    if (timer !== undefined) clearTimeout(timer);
    timeoutTimers.delete(jobId);
  };
  const clearJobTimers = (jobId: string): void => {
    clearTimer(jobId);
    clearTimeoutTimer(jobId);
    statusFailures.delete(jobId);
  };
  const markTimedOut = (jobId: string): void => {
    const job = read(jobId);
    if (!active(job)) return;
    clearJobTimers(jobId);
    operations.get(jobId)?.abort(new Error('Generation timed out.'));
    save(job, 'timed-out', { error: 'The video task exceeded the 15-minute limit.' });
  };
  const scheduleTimeout = (jobId: string): void => {
    clearTimeoutTimer(jobId);
    const job = read(jobId);
    if (!active(job) || job.kind !== 'video') return;
    const elapsed = now() - Date.parse(job.createdAt);
    const remaining = videoTimeoutMs - elapsed;
    if (!Number.isFinite(remaining) || remaining <= 0) {
      markTimedOut(jobId);
      return;
    }
    timeoutTimers.set(
      jobId,
      setTimeout(() => markTimedOut(jobId), remaining),
    );
  };
  const schedulePoll = (jobId: string, delay = pollIntervalMs): void => {
    clearTimer(jobId);
    timers.set(
      jobId,
      setTimeout(() => {
        timers.delete(jobId);
        void pollVideo(jobId);
      }, delay),
    );
  };
  const markFailed = (jobId: string, error: unknown): void => {
    const job = read(jobId);
    if (!active(job)) return;
    clearJobTimers(jobId);
    save(job, 'failed', { error: safeErrorMessage(error) });
  };
  /** A failed status check keeps the job alive until the limit of checks in a row is reached. */
  const statusFailed = (jobId: string, error: unknown): void => {
    const failures = (statusFailures.get(jobId) ?? 0) + 1;
    if (failures >= GENERATION_STATUS_ERROR_LIMIT) {
      markFailed(jobId, error);
      return;
    }
    statusFailures.set(jobId, failures);
    if (active(read(jobId))) schedulePoll(jobId);
  };

  const saveMedia = async (
    job: GenerationJobRecord,
    source: AsyncIterable<Uint8Array>,
    contentLength: number | undefined,
    signal: AbortSignal,
    onData?: () => void,
  ): Promise<{ readonly filePath: string; readonly sha256: string }> => {
    const input = source instanceof Readable ? source : Readable.from(source);
    const limit = job.kind === 'image' ? maxImageBytes : maxVideoBytes;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      input.destroy();
      throw new Error('The generated file limit is invalid.');
    }
    if (
      contentLength !== undefined &&
      (!Number.isSafeInteger(contentLength) || contentLength < 0)
    ) {
      input.destroy();
      throw new Error('The generated file size is invalid.');
    }
    if (contentLength !== undefined && contentLength > limit) {
      input.destroy();
      throw new Error(`The generated file is larger than the ${limit}-byte limit.`);
    }

    await mkdir(options.generatedDirectory, { recursive: true });
    const temporaryPath = path.join(
      options.generatedDirectory,
      `.${job.id}.${randomUUID()}.partial`,
    );
    const digest = createHash('sha256');
    let bytes = 0;
    const capAndHash = new Transform({
      transform(chunk: Buffer | Uint8Array, _encoding, callback) {
        onData?.();
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.byteLength;
        if (bytes > limit) {
          callback(new Error(`The generated file is larger than the ${limit}-byte limit.`));
          return;
        }
        digest.update(data);
        callback(null, data);
      },
    });

    try {
      await pipeline(input, capAndHash, createWriteStream(temporaryPath, { flags: 'wx' }), {
        signal,
      });
      if (bytes === 0) throw new Error('The generated file was empty.');
      const probed = await options.probe(temporaryPath, signal);
      if (signal.aborted) throw new Error('The generation was cancelled.');
      const allowedExtensions = job.kind === 'image' ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS;
      const extension = probed.extension.toLowerCase().replace(/^\./, '');
      if (probed.kind !== job.kind || !allowedExtensions.has(extension)) {
        throw new Error('The generated file type did not match the requested media type.');
      }
      const filePath = path.join(options.generatedDirectory, `${job.id}.${extension}`);
      await rename(temporaryPath, filePath);
      if (signal.aborted) {
        // A cancel that lands after the rename must not leave a finished file with no completed job.
        await rm(filePath, { force: true }).catch(() => undefined);
        throw new Error('The generation was cancelled.');
      }
      return { filePath, sha256: digest.digest('hex') };
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const finishVideo = async (
    job: GenerationJobRecord,
    fileId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const profile = options.getProfile(job.profileId);
    if (profile === undefined) throw new Error('The provider profile is no longer available.');
    const link = await options.broker.videoFileLink({ profileId: profile.id, fileId });
    if (!link.ok) throw new Error(link.message);
    if (!active(read(job.id))) return;
    clearJobTimers(job.id);
    const current = read(job.id);
    if (current === undefined) return;
    save(current, 'downloading', { error: undefined });

    // The download has its own deadline: an overall limit and an idle limit that restarts on every chunk.
    const downloadAbort = new AbortController();
    let limitError: Error | undefined;
    const abortWithParent = (): void => downloadAbort.abort(signal.reason);
    if (signal.aborted) abortWithParent();
    else signal.addEventListener('abort', abortWithParent, { once: true });
    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const stopIdleTimer = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    const restartIdleTimer = (): void => {
      stopIdleTimer();
      idleTimer = setTimeout(() => {
        limitError = new Error('The video download stopped sending data for 30 seconds.');
        downloadAbort.abort(limitError);
      }, GENERATION_DOWNLOAD_IDLE_TIMEOUT_MS);
    };
    try {
      overallTimer = setTimeout(() => {
        limitError = new Error('The video download took longer than five minutes.');
        downloadAbort.abort(limitError);
      }, GENERATION_DOWNLOAD_TIMEOUT_MS);
      restartIdleTimer();
      const downloaded = await options.download(link.data.downloadUrl, downloadAbort.signal);
      if (!active(read(job.id))) return;
      const saved = await saveMedia(
        job,
        downloaded.body,
        downloaded.contentLength,
        downloadAbort.signal,
        restartIdleTimer,
      );
      const latest = read(job.id);
      if (!active(latest)) {
        await rm(saved.filePath, { force: true }).catch(() => undefined);
        return;
      }
      clearJobTimers(job.id);
      save(latest, 'completed', { ...saved, error: undefined });
    } catch (error) {
      if (limitError !== undefined && !signal.aborted) throw limitError;
      throw error;
    } finally {
      signal.removeEventListener('abort', abortWithParent);
      if (overallTimer !== undefined) clearTimeout(overallTimer);
      stopIdleTimer();
    }
  };

  const pollVideo = async (jobId: string): Promise<void> => {
    const job = read(jobId);
    if (
      !active(job) ||
      job.kind !== 'video' ||
      job.providerTaskId === undefined ||
      job.route === undefined
    ) {
      return;
    }
    const elapsed = now() - Date.parse(job.createdAt);
    if (!Number.isFinite(elapsed) || elapsed >= videoTimeoutMs) {
      markTimedOut(jobId);
      return;
    }
    const profile = options.getProfile(job.profileId);
    if (profile === undefined) {
      markFailed(jobId, new Error('The provider profile is no longer available.'));
      return;
    }

    const controller = new AbortController();
    operations.set(jobId, controller);
    try {
      let result: Awaited<ReturnType<ProviderBroker['videoStatus']>>;
      try {
        result = await options.broker.videoStatus({
          profileId: profile.id,
          taskId: job.providerTaskId,
          route: job.route,
          signal: controller.signal,
        });
      } catch (error) {
        if (!controller.signal.aborted) statusFailed(jobId, error);
        return;
      }
      if (!active(read(jobId))) return;
      if (!result.ok) {
        statusFailed(jobId, result.message);
        return;
      }
      statusFailures.delete(jobId);
      switch (result.data.status) {
        case 'queued':
          save(job, 'queued', { error: undefined });
          schedulePoll(jobId);
          return;
        case 'running':
          save(job, 'running', { error: undefined });
          schedulePoll(jobId);
          return;
        case 'failed':
          markFailed(jobId, new Error('The provider reported that video generation failed.'));
          return;
        case 'cancelled':
          clearJobTimers(jobId);
          save(job, 'cancelled');
          return;
        case 'succeeded':
          if (result.data.fileId === undefined) {
            markFailed(jobId, new Error('The provider completed the task without a file id.'));
            return;
          }
          await finishVideo(job, result.data.fileId, controller.signal);
          return;
      }
    } catch (error) {
      if (!controller.signal.aborted) markFailed(jobId, error);
    } finally {
      if (operations.get(jobId) === controller) operations.delete(jobId);
    }
  };

  const runImage = async (jobId: string): Promise<void> => {
    const job = read(jobId);
    if (!active(job) || job.kind !== 'image') return;
    const profile = options.getProfile(job.profileId);
    if (profile === undefined) {
      markFailed(jobId, new Error('The provider profile is no longer available.'));
      return;
    }
    const controller = new AbortController();
    operations.set(jobId, controller);
    try {
      save(job, 'running', { error: undefined });
      const result = await options.broker.generateImage({
        profileId: profile.id,
        prompt: job.prompt,
        signal: controller.signal,
      });
      if (!active(read(jobId))) return;
      if (!result.ok) {
        markFailed(jobId, result.message);
        return;
      }
      const image = result.data;
      const maxEncodedBytes = Math.ceil((maxImageBytes * 4) / 3) + 64 * 1024;
      if (image.base64.length > maxEncodedBytes) {
        markFailed(
          jobId,
          new Error(`The generated picture is larger than the ${maxImageBytes}-byte limit.`),
        );
        return;
      }
      const source = base64Chunks(image.base64);
      const current = read(jobId);
      if (current === undefined) return;
      save(current, 'downloading', { model: image.model, route: image.route, error: undefined });
      const saved = await saveMedia(current, source, undefined, controller.signal);
      const latest = read(jobId);
      if (!active(latest)) {
        await rm(saved.filePath, { force: true }).catch(() => undefined);
        return;
      }
      clearJobTimers(jobId);
      save(latest, 'completed', {
        ...saved,
        model: image.model,
        route: image.route,
        error: undefined,
      });
    } catch (error) {
      if (!controller.signal.aborted) markFailed(jobId, error);
    } finally {
      if (operations.get(jobId) === controller) operations.delete(jobId);
    }
  };

  return {
    async start(request) {
      if (request.kind !== 'image' && request.kind !== 'video')
        throw new Error('Unsupported generation kind.');
      if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
        throw new Error('Write a prompt first.');
      }
      const profile = options.getProfile(request.profileId);
      if (profile === undefined) throw new Error('Unknown provider profile.');
      const limit =
        request.kind === 'image'
          ? MAX_ACTIVE_GENERATED_IMAGE_JOBS
          : MAX_ACTIVE_GENERATED_VIDEO_JOBS;
      const activeOfKind = options.store
        .list()
        .filter((job) => job.kind === request.kind && active(job)).length;
      if (activeOfKind >= limit) {
        throw new Error('Wait for the running picture or video to finish first.');
      }
      let id = newId();
      for (
        let attempt = 0;
        attempt < 10 && (options.store.get(id) !== undefined || !ID_PATTERN.test(id));
        attempt += 1
      ) {
        id = newId();
      }
      if (!ID_PATTERN.test(id) || options.store.get(id) !== undefined) {
        throw new Error('Could not allocate a generation job id.');
      }
      const timestamp = new Date(now()).toISOString();
      const job: GenerationJobRecord = {
        id,
        kind: request.kind,
        provider: profile.provider,
        profileId: profile.id,
        model:
          request.kind === 'image'
            ? MINIMAX_GENERATION_SETTINGS.image.model
            : MINIMAX_GENERATION_SETTINGS.video.model,
        prompt: request.prompt,
        state: 'queued',
        costNote: COST_NOTE,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      options.store.save(job);
      if (request.kind === 'image') {
        void Promise.resolve().then(() => runImage(id));
        return job;
      }

      try {
        const started = await options.broker.startVideo({
          profileId: profile.id,
          prompt: request.prompt,
        });
        const latest = read(id);
        if (!active(latest)) {
          // Cancelled while the task was being created: stop the provider task now that its id is known.
          if (started.ok) {
            try {
              await options.broker.cancelVideo({
                profileId: profile.id,
                taskId: started.data.taskId,
                route: started.data.route,
              });
            } catch {
              // The provider could not confirm cancellation; the local job is already stopped.
            }
          }
          return latest ?? job;
        }
        if (!started.ok) {
          clearJobTimers(id);
          return save(latest, 'failed', { error: safeErrorMessage(started.message) });
        }
        const model =
          started.data.route === 'current'
            ? MINIMAX_GENERATION_SETTINGS.video.model
            : MINIMAX_GENERATION_SETTINGS.video.legacyModel;
        const queued = save(latest, 'queued', {
          providerTaskId: started.data.taskId,
          route: started.data.route,
          model,
          error: undefined,
        });
        schedulePoll(id);
        scheduleTimeout(id);
        return queued;
      } catch (error) {
        markFailed(id, error);
        return read(id) ?? job;
      }
    },
    status(jobId) {
      return read(jobId);
    },
    async cancel(jobId) {
      const job = read(jobId);
      if (job === undefined) return undefined;
      if (!active(job)) return job;
      clearTimer(jobId);

      if (job.state === 'downloading') {
        // The provider has already finished, so only the local transfer is stopped.
        operations.get(jobId)?.abort(new Error('Cancelled locally.'));
        const latest = read(jobId);
        if (!active(latest)) return latest;
        clearJobTimers(jobId);
        return save(latest, 'cancelled', { error: undefined });
      }

      if (
        job.kind === 'video' &&
        job.state === 'queued' &&
        job.providerTaskId !== undefined &&
        job.route !== undefined
      ) {
        const profile = options.getProfile(job.profileId);
        if (profile !== undefined) {
          try {
            const result = await options.broker.cancelVideo({
              profileId: profile.id,
              taskId: job.providerTaskId,
              route: job.route,
            });
            const latest = read(jobId);
            if (!active(latest)) return latest;
            if (result.ok && result.data.cancelled) {
              operations.get(jobId)?.abort(new Error('Provider task cancelled.'));
              clearJobTimers(jobId);
              return save(latest, 'cancelled');
            }
          } catch {
            // The provider could not confirm cancellation; record the local abandonment below.
          }
        }
      }

      operations.get(jobId)?.abort(new Error('Cancelled locally.'));
      const latest = read(jobId);
      if (!active(latest)) return latest;
      clearJobTimers(jobId);
      return save(latest, 'abandoned-locally', {
        error: 'The local job was abandoned. Provider work may continue.',
      });
    },
    list() {
      return options.store.list();
    },
    resume() {
      for (const job of options.store.list()) {
        if (!active(job)) continue;
        if (
          job.kind === 'video' &&
          (job.state === 'queued' || job.state === 'running') &&
          job.providerTaskId !== undefined &&
          job.route !== undefined
        ) {
          const elapsed = now() - Date.parse(job.createdAt);
          if (!Number.isFinite(elapsed) || elapsed >= videoTimeoutMs) {
            markTimedOut(job.id);
          } else {
            schedulePoll(job.id);
            scheduleTimeout(job.id);
          }
          continue;
        }
        save(job, 'abandoned-locally', {
          error: 'The app stopped before this local generation job finished.',
        });
      }
    },
    stop() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const timer of timeoutTimers.values()) clearTimeout(timer);
      timeoutTimers.clear();
      for (const controller of operations.values()) controller.abort(new Error('App is stopping.'));
      operations.clear();
    },
  };
}

async function* base64Chunks(base64: string): AsyncGenerator<Buffer> {
  const compact = base64.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new Error('The generated picture data was not valid base64.');
  }
  const chunkChars = 64 * 1024;
  for (let offset = 0; offset < compact.length; offset += chunkChars) {
    const end = Math.min(compact.length, offset + chunkChars);
    const alignedEnd = end === compact.length ? end : end - ((end - offset) % 4);
    const chunk = compact.slice(offset, alignedEnd);
    if (chunk.length > 0) yield Buffer.from(chunk, 'base64');
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/(authorization|api[-_ ]?key|secret|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500);
}

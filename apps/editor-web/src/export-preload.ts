export const EXPORT_PRELOAD_TIMEOUT_MS = 15_000;

export type ExportPreloadStage =
  | 'resolving source'
  | 'loading detached video'
  | 'seeking video'
  | 'fetching authored audio bytes'
  | 'decoding authored audio';

export interface ExportClipSourcePreflight {
  readonly clipId: string;
  readonly clipLabel?: string;
  readonly visualAssetId: string;
  readonly visualAssetLabel?: string;
  readonly audioAssetId?: string;
  readonly audioAssetLabel?: string;
}

export interface ExportClipPreflightSources<T> {
  readonly visualSource: T;
  readonly audioSource: T;
}

type ExportClipAssetRole = 'visual' | 'audio';

export function formatExportClipAssetFailure(
  clip: ExportClipSourcePreflight,
  role: ExportClipAssetRole,
  phase: 'resolve' | 'prepare',
  detail: string,
): string {
  const clipReference =
    clip.clipLabel !== undefined &&
    clip.clipLabel.trim().length > 0 &&
    clip.clipLabel !== clip.clipId
      ? `Clip "${clip.clipLabel}" (${clip.clipId})`
      : `Clip ${clip.clipId}`;
  const assetId =
    role === 'visual' ? clip.visualAssetId : (clip.audioAssetId ?? clip.visualAssetId);
  const assetLabel =
    role === 'visual'
      ? (clip.visualAssetLabel ?? assetId)
      : (clip.audioAssetLabel ?? clip.visualAssetLabel ?? assetId);
  const recovery =
    role === 'audio'
      ? 'Restore the original media in Project Assets, reconnect owner storage if needed, or replace the clip audio before exporting.'
      : 'Restore the original media in Project Assets, reconnect owner storage if needed, or replace the clip before exporting.';
  return `${clipReference} cannot ${phase} ${role} asset "${assetLabel}" (${assetId}). ${recovery} ${detail}`;
}

export async function preflightExportClipSources<T>(
  clips: readonly ExportClipSourcePreflight[],
  resolveSource: (assetId: string) => Promise<T>,
): Promise<ReadonlyMap<string, ExportClipPreflightSources<T>>> {
  const prepared = new Map<string, ExportClipPreflightSources<T>>();
  for (const clip of clips) {
    let visualSource: T;
    try {
      visualSource = await resolveSource(clip.visualAssetId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(formatExportClipAssetFailure(clip, 'visual', 'resolve', detail), {
        cause: error,
      });
    }
    const audioAssetId = clip.audioAssetId ?? clip.visualAssetId;
    if (audioAssetId === clip.visualAssetId) {
      prepared.set(clip.clipId, { visualSource, audioSource: visualSource });
      continue;
    }
    try {
      const audioSource = await resolveSource(audioAssetId);
      prepared.set(clip.clipId, { visualSource, audioSource });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(formatExportClipAssetFailure(clip, 'audio', 'resolve', detail), {
        cause: error,
      });
    }
  }
  return prepared;
}

export async function runExportPreloadStage<T>(
  stage: ExportPreloadStage,
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs = EXPORT_PRELOAD_TIMEOUT_MS,
): Promise<T> {
  if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
  const stageController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const onAbort = () => stageController.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([
      operation(stageController.signal),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          reject(
            new Error(`Export preload timed out while ${stage} after ${timeoutMs / 1_000} seconds`),
          );
          stageController.abort();
        }, timeoutMs);
      }),
      new Promise<never>((_, reject) => {
        stageController.signal.addEventListener(
          'abort',
          () => {
            if (!timedOut) reject(new DOMException('Export cancelled', 'AbortError'));
          },
          { once: true },
        );
      }),
    ]);
  } catch (error) {
    if (timedOut)
      throw new Error(`Export preload timed out while ${stage} after ${timeoutMs / 1_000} seconds`);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Export preload failed while ${stage}: ${detail}`, { cause: error });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
}

export function loadDetachedVideo(
  video: HTMLVideoElement,
  sourceUrl: string,
  signal: AbortSignal,
): Promise<void> {
  video.preload = 'auto';
  video.playsInline = true;
  video.muted = true;
  video.src = sourceUrl;
  return runExportPreloadStage(
    'loading detached video',
    (stageSignal) =>
      new Promise((resolve, reject) => {
        const cleanup = () => {
          video.removeEventListener('loadeddata', onLoaded);
          video.removeEventListener('error', onError);
          stageSignal.removeEventListener('abort', onAbort);
        };
        const finish = (action: () => void) => {
          cleanup();
          action();
        };
        const onLoaded = () => finish(resolve);
        const onError = () =>
          finish(() => reject(new Error(`Unable to load export media ${sourceUrl}`)));
        const onAbort = () =>
          finish(() => reject(new DOMException('Export cancelled', 'AbortError')));
        video.addEventListener('loadeddata', onLoaded);
        video.addEventListener('error', onError);
        stageSignal.addEventListener('abort', onAbort, { once: true });
        if (video.readyState >= 2) return onLoaded();
        video.load();
        if (video.readyState >= 2) onLoaded();
      }),
    signal,
  );
}

export function seekDetachedVideo(
  video: HTMLVideoElement,
  timeUs: number,
  signal: AbortSignal,
): Promise<void> {
  const seconds = timeUs / 1_000_000;
  if (Math.abs(video.currentTime - seconds) < 0.001) return Promise.resolve();
  return runExportPreloadStage(
    'seeking video',
    (stageSignal) =>
      new Promise((resolve, reject) => {
        const cleanup = () => {
          video.removeEventListener('seeked', onSeeked);
          video.removeEventListener('error', onError);
          stageSignal.removeEventListener('abort', onAbort);
        };
        const finish = (action: () => void) => {
          cleanup();
          action();
        };
        const onSeeked = () => finish(resolve);
        const onError = () =>
          finish(() => reject(new Error(`Unable to seek export media to ${seconds}s`)));
        const onAbort = () =>
          finish(() => reject(new DOMException('Export cancelled', 'AbortError')));
        video.addEventListener('seeked', onSeeked);
        video.addEventListener('error', onError);
        stageSignal.addEventListener('abort', onAbort, { once: true });
        video.currentTime = seconds;
      }),
    signal,
  );
}

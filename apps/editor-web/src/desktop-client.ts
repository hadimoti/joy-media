/**
 * Typed helpers for the desktop host bridge (`window.joyDesktop`), injected by
 * `apps/desktop/src/preload/preload.cjs` via `contextBridge.exposeInMainWorld` when
 * editor-web is running inside the Electron desktop shell. `window.joyDesktop` is undefined
 * in every browser context (the normal, hosted editor).
 *
 * The bridge itself only exposes a generic `invoke(channel, payload)` plus the allow-listed
 * channel list — see that file. apps/desktop is a sibling app, not a workspace package, so
 * this module never imports from it; it re-declares the minimal request/response shapes it
 * needs to talk to the `desktop.*` IPC channels documented there
 * (apps/desktop/src/ipc.ts, apps/desktop/src/main/ipc-handlers.ts).
 *
 * Call these helpers instead of touching `window.joyDesktop` directly so the channel names
 * and payload/response shapes stay in one place.
 */

/** The shape `preload.cjs` actually installs on `window.joyDesktop`. */
export interface DesktopJoyBridge {
  readonly channels: readonly string[];
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  readonly projectStorage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    keys(): readonly string[];
  };
}

declare global {
  interface Window {
    /** Present only inside the Electron desktop shell; undefined in the browser. */
    joyDesktop?: DesktopJoyBridge;
  }
}

export type DesktopWorkerConnection =
  'unknown' | 'starting' | 'offline' | 'online' | 'degraded' | 'stopping';

/** Mirrors apps/desktop/src/worker-status.ts's `WorkerStatus`. */
export interface DesktopWorkerStatus {
  readonly connection: DesktopWorkerConnection;
  readonly workerId?: string;
  readonly capabilities: readonly string[];
  readonly lastSeenAt?: string;
}

/** Mirrors apps/desktop/src/file-boundary.ts's `OpaqueFileRef`. */
export interface DesktopFileSelection {
  readonly kind: 'local-file';
  readonly id: string;
  readonly displayName: string;
}

/** Mirrors the main process's update check result (apps/desktop/src/main/auto-update-policy.ts). The check runs in
 * the main process and takes no renderer-supplied trust material. An update is only a notice that links to its release
 * page: the app never downloads or installs a release. */
export type DesktopUpdateBlockReason =
  | 'release-key-unconfigured'
  | 'installed-version-invalid'
  | 'signature-invalid'
  | 'manifest-invalid'
  | 'channel-mismatch'
  | 'network-unavailable';

export type DesktopUpdateDecision =
  | { readonly status: 'blocked'; readonly reason: DesktopUpdateBlockReason }
  | { readonly status: 'current'; readonly reason: 'not-newer'; readonly latestVersion: string }
  | {
      readonly status: 'update';
      readonly latestVersion: string;
      readonly forced: boolean;
      readonly releaseUrl: string;
    };

export const DEFAULT_JOY_REMOTE_API_BASE = 'https://joyst.ir/api';

/** True only inside the Electron desktop shell. Safe to call from any environment, including
 * server-side rendering, where `window` itself may not exist. */
export function isDesktopHost(): boolean {
  return typeof window !== 'undefined' && window.joyDesktop !== undefined;
}

/** Resolves the base URL for VPS backend requests. Inside desktop host, targets https://joyst.ir/api. */
export function getRemoteApiBaseUrl(): string {
  if (
    typeof window !== 'undefined' &&
    (window as unknown as Record<string, unknown>).__JOY_MEDIA_API_BASE__
  ) {
    return (window as unknown as Record<string, unknown>).__JOY_MEDIA_API_BASE__ as string;
  }
  if (isDesktopHost()) {
    return DEFAULT_JOY_REMOTE_API_BASE;
  }
  return '/api';
}

function requireBridge(): DesktopJoyBridge {
  if (typeof window === 'undefined' || window.joyDesktop === undefined) {
    throw new Error('joy-desktop bridge is unavailable outside the desktop host');
  }
  return window.joyDesktop;
}

/**
 * Asks the main process to check the latest release for a newer signed version. The check is opt-in: the user asks for
 * it, and the main process fetches and verifies the manifest itself. The renderer sends nothing, so it cannot supply
 * trust material, and the check cannot download or install anything.
 */
export async function checkForDesktopUpdate(): Promise<DesktopUpdateDecision> {
  const data = await requireBridge().invoke('desktop.check-for-update');
  return data as DesktopUpdateDecision;
}

/** Reads the desktop Worker supervisor's current status via `desktop.worker-status`. */
export async function getDesktopWorkerStatus(): Promise<DesktopWorkerStatus> {
  const data = await requireBridge().invoke('desktop.worker-status');
  return data as DesktopWorkerStatus;
}

/**
 * Opens the native "select a file" dialog via `desktop.select-file`. Resolves to `undefined`
 * if the user cancels the dialog.
 */
export async function selectDesktopFile(): Promise<DesktopFileSelection | undefined> {
  const data = await requireBridge().invoke('desktop.select-file');
  return data as DesktopFileSelection | undefined;
}

/** Identity of an imported original: the hash and size the browser registered it with. */
export interface DesktopStageSource {
  readonly sha256: string;
  readonly bytes: number;
  readonly displayName: string;
}

/** Bytes per IPC message when staging. Bounds memory: the original is never read in one piece. */
export const DESKTOP_STAGE_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Makes an imported original readable by the desktop Worker. The desktop host reuses a verified
 * copy when it already holds one for this hash, so the bytes are sent only when it does not.
 * Otherwise they are sent in fixed-size chunks and verified again on the desktop before use.
 */
export async function stageDesktopMedia(
  source: DesktopStageSource,
  blob: Blob,
  onProgress?: (ratio: number) => void,
): Promise<DesktopFileSelection> {
  if (blob.size !== source.bytes) throw new Error('media bytes do not match the imported size');
  const bridge = requireBridge();
  const begun = (await bridge.invoke('desktop.media-stage.begin', source)) as
    | { readonly status: 'cached'; readonly ref: DesktopFileSelection }
    | { readonly status: 'upload'; readonly uploadId: string };
  if (begun.status === 'cached') {
    onProgress?.(1);
    return begun.ref;
  }
  const { uploadId } = begun;
  try {
    for (let offset = 0; offset < blob.size; offset += DESKTOP_STAGE_CHUNK_BYTES) {
      const data = new Uint8Array(
        await blob.slice(offset, offset + DESKTOP_STAGE_CHUNK_BYTES).arrayBuffer(),
      );
      await bridge.invoke('desktop.media-stage.chunk', { uploadId, offset, data });
      onProgress?.(Math.min(1, (offset + data.byteLength) / blob.size));
    }
    return (await bridge.invoke('desktop.media-stage.finish', {
      uploadId,
    })) as DesktopFileSelection;
  } catch (error) {
    await bridge.invoke('desktop.media-stage.abort', { uploadId }).catch(() => undefined);
    throw error;
  }
}

/** A Worker job as the desktop host reports it. Never carries a path or lease token. */
export interface DesktopJobView {
  readonly id: string;
  readonly status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | string;
  readonly progress?: number;
  readonly error?: string;
}

const TERMINAL_JOB_STATUSES: readonly string[] = ['done', 'failed', 'cancelled'];

/**
 * Starts the desktop's local Worker for this session. Asking for a derivative is an explicit
 * request for the Worker, so the editor starts it here instead of leaving the job queued.
 */
export async function startDesktopWorker(): Promise<void> {
  await requireBridge().invoke('desktop.startup-preference', 'start-worker');
}

/** Asks the desktop host for a thumbnail of a staged original. Resolves to the job id. */
export async function requestDesktopThumbnail(ref: DesktopFileSelection): Promise<string> {
  const data = (await requireBridge().invoke('desktop.request-derivative', {
    ref,
    kind: 'thumbnail',
  })) as { readonly jobId: string };
  return data.jobId;
}

/**
 * Polls a job until it reaches a terminal state. The caller supplies the signal, so leaving the
 * editor or cancelling the request stops polling without leaving a timer behind.
 */
export async function waitForDesktopJob(
  jobId: string,
  options: {
    readonly signal?: AbortSignal;
    readonly intervalMs?: number;
    readonly timeoutMs?: number;
    readonly onUpdate?: (job: DesktopJobView) => void;
  } = {},
): Promise<DesktopJobView> {
  const interval = options.intervalMs ?? 500;
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);
  for (;;) {
    options.signal?.throwIfAborted();
    const job = (await requireBridge().invoke('desktop.job-status', { jobId })) as DesktopJobView;
    options.onUpdate?.(job);
    if (TERMINAL_JOB_STATUSES.includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error('The desktop worker did not finish in time');
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, interval);
      options.signal?.addEventListener(
        'abort',
        () => {
          window.clearTimeout(timer);
          reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }
}

/** Reads a finished derivative back. The desktop host re-verifies its hash before sending it. */
export async function readDesktopDerivative(jobId: string): Promise<Blob> {
  const data = (await requireBridge().invoke('desktop.job-derivative.read', { jobId })) as {
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  };
  return new Blob([data.bytes.slice()], { type: data.mimeType });
}

/**
 * Whether a staged copy has an audio stream, from ffprobe on the desktop. `unknown` means the
 * desktop could not answer (for example, no staged copy), and callers must not treat it as silent.
 */
export async function probeDesktopAudioPresence(
  source: Pick<DesktopStageSource, 'sha256' | 'bytes'>,
): Promise<DesktopAudioPresence> {
  return (await requireBridge().invoke(
    'desktop.media-audio-presence',
    source,
  )) as DesktopAudioPresence;
}

export type DesktopAudioPresence =
  | { readonly status: 'present'; readonly streams: number }
  | { readonly status: 'absent' }
  | { readonly status: 'unknown'; readonly reason: string };

export interface DesktopProviderProfile {
  readonly id: string;
  readonly name?: string | undefined;
  readonly provider: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly cachedModels?: readonly string[] | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveDesktopProviderProfileRequest {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly provider: string;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly cachedModels?: readonly string[] | undefined;
  readonly apiKey?: string | undefined;
}

export interface DiscoveredModel {
  readonly id: string;
  readonly name: string;
}

/**
 * Saves or updates a BYOK provider profile in the desktop host's local database and DPAPI secret store.
 */
export async function saveDesktopProviderProfile(
  request: SaveDesktopProviderProfileRequest,
): Promise<DesktopProviderProfile> {
  const data = await requireBridge().invoke('desktop.provider-profile.save', request);
  return data as DesktopProviderProfile;
}

/**
 * Lists all provider profiles saved in the desktop host's local database.
 */
export async function listDesktopProviderProfiles(): Promise<readonly DesktopProviderProfile[]> {
  const data = await requireBridge().invoke('desktop.provider-profile.list');
  return (data as readonly DesktopProviderProfile[]) ?? [];
}

/**
 * Deletes a provider profile and its associated encrypted secret key.
 */
export async function deleteDesktopProviderProfile(id: string): Promise<void> {
  await requireBridge().invoke('desktop.provider-profile.delete', { id });
}

/**
 * Hands back the decrypted provider session configuration for a single session.
 */
export async function beginDesktopProviderSession(id: string): Promise<unknown> {
  const data = await requireBridge().invoke('desktop.provider-profile.begin-session', { id });
  return data;
}

/**
 * Probes the provider profile connectivity in the desktop host without exposing the key.
 */
export async function testDesktopProviderProfile(id: string): Promise<unknown> {
  const data = await requireBridge().invoke('desktop.provider-profile.test', { id });
  return data;
}

/**
 * Discovers models available behind an API endpoint (via desktop bridge if available, or direct fetch in browser).
 */
export async function fetchDesktopProviderModels(request: {
  id?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  provider?: string | undefined;
}): Promise<readonly DiscoveredModel[]> {
  if (isDesktopHost()) {
    const data = await requireBridge().invoke('desktop.provider-profile.fetch-models', request);
    return (data as readonly DiscoveredModel[]) ?? [];
  }
  if (!request.baseUrl) return [];
  const normalizedBaseUrl = request.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (request.apiKey && request.apiKey !== 'not-provided') {
    headers['Authorization'] = `Bearer ${request.apiKey}`;
  }
  const res = await fetch(`${normalizedBaseUrl}/models`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { data?: unknown };
  const raw = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
  return raw
    .map((item) => {
      if (typeof item === 'string') return { id: item, name: item };
      if (item && typeof item === 'object') {
        const id = (item as { id?: string }).id || '';
        const name = (item as { name?: string }).name || id;
        return { id, name };
      }
      return null;
    })
    .filter((m): m is DiscoveredModel => Boolean(m && m.id));
}

/**
 * Minimizes the host application window.
 */
export async function minimizeDesktopWindow(): Promise<void> {
  await requireBridge().invoke('desktop.window-minimize');
}

/**
 * Toggles full screen on the host application window. Returns whether it is
 * full screen after toggling. The main process owns the window state, so this
 * does not depend on the renderer's Fullscreen API, which does not settle in
 * every desktop environment.
 */
export async function toggleFullscreenDesktopWindow(): Promise<boolean> {
  const isFull = await requireBridge().invoke('desktop.window-toggle-fullscreen');
  return Boolean(isFull);
}

/**
 * Toggles maximize / restore on the host application window.
 * Returns whether the window is currently maximized after toggling.
 */
export async function toggleMaximizeDesktopWindow(): Promise<boolean> {
  const isMax = await requireBridge().invoke('desktop.window-maximize');
  return Boolean(isMax);
}

/**
 * Closes the host application window.
 */
export async function closeDesktopWindow(): Promise<void> {
  await requireBridge().invoke('desktop.window-close');
}

/**
 * Checks whether the host application window is maximized.
 */
export async function isDesktopWindowMaximized(): Promise<boolean> {
  const isMax = await requireBridge().invoke('desktop.window-is-maximized');
  return Boolean(isMax);
}

export interface DesktopAssetLibrarySettings {
  readonly directory: string;
  readonly exists: boolean;
  readonly hasCatalog: boolean;
  readonly isDefault: boolean;
  readonly counts: {
    readonly total: number;
    readonly audio: number;
    readonly image: number;
  };
}

export interface DesktopAssetCatalog {
  readonly version: number;
  readonly generatedAt?: string;
  readonly counts: {
    readonly total: number;
    readonly audio: number;
    readonly image: number;
  };
  readonly assets: readonly unknown[];
}

/**
 * Retrieves the currently configured local asset library folder settings and counts.
 */
export async function getDesktopAssetLibrarySettings(): Promise<DesktopAssetLibrarySettings> {
  return (await requireBridge().invoke(
    'desktop.asset-library.get-settings',
  )) as DesktopAssetLibrarySettings;
}

/**
 * Updates the configured local asset library directory.
 */
export async function setDesktopAssetLibraryDirectory(
  directory: string,
): Promise<DesktopAssetLibrarySettings> {
  return (await requireBridge().invoke('desktop.asset-library.set-directory', {
    directory,
  })) as DesktopAssetLibrarySettings;
}

/**
 * Prompts the user with a native folder picker dialog to select an asset library folder.
 */
export async function selectDesktopAssetLibraryDirectory(): Promise<DesktopAssetLibrarySettings | null> {
  const result = await requireBridge().invoke('desktop.asset-library.select-directory');
  return result ? (result as DesktopAssetLibrarySettings) : null;
}

/**
 * Resets the configured local asset library directory to its default.
 */
export async function resetDesktopAssetLibraryDirectory(): Promise<DesktopAssetLibrarySettings> {
  return (await requireBridge().invoke(
    'desktop.asset-library.reset-directory',
  )) as DesktopAssetLibrarySettings;
}

/**
 * Loads the local catalog.json from the configured local asset library folder.
 */
export async function getDesktopAssetLibraryCatalog(): Promise<DesktopAssetCatalog> {
  return (await requireBridge().invoke('desktop.asset-library.get-catalog')) as DesktopAssetCatalog;
}

/**
 * Formats a local asset relative path or ID to the joy-asset:// protocol for instant local streaming.
 */
export function resolveDesktopAssetUrl(relativePathOrId: string): string {
  const clean = relativePathOrId.replace(/^joy-asset:\/\/library\/?/, '').replace(/^\/+/, '');
  return `joy-asset://library/${clean}`;
}

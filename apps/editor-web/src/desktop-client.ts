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

/** Mirrors apps/desktop/src/main/auto-update-policy.ts's `ReleaseManifestPayload`. */
export interface DesktopReleaseManifestPayload {
  readonly channel: 'stable' | 'beta';
  readonly version: string;
  readonly downloadUrl: string;
  readonly sha256: string;
  readonly minSupportedVersion?: string;
}

/** Mirrors apps/desktop/src/main/auto-update-policy.ts's `SignedReleaseManifest`. The renderer
 * is the one that fetches this from the existing public `GET /v1/releases/:channel` route;
 * this helper only forwards it to the main process for verification. */
export interface DesktopSignedReleaseManifest {
  readonly payload: DesktopReleaseManifestPayload;
  readonly signature: string;
}

export interface DesktopUpdateCheckRequest {
  readonly manifest: DesktopSignedReleaseManifest;
  readonly subscriptionActive: boolean;
}

export type DesktopUpdateBlockReason =
  | 'subscription-required'
  | 'release-key-unconfigured'
  | 'manifest-invalid'
  | 'signature-invalid'
  | 'download-url-invalid'
  | 'not-newer';

/** Mirrors apps/desktop/src/main/auto-update-policy.ts's `AutoUpdateDecision`. */
export type DesktopUpdateDecision =
  | { readonly status: 'blocked'; readonly reason: DesktopUpdateBlockReason }
  | { readonly status: 'current'; readonly reason: 'not-newer' }
  | {
      readonly status: 'update';
      readonly manifest: DesktopSignedReleaseManifest;
      readonly forced: boolean;
      readonly autoDownload: boolean;
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
 * Forwards a manifest the caller already fetched from `GET /v1/releases/:channel`, plus the
 * caller's own `GET /v1/account/subscription` result, to the main process's
 * `desktop.check-for-update` handler. The main process alone supplies the pinned
 * release-signing public key and the running app version, so a compromised renderer can never
 * inject either — this call cannot download or install anything by itself.
 */
export async function checkForDesktopUpdate(
  request: DesktopUpdateCheckRequest,
): Promise<DesktopUpdateDecision> {
  const data = await requireBridge().invoke('desktop.check-for-update', request);
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

import { ProviderCallError, type ProviderCallRequest } from './joy-agent/provider-call.js';
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

/** True only inside the Electron desktop shell. Safe to call from any environment, including
 * server-side rendering, where `window` itself may not exist. */
export function isDesktopHost(): boolean {
  return typeof window !== 'undefined' && window.joyDesktop !== undefined;
}

function requireBridge(): DesktopJoyBridge {
  if (typeof window === 'undefined' || window.joyDesktop === undefined) {
    throw new Error('joy-desktop bridge is unavailable outside the desktop host');
  }
  return window.joyDesktop;
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
 * Probes the provider profile connectivity in the desktop host without exposing the key.
 */
export async function testDesktopProviderProfile(id: string): Promise<unknown> {
  const data = await requireBridge().invoke('desktop.provider.test', { id });
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
  if (!isDesktopHost()) throw new Error('Model lists are available in the desktop app only');
  const payload =
    request.id === undefined || request.id.length === 0
      ? {
          draft: {
            provider: request.provider ?? '',
            baseUrl: request.baseUrl ?? '',
            apiKey: request.apiKey ?? '',
          },
        }
      : { id: request.id };
  const data = await requireBridge().invoke('desktop.provider.models', payload);
  return (data as readonly DiscoveredModel[]) ?? [];
}

/** One model call through the desktop broker. The key never reaches this side (PLAN-v4 §6a). */
export async function requestAgentCompletion(request: ProviderCallRequest): Promise<string> {
  const data = (await requireBridge().invoke('desktop.agent.request', request)) as
    | {
        readonly ok?: unknown;
        readonly text?: unknown;
        readonly code?: unknown;
        readonly message?: unknown;
      }
    | undefined;
  if (data?.ok === true && typeof data.text === 'string') return data.text;
  throw new ProviderCallError(
    typeof data?.code === 'string' ? data.code : 'NETWORK_ERROR',
    typeof data?.message === 'string' ? data.message : 'The provider request failed',
  );
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

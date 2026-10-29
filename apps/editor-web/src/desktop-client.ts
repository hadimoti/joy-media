import { evaluateEndpoint, type AgentSlotId } from '@joy-media/provider-sdk';
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
  /** Why the Worker stopped on its own. Shown with a retry action once the automatic restarts are used up. */
  readonly lastError?: string;
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

/** Starts the desktop's Worker again, after its automatic restarts are used up, via `desktop.worker-retry`. */
export async function retryDesktopWorker(): Promise<DesktopWorkerStatus> {
  const data = await requireBridge().invoke('desktop.worker-retry');
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
  /** False until the saved key is confirmed for this endpoint. Such a profile asks for its key again. */
  readonly bound?: boolean | undefined;
}

export interface SaveDesktopProviderProfileRequest {
  /** The owner has confirmed this public custom endpoint (S8). */
  readonly acknowledgedPublicEndpoint?: boolean | undefined;
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
  // A new profile for a local endpoint may be saved with no key (PLAN-v4 D8). It is stored with the
  // placeholder, so the profile still reads as having a key. An existing profile is left alone.
  const keyless = request.apiKey === undefined || request.apiKey === '';
  const verdict = evaluateEndpoint(request.provider, request.baseUrl, {
    consentToPublicEndpoint: request.acknowledgedPublicEndpoint === true,
  });
  const local = verdict.allowed && verdict.kind === 'loopback';
  const payload =
    request.id === undefined && keyless && local ? { ...request, apiKey: 'not-provided' } : request;
  const data = await requireBridge().invoke('desktop.provider-profile.save', payload);
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
 * Signs in to OpenRouter or ChatGPT in the desktop app, and saves the profile it makes. The key or token stays in the
 * desktop: the reply is the saved profile, which holds no secret (PLAN-v4 §6b, §6d).
 */
export async function signInDesktopProviderProfile(request: {
  readonly provider: 'openrouter' | 'chatgpt';
  readonly id?: string | undefined;
}): Promise<DesktopProviderProfile> {
  const data = await requireBridge().invoke('desktop.provider-profile.sign-in', request);
  return data as DesktopProviderProfile;
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
  /** The owner has confirmed this public custom endpoint (S8). */
  readonly acknowledgedPublicEndpoint?: boolean | undefined;
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

/**
 * One model call through the desktop broker. The key never reaches this side (PLAN-v4 §6a). A call that
 * is aborted here is cancelled in the desktop as well, so the provider request it began is not left running.
 */
export async function requestAgentCompletion(request: ProviderCallRequest): Promise<string> {
  const bridge = requireBridge();
  const { signal, ...payload } = request;
  if (signal?.aborted) throw new ProviderCallError('NETWORK_ERROR', 'The request was cancelled.');
  // A random id per call: a counter restarts on every reload, and an old page's id could then match a new call.
  const requestId = `agent-${crypto.randomUUID()}`;
  const cancel = (): void => {
    void bridge.invoke('desktop.agent.cancel', { requestId }).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const data = (await bridge.invoke('desktop.agent.request', { ...payload, requestId })) as
      | {
          readonly ok?: unknown;
          readonly text?: unknown;
          readonly code?: unknown;
          readonly message?: unknown;
        }
      | undefined;
    // A reply that lands after the caller aborted is not returned: the caller has stopped waiting for it.
    if (signal?.aborted) throw new ProviderCallError('NETWORK_ERROR', 'The request was cancelled.');
    if (data?.ok === true && typeof data.text === 'string') return data.text;
    throw new ProviderCallError(
      typeof data?.code === 'string' ? data.code : 'NETWORK_ERROR',
      typeof data?.message === 'string' ? data.message : 'The provider request failed',
    );
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

/**
 * Minimizes the host application window.
 */
/** One agent slot as the desktop reports it. The key stays in the desktop, and the profile is named, not sent. */
export interface DesktopAgentSlot {
  readonly id: AgentSlotId;
  readonly label: string;
  readonly profileId: string | null;
  readonly profileName: string | null;
  readonly profileProvider: string | null;
  readonly model: string | null;
  readonly instructions: string;
  readonly settings: { readonly temperature?: number; readonly maxOutputTokens?: number };
  /** True when the slot names a saved profile and a model, and that profile is not a retired one. */
  readonly ready: boolean;
}

/** What the owner sets for a slot. An absent field is not set, and an empty draft empties the slot. */
export interface DesktopAgentSlotDraft {
  readonly profileId?: string | undefined;
  readonly model?: string | undefined;
  readonly instructions?: string | undefined;
  readonly settings?:
    | { readonly temperature?: number | undefined; readonly maxOutputTokens?: number | undefined }
    | undefined;
}

/** Both agent slots, through `desktop.agent-slots.list`. */
export async function listDesktopAgentSlots(): Promise<readonly DesktopAgentSlot[]> {
  const data = await requireBridge().invoke('desktop.agent-slots.list');
  return Array.isArray(data) ? (data as readonly DesktopAgentSlot[]) : [];
}

/** Saves one slot through `desktop.agent-slots.save`. The desktop refuses a draft that breaks the rules. */
export async function saveDesktopAgentSlot(
  id: AgentSlotId,
  draft: DesktopAgentSlotDraft,
): Promise<DesktopAgentSlot> {
  const data = await requireBridge().invoke('desktop.agent-slots.save', { id, draft });
  return data as DesktopAgentSlot;
}

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

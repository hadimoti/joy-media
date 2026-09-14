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

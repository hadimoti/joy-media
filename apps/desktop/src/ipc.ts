import { assertAllowedEditorOrigin } from './origin-policy.js';
export const IPC_CHANNELS = [
  'desktop.select-file',
  'desktop.revoke-file',
  'desktop.request-derivative',
  'desktop.worker-status',
  'desktop.startup-preference',
  'desktop.job-status',
  'desktop.cancel-job',
  'desktop.provider-profile.save',
  'desktop.provider-profile.list',
  'desktop.provider-profile.delete',
  'desktop.provider-profile.begin-session',
  'desktop.provider-profile.test',
  'desktop.provider-profile.fetch-models',
  'desktop.check-for-update',
  'desktop.window-minimize',
  'desktop.window-maximize',
  'desktop.window-close',
  'desktop.window-is-maximized',
  'desktop.asset-library.get-settings',
  'desktop.asset-library.set-directory',
  'desktop.asset-library.select-directory',
  'desktop.asset-library.get-catalog',
  'desktop.asset-library.reset-directory',
  'desktop.media-session.get',
  'desktop.media-session.set',
  'desktop.media-session.clear',
] as const;
export type IpcChannel = (typeof IPC_CHANNELS)[number];
export interface IpcRequest {
  readonly origin: string;
  readonly channel: string;
  readonly payload?: unknown;
}

export interface IpcSenderFrame {
  readonly url: string;
}

/** Checks the invoking renderer is the main frame and its URL matches its claimed origin. */
export function isTrustedIpcSenderFrame(
  event: {
    readonly senderFrame: IpcSenderFrame | null;
    readonly mainFrame: IpcSenderFrame;
  },
  requestOrigin: unknown,
): boolean {
  const frame = event.senderFrame;
  if (frame === null || frame !== event.mainFrame || typeof requestOrigin !== 'string')
    return false;
  try {
    const url = new URL(frame.url);
    const frameOrigin =
      url.origin === 'null' && url.protocol === 'joy-media-app:' && url.host === 'renderer'
        ? 'joy-media-app://renderer'
        : url.origin;
    return frameOrigin !== 'null' && frameOrigin === requestOrigin;
  } catch {
    return false;
  }
}

export function isAllowedIpcRequest(
  request: IpcRequest,
): request is IpcRequest & { channel: IpcChannel } {
  assertAllowedEditorOrigin(request.origin);
  return (IPC_CHANNELS as readonly string[]).includes(request.channel);
}

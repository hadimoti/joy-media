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
  'desktop.check-for-update',
  'desktop.window-minimize',
  'desktop.window-maximize',
  'desktop.window-close',
  'desktop.window-is-maximized',
  'desktop.asset-library.get-settings',
  'desktop.asset-library.set-directory',
  'desktop.asset-library.select-directory',
  'desktop.asset-library.get-catalog',
] as const;
export type IpcChannel = (typeof IPC_CHANNELS)[number];
export interface IpcRequest {
  readonly origin: string;
  readonly channel: string;
  readonly payload?: unknown;
}
export function isAllowedIpcRequest(
  request: IpcRequest,
): request is IpcRequest & { channel: IpcChannel } {
  assertAllowedEditorOrigin(request.origin);
  return (IPC_CHANNELS as readonly string[]).includes(request.channel);
}

import { assertAllowedEditorOrigin } from './origin-policy.js';
export const IPC_CHANNELS = [
  'desktop.select-file',
  'desktop.revoke-file',
  'desktop.request-derivative',
  'desktop.worker-status',
  'desktop.startup-preference',
  'desktop.job-status',
  'desktop.cancel-job',
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

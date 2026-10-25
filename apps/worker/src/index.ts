import { WorkerControlPlaneClient, type WorkerSessionStore } from './control-plane-client.js';
import { waitForWorkerPairing } from './pairing-loop.js';
import { WorkerDaemon } from './worker-daemon.js';
import {
  getDeviceIdentity,
  JsonFileWorkerStore,
  WindowsDpapiSecretProtector,
  WorkerRuntime,
  detectMediaTools,
  localAssetSourcesFromEnvironment,
} from './runtime.js';
import { GpuPreviewHost } from './gpu-preview-host.js';
import { createLocalSessionStore, isLoopbackApiUrl } from './local-session.js';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  clearPairingNotification,
  createPairingNotificationWriter,
} from './pairing-notification.js';

const configuredStatePath = process.env.JOY_MEDIA_WORKER_STATE_PATH?.trim();
const statePath = configuredStatePath || join(homedir(), '.joy-media', 'worker-state.json');
const configuredPairingNotificationPath =
  process.env.JOY_MEDIA_WORKER_PAIRING_NOTIFICATION_PATH?.trim();
const pairingNotificationPath =
  configuredPairingNotificationPath || join(dirname(statePath), 'pairing-notification.json');
const store = new JsonFileWorkerStore(
  statePath,
  process.platform === 'win32' ? { secretProtector: new WindowsDpapiSecretProtector() } : {},
);
store.migrateLegacySecrets();
const identity = getDeviceIdentity(store);
const sources = localAssetSourcesFromEnvironment(process.env.JOY_MEDIA_LOCAL_ASSETS_JSON);
// The desktop app's local job route supplies a per-run token instead of a cloud pairing. That
// token is only accepted on the loopback address the desktop app bound.
const localToken = process.env.JOY_MEDIA_WORKER_LOCAL_TOKEN?.trim() || undefined;
const apiUrl = process.env.JOY_MEDIA_API_URL;
if (localToken !== undefined && (apiUrl === undefined || !isLoopbackApiUrl(apiUrl)))
  throw new Error('JOY_MEDIA_WORKER_LOCAL_TOKEN requires JOY_MEDIA_API_URL on 127.0.0.1');
const sessionStore: WorkerSessionStore =
  localToken === undefined ? store : createLocalSessionStore(localToken);
if (sessionStore.loadWorkerSession() !== undefined)
  clearPairingNotification(pairingNotificationPath);
let gpuPreviewHost: GpuPreviewHost | undefined;
if (localToken === undefined) {
  try {
    gpuPreviewHost = await GpuPreviewHost.create();
    console.log(
      JSON.stringify({
        gpuPreview: 'hardware',
        renderer: gpuPreviewHost.identity.renderer,
        backend: gpuPreviewHost.identity.backend,
      }),
    );
  } catch (error) {
    console.warn(
      `GPU preview unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
const client =
  apiUrl === undefined
    ? undefined
    : new WorkerControlPlaneClient({ apiUrl, identity, sessionStore });
const derivativeDirectory = process.env.JOY_MEDIA_WORKER_DERIVATIVE_DIR?.trim() || undefined;
const runtime = new WorkerRuntime(identity, detectMediaTools(), {
  ...(sources === undefined ? {} : { sources }),
  ...(derivativeDirectory === undefined ? {} : { derivativeDirectory }),
  gpuPreviewAvailable: gpuPreviewHost !== undefined,
  ...(client === undefined ? {} : { downloadJobAsset: client.downloadJobAsset.bind(client) }),
});
console.log(JSON.stringify(runtime.hello(process.platform, process.arch)));

if (apiUrl !== undefined && client !== undefined) {
  if (sessionStore.loadWorkerSession() === undefined) {
    try {
      await waitForWorkerPairing(client, store, {
        createPairingCode: WorkerControlPlaneClient.createPairingCode,
        log: (message) => console.log(message),
        notify: createPairingNotificationWriter(pairingNotificationPath),
      });
    } finally {
      clearPairingNotification(pairingNotificationPath);
    }
  }
  // Pairing only returns once the control plane accepted the offer, so a
  // missing session here is a local state fault. Exiting quietly would be
  // indistinguishable from a Worker that never paired and leaves the operator
  // with a daemon that produced no control-plane traffic and no reason why.
  if (sessionStore.loadWorkerSession() === undefined)
    throw new Error('Worker session is unavailable after pairing; refusing to run unpaired');
  const daemon = new WorkerDaemon(client, runtime, gpuPreviewHost);
  await daemon.run({ stopped: () => false });
}

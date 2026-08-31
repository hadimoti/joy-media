import { WorkerControlPlaneClient } from './control-plane-client.js';
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
if (store.loadWorkerSession() !== undefined) clearPairingNotification(pairingNotificationPath);
let gpuPreviewHost: GpuPreviewHost | undefined;
const apiUrl = process.env.JOY_MEDIA_API_URL;
const client =
  apiUrl === undefined
    ? undefined
    : new WorkerControlPlaneClient({ apiUrl, identity, sessionStore: store });
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
const runtime = new WorkerRuntime(identity, detectMediaTools(), {
  ...(sources === undefined ? {} : { sources }),
  gpuPreviewAvailable: gpuPreviewHost !== undefined,
  ...(client === undefined ? {} : { downloadJobAsset: client.downloadJobAsset.bind(client) }),
});
console.log(JSON.stringify(runtime.hello(process.platform, process.arch)));

if (apiUrl !== undefined && client !== undefined) {
  if (store.loadWorkerSession() === undefined) {
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
  if (store.loadWorkerSession() !== undefined) {
    const daemon = new WorkerDaemon(client, runtime, gpuPreviewHost);
    await daemon.run({ stopped: () => false });
  }
}

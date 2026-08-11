import { WorkerControlPlaneClient } from './control-plane-client.js';
import { waitForWorkerPairing } from './pairing-loop.js';
import { WorkerDaemon } from './worker-daemon.js';
import {
  getDeviceIdentity,
  JsonFileWorkerStore,
  WorkerRuntime,
  detectMediaTools,
  localAssetSourcesFromEnvironment,
} from './runtime.js';

const store = new JsonFileWorkerStore(process.env.JOY_MEDIA_WORKER_STATE_PATH);
const identity = getDeviceIdentity(store);
const sources = localAssetSourcesFromEnvironment(process.env.JOY_MEDIA_LOCAL_ASSETS_JSON);
const runtime = new WorkerRuntime(
  identity,
  detectMediaTools(),
  sources === undefined ? {} : { sources },
);
console.log(JSON.stringify(runtime.hello(process.platform, process.arch)));

const apiUrl = process.env.JOY_MEDIA_API_URL;
if (apiUrl !== undefined) {
  const client = new WorkerControlPlaneClient({ apiUrl, identity, sessionStore: store });
  if (store.loadWorkerSession() === undefined) {
    await waitForWorkerPairing(client, store, {
      createPairingCode: WorkerControlPlaneClient.createPairingCode,
      log: (message) => console.log(message),
    });
  }
  if (store.loadWorkerSession() !== undefined) {
    const daemon = new WorkerDaemon(client, runtime);
    await daemon.run({ stopped: () => false });
  }
}

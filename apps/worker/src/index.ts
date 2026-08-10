import { WorkerControlPlaneClient } from './control-plane-client.js';
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
    const pending = store.loadPendingPairing();
    const pairingCode = pending?.code ?? WorkerControlPlaneClient.createPairingCode();
    if (pending === undefined) {
      const expiresAt = await client.publishPairingOffer(pairingCode);
      store.savePendingPairing(pairingCode, expiresAt);
    }
    console.log(`Approve this Worker in JOY Media with pairing code: ${pairingCode}`);
    while (store.loadWorkerSession() === undefined) {
      if (await client.claimPairing(pairingCode)) {
        store.clearPendingPairing();
        break;
      }
      if (Date.now() >= (store.loadPendingPairing()?.expiresAt ?? 0)) {
        const refreshedCode = WorkerControlPlaneClient.createPairingCode();
        const expiresAt = await client.publishPairingOffer(refreshedCode);
        store.savePendingPairing(refreshedCode, expiresAt);
        console.log(`Pairing code expired; new code: ${refreshedCode}`);
      }
      console.log('Waiting for approval; polling again in 5 seconds.');
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  if (store.loadWorkerSession() !== undefined) {
    const daemon = new WorkerDaemon(client, runtime);
    await daemon.run({ stopped: () => false });
  }
}

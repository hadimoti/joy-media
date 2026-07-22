import { WorkerControlPlaneClient } from './control-plane-client.js';
import { WorkerDaemon } from './worker-daemon.js';
import {
  getDeviceIdentity,
  JsonFileWorkerStore,
  WorkerRuntime,
  detectMediaTools,
} from './runtime.js';

const store = new JsonFileWorkerStore(process.env.JOY_MEDIA_WORKER_STATE_PATH);
const identity = getDeviceIdentity(store);
const runtime = new WorkerRuntime(identity, detectMediaTools());
console.log(JSON.stringify(runtime.hello(process.platform, process.arch)));

const apiUrl = process.env.JOY_MEDIA_API_URL;
if (apiUrl !== undefined) {
  const client = new WorkerControlPlaneClient({ apiUrl, identity, sessionStore: store });
  if (store.loadWorkerSession() === undefined) {
    const pairingCode = WorkerControlPlaneClient.createPairingCode();
    await client.publishPairingOffer(pairingCode);
    console.log(`Approve this Worker in JOY Media with pairing code: ${pairingCode}`);
    if (!(await client.claimPairing(pairingCode))) {
      console.log(
        'Waiting for approval; restart after the signed-in JOY user approves the pairing code.',
      );
      process.exitCode = 2;
    }
  }
  if (store.loadWorkerSession() !== undefined) {
    const daemon = new WorkerDaemon(client, runtime);
    await daemon.run({ stopped: () => false });
  }
}

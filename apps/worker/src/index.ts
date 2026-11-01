import { WorkerControlPlaneClient } from './control-plane-client.js';
import { WorkerDaemon } from './worker-daemon.js';
import {
  getDeviceIdentity,
  JsonFileWorkerStore,
  WorkerRuntime,
  detectMediaTools,
  localAssetSourcesFromEnvironment,
} from './runtime.js';
import { createLocalSessionStore, workerApiUrl } from './local-session.js';
import { GpuPreviewHost } from './gpu-preview-host.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Checked first: a Worker that names a remote control plane stops before it reads or writes any state.
const apiUrl = workerApiUrl(process.env.JOY_MEDIA_API_URL);
if (apiUrl === undefined)
  throw new Error(
    'JOY_MEDIA_API_URL is required: set it to the desktop app local job API, http://127.0.0.1:<port>',
  );
// The desktop app's local job route gives the Worker a per-run token. That token is the only credential,
// and it is held in memory only.
const localToken = process.env.JOY_MEDIA_WORKER_LOCAL_TOKEN?.trim() || undefined;
if (localToken === undefined)
  throw new Error('JOY_MEDIA_WORKER_LOCAL_TOKEN is required with JOY_MEDIA_API_URL');

const configuredStatePath = process.env.JOY_MEDIA_WORKER_STATE_PATH?.trim();
const statePath = configuredStatePath || join(homedir(), '.joy-media', 'worker-state.json');
const store = new JsonFileWorkerStore(statePath);
const identity = getDeviceIdentity(store);
const sources = localAssetSourcesFromEnvironment(process.env.JOY_MEDIA_LOCAL_ASSETS_JSON);
const client = new WorkerControlPlaneClient({
  apiUrl,
  identity,
  sessionStore: createLocalSessionStore(localToken),
});
const derivativeDirectory = process.env.JOY_MEDIA_WORKER_DERIVATIVE_DIR?.trim() || undefined;
// The GPU preview host is an explicit local capability. It is created only when this switch is set,
// so the default desktop start does not launch a GPU process. The capability is advertised only while
// the host exists (PLAN-v4 §6h, GPU preview).
let gpuPreviewHost: GpuPreviewHost | undefined;
if (process.env.JOY_MEDIA_WORKER_GPU_PREVIEW?.trim() === '1') {
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
const runtime = new WorkerRuntime(identity, detectMediaTools(undefined, { aiBroker: true }), {
  ...(sources === undefined ? {} : { sources }),
  ...(derivativeDirectory === undefined ? {} : { derivativeDirectory }),
  gpuPreviewAvailable: gpuPreviewHost !== undefined,
  downloadJobAsset: client.downloadJobAsset.bind(client),
  completeAi: client.completeAi.bind(client),
});
console.log(JSON.stringify(runtime.hello(process.platform, process.arch)));
await new WorkerDaemon(client, runtime, gpuPreviewHost).run({ stopped: () => false });

import { join } from 'node:path';

/**
 * Inherited variables the local route owns. Leaving them in place would point a local Worker at a
 * different API, a different source registry, or a pairing flow it must not use.
 */
const LOCAL_ROUTE_OWNED = [
  'JOY_MEDIA_LOCAL_ASSETS_JSON',
  'JOY_MEDIA_API_URL',
  'JOY_MEDIA_WORKER_LOCAL_TOKEN',
  'JOY_MEDIA_WORKER_PAIRING_NOTIFICATION_PATH',
] as const;

export interface LocalWorkerRoute {
  /** From `startLocalJobApi(...).workerEnv`: the loopback URL and the per-run token. */
  readonly apiEnv: Readonly<Record<string, string>>;
  /** Worker-private directory for its identity state and its own derivative copies. */
  readonly workerRoot: string;
}

/**
 * Environment for the local Worker process. Tool toggles such as ComfyUI or ML denoise are kept,
 * because they describe this machine; the variables in LOCAL_ROUTE_OWNED are replaced.
 */
export function localWorkerEnv(
  inherited: NodeJS.ProcessEnv,
  route: LocalWorkerRoute,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited };
  for (const key of LOCAL_ROUTE_OWNED) delete env[key];
  return {
    ...env,
    ...route.apiEnv,
    // The packaged Electron binary runs the Worker script as plain Node only with this set.
    ELECTRON_RUN_AS_NODE: '1',
    JOY_MEDIA_WORKER_STATE_PATH: join(route.workerRoot, 'worker-state.json'),
    JOY_MEDIA_WORKER_DERIVATIVE_DIR: join(route.workerRoot, 'derivatives'),
  };
}

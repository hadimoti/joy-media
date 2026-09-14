/**
 * Fail-closed retirement for hosted project/media/Worker-pairing routes, once the desktop
 * app's local runtime (wave 2) covers the equivalent workflow and an explicit cutover flag is
 * enabled. Mirrors joy-agent-route-retirement.ts's `{code, message}` shape — same precedent
 * this migration's wave 0 design doc calls out for reuse.
 *
 * Every flag defaults to `false` (retirement inert) unless the corresponding environment
 * variable is exactly the string `"true"`. This worktree never sets any of them: flipping a
 * retirement flag on a real deployment is explicitly reserved for Codex after the archive/
 * acceptance wave (see docs/joy-media-final-migration-design.md §4 and the lead brief's stop
 * conditions on retiring VPS routes).
 */

export interface HostedRouteRetirementFlags {
  readonly projectRoutes: boolean;
  readonly mediaLibraryRoutes: boolean;
  readonly workerPairingRoutes: boolean;
}

export const HOSTED_ROUTE_RETIREMENT_ENV_VARS = {
  projectRoutes: 'JOY_MEDIA_RETIRE_PROJECT_ROUTES',
  mediaLibraryRoutes: 'JOY_MEDIA_RETIRE_MEDIA_LIBRARY_ROUTES',
  workerPairingRoutes: 'JOY_MEDIA_RETIRE_WORKER_PAIRING_ROUTES',
} as const;

export function readHostedRouteRetirementFlags(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HostedRouteRetirementFlags {
  return {
    projectRoutes: env[HOSTED_ROUTE_RETIREMENT_ENV_VARS.projectRoutes] === 'true',
    mediaLibraryRoutes: env[HOSTED_ROUTE_RETIREMENT_ENV_VARS.mediaLibraryRoutes] === 'true',
    workerPairingRoutes: env[HOSTED_ROUTE_RETIREMENT_ENV_VARS.workerPairingRoutes] === 'true',
  };
}

export const ALL_HOSTED_ROUTE_RETIREMENT_DISABLED: HostedRouteRetirementFlags = Object.freeze({
  projectRoutes: false,
  mediaLibraryRoutes: false,
  workerPairingRoutes: false,
});

interface RetirableRoute {
  readonly method: string;
  readonly pathname: string;
  readonly flag: keyof HostedRouteRetirementFlags;
}

/**
 * Exact method+path matches only — deliberately not a broad prefix regex. Each entry is one
 * of the routes docs/joy-media-final-migration-design.md §4 names as retirable; a route not
 * listed here is never affected by any flag, however it's set.
 */
const RETIRABLE_ROUTES: readonly RetirableRoute[] = [
  { method: 'POST', pathname: '/v1/projects', flag: 'projectRoutes' },
  { method: 'POST', pathname: '/v1/projects/ensure', flag: 'projectRoutes' },
  { method: 'GET', pathname: '/v1/library/cloud-assets', flag: 'mediaLibraryRoutes' },
  { method: 'GET', pathname: '/v1/library/my-assets', flag: 'mediaLibraryRoutes' },
  { method: 'POST', pathname: '/v1/worker-pair/offers', flag: 'workerPairingRoutes' },
  { method: 'POST', pathname: '/v1/worker-pair/claim', flag: 'workerPairingRoutes' },
  { method: 'GET', pathname: '/v1/workers', flag: 'workerPairingRoutes' },
];

export const HOSTED_ROUTE_RETIRED_RESPONSE = Object.freeze({
  code: 'JOY_MEDIA_HOSTED_ROUTE_RETIRED',
  message:
    'This hosted workflow has moved to the JOY Media desktop app. Use the desktop app for local project, media, and Worker workflows.',
});

export function isRetiredHostedRoute(
  method: string,
  pathname: string,
  flags: HostedRouteRetirementFlags,
): boolean {
  return RETIRABLE_ROUTES.some(
    (route) => route.method === method && route.pathname === pathname && flags[route.flag],
  );
}

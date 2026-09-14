import { describe, expect, it } from 'vitest';
import {
  ALL_HOSTED_ROUTE_RETIREMENT_DISABLED,
  HOSTED_ROUTE_RETIRED_RESPONSE,
  HOSTED_ROUTE_RETIREMENT_ENV_VARS,
  isRetiredHostedRoute,
  readHostedRouteRetirementFlags,
} from './hosted-route-retirement.js';

describe('readHostedRouteRetirementFlags', () => {
  it('defaults every flag to false on an empty environment', () => {
    expect(readHostedRouteRetirementFlags({})).toEqual(ALL_HOSTED_ROUTE_RETIREMENT_DISABLED);
  });

  it('only turns a flag on for the exact string "true"', () => {
    expect(
      readHostedRouteRetirementFlags({
        [HOSTED_ROUTE_RETIREMENT_ENV_VARS.projectRoutes]: 'TRUE',
      }),
    ).toEqual(ALL_HOSTED_ROUTE_RETIREMENT_DISABLED);
    expect(
      readHostedRouteRetirementFlags({
        [HOSTED_ROUTE_RETIREMENT_ENV_VARS.projectRoutes]: '1',
      }),
    ).toEqual(ALL_HOSTED_ROUTE_RETIREMENT_DISABLED);
  });

  it('turns on exactly the flag whose env var is "true", leaving the others off', () => {
    expect(
      readHostedRouteRetirementFlags({
        [HOSTED_ROUTE_RETIREMENT_ENV_VARS.mediaLibraryRoutes]: 'true',
      }),
    ).toEqual({ projectRoutes: false, mediaLibraryRoutes: true, workerPairingRoutes: false });
  });
});

describe('isRetiredHostedRoute', () => {
  it('never retires anything when every flag is off (the default, real-world-today state)', () => {
    expect(isRetiredHostedRoute('POST', '/v1/projects', ALL_HOSTED_ROUTE_RETIREMENT_DISABLED)).toBe(
      false,
    );
    expect(
      isRetiredHostedRoute('GET', '/v1/library/my-assets', ALL_HOSTED_ROUTE_RETIREMENT_DISABLED),
    ).toBe(false);
    expect(isRetiredHostedRoute('GET', '/v1/workers', ALL_HOSTED_ROUTE_RETIREMENT_DISABLED)).toBe(
      false,
    );
  });

  it('retires POST /v1/projects and /v1/projects/ensure only when projectRoutes is on', () => {
    const flags = { ...ALL_HOSTED_ROUTE_RETIREMENT_DISABLED, projectRoutes: true };
    expect(isRetiredHostedRoute('POST', '/v1/projects', flags)).toBe(true);
    expect(isRetiredHostedRoute('POST', '/v1/projects/ensure', flags)).toBe(true);
    expect(isRetiredHostedRoute('GET', '/v1/library/my-assets', flags)).toBe(false);
    expect(isRetiredHostedRoute('GET', '/v1/workers', flags)).toBe(false);
  });

  it('retires the library routes only when mediaLibraryRoutes is on', () => {
    const flags = { ...ALL_HOSTED_ROUTE_RETIREMENT_DISABLED, mediaLibraryRoutes: true };
    expect(isRetiredHostedRoute('GET', '/v1/library/cloud-assets', flags)).toBe(true);
    expect(isRetiredHostedRoute('GET', '/v1/library/my-assets', flags)).toBe(true);
    expect(isRetiredHostedRoute('POST', '/v1/projects', flags)).toBe(false);
  });

  it('retires the worker-pairing routes only when workerPairingRoutes is on', () => {
    const flags = { ...ALL_HOSTED_ROUTE_RETIREMENT_DISABLED, workerPairingRoutes: true };
    expect(isRetiredHostedRoute('POST', '/v1/worker-pair/offers', flags)).toBe(true);
    expect(isRetiredHostedRoute('POST', '/v1/worker-pair/claim', flags)).toBe(true);
    expect(isRetiredHostedRoute('GET', '/v1/workers', flags)).toBe(true);
    expect(isRetiredHostedRoute('POST', '/v1/projects', flags)).toBe(false);
  });

  it('never matches a route outside the exact enumerated list, even with every flag on', () => {
    const flags = {
      projectRoutes: true,
      mediaLibraryRoutes: true,
      workerPairingRoutes: true,
    };
    // A project-scoped sub-route (e.g. preview-sessions) must stay reachable: it is not in
    // the wave 0 retirement list and this predicate must never widen to a prefix match.
    expect(isRetiredHostedRoute('POST', '/v1/projects/abc/preview-sessions', flags)).toBe(false);
    expect(isRetiredHostedRoute('GET', '/v1/projects', flags)).toBe(false); // wrong method
  });

  it('exposes a stable, frozen error shape matching the joy-agent-route-retirement precedent', () => {
    expect(HOSTED_ROUTE_RETIRED_RESPONSE.code).toBe('JOY_MEDIA_HOSTED_ROUTE_RETIRED');
    expect(Object.isFrozen(HOSTED_ROUTE_RETIRED_RESPONSE)).toBe(true);
  });
});

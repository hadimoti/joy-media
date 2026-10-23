import { describe, expect, it } from 'vitest';
import { auditProjectRequests, type ServedRequest } from './project-request-audit.js';

const BOUND = new Set(['project-own']);
const OWNED = [
  { id: 'asset-own', projectId: 'project-own' },
  { id: 'asset-a', projectId: 'project-a' },
];

const get = (path: string, status: number | null = 200, query = ''): ServedRequest => ({
  method: 'GET',
  path,
  query,
  status,
});
const derivatives = (projectId: string, assetId: string): string =>
  `/v1/projects/${projectId}/assets/${assetId}/derivatives`;

function audit(served: readonly ServedRequest[]) {
  return auditProjectRequests({ served, boundProjectIds: BOUND, ownedAssets: OWNED });
}

describe('auditProjectRequests', () => {
  it('passes an owned derivative read of another project, with its preflight', () => {
    const result = audit([
      { method: 'OPTIONS', path: derivatives('project-a', 'asset-a'), status: 204 },
      get(derivatives('project-a', 'asset-a')),
      get(derivatives('project-own', 'asset-own')),
    ]);
    expect(result.violations).toEqual([]);
    expect(result.ownedForeignReads).toBe(1);
  });

  it('fails a foreign jobs read even though it is a GET', () => {
    const result = audit([get('/v1/projects/project-a/jobs')]);
    expect(result.violations.map((violation) => violation.request.path)).toEqual([
      '/v1/projects/project-a/jobs',
    ]);
  });

  it('fails a foreign document read', () => {
    expect(audit([get('/v1/projects/project-a/document')]).violations).toHaveLength(1);
  });

  it('fails a derivative read of an asset the owner does not hold', () => {
    expect(audit([get(derivatives('project-a', 'asset-stranger'))]).violations).toHaveLength(1);
  });

  it('fails a derivative read that names a project which does not own the asset', () => {
    expect(audit([get(derivatives('project-b', 'asset-a'))]).violations).toHaveLength(1);
  });

  it('fails every foreign write, and the preflight of a foreign job request', () => {
    const result = audit([
      { method: 'POST', path: '/v1/projects/project-a/assets', status: 201 },
      { method: 'PUT', path: '/v1/projects/project-a/document', status: 200 },
      { method: 'OPTIONS', path: '/v1/projects/project-a/jobs', status: 204 },
      { method: 'POST', path: '/v1/projects/project-a/jobs', status: 201 },
      { method: 'DELETE', path: derivatives('project-a', 'asset-a'), status: 204 },
    ]);
    expect(result.violations).toHaveLength(5);
    expect(result.ownedForeignReads).toBe(0);
  });

  it('fails an owned derivative read of another project that the server refused', () => {
    const result = audit([get(derivatives('project-a', 'asset-a'), 403)]);
    expect(result.violations).toHaveLength(1);
    expect(result.ownedForeignReads).toBe(0);
  });

  it('fails a request for a project the owner does not hold', () => {
    expect(
      audit([get('/v1/projects/project-other/assets/asset-x/derivatives', 404)]).violations,
    ).toHaveLength(1);
  });

  it('fails unbound and transitional ids wherever they appear', () => {
    const result = audit([
      get('/v1/projects/unbound-123/jobs'),
      get('/v1/projects/project-transitional-1/document'),
    ]);
    expect(result.violations).toHaveLength(2);
  });

  it('leaves the ensure route, non-project routes and the bound project to the spec', () => {
    const result = audit([
      { method: 'POST', path: '/v1/projects/ensure', status: 201 },
      get('/v1/library/my-assets'),
      get('/v1/workers'),
      get('/v1/projects/project-own/jobs'),
      { method: 'PUT', path: '/v1/projects/project-own/document', status: 200 },
    ]);
    expect(result.violations).toEqual([]);
    expect(result.ownedForeignReads).toBe(0);
  });

  it('matches an encoded asset id against the owned asset it names', () => {
    const result = audit([get('/v1/projects/project-a/assets/asset%2Da/derivatives')]);
    expect(result.violations).toEqual([]);
    expect(result.ownedForeignReads).toBe(1);
  });

  it('fails every foreign read when the owner holds no assets', () => {
    const result = auditProjectRequests({
      served: [get(derivatives('project-a', 'asset-a'))],
      boundProjectIds: BOUND,
      ownedAssets: [],
    });
    expect(result.violations).toHaveLength(1);
  });

  it('fails a library read that names a foreign project in its query', () => {
    const result = audit([get('/v1/library/my-assets', 200, 'projectId=project-a')]);
    expect(result.violations).toHaveLength(1);
  });

  it('passes a library read whose query names only the bound project', () => {
    const result = audit([get('/v1/library/my-assets', 200, '?projectId=project-own')]);
    expect(result.violations).toEqual([]);
  });

  it('fails a provider request that names a foreign project in its query', () => {
    const result = audit([get('/v1/providers/audio/denoise', 200, 'projectId=project-a')]);
    expect(result.violations).toHaveLength(1);
  });

  it('fails an unbound id that appears only in a query', () => {
    const result = audit([get('/v1/library/my-assets', 200, 'projectId=unbound-9')]);
    expect(result.violations).toHaveLength(1);
  });

  it('does not count an abandoned owned read as a success, and fails none for it', () => {
    const result = audit([get(derivatives('project-a', 'asset-a'), null)]);
    expect(result.violations).toEqual([]);
    expect(result.ownedForeignReads).toBe(0);
  });

  it('fails an abandoned read of a derivative the owner does not hold', () => {
    const result = audit([get(derivatives('project-a', 'asset-stranger'), null)]);
    expect(result.violations).toHaveLength(1);
  });
});

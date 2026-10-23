// Classifies the project requests the packaged app sent to the API server. The server log names each
// request's method, path, query and status, as the router reads them; this module decides which of them
// the session was allowed to make. It is pure, so the unit test covers every rule without launching the
// packaged app.
//
// The packaged library ("My media") lists the owner's assets across all of the owner's projects and reads
// each asset's derivatives from that asset's own project. A session therefore reads other projects of the
// same owner, and only that is allowed: a GET (or its CORS preflight) for a derivative of an asset the
// owner's library lists in that project. Every other request that names a project the session did not
// bind fails, whatever its method or status, whether the project is named in the path or in a query
// parameter. An annotation can never pass a read.

export interface ServedRequest {
  readonly method: string;
  readonly path: string;
  /** The query string, with or without its leading "?". Absent or empty when there is none. */
  readonly query?: string;
  /** The status the server sent, or null when the client abandoned the response before it finished. */
  readonly status: number | null;
}

/** One asset of the owner's library, as the API's my-assets listing names it. */
export interface OwnedAsset {
  readonly id: string;
  readonly projectId: string;
}

export interface ProjectRequestAuditInput {
  readonly served: readonly ServedRequest[];
  /** The projects the packaged renderer bound for the owner. The spec checks those requests itself. */
  readonly boundProjectIds: ReadonlySet<string>;
  /** The owner's library, read from the API rather than from the app. */
  readonly ownedAssets: readonly OwnedAsset[];
}

export interface ProjectRequestViolation {
  readonly request: ServedRequest;
  readonly reason: string;
}

export interface ProjectRequestAudit {
  readonly violations: readonly ProjectRequestViolation[];
  /** Successful GET derivative reads of owned assets in projects the session did not bind. */
  readonly ownedForeignReads: number;
}

export const ENSURE_PATH = '/v1/projects/ensure';
/** The collection path. A create names no project in its path, so the path rules never see it. */
const PROJECTS_PATH = '/v1/projects';

const PROJECT_PATH = /^\/v1\/projects\/([^/]+)/u;
const DERIVATIVE_PATH = /^\/v1\/projects\/([^/]+)\/assets\/([^/]+)\/derivatives$/u;
const UNBOUND_OR_TRANSITIONAL = /unbound-|transitional/u;

/** The project a request path names. The ensure route names none in its path. */
export function projectIdOf(path: string): string | undefined {
  if (path === ENSURE_PATH) return undefined;
  return PROJECT_PATH.exec(path)?.[1];
}

/** The project ids a query names, under any parameter whose key mentions a project. */
export function queryProjectIds(query: string | undefined): string[] {
  const ids: string[] = [];
  for (const [key, value] of new URLSearchParams(query ?? '')) {
    if (/project/iu.test(key) && value !== '') ids.push(value);
  }
  return ids;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function ownedAssetsByProject(assets: readonly OwnedAsset[]): Map<string, Set<string>> {
  const byProject = new Map<string, Set<string>>();
  for (const asset of assets) {
    const ids = byProject.get(asset.projectId) ?? new Set<string>();
    ids.add(asset.id);
    byProject.set(asset.projectId, ids);
  }
  return byProject;
}

export function auditProjectRequests(input: ProjectRequestAuditInput): ProjectRequestAudit {
  const ownedByProject = ownedAssetsByProject(input.ownedAssets);
  const violations: ProjectRequestViolation[] = [];
  let ownedForeignReads = 0;
  for (const request of input.served) {
    if (request.path === PROJECTS_PATH && request.method === 'POST') {
      violations.push({
        request,
        reason: 'creates a project; the session binds projects through ensure only',
      });
      continue;
    }
    if (UNBOUND_OR_TRANSITIONAL.test(`${request.path}?${request.query ?? ''}`)) {
      violations.push({ request, reason: 'names an unbound or transitional id' });
      continue;
    }
    // No owned derivative read carries a query, so a project the session did not bind named in a query
    // fails whatever the path is.
    if (queryProjectIds(request.query).some((id) => !input.boundProjectIds.has(id))) {
      violations.push({
        request,
        reason: 'names a project this session did not bind in its query',
      });
      continue;
    }
    const projectId = projectIdOf(request.path);
    if (projectId === undefined || input.boundProjectIds.has(projectId)) continue;

    const derivative = DERIVATIVE_PATH.exec(request.path);
    const ownsDerivative =
      derivative !== null &&
      ownedByProject.get(safeDecode(derivative[1] ?? ''))?.has(safeDecode(derivative[2] ?? '')) ===
        true;
    if (!ownsDerivative || (request.method !== 'GET' && request.method !== 'OPTIONS')) {
      violations.push({
        request,
        reason: 'names a project this session did not bind, outside an owned derivative read',
      });
      continue;
    }
    // A preflight is the browser's permission check for the owned read it precedes; it reads nothing.
    if (request.method === 'OPTIONS') continue;
    // The client abandoned the read before the server finished it: neither a success nor a refusal.
    if (request.status === null) continue;
    if (request.status >= 400) {
      violations.push({
        request,
        reason: 'an owned derivative read of another project was refused',
      });
      continue;
    }
    ownedForeignReads += 1;
  }
  return { violations, ownedForeignReads };
}

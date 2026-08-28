import type { ControlPlane } from './control-plane.js';
import type { ApiReadinessOptions } from './http-server.js';
import type { PrivateObjectStore } from './private-object-store.js';

interface ReadinessQueryClient {
  query(sql: string): Promise<unknown>;
}

export interface ProductionReadinessDependencies {
  readonly pool: ReadinessQueryClient | undefined;
  readonly durableControlPlane: ControlPlane | undefined;
  readonly privateObjectStore: PrivateObjectStore | undefined;
}

/**
 * Production readiness is deliberately fail-closed. The schema probe resolves
 * the critical persistence, asset, and job tables without reading row data.
 */
export function productionReadinessOptions(
  dependencies: ProductionReadinessDependencies,
): ApiReadinessOptions {
  return {
    checks: {
      database: async () => {
        if (dependencies.pool === undefined) return false;
        await dependencies.pool.query('SELECT 1');
        return true;
      },
      controlPlane: async () => {
        if (dependencies.pool === undefined || dependencies.durableControlPlane === undefined)
          return false;
        await dependencies.pool.query(
          'SELECT 1 FROM projects, project_documents, media_assets, jobs LIMIT 0',
        );
        return true;
      },
      // The current adapter has no non-mutating remote health operation. Still
      // fail closed when private cloud storage is not configured at all.
      privateObjectStore: () => dependencies.privateObjectStore !== undefined,
    },
  };
}

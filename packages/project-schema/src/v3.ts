/**
 * Schema v3 — the v2 creative document plus durable Living Look instances.
 *
 * v3 is additive in the same way v2 was. Every v2 field keeps its meaning, and
 * the one new container (`lookInstances`) is optional. A v2 document is a valid
 * v3 document with no Looks applied, which is what lets L1 land the schema
 * without touching an editing surface: nothing reads `lookInstances` until the
 * L2 Look compiler and panel do.
 *
 * Instances are stored, never the definitions — those are code in
 * `@joy-media/motion-core`. Each instance pins the exact `definitionVersion` it
 * compiled against, so upgrading a pack is always an explicit action.
 */

import type { ProjectDiagnostic } from './model.js';
import type { JoyProjectV1 } from './v1.js';
import type { JoyProjectV2 } from './v2.js';
import { validateJoyProjectV2 } from './v2.js';
import { validateLookInstances, type LookInstancesV3 } from './living-look.js';

export const LATEST_PROJECT_SCHEMA_VERSION = 3;

export interface JoyProjectV3 extends Omit<JoyProjectV2, 'schemaVersion'> {
  readonly schemaVersion: 3;
  /**
   * Applied Look instances, keyed by instance id. Absent means the project has
   * never applied a Look — distinct from an empty map, which a project that
   * applied and then detached every Look would have.
   */
  readonly lookInstances?: LookInstancesV3;
}

export type AnyJoyProjectV3 = JoyProjectV1 | JoyProjectV2 | JoyProjectV3;

export function isJoyProjectV3(project: {
  readonly schemaVersion: number;
}): project is JoyProjectV3 {
  return project.schemaVersion === 3;
}

export function validateJoyProjectV3(value: unknown): ProjectDiagnostic[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [
      { code: 'PROJECT_SCHEMA_V3_NOT_OBJECT', message: 'project must be an object', path: '' },
    ];
  }
  const candidate = value as Record<string, unknown>;
  const diagnostics: ProjectDiagnostic[] = [];

  if (candidate.schemaVersion !== 3) {
    diagnostics.push({
      code: 'PROJECT_SCHEMA_V3_VERSION',
      message: 'schemaVersion must be 3',
      path: 'schemaVersion',
    });
  }

  // The v2 body (which itself delegates the v1 body) is validated by the v2
  // validator rather than a reimplementation, so the layers can never disagree
  // about what a composition, artifact, or workflow is. Its version check is
  // the one rule that does not apply here.
  diagnostics.push(
    ...validateJoyProjectV2({ ...candidate, schemaVersion: 2 }).filter(
      (entry) => entry.code !== 'PROJECT_SCHEMA_V2_VERSION',
    ),
  );

  diagnostics.push(...validateLookInstances(candidate.lookInstances));

  return diagnostics;
}

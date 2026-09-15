/**
 * The canonical per-project Look Instances document (R2 / GAP 1a).
 *
 * A Look *definition* is code (a pack in `@joy-media/motion-core`). A Look
 * *instance* is the project's record of one definition applied to one
 * composition — see `./living-look.ts`. Those instances need to be saved,
 * reopened, adjusted, detached and carried in a project package.
 *
 * They live here, in their own document with its own persistence log, rather
 * than as a field on the creative document. That keeps a single authoritative
 * copy, leaves the ~60-file `JoyProjectV1` visual-document surface untouched,
 * and lets the editor join this document to the creative document through the
 * existing compound-write journal (atomic commit / recovery / undo-redo) — the
 * same pattern the workflow-graph and creative-artifact documents already use.
 *
 * This is a first-class document with its **own** `schemaVersion`. It reuses
 * the `LookInstance` / `LookInstancesV3` value types from `./living-look.ts`
 * but is deliberately not "the v3 project schema" — a `JoyProjectV3` never
 * carries these, and this document never carries a composition.
 */

import type { ProjectDiagnostic } from './model.js';
import { validateLookInstances, type LookInstance, type LookInstancesV3 } from './living-look.js';

export const LOOK_INSTANCES_DOCUMENT_SCHEMA_VERSION = 1;

export interface LookInstancesDocument {
  /** Shares the editor project id, like every other per-project document. */
  readonly id: string;
  readonly schemaVersion: typeof LOOK_INSTANCES_DOCUMENT_SCHEMA_VERSION;
  /**
   * Applied Look instances, keyed by instance id. An empty map is a project
   * that has applied and then detached every Look; a legacy project that never
   * had this document loads as an empty map too. The two are indistinguishable
   * on purpose — "no Look is applied" is the only fact either conveys.
   */
  readonly instances: LookInstancesV3;
}

/** The document a project has before any Look is ever applied. */
export function emptyLookInstancesDocument(id: string): LookInstancesDocument {
  return { id, schemaVersion: LOOK_INSTANCES_DOCUMENT_SCHEMA_VERSION, instances: {} };
}

const CODE = {
  notObject: 'LOOK_INSTANCES_DOC_NOT_OBJECT',
  version: 'LOOK_INSTANCES_DOC_VERSION',
  id: 'LOOK_INSTANCES_DOC_ID',
  instances: 'LOOK_INSTANCES_DOC_INSTANCES',
} as const;

/**
 * Structural validation for the whole document. An unsupported `schemaVersion`
 * is a hard error, never a silent downgrade: a future document must fail to
 * open on an old build rather than be reinterpreted as v1 and truncated.
 *
 * Note this does **not** check that a binding target or created-entity id still
 * names a live visual object — a dangling reference is a content condition the
 * L2 compiler and the panel resolve at use, not a reason to refuse to load.
 */
export function validateLookInstancesDocument(
  value: unknown,
  path = 'lookInstances',
): ProjectDiagnostic[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [{ code: CODE.notObject, message: 'look instances document must be an object', path }];
  }
  const candidate = value as Record<string, unknown>;
  const diagnostics: ProjectDiagnostic[] = [];

  if (candidate.schemaVersion !== LOOK_INSTANCES_DOCUMENT_SCHEMA_VERSION) {
    diagnostics.push({
      code: CODE.version,
      message: `schemaVersion must be ${LOOK_INSTANCES_DOCUMENT_SCHEMA_VERSION}`,
      path: `${path}.schemaVersion`,
    });
  }

  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    diagnostics.push({
      code: CODE.id,
      message: 'id must be a non-empty string',
      path: `${path}.id`,
    });
  }

  if (
    candidate.instances === null ||
    typeof candidate.instances !== 'object' ||
    Array.isArray(candidate.instances)
  ) {
    diagnostics.push({
      code: CODE.instances,
      message: 'instances must be an object keyed by instance id',
      path: `${path}.instances`,
    });
  } else {
    diagnostics.push(...validateLookInstances(candidate.instances, `${path}.instances`));
  }

  return diagnostics;
}

export type { LookInstance, LookInstancesV3 };

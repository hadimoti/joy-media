/**
 * Living Look durable instances (R2 / L1).
 *
 * A Look *definition* is code — a versioned pack in `@joy-media/motion-core`
 * that declares typed slots, controls and binding targets. A Look *instance* is
 * the project-owned record of one definition applied to one composition: which
 * entities its slots resolved to, what the operator set the controls to, and
 * which of its bindings the operator has since hand-edited (overrides).
 *
 * Instances are persisted separately from definitions on purpose. Upgrading a
 * pack must be an explicit action — a new definition version never silently
 * reaches into an existing pinned instance — so the instance carries the exact
 * `definitionVersion` it was compiled against, not "latest".
 *
 * These records are ordinary project data. They never carry a URL, a file
 * path, a credential, or an executable payload; the compiler in L2 only ever
 * reads declared scalar/enum/color/font control values and stable entity ids.
 */

import type { ProjectDiagnostic } from './model.js';

/**
 * One Look definition applied to one composition.
 *
 * - `entityBindings` maps a definition slot's stable binding id to the id of
 *   the project entity that slot resolved to. Keys are binding identity, not a
 *   translated display label.
 * - `controlValues` is the operator's setting for each declared control. Only
 *   the three scalar JSON primitives are legal; the pack decides how each maps
 *   onto a real property range (L2).
 * - `overriddenBindingIds` are bindings the operator has hand-edited through
 *   the canonical operation path. Reapplying the Look leaves them alone unless
 *   an explicit reset names them.
 * - `createdEntityIds` are the entities this instance authored (titles, accent
 *   shapes, …). Detach keeps them as ordinary editable content; removal needs
 *   an explicit intent and only ever lists these ids.
 */
export interface LookInstance {
  readonly id: string;
  readonly definitionId: string;
  readonly definitionVersion: number;
  readonly compositionId: string;
  readonly entityBindings: Readonly<Record<string, string>>;
  readonly controlValues: Readonly<Record<string, number | string | boolean>>;
  readonly overriddenBindingIds: readonly string[];
  readonly createdEntityIds: readonly string[];
}

/**
 * Whether the Look compiler may write `bindingId` on `instance`.
 *
 * A hand-edited binding is protected: reapplying the Look never clobbers it.
 * `resetOverrides` is the operator's explicit "put this back under Look
 * control" — passed as `true` only for the specific bindings a reset names.
 */
export function isLookBindingWritable(
  bindingId: string,
  instance: LookInstance,
  resetOverrides: boolean,
): boolean {
  return resetOverrides || !instance.overriddenBindingIds.includes(bindingId);
}

/** A stable id token: letters, digits, and `_ - .` separators, 1–128 chars. */
const LOOK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

/**
 * Payload shapes that must never appear in a Look instance value. A Look is
 * data the compiler trusts; a URL, an object-store ref, a filesystem path, or
 * an executable fragment reaching the compiler would turn a "style" into a
 * fetch or an eval. Matched against string control values and binding targets.
 */
const LOOK_FORBIDDEN_VALUE_PATTERNS: readonly RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\//iu, // any scheme://host — http, ftp, gs, s3, ws…
  /\bdata:/iu,
  /\bblob:/iu,
  /\bjavascript:/iu,
  /<\/?script\b/iu,
  /[<>]\s*(?:img|iframe|svg|object|embed)\b/iu,
  /\bon[a-z]+\s*=/iu, // inline event handler
  /[$]\{.*\}/u, // template-literal interpolation
  /=>|\bfunction\s*\(/u, // arrow / function expression
  /\.\.[/\\]/u, // path traversal
  /^[A-Za-z]:[\\/]/u, // Windows drive path
];

const CODE = {
  notObject: 'PROJECT_SCHEMA_LOOK_INSTANCE_NOT_OBJECT',
  id: 'PROJECT_SCHEMA_LOOK_INSTANCE_ID',
  definitionId: 'PROJECT_SCHEMA_LOOK_INSTANCE_DEFINITION_ID',
  definitionVersion: 'PROJECT_SCHEMA_LOOK_INSTANCE_DEFINITION_VERSION',
  compositionId: 'PROJECT_SCHEMA_LOOK_INSTANCE_COMPOSITION_ID',
  entityBindings: 'PROJECT_SCHEMA_LOOK_INSTANCE_ENTITY_BINDINGS',
  bindingTarget: 'PROJECT_SCHEMA_LOOK_INSTANCE_BINDING_TARGET',
  controlValues: 'PROJECT_SCHEMA_LOOK_INSTANCE_CONTROL_VALUES',
  controlType: 'PROJECT_SCHEMA_LOOK_INSTANCE_CONTROL_TYPE',
  controlValue: 'PROJECT_SCHEMA_LOOK_INSTANCE_CONTROL_VALUE',
  override: 'PROJECT_SCHEMA_LOOK_INSTANCE_OVERRIDE',
  createdEntity: 'PROJECT_SCHEMA_LOOK_INSTANCE_CREATED_ENTITY',
  forbidden: 'PROJECT_SCHEMA_LOOK_INSTANCE_FORBIDDEN_VALUE',
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsForbiddenPayload(value: string): boolean {
  return LOOK_FORBIDDEN_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Structural validation for one persisted `LookInstance`. Returns a diagnostic
 * per problem; an empty array means the record is safe to hand to the L2
 * compiler. This does **not** check that the referenced definition, composition
 * or entities exist — that needs project context and belongs to the operation
 * layer.
 */
export function validateLookInstance(value: unknown, path = ''): ProjectDiagnostic[] {
  const at = (suffix: string): string => (path === '' ? suffix : `${path}.${suffix}`);
  if (!isPlainObject(value)) {
    return [{ code: CODE.notObject, message: 'look instance must be an object', path }];
  }
  const diagnostics: ProjectDiagnostic[] = [];
  const candidate = value;

  if (typeof candidate.id !== 'string' || !LOOK_ID_PATTERN.test(candidate.id)) {
    diagnostics.push({ code: CODE.id, message: 'id must be a stable id token', path: at('id') });
  }
  if (typeof candidate.definitionId !== 'string' || !LOOK_ID_PATTERN.test(candidate.definitionId)) {
    diagnostics.push({
      code: CODE.definitionId,
      message: 'definitionId must be a stable id token',
      path: at('definitionId'),
    });
  }
  if (
    typeof candidate.definitionVersion !== 'number' ||
    !Number.isInteger(candidate.definitionVersion) ||
    candidate.definitionVersion < 1
  ) {
    diagnostics.push({
      code: CODE.definitionVersion,
      message: 'definitionVersion must be a positive integer',
      path: at('definitionVersion'),
    });
  }
  if (typeof candidate.compositionId !== 'string' || candidate.compositionId.length === 0) {
    diagnostics.push({
      code: CODE.compositionId,
      message: 'compositionId must be a non-empty string',
      path: at('compositionId'),
    });
  }

  const bindingIds = new Set<string>();
  if (!isPlainObject(candidate.entityBindings)) {
    diagnostics.push({
      code: CODE.entityBindings,
      message: 'entityBindings must be an object keyed by binding id',
      path: at('entityBindings'),
    });
  } else {
    for (const [bindingId, target] of Object.entries(candidate.entityBindings)) {
      bindingIds.add(bindingId);
      if (!LOOK_ID_PATTERN.test(bindingId)) {
        diagnostics.push({
          code: CODE.entityBindings,
          message: `binding id "${bindingId}" is not a stable id token`,
          path: at(`entityBindings.${bindingId}`),
        });
      }
      if (typeof target !== 'string' || target.length === 0) {
        diagnostics.push({
          code: CODE.bindingTarget,
          message: 'binding target must be a non-empty entity id',
          path: at(`entityBindings.${bindingId}`),
        });
        continue;
      }
      if (containsForbiddenPayload(target)) {
        diagnostics.push({
          code: CODE.forbidden,
          message: 'binding target must not be a URL, path, or executable payload',
          path: at(`entityBindings.${bindingId}`),
        });
      }
    }
  }

  if (!isPlainObject(candidate.controlValues)) {
    diagnostics.push({
      code: CODE.controlValues,
      message: 'controlValues must be an object keyed by control id',
      path: at('controlValues'),
    });
  } else {
    for (const [controlId, controlValue] of Object.entries(candidate.controlValues)) {
      const controlPath = at(`controlValues.${controlId}`);
      if (!LOOK_ID_PATTERN.test(controlId)) {
        diagnostics.push({
          code: CODE.controlValues,
          message: `control id "${controlId}" is not a stable id token`,
          path: controlPath,
        });
      }
      const kind = typeof controlValue;
      if (kind !== 'number' && kind !== 'string' && kind !== 'boolean') {
        diagnostics.push({
          code: CODE.controlType,
          message: 'control value must be a number, string, or boolean',
          path: controlPath,
        });
        continue;
      }
      if (kind === 'number' && !Number.isFinite(controlValue)) {
        diagnostics.push({
          code: CODE.controlValue,
          message: 'numeric control value must be finite',
          path: controlPath,
        });
      }
      if (kind === 'string' && containsForbiddenPayload(controlValue as string)) {
        diagnostics.push({
          code: CODE.forbidden,
          message: 'string control value must not be a URL, path, or executable payload',
          path: controlPath,
        });
      }
    }
  }

  if (!Array.isArray(candidate.overriddenBindingIds)) {
    diagnostics.push({
      code: CODE.override,
      message: 'overriddenBindingIds must be an array',
      path: at('overriddenBindingIds'),
    });
  } else {
    const seen = new Set<string>();
    candidate.overriddenBindingIds.forEach((entry, index) => {
      if (typeof entry !== 'string' || entry.length === 0) {
        diagnostics.push({
          code: CODE.override,
          message: 'override entry must be a non-empty binding id',
          path: at(`overriddenBindingIds[${index}]`),
        });
        return;
      }
      if (seen.has(entry)) {
        diagnostics.push({
          code: CODE.override,
          message: `override "${entry}" is listed more than once`,
          path: at(`overriddenBindingIds[${index}]`),
        });
      }
      seen.add(entry);
      // An override that names no known binding is dead state that would keep a
      // binding locked with nothing able to explain why.
      if (bindingIds.size > 0 && !bindingIds.has(entry)) {
        diagnostics.push({
          code: CODE.override,
          message: `override "${entry}" does not name a known binding`,
          path: at(`overriddenBindingIds[${index}]`),
        });
      }
    });
  }

  if (!Array.isArray(candidate.createdEntityIds)) {
    diagnostics.push({
      code: CODE.createdEntity,
      message: 'createdEntityIds must be an array',
      path: at('createdEntityIds'),
    });
  } else {
    const seen = new Set<string>();
    candidate.createdEntityIds.forEach((entry, index) => {
      if (typeof entry !== 'string' || entry.length === 0) {
        diagnostics.push({
          code: CODE.createdEntity,
          message: 'created entity id must be a non-empty string',
          path: at(`createdEntityIds[${index}]`),
        });
        return;
      }
      if (seen.has(entry)) {
        diagnostics.push({
          code: CODE.createdEntity,
          message: `created entity "${entry}" is listed more than once`,
          path: at(`createdEntityIds[${index}]`),
        });
      }
      seen.add(entry);
    });
  }

  return diagnostics;
}

/**
 * The project-document container for Look instances: a map keyed by instance
 * id. Absent means the project has never applied a Look — distinct from an
 * empty map, which a project that applied and then detached every Look would
 * have.
 */
export type LookInstancesV3 = Readonly<Record<string, LookInstance>>;

const CODE_INSTANCES = 'PROJECT_SCHEMA_LOOK_INSTANCES';
const CODE_INSTANCE_KEY = 'PROJECT_SCHEMA_LOOK_INSTANCE_KEY';

/** Validate the whole `lookInstances` map. */
export function validateLookInstances(value: unknown, path = 'lookInstances'): ProjectDiagnostic[] {
  if (value === undefined) return [];
  if (!isPlainObject(value)) {
    return [
      {
        code: CODE_INSTANCES,
        message: 'lookInstances must be an object keyed by instance id',
        path,
      },
    ];
  }
  const diagnostics: ProjectDiagnostic[] = [];
  for (const [key, instance] of Object.entries(value)) {
    diagnostics.push(...validateLookInstance(instance, `${path}.${key}`));
    if (isPlainObject(instance) && instance.id !== key) {
      diagnostics.push({
        code: CODE_INSTANCE_KEY,
        message: `lookInstances key "${key}" does not match the instance's id`,
        path: `${path}.${key}.id`,
      });
    }
  }
  return diagnostics;
}

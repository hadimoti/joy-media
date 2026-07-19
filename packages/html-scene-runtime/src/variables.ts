/**
 * Typed scene variables (§39-69). A scene declares a variable schema; JOY
 * resolves the user's overrides against it, applying defaults and rejecting bad
 * values. Resolution is pure and total: it always returns a full value set plus
 * diagnostics, so a bad override degrades one field instead of breaking render.
 */

import { isRecord, sceneDiagnostic } from './diagnostics.js';
import type { SceneDiagnostic } from './diagnostics.js';

export type SceneVariableType = 'string' | 'number' | 'boolean' | 'color' | 'enum';

export type SceneVariableValue = string | number | boolean;

export interface SceneVariableDef {
  readonly type: SceneVariableType;
  readonly label?: string;
  readonly default: SceneVariableValue;
  /** Allowed values for `enum`. */
  readonly options?: readonly string[];
  /** Inclusive bounds for `number`. */
  readonly min?: number;
  readonly max?: number;
}

export type SceneVariableSchema = Readonly<Record<string, SceneVariableDef>>;

export interface ResolvedVariables {
  readonly values: Readonly<Record<string, SceneVariableValue>>;
  readonly diagnostics: readonly SceneDiagnostic[];
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Validates the schema shape itself (defaults must satisfy their own types). */
export function validateVariableSchema(schema: unknown): SceneDiagnostic[] {
  const diagnostics: SceneDiagnostic[] = [];
  if (!isRecord(schema))
    return [sceneDiagnostic('SCENE_VARIABLES_SCHEMA', 'variable schema must be an object')];
  for (const [key, def] of Object.entries(schema)) {
    const path = `variables.${key}`;
    if (!isRecord(def) || typeof def.type !== 'string') {
      diagnostics.push(sceneDiagnostic('SCENE_VARIABLES_SCHEMA', 'variable def is invalid', path));
      continue;
    }
    if (!['string', 'number', 'boolean', 'color', 'enum'].includes(def.type)) {
      diagnostics.push(
        sceneDiagnostic('SCENE_VARIABLES_SCHEMA', `unknown type "${def.type}"`, path),
      );
      continue;
    }
    if (def.type === 'enum' && (!Array.isArray(def.options) || def.options.length === 0))
      diagnostics.push(
        sceneDiagnostic('SCENE_VARIABLES_SCHEMA', 'enum requires a non-empty options list', path),
      );
    const defaultError = checkValue(def as unknown as SceneVariableDef, def.default);
    if (defaultError !== undefined)
      diagnostics.push(sceneDiagnostic('SCENE_VARIABLES_SCHEMA', `default ${defaultError}`, path));
  }
  return diagnostics;
}

/** Resolves user overrides against a schema: defaults fill gaps, bad values are reported. */
export function resolveSceneVariables(
  schema: SceneVariableSchema,
  provided: Readonly<Record<string, unknown>> = {},
): ResolvedVariables {
  const values: Record<string, SceneVariableValue> = {};
  const diagnostics: SceneDiagnostic[] = [];
  for (const [key, def] of Object.entries(schema)) {
    const path = `variables.${key}`;
    if (!(key in provided)) {
      values[key] = def.default;
      continue;
    }
    const error = checkValue(def, provided[key]);
    if (error === undefined) {
      values[key] = provided[key] as SceneVariableValue;
    } else {
      values[key] = def.default;
      diagnostics.push(sceneDiagnostic('SCENE_VARIABLES_VALUE', error, path));
    }
  }
  for (const key of Object.keys(provided))
    if (!(key in schema))
      diagnostics.push(
        sceneDiagnostic(
          'SCENE_VARIABLES_UNKNOWN',
          `"${key}" is not a declared variable`,
          `variables.${key}`,
        ),
      );
  return { values, diagnostics };
}

function checkValue(def: SceneVariableDef, value: unknown): string | undefined {
  switch (def.type) {
    case 'string':
      return typeof value === 'string' ? undefined : 'must be a string';
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'must be a boolean';
    case 'color':
      return typeof value === 'string' && HEX_COLOR.test(value) ? undefined : 'must be a hex color';
    case 'enum':
      return typeof value === 'string' && (def.options ?? []).includes(value)
        ? undefined
        : 'must be one of the declared options';
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a finite number';
      if (def.min !== undefined && value < def.min) return `must be >= ${def.min}`;
      if (def.max !== undefined && value > def.max) return `must be <= ${def.max}`;
      return undefined;
    }
    default:
      return 'has an unknown type';
  }
}

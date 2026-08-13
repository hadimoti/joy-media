import { sceneDiagnostic } from './diagnostics.js';
import type { SceneDiagnostic } from './diagnostics.js';
import type { SceneInputDefV1, SceneInputSchemaV1 } from './manifest.js';

export type SceneInputValue = number | readonly [number, number] | string;

export interface ResolvedSceneInputs {
  readonly values: Readonly<Record<string, SceneInputValue>>;
  readonly diagnostics: readonly SceneDiagnostic[];
}

export function resolveSceneInputs(
  schema: SceneInputSchemaV1 = {},
  provided: Readonly<Record<string, unknown>> = {},
): ResolvedSceneInputs {
  const values: Record<string, SceneInputValue> = {};
  const diagnostics: SceneDiagnostic[] = [];
  for (const [key, def] of Object.entries(schema)) {
    const candidate = provided[key];
    if (candidate === undefined) {
      values[key] = cloneValue(def.default);
      continue;
    }
    const error = validateValue(def, candidate);
    if (error === undefined) values[key] = cloneValue(candidate as SceneInputValue);
    else {
      values[key] = cloneValue(def.default);
      diagnostics.push(sceneDiagnostic('SCENE_INPUT_VALUE', error, `inputs.${key}`));
    }
  }
  for (const key of Object.keys(provided))
    if (!(key in schema))
      diagnostics.push(
        sceneDiagnostic('SCENE_INPUT_UNKNOWN', `"${key}" is not declared`, `inputs.${key}`),
      );
  return { values, diagnostics };
}

function validateValue(def: SceneInputDefV1, value: unknown): string | undefined {
  if (def.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a finite number';
    return validateRange(def, value);
  }
  if (def.kind === 'vector2') {
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !value.every((part) => typeof part === 'number' && Number.isFinite(part))
    )
      return 'must be a finite vector2';
    return value.map((part) => validateRange(def, part)).find((error) => error !== undefined);
  }
  return typeof value === 'string' && /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)
    ? undefined
    : 'must be a #RRGGBB or #RRGGBBAA color';
}

function validateRange(def: SceneInputDefV1, value: number): string | undefined {
  if (def.constraints?.min !== undefined && value < def.constraints.min)
    return `must be >= ${def.constraints.min}`;
  if (def.constraints?.max !== undefined && value > def.constraints.max)
    return `must be <= ${def.constraints.max}`;
  return undefined;
}

function cloneValue(value: SceneInputValue): SceneInputValue {
  return Array.isArray(value) ? ([value[0]!, value[1]!] as const) : value;
}

/** Only manifest-declared `ctx.inputs.<name>` reads are accepted. */
export function validateSceneInputAccess(
  source: string,
  schema: SceneInputSchemaV1 = {},
): readonly SceneDiagnostic[] {
  const diagnostics: SceneDiagnostic[] = [];
  const accessPattern = /\b(?:ctx|context)\.inputs\.([A-Za-z_$][\w$]*)/g;
  for (const match of source.matchAll(accessPattern)) {
    if (!(match[1]! in schema))
      diagnostics.push(
        sceneDiagnostic('SCENE_INPUT_UNKNOWN', `"${match[1]}" is not declared`, 'source'),
      );
  }
  if (/\b(?:document|window|HTMLElement|CSSStyleDeclaration)\b/.test(source))
    diagnostics.push(
      sceneDiagnostic(
        'SCENE_INPUT_DOM_DENIED',
        'DOM/CSS mutation is not allowed in deterministic scenes',
        'source',
      ),
    );
  return diagnostics;
}

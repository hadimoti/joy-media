/**
 * Production scene manifest (§20.4). Extends the P00.4 spike manifest with a
 * bundle entry, a variables-schema reference, and a network permission
 * allowlist. Manifests are untrusted input from scene packages, so validation
 * is a diagnostics boundary, not exceptions.
 */

import type { TimeUs } from '@joy-media/project-schema';
import { isNonEmptyString, isPositiveInteger, isRecord, sceneDiagnostic } from './diagnostics.js';
import type { SceneDiagnostic } from './diagnostics.js';

export type SceneStoragePermission = 'none';

export interface ScenePermissionsV1 {
  /** Allowlisted network origins (e.g. "https://cdn.example.com"); `[]` = no network. */
  readonly network: readonly string[];
  readonly storage: SceneStoragePermission;
}

export interface SceneDeterminismV1 {
  /** Scenes must use JOY's seeded stream — the runtime denies Math.random otherwise. */
  readonly seededRandom: boolean;
  /** Wall-clock access must stay off for deterministic export. */
  readonly wallClock: boolean;
}

export type SceneInputKind = 'number' | 'vector2' | 'color';

export interface SceneInputConstraint {
  readonly min?: number;
  readonly max?: number;
}

export interface SceneInputDefV1 {
  readonly kind: SceneInputKind;
  readonly default: number | readonly [number, number] | string;
  /** WP34 scenes are sampled by JOY; hold is the only portable policy. */
  readonly animation: 'hold';
  readonly constraints?: SceneInputConstraint;
}

export type SceneInputSchemaV1 = Readonly<Record<string, SceneInputDefV1>>;

export interface SceneManifestV1 {
  readonly formatVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly runtime: 'joy-html-scene-1';
  /** Compiled bundle entry, relative to the package root (e.g. "dist/index.js"). */
  readonly entry: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly transparent: boolean;
  readonly durationUs: TimeUs;
  readonly permissions: ScenePermissionsV1;
  readonly determinism: SceneDeterminismV1;
  /** Explicit scene-local inputs; undeclared paths are not runtime-accessible. */
  readonly inputs?: SceneInputSchemaV1;
  /** Path to the variables JSON schema inside the package, when the scene has variables. */
  readonly variablesSchema?: string;
}

const ORIGIN = /^https:\/\/[^/]+$/;

/** A manifest may only name a file inside its own scene package. */
export function isScenePackagePath(value: unknown, extension?: string): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.includes('\0')
  )
    return false;
  if (
    value.startsWith('/') ||
    value.split('/').some((segment) => segment === '' || segment === '.')
  )
    return false;
  if (value.split('/').some((segment) => segment === '..')) return false;
  return extension === undefined || value.endsWith(extension);
}

/** Validates an untrusted manifest, returning coded diagnostics (empty = valid). */
export function validateSceneManifest(value: unknown): SceneDiagnostic[] {
  const diagnostics: SceneDiagnostic[] = [];
  if (!isRecord(value))
    return [sceneDiagnostic('SCENE_MANIFEST_NOT_OBJECT', 'manifest must be an object')];
  if (value.formatVersion !== 1)
    diagnostics.push(
      sceneDiagnostic('SCENE_MANIFEST_VERSION', 'formatVersion must be 1', 'formatVersion'),
    );
  if (value.runtime !== 'joy-html-scene-1')
    diagnostics.push(
      sceneDiagnostic('SCENE_MANIFEST_RUNTIME', 'runtime must be "joy-html-scene-1"', 'runtime'),
    );
  if (!isNonEmptyString(value.id))
    diagnostics.push(sceneDiagnostic('SCENE_MANIFEST_ID', 'id is required', 'id'));
  if (!isNonEmptyString(value.version))
    diagnostics.push(sceneDiagnostic('SCENE_MANIFEST_VERSION', 'version is required', 'version'));
  if (!isScenePackagePath(value.entry, '.js'))
    diagnostics.push(
      sceneDiagnostic(
        'SCENE_MANIFEST_ENTRY',
        'entry must be a package-relative .js file path',
        'entry',
      ),
    );
  if (
    !isRecord(value.viewport) ||
    !isPositiveInteger(value.viewport.width) ||
    !isPositiveInteger(value.viewport.height)
  )
    diagnostics.push(
      sceneDiagnostic('SCENE_MANIFEST_VIEWPORT', 'viewport must be positive integers', 'viewport'),
    );
  if (typeof value.transparent !== 'boolean')
    diagnostics.push(
      sceneDiagnostic('SCENE_MANIFEST_TRANSPARENT', 'transparent must be a boolean', 'transparent'),
    );
  if (!isPositiveInteger(value.durationUs))
    diagnostics.push(
      sceneDiagnostic(
        'SCENE_MANIFEST_DURATION',
        'durationUs must be a positive integer',
        'durationUs',
      ),
    );
  validatePermissions(value.permissions, diagnostics);
  validateDeterminism(value.determinism, diagnostics);
  if (value.variablesSchema !== undefined && !isScenePackagePath(value.variablesSchema, '.json'))
    diagnostics.push(
      sceneDiagnostic(
        'SCENE_MANIFEST_VARIABLES_SCHEMA',
        'variablesSchema must be a package-relative .json file path when present',
        'variablesSchema',
      ),
    );
  validateInputs(value.inputs, diagnostics);
  return diagnostics;
}

function validateInputs(value: unknown, diagnostics: SceneDiagnostic[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    diagnostics.push(
      sceneDiagnostic('SCENE_MANIFEST_INPUTS', 'inputs must be an object', 'inputs'),
    );
    return;
  }
  for (const [key, input] of Object.entries(value)) {
    const path = `inputs.${key}`;
    if (!isRecord(input) || !['number', 'vector2', 'color'].includes(String(input.kind))) {
      diagnostics.push(sceneDiagnostic('SCENE_MANIFEST_INPUTS', 'input kind is invalid', path));
      continue;
    }
    if (input.animation !== 'hold')
      diagnostics.push(sceneDiagnostic('SCENE_MANIFEST_INPUTS', 'animation must be "hold"', path));
    const validDefault =
      input.kind === 'number'
        ? typeof input.default === 'number' && Number.isFinite(input.default)
        : input.kind === 'vector2'
          ? Array.isArray(input.default) &&
            input.default.length === 2 &&
            input.default.every((part) => typeof part === 'number' && Number.isFinite(part))
          : typeof input.default === 'string' &&
            /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(input.default);
    if (!validDefault)
      diagnostics.push(
        sceneDiagnostic('SCENE_MANIFEST_INPUTS', 'default does not match kind', path),
      );
    if (input.constraints !== undefined) {
      if (
        !isRecord(input.constraints) ||
        (input.constraints.min !== undefined &&
          (typeof input.constraints.min !== 'number' || !Number.isFinite(input.constraints.min))) ||
        (input.constraints.max !== undefined &&
          (typeof input.constraints.max !== 'number' || !Number.isFinite(input.constraints.max))) ||
        (input.constraints.min !== undefined &&
          input.constraints.max !== undefined &&
          input.constraints.min > input.constraints.max)
      )
        diagnostics.push(sceneDiagnostic('SCENE_MANIFEST_INPUTS', 'constraints are invalid', path));
    }
  }
}

function validatePermissions(value: unknown, diagnostics: SceneDiagnostic[]): void {
  if (!isRecord(value)) {
    diagnostics.push(
      sceneDiagnostic('SCENE_MANIFEST_PERMISSIONS', 'permissions must be an object', 'permissions'),
    );
    return;
  }
  if (
    !Array.isArray(value.network) ||
    !value.network.every((origin) => typeof origin === 'string' && ORIGIN.test(origin))
  )
    diagnostics.push(
      sceneDiagnostic(
        'SCENE_MANIFEST_PERMISSIONS',
        'permissions.network must be an array of https origins',
        'permissions.network',
      ),
    );
  if (value.storage !== 'none')
    diagnostics.push(
      sceneDiagnostic(
        'SCENE_MANIFEST_PERMISSIONS',
        'permissions.storage must be "none"',
        'permissions.storage',
      ),
    );
}

function validateDeterminism(value: unknown, diagnostics: SceneDiagnostic[]): void {
  if (!isRecord(value)) {
    diagnostics.push(
      sceneDiagnostic('SCENE_MANIFEST_DETERMINISM', 'determinism must be an object', 'determinism'),
    );
    return;
  }
  if (value.seededRandom !== true)
    diagnostics.push(
      sceneDiagnostic(
        'SCENE_MANIFEST_DETERMINISM',
        'determinism.seededRandom must be true',
        'determinism.seededRandom',
      ),
    );
  if (value.wallClock !== false)
    diagnostics.push(
      sceneDiagnostic(
        'SCENE_MANIFEST_DETERMINISM',
        'determinism.wallClock must be false',
        'determinism.wallClock',
      ),
    );
}

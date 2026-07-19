/**
 * Scene package CLI core (§39-66). Pure over an in-memory file set so it is
 * fully testable; the `bin/joy-scene.mjs` wrapper reads a real directory and
 * prints this report. It parses `scene.json` / `schema.json` / the entry source,
 * compiles the package, and returns coded diagnostics plus the bundle hash.
 */

import { sceneDiagnostic } from './diagnostics.js';
import type { SceneDiagnostic } from './diagnostics.js';
import { compileScenePackage } from './compile.js';
import type { SceneManifestV1 } from './manifest.js';
import type { SceneVariableSchema } from './variables.js';

export interface ScenePackageFiles {
  /** Contents of scene.json (the manifest). */
  readonly manifest: string;
  /** Contents of the entry source bundle. */
  readonly source: string;
  /** Contents of schema.json (the variable schema), when present. */
  readonly schema?: string;
  /** Contents of a variables.json override file, when present. */
  readonly variables?: string;
}

export interface ScenePackageReport {
  readonly ok: boolean;
  readonly manifestId?: string;
  readonly sourceSha256?: string;
  readonly csp?: string;
  readonly referenceFrameSha256?: string;
  readonly diagnostics: readonly SceneDiagnostic[];
}

function parseJson(
  label: string,
  path: string,
  raw: string,
  diagnostics: SceneDiagnostic[],
): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    diagnostics.push(
      sceneDiagnostic(
        'SCENE_PACKAGE_JSON',
        `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        path,
      ),
    );
    return undefined;
  }
}

/** Validates and compiles a scene package from its raw files. */
export function validateScenePackage(files: ScenePackageFiles): ScenePackageReport {
  const diagnostics: SceneDiagnostic[] = [];
  const manifest = parseJson('scene.json', 'scene.json', files.manifest, diagnostics);
  const schema =
    files.schema === undefined
      ? undefined
      : parseJson('schema.json', 'schema.json', files.schema, diagnostics);
  const variables =
    files.variables === undefined
      ? undefined
      : parseJson('variables.json', 'variables.json', files.variables, diagnostics);

  if (manifest === undefined) return { ok: false, diagnostics };

  const compiled = compileScenePackage({
    manifest: manifest as SceneManifestV1,
    source: files.source,
    ...(schema === undefined ? {} : { variableSchema: schema as SceneVariableSchema }),
    ...(variables === undefined ? {} : { variables: variables as Record<string, unknown> }),
  });

  const all = [...diagnostics, ...compiled.diagnostics];
  const manifestId = (manifest as { id?: unknown }).id;
  return {
    ok: all.length === 0,
    ...(typeof manifestId === 'string' ? { manifestId } : {}),
    sourceSha256: compiled.sourceSha256,
    ...(compiled.csp === undefined ? {} : { csp: compiled.csp }),
    ...(compiled.referenceFrameSha256 === undefined
      ? {}
      : { referenceFrameSha256: compiled.referenceFrameSha256 }),
    diagnostics: all,
  };
}

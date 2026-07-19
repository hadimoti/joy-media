/**
 * Scene compiler (§39-66). Ties a scene package together: validate the manifest
 * and variable schema, resolve variables, generate the CSP from permissions,
 * hash the bundle, and — for a deterministic, network-free scene — render one
 * reference frame through the proven P00.4 runtime to produce a stable frame
 * hash. Compile/runtime failures become diagnostics rather than throwing, so the
 * preview can show a placeholder (WP-04.4) instead of crashing.
 */

import { createHash } from 'node:crypto';
import { generateSceneCsp } from './csp.js';
import { sceneDiagnostic } from './diagnostics.js';
import type { SceneDiagnostic } from './diagnostics.js';
import { validateSceneManifest } from './manifest.js';
import type { SceneManifestV1 } from './manifest.js';
import { resolveSceneVariables, validateVariableSchema } from './variables.js';
import type { SceneVariableSchema, SceneVariableValue } from './variables.js';
import type { SceneResolvers } from './resolver.js';
import { createSandboxedReactScene } from './runtime.js';
import type { SceneManifest } from './runtime.js';

export interface ScenePackageInput {
  readonly manifest: SceneManifestV1;
  readonly source: string;
  readonly variableSchema?: SceneVariableSchema;
  readonly variables?: Readonly<Record<string, unknown>>;
  /** Resolver handles used for the deterministic reference frame, if needed. */
  readonly resolvers?: SceneResolvers;
}

export interface CompiledScene {
  readonly manifest: SceneManifestV1;
  readonly sourceSha256: string;
  /** Generated only when the manifest is structurally valid. */
  readonly csp?: string;
  readonly variables: Readonly<Record<string, SceneVariableValue>>;
  readonly diagnostics: readonly SceneDiagnostic[];
  /** Deterministic first-frame hash; present only for a rendered network-free scene. */
  readonly referenceFrameSha256?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const NETWORK_API = /\b(fetch|XMLHttpRequest|WebSocket)\b/;

/** Compiles and checks a scene package without executing any network I/O. */
export function compileScenePackage(input: ScenePackageInput): CompiledScene {
  const diagnostics: SceneDiagnostic[] = [];
  const manifestDiagnostics = validateSceneManifest(input.manifest);
  diagnostics.push(...manifestDiagnostics);

  if (input.variableSchema !== undefined)
    diagnostics.push(...validateVariableSchema(input.variableSchema));

  const resolved =
    input.variableSchema !== undefined
      ? resolveSceneVariables(input.variableSchema, input.variables ?? {})
      : { values: {}, diagnostics: [] as readonly SceneDiagnostic[] };
  diagnostics.push(...resolved.diagnostics);

  const networkFree = input.manifest.permissions?.network?.length === 0;
  if (networkFree && NETWORK_API.test(input.source))
    diagnostics.push(
      sceneDiagnostic(
        'SCENE_COMPILE_NETWORK',
        'source uses a network API while no network permission is declared',
        'source',
      ),
    );

  const manifestValid = manifestDiagnostics.length === 0;
  const csp = manifestValid ? generateSceneCsp(input.manifest.permissions) : undefined;
  const sourceSha256 = sha256(input.source);

  let referenceFrameSha256: string | undefined;
  if (manifestValid && networkFree) {
    try {
      const scene = createSandboxedReactScene(toSpikeManifest(input.manifest), input.source);
      const frame = scene.render({
        timeUs: 0,
        frameRate: { num: 30, den: 1 },
        seed: `${input.manifest.id}@${input.manifest.version}`,
        variables: resolved.values,
        locale: 'en',
        ...(input.resolvers === undefined ? {} : { resolvers: input.resolvers }),
      });
      referenceFrameSha256 = frame.sha256;
    } catch (error) {
      diagnostics.push(
        sceneDiagnostic(
          'SCENE_COMPILE_RENDER',
          error instanceof Error ? error.message : String(error),
          'source',
        ),
      );
    }
  }

  return {
    manifest: input.manifest,
    sourceSha256,
    ...(csp === undefined ? {} : { csp }),
    variables: resolved.values,
    diagnostics,
    ...(referenceFrameSha256 === undefined ? {} : { referenceFrameSha256 }),
  };
}

/** Narrows a production manifest to the P00 execution harness's spike manifest. */
function toSpikeManifest(manifest: SceneManifestV1): SceneManifest {
  return {
    formatVersion: 1,
    id: manifest.id,
    version: manifest.version,
    runtime: 'joy-html-scene-1',
    viewport: manifest.viewport,
    transparent: manifest.transparent,
    durationUs: manifest.durationUs,
    permissions: { network: [], storage: 'none' },
    determinism: { seededRandom: true, wallClock: false },
  };
}

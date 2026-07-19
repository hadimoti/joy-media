/**
 * @joy-media/html-scene-runtime — deterministic HTML/React scene package system.
 *
 * WP-00.4 provided the sandboxed reference execution (`runtime.ts`). WP-04.3
 * builds the production package layer on top: manifest, permissions→CSP, typed
 * variables, asset/font resolution, a compiler, a React starter, and a CLI.
 */
export const PACKAGE_NAME = '@joy-media/html-scene-runtime' as const;

export type { SceneDiagnostic } from './diagnostics.js';

export type {
  SceneManifest,
  JoySceneContext,
  SceneRenderRequest,
  CapturedSceneFrame,
  SandboxedReactScene,
} from './runtime.js';
export { SceneSandboxError, createSandboxedReactScene, captureSceneFrames } from './runtime.js';

export type {
  SceneManifestV1,
  ScenePermissionsV1,
  SceneDeterminismV1,
  SceneStoragePermission,
} from './manifest.js';
export { isScenePackagePath, validateSceneManifest } from './manifest.js';

export { generateSceneCsp } from './csp.js';

export type {
  SceneVariableDef,
  SceneVariableSchema,
  SceneVariableType,
  SceneVariableValue,
  ResolvedVariables,
} from './variables.js';
export { resolveSceneVariables, validateVariableSchema } from './variables.js';

export type { JoySceneAssetResolver, JoySceneFontResolver, SceneResolvers } from './resolver.js';
export { createManifestResolver, findUnresolved, SceneAssetError } from './resolver.js';

export type { CompiledScene, ScenePackageInput } from './compile.js';
export { compileScenePackage } from './compile.js';

export type {
  ScenePreviewMessage,
  ScenePreviewEvent,
  ScenePreviewUpdate,
  ScenePreviewLifecycle,
  ScenePreviewReady,
  ScenePreviewFailure,
  ScenePreviewEndpoint,
  SandboxedIframeDescriptor,
} from './preview-protocol.js';
export {
  createSandboxedIframeDescriptor,
  invalidPreviewMessageDiagnostic,
  ScenePreviewSession,
  validateScenePreviewEvent,
  validateScenePreviewMessage,
} from './preview-protocol.js';

export type {
  HeadlessCaptureRequest,
  HeadlessSceneDriver,
  HeadlessSurface,
  SceneCaptureRequest,
  CapturedSceneSurface,
  CapturedSceneRegion,
  SceneVisualTolerance,
  SceneSurfaceComparison,
} from './headless.js';
export {
  captureSceneRegion,
  captureSceneSurface,
  compareSceneSurfaces,
  SceneCaptureCache,
} from './headless.js';

export type { ChromiumSceneDriverOptions } from './chromium-driver.js';
export {
  createChromiumSceneDriver,
  findChromiumExecutable,
  readChromiumVersion,
} from './chromium-driver.js';

export type { SceneDiagnosticPlaceholder } from './placeholder.js';
export { createSceneDiagnosticPlaceholder } from './placeholder.js';

export type {
  FirstPartySceneId,
  FirstPartyScenePackage,
  ResolvedSceneInstance,
} from './first-party.js';
export {
  findFirstPartyScene,
  FIRST_PARTY_SCENES,
  resolveFirstPartySceneInstance,
} from './first-party.js';

export type { ScenePackageFiles, ScenePackageReport } from './cli.js';
export { validateScenePackage } from './cli.js';

export {
  createStarterScenePackage,
  REACT_STARTER_SCENE_SOURCE,
  REACT_STARTER_VARIABLE_SCHEMA,
  starterManifest,
} from './template.js';

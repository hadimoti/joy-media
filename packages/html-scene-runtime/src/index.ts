/** @joy-media/html-scene-runtime — deterministic React scene contract (WP-00.4). */
export const PACKAGE_NAME = '@joy-media/html-scene-runtime' as const;

export type {
  SceneManifest,
  JoySceneContext,
  SceneRenderRequest,
  CapturedSceneFrame,
  SandboxedReactScene,
} from './runtime.js';
export { SceneSandboxError, createSandboxedReactScene, captureSceneFrames } from './runtime.js';

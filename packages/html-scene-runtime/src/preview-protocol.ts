/**
 * Preview iframe protocol (WP-04.4). The host and an `allow-scripts` scene
 * iframe exchange only versioned, structured messages; neither side receives a
 * host object, DOM handle, or arbitrary command channel.
 */

import { generateSceneCsp } from './csp.js';
import { isRecord, sceneDiagnostic } from './diagnostics.js';
import type { SceneDiagnostic } from './diagnostics.js';
import type { SceneManifestV1 } from './manifest.js';

export interface ScenePreviewUpdate {
  readonly type: 'joy.scene.update.v1';
  readonly instanceId: string;
  readonly timeUs: number;
  readonly variables: Readonly<Record<string, string | number | boolean>>;
}

export interface ScenePreviewLifecycle {
  readonly type: 'joy.scene.suspend.v1' | 'joy.scene.resume.v1';
  readonly instanceId: string;
}

export type ScenePreviewMessage = ScenePreviewUpdate | ScenePreviewLifecycle;

export interface ScenePreviewReady {
  readonly type: 'joy.scene.ready.v1';
  readonly instanceId: string;
}

export interface ScenePreviewFailure {
  readonly type: 'joy.scene.failure.v1';
  readonly instanceId: string;
  readonly diagnostic: SceneDiagnostic;
}

export type ScenePreviewEvent = ScenePreviewReady | ScenePreviewFailure;

export interface SandboxedIframeDescriptor {
  readonly sandbox: 'allow-scripts';
  readonly srcDoc: string;
  readonly csp: string;
}

export interface ScenePreviewEndpoint {
  postMessage(message: ScenePreviewMessage, targetOrigin: '*'): void;
}

/**
 * Builds the strict iframe document. The bundle must be provided by a
 * controlled blob/data URL; no same-origin or storage capability is granted.
 */
export function createSandboxedIframeDescriptor(
  manifest: SceneManifestV1,
  bundleUrl: string,
): SandboxedIframeDescriptor {
  const csp = generateSceneCsp(manifest.permissions);
  const escapedCsp = csp.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const escapedBundleUrl = bundleUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  return {
    sandbox: 'allow-scripts',
    csp,
    srcDoc: [
      '<!doctype html>',
      '<html><head>',
      `<meta http-equiv="Content-Security-Policy" content="${escapedCsp}">`,
      '</head><body><div id="joy-scene-root"></div>',
      `<script type="module" src="${escapedBundleUrl}"></script>`,
      '</body></html>',
    ].join(''),
  };
}

/** A small lifecycle gate prevents offscreen scenes from consuming resources. */
export class ScenePreviewSession {
  #suspended = false;

  constructor(
    readonly instanceId: string,
    private readonly endpoint: ScenePreviewEndpoint,
  ) {}

  get suspended(): boolean {
    return this.#suspended;
  }

  update(timeUs: number, variables: ScenePreviewUpdate['variables']): boolean {
    if (this.#suspended) return false;
    this.endpoint.postMessage(
      { type: 'joy.scene.update.v1', instanceId: this.instanceId, timeUs, variables },
      '*',
    );
    return true;
  }

  suspend(): void {
    if (this.#suspended) return;
    this.#suspended = true;
    this.endpoint.postMessage({ type: 'joy.scene.suspend.v1', instanceId: this.instanceId }, '*');
  }

  resume(): void {
    if (!this.#suspended) return;
    this.#suspended = false;
    this.endpoint.postMessage({ type: 'joy.scene.resume.v1', instanceId: this.instanceId }, '*');
  }
}

export function validateScenePreviewMessage(value: unknown): ScenePreviewMessage | undefined {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.instanceId !== 'string')
    return undefined;
  if (value.type === 'joy.scene.suspend.v1' || value.type === 'joy.scene.resume.v1')
    return { type: value.type, instanceId: value.instanceId };
  if (
    value.type === 'joy.scene.update.v1' &&
    typeof value.timeUs === 'number' &&
    Number.isSafeInteger(value.timeUs) &&
    value.timeUs >= 0 &&
    isVariablesRecord(value.variables)
  )
    return {
      type: value.type,
      instanceId: value.instanceId,
      timeUs: value.timeUs,
      variables: value.variables,
    };
  return undefined;
}

export function validateScenePreviewEvent(value: unknown): ScenePreviewEvent | undefined {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.instanceId !== 'string')
    return undefined;
  if (value.type === 'joy.scene.ready.v1')
    return { type: value.type, instanceId: value.instanceId };
  if (value.type === 'joy.scene.failure.v1' && isDiagnostic(value.diagnostic))
    return { type: value.type, instanceId: value.instanceId, diagnostic: value.diagnostic };
  return undefined;
}

function isVariablesRecord(
  value: unknown,
): value is Readonly<Record<string, string | number | boolean>> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) =>
        typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean',
    )
  );
}

function isDiagnostic(value: unknown): value is SceneDiagnostic {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    typeof value.path === 'string'
  );
}

/** Converts a malformed iframe event into a stable diagnostic for the host. */
export function invalidPreviewMessageDiagnostic(): SceneDiagnostic {
  return sceneDiagnostic('SCENE_PREVIEW_MESSAGE_INVALID', 'scene preview message is invalid');
}

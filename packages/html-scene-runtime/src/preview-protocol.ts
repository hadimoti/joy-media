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

/** Host → scene: request an RGBA surface of the current painted frame. */
export interface ScenePreviewCapture {
  readonly type: 'joy.scene.capture.v1';
  readonly instanceId: string;
  readonly requestId: string;
  readonly width: number;
  readonly height: number;
}

export type ScenePreviewMessage =
  | ScenePreviewUpdate
  | ScenePreviewLifecycle
  | ScenePreviewCapture;

export interface ScenePreviewReady {
  readonly type: 'joy.scene.ready.v1';
  readonly instanceId: string;
}

export interface ScenePreviewFailure {
  readonly type: 'joy.scene.failure.v1';
  readonly instanceId: string;
  readonly diagnostic: SceneDiagnostic;
}

/** Scene → host: transferable RGBA bytes for Pixi `video-frame` bitmaps. */
export interface ScenePreviewSurface {
  readonly type: 'joy.scene.surface.v1';
  readonly instanceId: string;
  readonly requestId: string;
  readonly width: number;
  readonly height: number;
  readonly rgba: ArrayBuffer;
}

export type ScenePreviewEvent =
  | ScenePreviewReady
  | ScenePreviewFailure
  | ScenePreviewSurface;

export interface SandboxedIframeDescriptor {
  readonly sandbox: 'allow-scripts';
  readonly srcDoc: string;
  readonly csp: string;
}

const SAFE_BUNDLE_URL = /^(blob:|data:text\/javascript(?:;[^,]*)?,)/i;

/**
 * The only host↔scene bridge admitted into the opaque iframe. Scene bundles
 * subscribe to the DOM events below (or read `window.__joySceneContext`) and
 * must not expect a host object, DOM handle, or arbitrary command channel.
 */
const PREVIEW_BOOTSTRAP = `(function () {
  'use strict';
  var instanceId = null;
  var suspended = false;
  function validVariables(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.keys(value).every(function (key) {
      var item = value[key];
      return typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean';
    });
  }
  function captureSurface(requestId, width, height) {
    var root = document.getElementById('joy-scene-root');
    if (!root) {
      window.parent.postMessage({
        type: 'joy.scene.failure.v1',
        instanceId: instanceId || '',
        diagnostic: { code: 'SCENE_CAPTURE', message: 'joy-scene-root missing', path: 'root' }
      }, '*');
      return;
    }
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      window.parent.postMessage({
        type: 'joy.scene.failure.v1',
        instanceId: instanceId || '',
        diagnostic: { code: 'SCENE_CAPTURE', message: '2d context unavailable', path: 'canvas' }
      }, '*');
      return;
    }
    var html = new XMLSerializer().serializeToString(root);
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' +
      width +
      '" height="' +
      height +
      '">' +
      '<foreignObject width="100%" height="100%" requiredExtensions="http://www.w3.org/1999/xhtml">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' +
      width +
      'px;height:' +
      height +
      'px;margin:0;padding:0;overflow:hidden;background:transparent;">' +
      html +
      '</div></foreignObject></svg>';
    var blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      try {
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        var imageData = ctx.getImageData(0, 0, width, height);
        var buffer = imageData.data.buffer.slice(
          imageData.data.byteOffset,
          imageData.data.byteOffset + imageData.data.byteLength
        );
        window.parent.postMessage(
          {
            type: 'joy.scene.surface.v1',
            instanceId: instanceId || '',
            requestId: requestId,
            width: width,
            height: height,
            rgba: buffer
          },
          '*',
          [buffer]
        );
      } catch (error) {
        window.parent.postMessage({
          type: 'joy.scene.failure.v1',
          instanceId: instanceId || '',
          diagnostic: {
            code: 'SCENE_CAPTURE',
            message: error && error.message ? String(error.message) : 'capture failed',
            path: 'surface'
          }
        }, '*');
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      window.parent.postMessage({
        type: 'joy.scene.failure.v1',
        instanceId: instanceId || '',
        diagnostic: { code: 'SCENE_CAPTURE', message: 'svg rasterize failed', path: 'image' }
      }, '*');
    };
    img.src = url;
  }
  function receive(event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || typeof message !== 'object' || typeof message.type !== 'string' ||
        typeof message.instanceId !== 'string') return;
    if (instanceId !== null && message.instanceId !== instanceId) return;
    instanceId = message.instanceId;
    if (message.type === 'joy.scene.suspend.v1') { suspended = true; return; }
    if (message.type === 'joy.scene.resume.v1') { suspended = false; return; }
    if (message.type === 'joy.scene.capture.v1') {
      if (typeof message.requestId !== 'string' ||
          !Number.isSafeInteger(message.width) || message.width < 1 ||
          !Number.isSafeInteger(message.height) || message.height < 1) return;
      captureSurface(message.requestId, message.width, message.height);
      return;
    }
    if (message.type !== 'joy.scene.update.v1' || suspended ||
        !Number.isSafeInteger(message.timeUs) || message.timeUs < 0 ||
        !validVariables(message.variables)) return;
    var context = Object.freeze({
      timeUs: message.timeUs,
      variables: Object.freeze(Object.assign({}, message.variables))
    });
    window.__joySceneContext = context;
    window.dispatchEvent(new CustomEvent('joy.scene.update.v1', { detail: context }));
  }
  window.addEventListener('message', receive);
  window.parent.postMessage({ type: 'joy.scene.ready.v1', instanceId: '' }, '*');
}());`;

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
  if (!SAFE_BUNDLE_URL.test(bundleUrl)) {
    throw new RangeError('scene bundle URL must be a controlled blob: or data:text/javascript URL');
  }
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
      `<script>${PREVIEW_BOOTSTRAP}</script>`,
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
  ) {
    if (instanceId.length === 0) throw new RangeError('scene preview instanceId must be non-empty');
  }

  get suspended(): boolean {
    return this.#suspended;
  }

  update(timeUs: number, variables: ScenePreviewUpdate['variables']): boolean {
    if (!Number.isSafeInteger(timeUs) || timeUs < 0) {
      throw new RangeError('scene preview timeUs must be a non-negative safe integer');
    }
    if (this.#suspended) return false;
    this.endpoint.postMessage(
      { type: 'joy.scene.update.v1', instanceId: this.instanceId, timeUs, variables },
      '*',
    );
    return true;
  }

  capture(requestId: string, width: number, height: number): boolean {
    if (requestId.length === 0) throw new RangeError('scene capture requestId must be non-empty');
    if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1)
      throw new RangeError('scene capture size must be positive safe integers');
    if (this.#suspended) return false;
    this.endpoint.postMessage(
      {
        type: 'joy.scene.capture.v1',
        instanceId: this.instanceId,
        requestId,
        width,
        height,
      },
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
    value.type === 'joy.scene.capture.v1' &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    typeof value.width === 'number' &&
    Number.isSafeInteger(value.width) &&
    value.width > 0 &&
    typeof value.height === 'number' &&
    Number.isSafeInteger(value.height) &&
    value.height > 0
  )
    return {
      type: value.type,
      instanceId: value.instanceId,
      requestId: value.requestId,
      width: value.width,
      height: value.height,
    };
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
  if (
    value.type === 'joy.scene.surface.v1' &&
    typeof value.requestId === 'string' &&
    typeof value.width === 'number' &&
    Number.isSafeInteger(value.width) &&
    value.width > 0 &&
    typeof value.height === 'number' &&
    Number.isSafeInteger(value.height) &&
    value.height > 0 &&
    value.rgba instanceof ArrayBuffer
  )
    return {
      type: value.type,
      instanceId: value.instanceId,
      requestId: value.requestId,
      width: value.width,
      height: value.height,
      rgba: value.rgba,
    };
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

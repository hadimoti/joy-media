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
  /** Optional explicit shaped text lines; existing capture messages remain valid. */
  readonly lines?: readonly ScenePaintLine[];
}

export interface ScenePaintLine {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly height?: number;
  readonly font: string;
  readonly color?: string;
  readonly direction: 'ltr' | 'rtl';
  readonly align: 'start' | 'end' | 'left' | 'right' | 'center';
  readonly opacity?: number;
}

export interface ScenePreviewFontFace {
  readonly family: string;
  readonly weight: 400 | 700;
  readonly subset: 'arabic' | 'latin';
  /** Base64-encoded canonical WOFF2 bytes. */
  readonly bytesBase64: string;
}

export type ScenePreviewMessage = ScenePreviewUpdate | ScenePreviewLifecycle | ScenePreviewCapture;

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

export type ScenePreviewEvent = ScenePreviewReady | ScenePreviewFailure | ScenePreviewSurface;

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
export const SCENE_PAINT_SCRIPT = `(function () {
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
  function isTransparent(color) {
    return !color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)';
  }
  function resolveAlign(textAlign, rtl) {
    if (textAlign === 'center') return 'center';
    if (textAlign === 'end') return rtl ? 'left' : 'right';
    if (textAlign === 'right' || textAlign === 'left') return textAlign;
    return rtl ? 'right' : 'left';
  }
  function paintTree(ctx, root, width, height, explicitLines, background) {
    var rootRect = root.getBoundingClientRect();
    var rw = Math.max(1, rootRect.width || width);
    var rh = Math.max(1, rootRect.height || height);
    var sx = width / rw;
    var sy = height / rh;
    ctx.clearRect(0, 0, width, height);
    if (background && !isTransparent(background)) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
    function walk(node, inheritedX, inheritedY) {
      if (!node) return;
      if (node.nodeType === 3) {
        var text = String(node.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!text) return;
        var parent = node.parentElement;
        if (!parent) return;
        var ps = window.getComputedStyle(parent);
        if (ps.display === 'none' || ps.visibility === 'hidden') return;
        var opacity = parseFloat(ps.opacity);
        if (Number.isNaN(opacity)) opacity = 1;
        if (!(opacity > 0)) return;
        var pr = parent.getBoundingClientRect();
        ctx.save();
        ctx.fillStyle = ps.color || '#fff';
        ctx.font = ps.font || '16px sans-serif';
        ctx.direction = ps.direction === 'rtl' ? 'rtl' : 'ltr';
        var textAlign = resolveAlign(ps.textAlign, ps.direction === 'rtl');
        ctx.textAlign = textAlign;
        ctx.textBaseline = 'alphabetic';
        var metrics = ctx.measureText(text);
        var ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || (parseFloat(ps.fontSize) || 16) * 0.8;
        var textY = (pr.top - rootRect.top) * sy + inheritedY + ascent * sy;
        var textX = textAlign === 'right'
          ? (pr.right - rootRect.left) * sx + inheritedX
          : textAlign === 'center'
            ? (pr.left - rootRect.left + pr.width / 2) * sx + inheritedX
            : (pr.left - rootRect.left) * sx + inheritedX;
        if (!explicitLines || !explicitLines.length) {
          ctx.fillText(text, textX, textY, Math.max(1, pr.width * sx));
        }
        ctx.restore();
        return;
      }
      if (node.nodeType !== 1) return;
      var el = node;
      if (el.tagName === 'IMG') throw new Error('scene painter does not draw images');
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      var alpha = parseFloat(style.opacity);
      if (Number.isNaN(alpha)) alpha = 1;
      if (!(alpha > 0)) return;
      var rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        for (var c = el.firstChild; c; c = c.nextSibling) walk(c, inheritedX, inheritedY);
        return;
      }
      var localX = Number(el.getAttribute('data-joy-translate-x')) || 0;
      var localY = Number(el.getAttribute('data-joy-translate-y')) || 0;
      var translateX = inheritedX + localX * sx;
      var translateY = inheritedY + localY * sy;
      var x = (rect.left - rootRect.left) * sx + translateX;
      var y = (rect.top - rootRect.top) * sy + translateY;
      var w = rect.width * sx;
      var h = rect.height * sy;
      ctx.save();
      ctx.globalAlpha = alpha;
      if (!isTransparent(style.backgroundColor)) {
        ctx.fillStyle = style.backgroundColor;
        ctx.fillRect(x, y, w, h);
      }
      var bw = parseFloat(style.borderTopWidth) || 0;
      if (bw > 0 && !isTransparent(style.borderTopColor)) {
        ctx.strokeStyle = style.borderTopColor;
        ctx.lineWidth = Math.max(1, bw * Math.min(sx, sy));
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
      }
      for (var child = el.firstChild; child; child = child.nextSibling) walk(child, translateX, translateY);
      ctx.restore();
    }
    walk(root, 0, 0);
    if (explicitLines && explicitLines.length) {
      explicitLines.forEach(function (line) {
        ctx.save();
        ctx.font = line.font;
        ctx.fillStyle = line.color || '#fff';
        ctx.direction = line.direction === 'rtl' ? 'rtl' : 'ltr';
        ctx.textAlign = line.align || 'start';
        ctx.textBaseline = 'alphabetic';
        ctx.globalAlpha = line.opacity === undefined ? 1 : Math.max(0, Math.min(1, line.opacity));
        var metrics = ctx.measureText(line.text);
        var ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || 0;
        var descent = metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || 0;
        var baseline = line.y + ascent;
        if (line.height !== undefined) baseline = line.y + (line.height - ascent - descent) / 2 + ascent;
        ctx.fillText(line.text, line.x * sx, baseline * sy);
        ctx.restore();
      });
    }
  }
  async function captureSurface(requestId, width, height, lines) {
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
    // Paint the live laid-out DOM. SVG HTML embedding taints getImageData in Chromium.
    try {
      var fonts = [];
      (lines || []).forEach(function (line) { fonts.push([line.font, line.text]); });
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (var node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!String(node.textContent || '').trim() || !node.parentElement) continue;
        var style = window.getComputedStyle(node.parentElement);
        fonts.push([style.font || '16px sans-serif', String(node.textContent)]);
      }
      await Promise.all(fonts.map(function (entry) {
        return document.fonts.load(entry[0], entry[1]).then(function (loaded) {
          if (entry[0].indexOf('Noto Sans Arabic') !== -1 &&
              (!loaded.length || !document.fonts.check(entry[0], entry[1]))) {
            throw new Error('Noto Sans Arabic font face failed to load');
          }
        });
      }));
      await document.fonts.ready;
      paintTree(ctx, root, width, height, lines);
      var imageData = ctx.getImageData(0, 0, width, height);
      var buffer = imageData.data.buffer;
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
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  window.__joyPaintSceneSurface = function (width, height, lines, background) {
    var root = document.getElementById('joy-scene-root');
    if (!root) throw new Error('joy-scene-root missing');
    var canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2d context unavailable');
    paintTree(ctx, root, width, height, lines || [], background);
    var bytes = ctx.getImageData(0, 0, width, height).data;
    var binary = '';
    for (var start = 0; start < bytes.length; start += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(start, Math.min(start + 0x8000, bytes.length)));
    }
    canvas.width = 0; canvas.height = 0;
    return btoa(binary);
  };
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
      void captureSurface(message.requestId, message.width, message.height, message.lines);
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
  // Ready is posted by the scene bundle after __joyScene is defined (not here),
  // so host.update/capture never race an empty root.
}());`;

const PREVIEW_BOOTSTRAP = SCENE_PAINT_SCRIPT;

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
  fontFaces: readonly ScenePreviewFontFace[] = [],
): SandboxedIframeDescriptor {
  if (!SAFE_BUNDLE_URL.test(bundleUrl)) {
    throw new RangeError('scene bundle URL must be a controlled blob: or data:text/javascript URL');
  }
  const csp = generateSceneCsp(manifest.permissions);
  const escapedCsp = csp.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const escapedBundleUrl = bundleUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const fontCss = fontFaces
    .map((face) => {
      if (
        face.family !== 'Noto Sans Arabic' ||
        (face.weight !== 400 && face.weight !== 700) ||
        (face.subset !== 'arabic' && face.subset !== 'latin') ||
        face.bytesBase64.length > 200_000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(face.bytesBase64)
      ) {
        throw new RangeError('scene font face descriptor is invalid');
      }
      const unicodeRange =
        face.subset === 'arabic'
          ? 'U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF'
          : 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
      return `@font-face{font-family:'${face.family}';font-style:normal;font-weight:${face.weight};font-display:block;unicode-range:${unicodeRange};src:url(data:font/woff2;base64,${face.bytesBase64}) format('woff2');}`;
    })
    .join('');
  return {
    sandbox: 'allow-scripts',
    csp,
    srcDoc: [
      '<!doctype html>',
      '<html><head>',
      `<meta http-equiv="Content-Security-Policy" content="${escapedCsp}">`,
      `<style>${fontCss}html,body,#joy-scene-root{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;}</style>`,
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

  capture(
    requestId: string,
    width: number,
    height: number,
    lines?: readonly ScenePaintLine[],
  ): boolean {
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
        ...(lines === undefined ? {} : { lines }),
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
  ) {
    if (value.lines !== undefined && !isScenePaintLines(value.lines)) return undefined;
    return {
      type: value.type,
      instanceId: value.instanceId,
      requestId: value.requestId,
      width: value.width,
      height: value.height,
      ...(value.lines === undefined ? {} : { lines: value.lines }),
    };
  }
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

function isScenePaintLines(value: unknown): value is readonly ScenePaintLine[] {
  return (
    Array.isArray(value) &&
    value.every(
      (line) =>
        isRecord(line) &&
        typeof line.text === 'string' &&
        line.text.length > 0 &&
        typeof line.x === 'number' &&
        Number.isFinite(line.x) &&
        typeof line.y === 'number' &&
        Number.isFinite(line.y) &&
        (line.height === undefined ||
          (typeof line.height === 'number' && Number.isFinite(line.height) && line.height > 0)) &&
        typeof line.font === 'string' &&
        (line.direction === 'ltr' || line.direction === 'rtl') &&
        ['start', 'end', 'left', 'right', 'center'].includes(String(line.align)) &&
        (line.color === undefined || typeof line.color === 'string') &&
        (line.opacity === undefined ||
          (typeof line.opacity === 'number' &&
            Number.isFinite(line.opacity) &&
            line.opacity >= 0 &&
            line.opacity <= 1)),
    )
  );
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

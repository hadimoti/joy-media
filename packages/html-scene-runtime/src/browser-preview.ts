/**
 * Browser-only HTML scene preview host (opaque iframe → RGBA → Pixi).
 * Safe for Vite: no Node `vm` / Chromium driver imports.
 */

import type { FirstPartyScenePackage } from './first-party.js';
import { findFirstPartyScene, resolveFirstPartySceneInstance } from './first-party.js';
import {
  createSandboxedIframeDescriptor,
  ScenePreviewSession,
  validateScenePreviewEvent,
} from './preview-protocol.js';
import type { ScenePreviewSurface } from './preview-protocol.js';
import { resolveSceneVariables } from './variables.js';

export interface SceneSurfaceBitmap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface ScenePreviewHost {
  readonly instanceId: string;
  readonly iframe: HTMLIFrameElement;
  readonly session: ScenePreviewSession;
  readonly ready: Promise<void>;
  update(
    timeUs: number,
    variables: Readonly<Record<string, string | number | boolean>>,
  ): boolean;
  capture(width: number, height: number, timeoutMs?: number): Promise<SceneSurfaceBitmap>;
  destroy(): void;
}

/**
 * Minimal React.createElement → DOM for first-party scene sources inside the
 * opaque iframe (no network React bundle; CSP stays offline).
 */
function firstPartyBundleSource(sceneSource: string, durationUs: number): string {
  return `
const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat().filter((c) => c != null && c !== false) };
  }
};
${sceneSource}
function applyStyle(el, style) {
  if (!style || typeof style !== 'object') return;
  for (const [key, value] of Object.entries(style)) {
    if (value == null) continue;
    const cssKey = key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
    el.style[cssKey] = typeof value === 'number' && key !== 'opacity' && key !== 'zIndex'
      ? value + 'px'
      : String(value);
  }
}
function mount(node, parent) {
  if (typeof node === 'string' || typeof node === 'number') {
    parent.appendChild(document.createTextNode(String(node)));
    return;
  }
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  const el = document.createElement(node.type);
  const props = node.props || {};
  for (const [key, value] of Object.entries(props)) {
    if (key === 'style') applyStyle(el, value);
    else if (key === 'className') el.setAttribute('class', String(value));
    else if (key.startsWith('on')) continue;
    else if (value != null) el.setAttribute(key, String(value));
  }
  for (const child of node.children || []) mount(child, el);
  parent.appendChild(el);
}
function paint(detail) {
  const root = document.getElementById('joy-scene-root');
  if (!root || typeof globalThis.__joyScene !== 'function') return;
  const durationUs = ${durationUs};
  const timeUs = detail.timeUs;
  const progress = durationUs > 0 ? Math.min(1, Math.max(0, timeUs / durationUs)) : 0;
  const ctx = {
    timeUs,
    durationUs,
    progress,
    frameIndex: 0,
    frameRate: { num: 30, den: 1 },
    seed: 'preview',
    variables: detail.variables,
    assets: {},
    fonts: {},
    random: () => 0.5,
    locale: 'en',
  };
  root.replaceChildren();
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.margin = '0';
  root.style.overflow = 'hidden';
  mount(globalThis.__joyScene(ctx), root);
}
window.addEventListener('joy.scene.update.v1', (event) => paint(event.detail));
if (window.__joySceneContext) paint(window.__joySceneContext);
`;
}

export function createFirstPartySceneBundleUrl(scene: FirstPartyScenePackage): string {
  const source = firstPartyBundleSource(scene.source, scene.manifest.durationUs);
  return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
}

export function createScenePreviewHost(options: {
  readonly instanceId: string;
  readonly scene: FirstPartyScenePackage;
  readonly parent?: HTMLElement;
}): ScenePreviewHost {
  const bundleUrl = createFirstPartySceneBundleUrl(options.scene);
  const descriptor = createSandboxedIframeDescriptor(options.scene.manifest, bundleUrl);
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', descriptor.sandbox);
  iframe.srcdoc = descriptor.srcDoc;
  iframe.title = `joy-scene:${options.instanceId}`;
  iframe.style.cssText =
    'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;';
  const parent = options.parent ?? document.body;
  parent.appendChild(iframe);

  const sessionEndpoint = {
    postMessage(message: import('./preview-protocol.js').ScenePreviewMessage, _targetOrigin: '*'): void {
      iframe.contentWindow?.postMessage(message, '*');
    },
  };

  const session = new ScenePreviewSession(options.instanceId, sessionEndpoint);

  let readyResolve: () => void = () => undefined;
  let readyReject: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const pending = new Map<
    string,
    {
      readonly resolve: (bitmap: SceneSurfaceBitmap) => void;
      readonly reject: (error: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) return;
    const validated = validateScenePreviewEvent(event.data);
    if (validated === undefined) return;
    if (validated.type === 'joy.scene.ready.v1') {
      readyResolve();
      return;
    }
    if (validated.type === 'joy.scene.failure.v1') {
      const err = new Error(validated.diagnostic.message);
      for (const [id, waiter] of pending) {
        clearTimeout(waiter.timer);
        waiter.reject(err);
        pending.delete(id);
      }
      readyReject(err);
      return;
    }
    if (validated.type === 'joy.scene.surface.v1') {
      const waiter = pending.get(validated.requestId);
      if (waiter === undefined) return;
      clearTimeout(waiter.timer);
      pending.delete(validated.requestId);
      waiter.resolve(surfaceToBitmap(validated));
    }
  };
  window.addEventListener('message', onMessage);

  // Ready may race if iframe posts before listener attaches — also treat load as ready.
  iframe.addEventListener('load', () => readyResolve(), { once: true });

  return {
    instanceId: options.instanceId,
    iframe,
    session,
    ready,
    update(timeUs, variables) {
      return session.update(timeUs, variables);
    },
    async capture(width, height, timeoutMs = 2_500) {
      await ready;
      const requestId = `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise<SceneSurfaceBitmap>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error('scene capture timed out'));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        if (!session.capture(requestId, width, height)) {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(new Error('scene capture suppressed while suspended'));
        }
      });
    },
    destroy() {
      window.removeEventListener('message', onMessage);
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('scene preview host destroyed'));
      }
      pending.clear();
      iframe.remove();
      URL.revokeObjectURL(bundleUrl);
    },
  };
}

function surfaceToBitmap(surface: ScenePreviewSurface): SceneSurfaceBitmap {
  return {
    width: surface.width,
    height: surface.height,
    data: new Uint8ClampedArray(surface.rgba),
  };
}

/** Resolve default variables for a first-party scene package id. */
export function defaultVariablesForScene(
  scenePackageId: string,
): Readonly<Record<string, string | number | boolean>> {
  const scene = findFirstPartyScene(scenePackageId);
  if (scene === undefined) return {};
  const resolved = resolveSceneVariables(scene.variableSchema, {});
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(resolved.values)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      out[key] = value;
  }
  return out;
}

export function viewportForScene(scenePackageId: string): { width: number; height: number } {
  const scene = findFirstPartyScene(scenePackageId);
  return scene?.manifest.viewport ?? { width: 1080, height: 1920 };
}

export {
  findFirstPartyScene,
  resolveFirstPartySceneInstance,
  type FirstPartyScenePackage,
};

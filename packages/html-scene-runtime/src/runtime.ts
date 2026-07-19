/**
 * P00.4 deterministic HTML Scene runtime contract.
 *
 * A scene is source code that returns a React element. The Node `vm` harness is
 * intentionally a contract test harness, not the production security boundary;
 * production uses a sandboxed frame or isolated process (ADR-0006).
 */

import { createHash } from 'node:crypto';
import { Script, createContext } from 'node:vm';
import type { Context } from 'node:vm';
import { frameIndexAtUs, frameStartUs, rational } from '@joy-media/project-schema';
import type { Rational, TimeUs } from '@joy-media/project-schema';
import { createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export interface SceneManifest {
  readonly formatVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly runtime: 'joy-html-scene-1';
  readonly viewport: { readonly width: number; readonly height: number };
  readonly transparent: boolean;
  readonly durationUs: TimeUs;
  readonly permissions: { readonly network: readonly string[]; readonly storage: 'none' };
  readonly determinism: { readonly seededRandom: true; readonly wallClock: false };
}

export interface JoySceneContext<TVariables> {
  readonly timeUs: TimeUs;
  readonly durationUs: TimeUs;
  readonly progress: number;
  readonly frameIndex: number;
  readonly frameRate: Rational;
  readonly seed: string;
  readonly variables: Readonly<TVariables>;
  /** Deterministic scene-local random stream; reset for every captured frame. */
  readonly random: () => number;
  readonly locale: string;
}

export interface SceneRenderRequest<TVariables> {
  readonly timeUs: TimeUs;
  readonly frameRate: Rational;
  readonly seed: string;
  readonly variables: TVariables;
  readonly locale: string;
}

export interface CapturedSceneFrame {
  readonly timeUs: TimeUs;
  readonly frameIndex: number;
  readonly markup: string;
  readonly sha256: string;
}

export class SceneSandboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SceneSandboxError';
    this.code = code;
  }
}

/** A compiled scene can be advanced only by explicit JOY time requests. */
export interface SandboxedReactScene<TVariables> {
  readonly manifest: SceneManifest;
  readonly sourceSha256: string;
  render(request: SceneRenderRequest<TVariables>): CapturedSceneFrame;
}

/**
 * Compiles a parameterized React scene with an allowlisted global scope. Static
 * rejection makes accidental network use a clear policy error before rendering.
 */
export function createSandboxedReactScene<TVariables>(
  manifest: SceneManifest,
  source: string,
): SandboxedReactScene<TVariables> {
  validateManifest(manifest);
  rejectNetworkUse(source);
  const sandbox = createSceneContext();
  try {
    new Script(`'use strict';\n${source}`, { filename: `${manifest.id}.scene.js` }).runInContext(
      sandbox,
      {
        timeout: 50,
      },
    );
  } catch (error) {
    throw sceneFailure('SCENE_SANDBOX_COMPILE_FAILED', error);
  }
  const scene = sandbox.__joyScene;
  if (typeof scene !== 'function') {
    throw new SceneSandboxError(
      'SCENE_SANDBOX_INVALID_EXPORT',
      'scene source must assign a function to globalThis.__joyScene',
    );
  }

  return {
    manifest,
    sourceSha256: sha256(source),
    render(request): CapturedSceneFrame {
      validateRenderRequest(manifest, request);
      const context = createJoyContext(manifest, request);
      sandbox.__joyContext = context;
      try {
        new Script(
          'globalThis.__joyResult = globalThis.__joyScene(globalThis.__joyContext);',
        ).runInContext(sandbox, { timeout: 50 });
      } catch (error) {
        throw sceneFailure('SCENE_SANDBOX_EXECUTION_FAILED', error);
      } finally {
        sandbox.__joyContext = undefined;
      }
      const element = sandbox.__joyResult;
      sandbox.__joyResult = undefined;
      if (!isValidElement(element)) {
        throw new SceneSandboxError(
          'SCENE_SANDBOX_INVALID_RESULT',
          'scene must return a React element',
        );
      }
      const markup = renderToStaticMarkup(element);
      return {
        timeUs: context.timeUs,
        frameIndex: context.frameIndex,
        markup,
        sha256: sha256(markup),
      };
    },
  };
}

/** Captures an exact frame sequence at the declared rational rate, end-exclusive. */
export function captureSceneFrames<TVariables>(
  scene: SandboxedReactScene<TVariables>,
  request: Omit<SceneRenderRequest<TVariables>, 'timeUs'>,
): readonly CapturedSceneFrame[] {
  const frames: CapturedSceneFrame[] = [];
  for (let frameIndex = 0; ; frameIndex++) {
    const timeUs = frameStartUs(frameIndex, request.frameRate);
    if (timeUs >= scene.manifest.durationUs) return frames;
    frames.push(scene.render({ ...request, timeUs }));
  }
}

type SceneVmContext = Context & {
  __joyScene?: unknown;
  __joyContext?: unknown;
  __joyResult?: unknown;
};

function createSceneContext(): SceneVmContext {
  // Only the React element factory is exposed: no renderer, DOM, Node module
  // loader, timers, network APIs, or host application references cross in.
  const safeMath = Object.freeze({
    abs: Math.abs,
    ceil: Math.ceil,
    floor: Math.floor,
    max: Math.max,
    min: Math.min,
    round: Math.round,
    random: () => {
      throw new Error('Math.random is unavailable before JOY provides a frame context');
    },
  });
  return createContext({
    React: Object.freeze({ createElement }),
    Math: safeMath,
    Date: undefined,
    fetch: undefined,
    XMLHttpRequest: undefined,
    WebSocket: undefined,
    navigator: undefined,
    process: undefined,
    require: undefined,
    setInterval: undefined,
    setTimeout: undefined,
    requestAnimationFrame: undefined,
  }) as SceneVmContext;
}

function createJoyContext<TVariables>(
  manifest: SceneManifest,
  request: SceneRenderRequest<TVariables>,
): JoySceneContext<TVariables> {
  const random = seededRandom(`${request.seed}:${request.timeUs}`);
  return Object.freeze({
    timeUs: request.timeUs,
    durationUs: manifest.durationUs,
    progress: request.timeUs / manifest.durationUs,
    frameIndex: frameIndexAtUs(request.timeUs, request.frameRate),
    frameRate: request.frameRate,
    seed: request.seed,
    variables: deepFreeze(structuredClone(request.variables)),
    random,
    locale: request.locale,
  });
}

function validateManifest(manifest: SceneManifest): void {
  if (manifest.formatVersion !== 1 || manifest.runtime !== 'joy-html-scene-1') {
    throw new SceneSandboxError(
      'SCENE_MANIFEST_INVALID',
      'unsupported scene manifest version/runtime',
    );
  }
  if (
    manifest.id.length === 0 ||
    manifest.version.length === 0 ||
    !Number.isSafeInteger(manifest.durationUs) ||
    manifest.durationUs <= 0
  ) {
    throw new SceneSandboxError(
      'SCENE_MANIFEST_INVALID',
      'manifest id, version, and duration are required',
    );
  }
  if (
    !Number.isSafeInteger(manifest.viewport.width) ||
    !Number.isSafeInteger(manifest.viewport.height) ||
    manifest.viewport.width <= 0 ||
    manifest.viewport.height <= 0
  ) {
    throw new SceneSandboxError(
      'SCENE_MANIFEST_INVALID',
      'manifest viewport must be positive integers',
    );
  }
  if (manifest.permissions.network.length !== 0 || manifest.permissions.storage !== 'none') {
    throw new SceneSandboxError(
      'SCENE_SANDBOX_PERMISSION_DENIED',
      'P00 scenes permit neither network nor storage',
    );
  }
  if (!manifest.determinism.seededRandom || manifest.determinism.wallClock) {
    throw new SceneSandboxError(
      'SCENE_MANIFEST_INVALID',
      'P00 scenes require seeded randomness and no wall clock',
    );
  }
}

function validateRenderRequest<TVariables>(
  manifest: SceneManifest,
  request: SceneRenderRequest<TVariables>,
): void {
  if (
    !Number.isSafeInteger(request.timeUs) ||
    request.timeUs < 0 ||
    request.timeUs >= manifest.durationUs
  ) {
    throw new SceneSandboxError(
      'SCENE_RENDER_TIME_INVALID',
      'timeUs must be inside the scene duration',
    );
  }
  try {
    rational(request.frameRate.num, request.frameRate.den);
  } catch (error) {
    throw sceneFailure('SCENE_RENDER_RATE_INVALID', error);
  }
}

function rejectNetworkUse(source: string): void {
  if (/\b(fetch|XMLHttpRequest|WebSocket)\b/.test(source)) {
    throw new SceneSandboxError(
      'SCENE_SANDBOX_NETWORK_DENIED',
      'scene source references a network API while network permission is disabled',
    );
  }
}

function seededRandom(seed: string): () => number {
  let state = hash32(seed);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sceneFailure(code: string, error: unknown): SceneSandboxError {
  const message = error instanceof Error ? error.message : String(error);
  return new SceneSandboxError(code, message);
}

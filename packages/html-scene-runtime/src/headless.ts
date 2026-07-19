/**
 * Deterministic capture boundary (WP-04.4). A pinned browser implementation
 * supplies pixels, while this module owns time/frame identity, alpha metadata,
 * and bounded frame/region caches. Keeping it adapter-based avoids baking a
 * browser API into the scene package contract.
 */

import { createHash } from 'node:crypto';
import type { Rational, TimeUs } from '@joy-media/project-schema';
import type { SandboxedReactScene } from './runtime.js';
import type { SceneResolvers } from './resolver.js';

export interface HeadlessCaptureRequest {
  readonly markup: string;
  readonly width: number;
  readonly height: number;
  readonly transparent: boolean;
  readonly timeUs: TimeUs;
  readonly frameRate: Rational;
  readonly locale: string;
  readonly seed: string;
}

export interface HeadlessSurface {
  readonly rgba: Uint8Array;
}

/** Implemented by the pinned Chromium/runtime process in WP-04.4 consumers. */
export interface HeadlessSceneDriver {
  capture(request: HeadlessCaptureRequest): HeadlessSurface;
}

export interface SceneCaptureRequest<TVariables> {
  readonly timeUs: TimeUs;
  readonly frameRate: Rational;
  readonly seed: string;
  readonly variables: TVariables;
  readonly locale: string;
  readonly resolvers?: SceneResolvers;
  /** Immutable asset/font revision, required when resolver handles are supplied. */
  readonly resolverKey?: string;
}

export interface CapturedSceneSurface {
  readonly key: string;
  readonly timeUs: TimeUs;
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
  readonly rgba: Uint8Array;
  readonly sha256: string;
}

export interface CapturedSceneRegion {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly sha256: string;
}

export interface SceneVisualTolerance {
  /** Largest permitted absolute difference in a single RGBA channel. */
  readonly maxChannelDelta: number;
  /** Largest permitted count of pixels with any channel outside the delta. */
  readonly maxDifferingPixels: number;
}

export interface SceneSurfaceComparison {
  readonly matches: boolean;
  readonly maxChannelDelta: number;
  readonly differingPixels: number;
  readonly totalPixels: number;
}

/** Bounded cache that returns defensive copies so callers cannot corrupt frames. */
export class SceneCaptureCache {
  readonly #frames = new Map<string, CapturedSceneSurface>();
  readonly #regions = new Map<string, CapturedSceneRegion>();

  constructor(private readonly limit = 120) {}

  getFrame(key: string): CapturedSceneSurface | undefined {
    const value = this.#frames.get(key);
    if (value === undefined) return undefined;
    this.#frames.delete(key);
    this.#frames.set(key, value);
    return cloneSurface(value);
  }

  putFrame(value: CapturedSceneSurface): void {
    this.#frames.set(value.key, cloneSurface(value));
    trim(this.#frames, this.limit);
  }

  getRegion(key: string): CapturedSceneRegion | undefined {
    const value = this.#regions.get(key);
    if (value === undefined) return undefined;
    this.#regions.delete(key);
    this.#regions.set(key, value);
    return cloneRegion(value);
  }

  putRegion(value: CapturedSceneRegion): void {
    this.#regions.set(value.key, cloneRegion(value));
    trim(this.#regions, this.limit);
  }
}

export function captureSceneSurface<TVariables>(
  scene: SandboxedReactScene<TVariables>,
  driver: HeadlessSceneDriver,
  request: SceneCaptureRequest<TVariables>,
  cache = new SceneCaptureCache(),
): CapturedSceneSurface {
  const key = frameKey(scene, request);
  const cached = cache.getFrame(key);
  if (cached !== undefined) return cached;
  if (request.resolvers !== undefined && request.resolverKey === undefined) {
    throw new RangeError('scene capture with resolvers requires an immutable resolverKey');
  }
  const frame = scene.render({
    timeUs: request.timeUs,
    frameRate: request.frameRate,
    seed: request.seed,
    variables: request.variables,
    locale: request.locale,
    ...(request.resolvers === undefined ? {} : { resolvers: request.resolvers }),
  });
  const { width, height } = scene.manifest.viewport;
  const surface = driver.capture({
    markup: frame.markup,
    width,
    height,
    transparent: scene.manifest.transparent,
    timeUs: request.timeUs,
    frameRate: request.frameRate,
    locale: request.locale,
    seed: request.seed,
  });
  const expectedLength = width * height * 4;
  if (surface.rgba.length !== expectedLength)
    throw new RangeError(`headless capture must return ${expectedLength} RGBA bytes`);
  const result: CapturedSceneSurface = {
    key,
    timeUs: request.timeUs,
    width,
    height,
    hasAlpha: scene.manifest.transparent,
    rgba: new Uint8Array(surface.rgba),
    sha256: hashBytes(surface.rgba),
  };
  cache.putFrame(result);
  return result;
}

/**
 * Compares actual browser-captured scene surfaces. This is the shared preview
 * versus final-export tolerance contract; it intentionally operates on pixels,
 * never markup hashes or renderer-specific metadata.
 */
export function compareSceneSurfaces(
  preview: CapturedSceneSurface,
  finalRender: CapturedSceneSurface,
  tolerance: SceneVisualTolerance = { maxChannelDelta: 0, maxDifferingPixels: 0 },
): SceneSurfaceComparison {
  if (preview.width !== finalRender.width || preview.height !== finalRender.height) {
    throw new RangeError('scene surfaces must have identical dimensions for visual comparison');
  }
  if (
    !Number.isSafeInteger(tolerance.maxChannelDelta) ||
    tolerance.maxChannelDelta < 0 ||
    !Number.isSafeInteger(tolerance.maxDifferingPixels) ||
    tolerance.maxDifferingPixels < 0
  ) {
    throw new RangeError('scene visual tolerance values must be non-negative safe integers');
  }
  let maxChannelDelta = 0;
  let differingPixels = 0;
  for (let pixel = 0; pixel < preview.width * preview.height; pixel++) {
    let pixelOutsideTolerance = false;
    const base = pixel * 4;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(preview.rgba[base + channel]! - finalRender.rgba[base + channel]!);
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      if (delta > tolerance.maxChannelDelta) pixelOutsideTolerance = true;
    }
    if (pixelOutsideTolerance) differingPixels++;
  }
  return {
    matches: differingPixels <= tolerance.maxDifferingPixels,
    maxChannelDelta,
    differingPixels,
    totalPixels: preview.width * preview.height,
  };
}

export function captureSceneRegion(
  surface: CapturedSceneSurface,
  region: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  cache = new SceneCaptureCache(),
): CapturedSceneRegion {
  validateRegion(surface, region);
  const key = `${surface.key}:${region.x}:${region.y}:${region.width}:${region.height}`;
  const cached = cache.getRegion(key);
  if (cached !== undefined) return cached;
  const rgba = new Uint8Array(region.width * region.height * 4);
  for (let row = 0; row < region.height; row++) {
    const sourceStart = ((region.y + row) * surface.width + region.x) * 4;
    rgba.set(
      surface.rgba.subarray(sourceStart, sourceStart + region.width * 4),
      row * region.width * 4,
    );
  }
  const result = { ...region, key, rgba, sha256: hashBytes(rgba) };
  cache.putRegion(result);
  return result;
}

function frameKey<TVariables>(
  scene: SandboxedReactScene<TVariables>,
  request: SceneCaptureRequest<TVariables>,
): string {
  return sha256(
    JSON.stringify({
      source: scene.sourceSha256,
      manifest: `${scene.manifest.id}@${scene.manifest.version}`,
      timeUs: request.timeUs,
      frameRate: request.frameRate,
      seed: request.seed,
      locale: request.locale,
      variables: request.variables,
      resolverKey: request.resolverKey ?? '',
    }),
  );
}

function validateRegion(
  surface: CapturedSceneSurface,
  region: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): void {
  if (
    !Number.isSafeInteger(region.x) ||
    !Number.isSafeInteger(region.y) ||
    !Number.isSafeInteger(region.width) ||
    !Number.isSafeInteger(region.height) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width < 1 ||
    region.height < 1 ||
    region.x + region.width > surface.width ||
    region.y + region.height > surface.height
  )
    throw new RangeError('scene region must be inside the captured surface');
}

function trim<T>(entries: Map<string, T>, limit: number): void {
  while (entries.size > limit) entries.delete(entries.keys().next().value!);
}

function cloneSurface(value: CapturedSceneSurface): CapturedSceneSurface {
  return { ...value, rgba: new Uint8Array(value.rgba) };
}

function cloneRegion(value: CapturedSceneRegion): CapturedSceneRegion {
  return { ...value, rgba: new Uint8Array(value.rgba) };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

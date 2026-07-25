/**
 * Portrait stills for the compact HTML-scene list rows.
 * Catalog tiles use live iframe hosts (see MotionPanel) — not PNG strips.
 */

import {
  createScenePreviewHost,
  defaultVariablesForScene,
  findFirstPartyScene,
  viewportForScene,
} from '@joy-media/html-scene-runtime/browser';
import type { ScenePreviewFocus } from '@joy-media/html-scene-runtime/first-party';

/** Mid-progress still for list rows. */
const THUMB_PROGRESS = 0.45;

const STILL_CACHE = new Map<string, string>();
const STILL_INFLIGHT = new Map<string, Promise<string | undefined>>();

export function focusCoverTransform(
  sceneW: number,
  sceneH: number,
  tileW: number,
  tileH: number,
  focus: ScenePreviewFocus,
): { scale: number; tx: number; ty: number } {
  const fw = Math.max(1, focus.w * sceneW);
  const fh = Math.max(1, focus.h * sceneH);
  const scale = Math.max(tileW / fw, tileH / fh);
  const ox = focus.x * sceneW;
  const oy = focus.y * sceneH;
  const tx = -ox * scale - (fw * scale - tileW) / 2;
  const ty = -oy * scale - (fh * scale - tileH) / 2;
  return { scale, tx, ty };
}

function bitmapToPortraitDataUrl(
  bitmap: { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray },
  height: number,
  focus: ScenePreviewFocus,
): string {
  const source = document.createElement('canvas');
  source.width = bitmap.width;
  source.height = bitmap.height;
  const sourceCtx = source.getContext('2d');
  if (sourceCtx === null) throw new Error('2d context unavailable for scene thumb');
  sourceCtx.putImageData(
    new ImageData(new Uint8ClampedArray(bitmap.data), bitmap.width, bitmap.height),
    0,
    0,
  );

  const width = Math.max(1, Math.round((height * 9) / 16));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2d context unavailable for scene thumb portrait');
  ctx.fillStyle = '#141416';
  ctx.fillRect(0, 0, width, height);

  const sx = Math.max(0, Math.floor(focus.x * bitmap.width));
  const sy = Math.max(0, Math.floor(focus.y * bitmap.height));
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.floor(focus.w * bitmap.width)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.floor(focus.h * bitmap.height)));
  const scale = Math.max(width / sw, height / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(source, sx, sy, sw, sh, (width - dw) / 2, (height - dh) / 2, dw, dh);
  return canvas.toDataURL('image/png');
}

async function waitTwoFrames(): Promise<void> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

async function captureSceneThumb(sceneId: string, height: number): Promise<string | undefined> {
  const scene = findFirstPartyScene(sceneId);
  if (scene === undefined) return undefined;
  const host = createScenePreviewHost({
    instanceId: `thumb-still-${sceneId}`,
    scene,
  });
  try {
    await host.ready;
    const durationUs = scene.manifest.durationUs;
    const timeUs = Math.max(0, Math.floor(durationUs * THUMB_PROGRESS));
    host.update(timeUs, defaultVariablesForScene(sceneId));
    await waitTwoFrames();
    const viewport = viewportForScene(sceneId);
    const width = Math.max(72, Math.round(viewport.width / 6));
    const captureH = Math.max(128, Math.round(viewport.height / 6));
    const bitmap = await host.capture(width, captureH, 6_000);
    return bitmapToPortraitDataUrl(bitmap, height, scene.previewFocus);
  } catch {
    return undefined;
  } finally {
    host.destroy();
  }
}

/** Cached mid-progress portrait still (list rows). `height` is the tile height in CSS px. */
export function getFirstPartySceneThumbUrl(
  sceneId: string,
  height = 64,
): Promise<string | undefined> {
  const cacheKey = `${sceneId}@${height}`;
  const cached = STILL_CACHE.get(cacheKey);
  if (cached !== undefined) return Promise.resolve(cached);
  const existing = STILL_INFLIGHT.get(cacheKey);
  if (existing !== undefined) return existing;
  const pending = captureSceneThumb(sceneId, height).then((url) => {
    STILL_INFLIGHT.delete(cacheKey);
    if (url !== undefined) STILL_CACHE.set(cacheKey, url);
    return url;
  });
  STILL_INFLIGHT.set(cacheKey, pending);
  return pending;
}

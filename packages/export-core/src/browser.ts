import { deliveryPromiseFromManifest } from '@joy-media/production-quality/browser';
import type { DeliveryPromiseV1 } from '@joy-media/production-quality/browser';
import { freezeManifest, type RenderManifest } from './manifest.js';

/** Browser-only delivery contract projection; no ffmpeg or filesystem code. */
export function deliveryPromiseForManifest(manifest: RenderManifest): DeliveryPromiseV1 {
  return deliveryPromiseFromManifest(freezeManifest(manifest));
}

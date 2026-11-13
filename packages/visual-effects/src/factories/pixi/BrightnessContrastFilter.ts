/**
 * Brightness/Contrast filter for PixiJS renderer.
 *
 * Maps effect parameters to a ColorMatrixFilter 5x4 matrix:
 * Brightness: [-1, 1] -> normalized RGB offset
 * Contrast:   [-1, 1] -> scale [0, 2] centered around mid-grey (0.5)
 */

import { ColorMatrixFilter } from 'pixi.js';
import type { EffectParamValue } from '../../types.js';

export interface BrightnessContrastParams {
  readonly brightness: number;
  readonly contrast: number;
}

function buildBrightnessContrastMatrix(
  params: BrightnessContrastParams,
): ColorMatrixFilter['matrix'] {
  const b = Math.max(-1, Math.min(1, params.brightness));
  const c = Math.max(-1, Math.min(1, params.contrast));
  const scale = 1 + c;
  // Center contrast scaling around 0.5 and apply brightness offset cleanly;
  // at brightness=0, contrast=0 this yields the exact identity matrix.
  const offset = b + 0.5 * (1 - scale);
  return [
    scale,
    0,
    0,
    0,
    offset,
    0,
    scale,
    0,
    0,
    offset,
    0,
    0,
    scale,
    0,
    offset,
    0,
    0,
    0,
    1,
    0,
  ] as ColorMatrixFilter['matrix'];
}

export function createBrightnessContrastFilter(
  params: BrightnessContrastParams,
): ColorMatrixFilter {
  const filter = new ColorMatrixFilter();
  filter.matrix = buildBrightnessContrastMatrix(params);
  return filter;
}

export function normalizeBrightnessContrastParams(
  rawParams: Readonly<Record<string, EffectParamValue>>,
): BrightnessContrastParams {
  const brightnessRaw = rawParams.brightness;
  const contrastRaw = rawParams.contrast;

  return {
    brightness: typeof brightnessRaw === 'number' ? brightnessRaw : 0,
    contrast: typeof contrastRaw === 'number' ? contrastRaw : 0,
  };
}

export function updateBrightnessContrastFilter(
  filter: ColorMatrixFilter,
  params: BrightnessContrastParams,
): void {
  filter.matrix = buildBrightnessContrastMatrix(params);
}

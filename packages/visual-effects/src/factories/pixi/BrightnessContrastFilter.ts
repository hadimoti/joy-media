/**
 * Brightness/Contrast filter for PixiJS renderer.
 *
 * Maps the effect parameters to a ColorMatrixFilter uniform.
 * Brightness: [-1, 1] → offset [-255, 255] in color matrix
 * Contrast:   [-1, 1] → scale [0, 2] in color matrix
 */

import { ColorMatrixFilter } from 'pixi.js';
import type { EffectParamValue } from '../../types.js';

export interface BrightnessContrastParams {
  readonly brightness: number;
  readonly contrast: number;
}

export function createBrightnessContrastFilter(
  params: BrightnessContrastParams,
): ColorMatrixFilter {
  const b = Math.max(-1, Math.min(1, params.brightness));
  const c = Math.max(-1, Math.min(1, params.contrast));

  const filter = new ColorMatrixFilter();
  filter.brightness(b, false);
  const contrastMultiplier = c + 1;
  if (contrastMultiplier !== 1) {
    const m = filter.matrix.slice() as number[];
    m[0] = (m[0] ?? 1) * contrastMultiplier;
    m[5] = (m[5] ?? 1) * contrastMultiplier;
    m[10] = (m[10] ?? 1) * contrastMultiplier;
    filter.matrix = m as ColorMatrixFilter['matrix'];
  }
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
  const b = Math.max(-1, Math.min(1, params.brightness));
  const c = Math.max(-1, Math.min(1, params.contrast));

  filter.reset();
  filter.brightness(b, false);
  const contrastMultiplier = c + 1;
  if (contrastMultiplier !== 1) {
    const m = filter.matrix.slice() as number[];
    m[0] = (m[0] ?? 1) * contrastMultiplier;
    m[5] = (m[5] ?? 1) * contrastMultiplier;
    m[10] = (m[10] ?? 1) * contrastMultiplier;
    filter.matrix = m as ColorMatrixFilter['matrix'];
  }
}

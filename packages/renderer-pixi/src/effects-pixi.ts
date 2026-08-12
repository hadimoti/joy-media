/**
 * Browser-only Pixi filter construction for effects + master color grade.
 */

import { BlurFilter, ColorMatrixFilter, Filter, GlProgram, NoiseFilter } from 'pixi.js';
import type { ColorGradeIR, EffectInstanceIR } from '@joy-media/render-ir';
import { isIdentityColorGrade } from './effects-cpu.js';
import {
  createBrightnessContrastFilter,
  normalizeBrightnessContrastParams,
} from '@joy-media/visual-effects';
import { createCreativeEffectFilter } from './creative-effects.js';

export { colorGradeSignature, effectsSignature, isIdentityColorGrade } from './effects-cpu.js';

const DEFAULT_FILTER_VERT = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition( void )
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0*uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord( void )
{
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void)
{
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;

const VIGNETTE_FRAG = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uAmount;

void main()
{
    vec4 color = texture(uTexture, vTextureCoord);
    vec2 uv = vTextureCoord - 0.5;
    float dist = length(uv) * 1.41421356;
    float vig = smoothstep(0.35, 1.05, dist) * uAmount;
    color.rgb *= (1.0 - vig);
    finalColor = color;
}
`;

const COLOR_GRADE_V2_FRAG = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uExposure;
uniform float uContrast;
uniform float uTemperature;
uniform float uTint;
uniform float uSaturation;
uniform float uHighlights;
uniform float uShadows;
uniform float uSoftClip;
uniform float uMonochrome;

void main() {
  vec4 color = texture(uTexture, vTextureCoord);
  vec3 rgb = color.rgb * pow(2.0, uExposure);
  rgb.r += uTemperature * 0.06 + uTint * 0.02;
  rgb.g += uTint * -0.03;
  rgb.b -= uTemperature * 0.06 + uTint * 0.02;
  float pivot = 0.5;
  rgb = (rgb - pivot) * (1.0 + uContrast) + pivot;
  float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  float shadowWeight = max(0.0, 1.0 - lum * 2.0);
  float highlightWeight = max(0.0, lum * 2.0 - 1.0);
  rgb += (uShadows * shadowWeight + uHighlights * highlightWeight) * 0.25;
  rgb = mix(vec3(lum), rgb, uSaturation);
  float mono = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(rgb, vec3(mono), uMonochrome);
  rgb = max(vec3(0.0), rgb);
  if (uSoftClip > 0.0) rgb = rgb / (rgb + uSoftClip);
  finalColor = vec4(clamp(rgb, 0.0, 1.0), color.a);
}`;

/** Build Pixi filters for a node's effect stack (enabled only). */
export function buildPixiEffectFilters(effects: readonly EffectInstanceIR[] | undefined): Filter[] {
  if (effects === undefined || effects.length === 0) return [];
  const filters: Filter[] = [];
  for (const effect of effects) {
    if (!effect.enabled) continue;
    const built = filterForEffect(effect);
    if (built !== undefined) filters.push(...built);
  }
  return filters;
}

/** Master color grade as a ColorMatrixFilter (identity → undefined). */
export function buildPixiColorGradeFilter(grade: ColorGradeIR | undefined): Filter | undefined {
  if (grade === undefined || isIdentityColorGrade(grade)) return undefined;
  if (grade.version === 2) return createColorGradeV2Filter(grade);
  const filter = new ColorMatrixFilter();
  applyColorGradeMatrix(filter, grade);
  return filter;
}

function createColorGradeV2Filter(grade: ColorGradeIR): Filter {
  const adjust = grade.adjust;
  const lut = grade.lut;
  return new Filter({
    glProgram: GlProgram.from({
      vertex: DEFAULT_FILTER_VERT,
      fragment: COLOR_GRADE_V2_FRAG,
      name: 'joy-color-grade-v2',
    }),
    resources: {
      colorGradeUniforms: {
        uExposure: { value: adjust?.exposure ?? 0, type: 'f32' },
        uContrast: { value: adjust?.contrast ?? 0, type: 'f32' },
        uTemperature: { value: adjust?.temperature ?? 0, type: 'f32' },
        uTint: { value: adjust?.tint ?? 0, type: 'f32' },
        uSaturation: { value: adjust?.saturation ?? grade.saturation, type: 'f32' },
        uHighlights: { value: adjust?.highlights ?? 0, type: 'f32' },
        uShadows: { value: adjust?.shadows ?? 0, type: 'f32' },
        uSoftClip: { value: grade.outputSafety?.softClip ?? 0, type: 'f32' },
        uMonochrome: { value: lut?.builtIn === 'monochrome' ? lut.intensity : 0, type: 'f32' },
      },
    },
  });
}

export function applyColorGradeMatrix(filter: ColorMatrixFilter, grade: ColorGradeIR): void {
  filter.reset();
  if (grade.gain !== 1) filter.brightness(grade.gain, false);
  if (grade.saturation !== 1) filter.saturate(grade.saturation - 1, true);
  if (grade.lutId === 'contrast' || grade.lutId === 'rec709') {
    filter.contrast(grade.lutId === 'contrast' ? 0.25 : 0.1, true);
  }
  if (grade.lift !== 0) {
    const matrix = filter.matrix.slice() as number[];
    matrix[4] = (matrix[4] ?? 0) + grade.lift;
    matrix[9] = (matrix[9] ?? 0) + grade.lift;
    matrix[14] = (matrix[14] ?? 0) + grade.lift;
    filter.matrix = matrix as ColorMatrixFilter['matrix'];
  }
  if (grade.gamma !== 1) {
    const amount = Math.max(-1, Math.min(1, (1 - grade.gamma) * 0.8));
    filter.contrast(amount, true);
  }
}

function filterForEffect(effect: EffectInstanceIR): Filter[] | undefined {
  switch (effect.kind) {
    case 'blur':
    case 'gaussian-blur': {
      const amount = effect.params.amount ?? 4;
      return [new BlurFilter({ strength: amount, quality: 3 })];
    }
    case 'glow': {
      const amount = effect.params.amount ?? 0.4;
      const blur = new BlurFilter({ strength: Math.max(2, amount * 12), quality: 2 });
      const tint = new ColorMatrixFilter();
      tint.brightness(1 + amount * 0.5, false);
      return [blur, tint];
    }
    case 'shadow':
    case 'drop-shadow': {
      const distance = effect.params.distance ?? 8;
      const opacity = effect.params.opacity ?? 0.5;
      const blur = new BlurFilter({ strength: Math.max(1, distance / 2), quality: 2 });
      blur.padding = distance;
      const darken = new ColorMatrixFilter();
      darken.brightness(Math.max(0.2, 1 - opacity), false);
      return [darken, blur];
    }
    case 'vignette': {
      const amount = effect.params.amount ?? 0.35;
      return [createVignetteFilter(amount)];
    }
    case 'sharpen': {
      const amount = effect.params.amount ?? 0.3;
      const matrix = new ColorMatrixFilter();
      matrix.contrast(amount, false);
      return [matrix];
    }
    case 'grain':
    case 'noise': {
      const amount = effect.params.amount ?? 0.2;
      return [new NoiseFilter({ noise: Math.min(1, Math.max(0.01, amount)), seed: 42 })];
    }
    case 'brightness-contrast': {
      const params = normalizeBrightnessContrastParams(effect.params);
      return [createBrightnessContrastFilter(params)];
    }
    case 'sepia': {
      const amount = effect.params.amount ?? 0.5;
      const matrix = new ColorMatrixFilter();
      matrix.sepia(false);
      matrix.brightness(amount, false);
      return [matrix];
    }
    case 'hue-saturation': {
      const matrix = new ColorMatrixFilter();
      const hue = (effect.params.hue ?? 0) * 180;
      const sat = (effect.params.saturation ?? 0) + 1;
      if (hue !== 0) matrix.hue(hue, false);
      if (sat !== 1) matrix.saturate(sat, true);
      return [matrix];
    }
    case 'vibrance': {
      const amount = effect.params.amount ?? 0;
      const matrix = new ColorMatrixFilter();
      matrix.saturate(1 + amount * 0.5, true);
      return [matrix];
    }
    case 'bloom': {
      const amount = effect.params.amount ?? 0.4;
      const blur = new BlurFilter({ strength: Math.max(4, amount * 20), quality: 3 });
      const tint = new ColorMatrixFilter();
      tint.brightness(1 + amount * 0.3, false);
      tint.contrast(1 + amount * 0.2, false);
      return [blur, tint];
    }
    case 'posterize': {
      const filter = createCreativeEffectFilter(effect);
      return filter === undefined ? undefined : [filter];
    }
    case 'pixelate': {
      const filter = createCreativeEffectFilter(effect);
      return filter === undefined ? undefined : [filter];
    }
    default: {
      const filter = createCreativeEffectFilter(effect);
      return filter === undefined ? undefined : [filter];
    }
  }
}

function createVignetteFilter(amount: number): Filter {
  return new Filter({
    glProgram: GlProgram.from({
      vertex: DEFAULT_FILTER_VERT,
      fragment: VIGNETTE_FRAG,
      name: 'joy-vignette-filter',
    }),
    resources: {
      vignetteUniforms: {
        uAmount: { value: amount, type: 'f32' },
      },
    },
  });
}

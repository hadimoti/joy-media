/**
 * Browser-only Pixi filter construction for effects + master color grade.
 */

import {
  BlurFilter,
  ColorMatrixFilter,
  Filter,
  GlProgram,
  NoiseFilter,
} from 'pixi.js';
import type { ColorGradeIR, EffectInstanceIR } from '@joy-media/render-ir';
import { isIdentityColorGrade } from './effects-cpu.js';

export {
  colorGradeSignature,
  effectsSignature,
  isIdentityColorGrade,
} from './effects-cpu.js';

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

/** Build Pixi filters for a node's effect stack (enabled only). */
export function buildPixiEffectFilters(
  effects: readonly EffectInstanceIR[] | undefined,
): Filter[] {
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
export function buildPixiColorGradeFilter(grade: ColorGradeIR | undefined): ColorMatrixFilter | undefined {
  if (grade === undefined || isIdentityColorGrade(grade)) return undefined;
  const filter = new ColorMatrixFilter();
  applyColorGradeMatrix(filter, grade);
  return filter;
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
    case 'blur': {
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
    case 'shadow': {
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
    case 'grain': {
      const amount = effect.params.amount ?? 0.2;
      return [new NoiseFilter({ noise: Math.min(1, Math.max(0.01, amount)), seed: 42 })];
    }
    default:
      return undefined;
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

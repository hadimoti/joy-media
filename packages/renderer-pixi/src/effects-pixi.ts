/**
 * Browser-only Pixi filter construction for effects + master color grade.
 */

import {
  BlurFilter,
  BufferImageSource,
  ColorMatrixFilter,
  Filter,
  GlProgram,
  NoiseFilter,
  Texture,
} from 'pixi.js';
import type { ColorGradeIR, EffectInstanceIR } from '@joy-media/render-ir';
import { isIdentityColorGrade } from './effects-cpu.js';
import { buildColorCurveLut } from './color-grade-math.js';
import type { ParsedCubeLut } from './lut.js';
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
uniform sampler2D uCurveTexture;
uniform sampler2D uCubeLutTexture;
uniform float uExposure;
uniform float uContrast;
uniform float uPivot;
uniform float uTemperature;
uniform float uTint;
uniform float uSaturation;
uniform float uVibrance;
uniform float uHue;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uSoftClip;
uniform float uLegalRange;
uniform float uLook;
uniform float uLookIntensity;
uniform float uCubeEnabled;
uniform float uCubeIntensity;
uniform vec3 uCubeDomainMin;
uniform vec3 uCubeDomainMax;
uniform float uCubeSize;
uniform vec4 uLift;
uniform vec4 uGamma;
uniform vec4 uGain;
uniform vec4 uOffset;
uniform vec4 uHslBands[8];
uniform vec4 uHslAdjust[8];

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float smooth01(float x) { x = clamp(x, 0.0, 1.0); return x*x*(3.0-2.0*x); }
float wrapHue(float h) { return mod(mod(h, 360.0) + 360.0, 360.0); }
float hueDistance(float a, float b) { float d = abs(a-b); return min(d, 360.0-d); }
float curveLookup(float x, int channel) { vec4 v=texture(uCurveTexture,vec2((clamp(x,0.0,1.0)*255.0+0.5)/256.0,0.5)); return channel==0?v.r:channel==1?v.g:channel==2?v.b:v.a; }
vec3 rgbToHsl(vec3 c) {
  float hi=max(max(c.r,c.g),c.b), lo=min(min(c.r,c.g),c.b), d=hi-lo;
  float l=(hi+lo)*0.5;
  if (d < 0.000001) return vec3(0.0,0.0,l);
  float s=d/max(0.000001,1.0-abs(2.0*l-1.0));
  float h=hi==c.r ? mod((c.g-c.b)/d,6.0) : hi==c.g ? (c.b-c.r)/d+2.0 : (c.r-c.g)/d+4.0;
  return vec3(wrapHue(h*60.0),s,l);
}
vec3 hslToRgb(vec3 hsl) {
  float h=wrapHue(hsl.x)/60.0, s=clamp(hsl.y,0.0,1.0), l=clamp(hsl.z,0.0,1.0);
  float c=(1.0-abs(2.0*l-1.0))*s, x=c*(1.0-abs(mod(h,2.0)-1.0)), m=l-c*0.5;
  vec3 rgb=h<1.0?vec3(c,x,0.0):h<2.0?vec3(x,c,0.0):h<3.0?vec3(0.0,c,x):h<4.0?vec3(0.0,x,c):h<5.0?vec3(x,0.0,c):vec3(c,0.0,x);
  return rgb+m;
}
vec3 sampleCube(vec3 rgb) {
  vec3 p=clamp((rgb-uCubeDomainMin)/(uCubeDomainMax-uCubeDomainMin),0.0,1.0)*(uCubeSize-1.0);
  vec3 lo=floor(p), hi=min(vec3(uCubeSize-1.0),lo+1.0), f=p-lo;
  float n=uCubeSize;
  vec3 c000=texelFetch(uCubeLutTexture,ivec2(int(lo.x*n+lo.z),int(lo.y)),0).rgb;
  vec3 c100=texelFetch(uCubeLutTexture,ivec2(int(hi.x*n+lo.z),int(lo.y)),0).rgb;
  vec3 c010=texelFetch(uCubeLutTexture,ivec2(int(lo.x*n+lo.z),int(hi.y)),0).rgb;
  vec3 c110=texelFetch(uCubeLutTexture,ivec2(int(hi.x*n+lo.z),int(hi.y)),0).rgb;
  vec3 c001=texelFetch(uCubeLutTexture,ivec2(int(lo.x*n+hi.z),int(lo.y)),0).rgb;
  vec3 c101=texelFetch(uCubeLutTexture,ivec2(int(hi.x*n+hi.z),int(lo.y)),0).rgb;
  vec3 c011=texelFetch(uCubeLutTexture,ivec2(int(lo.x*n+hi.z),int(hi.y)),0).rgb;
  vec3 c111=texelFetch(uCubeLutTexture,ivec2(int(hi.x*n+hi.z),int(hi.y)),0).rgb;
  return mix(mix(mix(c000,c100,f.x),mix(c010,c110,f.x),f.y),mix(mix(c001,c101,f.x),mix(c011,c111,f.x),f.y),f.z);
}

void main() {
  vec4 color = texture(uTexture, vTextureCoord);
  vec3 rgb = color.rgb * pow(2.0, uExposure);
  rgb.r += uTemperature * 0.06 + uTint * 0.02;
  rgb.g += uTint * -0.03;
  rgb.b -= uTemperature * 0.06 + uTint * 0.02;

  vec3 lift=vec3(uLift.x,uLift.y,uLift.z)+uLift.www;
  vec3 gamma=vec3(uGamma.x,uGamma.y,uGamma.z)+uGamma.www;
  vec3 gain=vec3(uGain.x,uGain.y,uGain.z)+uGain.www;
  vec3 offset=vec3(uOffset.x,uOffset.y,uOffset.z)+uOffset.www;
  rgb=pow(max(vec3(0.0),rgb+lift*pow(vec3(1.0)-rgb,vec3(2.0))),1.0/max(vec3(0.05),vec3(1.0)+gamma));
  rgb=rgb*(vec3(1.0)+gain)+offset;
  rgb = (rgb - uPivot) * (1.0 + uContrast) + uPivot;
  float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  float sw=pow(1.0-smooth01((lum-0.02)/0.43),2.0), hw=pow(smooth01((lum-0.55)/0.43),2.0);
  float bw=pow(1.0-smooth01((lum-0.08)/0.47),2.0), ww=pow(smooth01((lum-0.45)/0.47),2.0);
  rgb += vec3((uShadows*sw+uHighlights*hw+uBlacks*bw+uWhites*ww)*0.25);

  vec3 rgbMapped=vec3(
    curveLookup(rgb.r,0), curveLookup(rgb.g,0), curveLookup(rgb.b,0));
  rgb=vec3(
    curveLookup(rgbMapped.r,1), curveLookup(rgbMapped.g,2), curveLookup(rgbMapped.b,3));

  vec3 hsl=rgbToHsl(rgb);
  for(int i=0;i<8;i++) {
    vec4 band=uHslBands[i], adjustment=uHslAdjust[i];
    float halfWidth=max(0.001,band.y*0.5), feather=max(0.5,halfWidth*clamp(band.z,0.0,1.0));
    float weight=(adjustment.z<0.5)?0.0:1.0-smoothstep(halfWidth-feather,halfWidth+feather,hueDistance(hsl.x,wrapHue(band.x)));
    hsl=vec3(wrapHue(hsl.x+band.w*weight),clamp(hsl.y*(1.0+adjustment.x*weight),0.0,1.0),clamp(hsl.z+adjustment.y*weight,0.0,1.0));
  }
  rgb=hslToRgb(hsl);
  lum=luma(rgb);
  float chroma=max(max(rgb.r,rgb.g),rgb.b)-min(min(rgb.r,rgb.g),rgb.b);
  rgb=mix(vec3(lum),rgb,uSaturation+uVibrance*(1.0-chroma));
  hsl=rgbToHsl(rgb); rgb=hslToRgb(vec3(wrapHue(hsl.x+uHue),hsl.y,hsl.z));

  vec3 look=rgb;
  if (uLook < 0.5 && uLook > -0.5) look=0.5+(rgb-0.5)*1.22;
  else if (uLook < 1.5 && uLook > 0.5) look=vec3(0.5)+(rgb-0.5)*1.1;
  else if (uLook < 2.5 && uLook > 1.5) look=vec3(0.035+0.91*pow(clamp(rgb.r,0.0,1.0),0.92),0.03+0.91*pow(clamp(rgb.g,0.0,1.0),0.96),0.025+0.91*pow(clamp(rgb.b,0.0,1.0),1.04));
  else if (uLook < 3.5 && uLook > 2.5) { lum=luma(rgb); look=rgb+vec3(0.055*(1.0-lum),0.012*(1.0-lum),-0.045*lum); }
  else if (uLook < 4.5 && uLook > 3.5) { lum=luma(rgb); look=rgb+vec3(0.025,0.02,0.055)*(1.0-lum); }
  else if (uLook < 5.5 && uLook > 4.5) look=vec3(luma(rgb));
  rgb=mix(rgb,look,uLookIntensity);
  if(uCubeEnabled>0.5) rgb=mix(rgb,sampleCube(rgb),uCubeIntensity);
  rgb=max(vec3(0.0),rgb);
  if (uSoftClip > 0.0) rgb = rgb / (vec3(1.0) + uSoftClip*max(vec3(0.0),rgb));
  if(uLegalRange>0.5) rgb=clamp(rgb,vec3(16.0/255.0),vec3(235.0/255.0));
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
export function buildPixiColorGradeFilter(
  grade: ColorGradeIR | undefined,
  cubeLut?: ParsedCubeLut,
): Filter | undefined {
  if (grade === undefined || isIdentityColorGrade(grade)) return undefined;
  if (grade.version === 2) return createColorGradeV2Filter(grade, cubeLut);
  const filter = new ColorMatrixFilter();
  applyColorGradeMatrix(filter, grade);
  return filter;
}

const curveTextureCache = new WeakMap<object, Texture>();
const cubeTextureCache = new WeakMap<object, Texture>();

function createColorGradeV2Filter(grade: ColorGradeIR, cubeLut?: ParsedCubeLut): Filter {
  const adjust = grade.adjust;
  const lut = grade.lut;
  const curves = grade.curves;
  const curveTexture = curves === undefined ? identityCurveTexture() : getCurveTexture(curves);
  const cubeTexture = cubeLut === undefined ? identityCubeTexture() : getCubeTexture(cubeLut);
  const wheel = (key: 'lift' | 'gamma' | 'gain' | 'offset') => {
    const value = grade.wheels?.[key];
    return new Float32Array([value?.r ?? 0, value?.g ?? 0, value?.b ?? 0, value?.master ?? 0]);
  };
  const bands = Array.from({ length: 8 }, (_, index) => grade.hsl?.[index]);
  const bandData = new Float32Array(32);
  const adjustmentData = new Float32Array(32);
  bands.forEach((band, index) => {
    const start = index * 4;
    bandData.set(
      [band?.hue ?? 0, band?.hueWidth ?? 0, band?.softness ?? 0, band?.hueShift ?? 0],
      start,
    );
    adjustmentData.set(
      [band?.saturation ?? 0, band?.luminance ?? 0, band === undefined ? 0 : 1, 0],
      start,
    );
  });
  const lookId = lut?.builtIn ?? grade.lutId ?? 'none';
  const lookIndex =
    lookId === 'clean-contrast' || lookId === 'contrast'
      ? 0
      : lookId === 'rec709'
        ? 1
        : lookId === 'soft-film'
          ? 2
          : lookId === 'warm-cinema'
            ? 3
            : lookId === 'cool-fade'
              ? 4
              : lookId === 'monochrome'
                ? 5
                : -1;
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
        uPivot: { value: adjust?.pivot ?? 0.5, type: 'f32' },
        uTemperature: { value: adjust?.temperature ?? 0, type: 'f32' },
        uTint: { value: adjust?.tint ?? 0, type: 'f32' },
        uSaturation: { value: adjust?.saturation ?? grade.saturation, type: 'f32' },
        uVibrance: { value: adjust?.vibrance ?? 0, type: 'f32' },
        uHue: { value: adjust?.hue ?? 0, type: 'f32' },
        uHighlights: { value: adjust?.highlights ?? 0, type: 'f32' },
        uShadows: { value: adjust?.shadows ?? 0, type: 'f32' },
        uWhites: { value: adjust?.whites ?? 0, type: 'f32' },
        uBlacks: { value: adjust?.blacks ?? 0, type: 'f32' },
        uSoftClip: { value: grade.outputSafety?.softClip ?? 0, type: 'f32' },
        uLegalRange: { value: grade.outputSafety?.legalRange === true ? 1 : 0, type: 'f32' },
        uLook: { value: lookIndex, type: 'f32' },
        uLookIntensity: { value: lut?.intensity ?? 1, type: 'f32' },
        uCubeEnabled: { value: cubeLut === undefined ? 0 : 1, type: 'f32' },
        uCubeIntensity: { value: cubeLut === undefined ? 0 : (lut?.intensity ?? 1), type: 'f32' },
        uCubeDomainMin: { value: cubeLut?.domainMin ?? [0, 0, 0], type: 'vec3<f32>' },
        uCubeDomainMax: { value: cubeLut?.domainMax ?? [1, 1, 1], type: 'vec3<f32>' },
        uCubeSize: { value: cubeLut?.size ?? 2, type: 'f32' },
        uLift: { value: wheel('lift'), type: 'vec4<f32>' },
        uGamma: { value: wheel('gamma'), type: 'vec4<f32>' },
        uGain: { value: wheel('gain'), type: 'vec4<f32>' },
        uOffset: { value: wheel('offset'), type: 'vec4<f32>' },
        uHslBands: { value: bandData, type: 'vec4<f32>', size: 8 },
        uHslAdjust: { value: adjustmentData, type: 'vec4<f32>', size: 8 },
      },
      uCurveTexture: curveTexture,
      uCubeLutTexture: cubeTexture,
    },
  });
}

function identityCurveTexture(): Texture {
  const key = identityCurveTexture;
  const cached = curveTextureCache.get(key);
  if (cached !== undefined) return cached;
  const pixels = new Uint8Array(256 * 4);
  for (let x = 0; x < 256; x += 1) pixels.fill(x, x * 4, x * 4 + 4);
  const texture = new Texture({
    source: new BufferImageSource({ resource: pixels, width: 256, height: 1 }),
  });
  curveTextureCache.set(key, texture);
  return texture;
}

function getCurveTexture(curves: NonNullable<ColorGradeIR['curves']>): Texture {
  const key = curves as object;
  const cached = curveTextureCache.get(key);
  if (cached !== undefined) return cached;
  const tables = [curves.rgb, curves.red, curves.green, curves.blue].map(buildColorCurveLut);
  const pixels = new Uint8Array(256 * 4);
  for (let x = 0; x < 256; x += 1)
    for (let channel = 0; channel < 4; channel += 1) pixels[x * 4 + channel] = tables[channel]![x]!;
  const texture = new Texture({
    source: new BufferImageSource({ resource: pixels, width: 256, height: 1 }),
  });
  curveTextureCache.set(key, texture);
  return texture;
}

function identityCubeTexture(): Texture {
  const cached = cubeTextureCache.get(identityCubeTexture);
  if (cached !== undefined) return cached;
  const texture = new Texture({
    source: new BufferImageSource({
      resource: new Float32Array([
        0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1,
        1,
      ]),
      width: 4,
      height: 2,
      format: 'rgba32float',
    }),
  });
  cubeTextureCache.set(identityCubeTexture, texture);
  return texture;
}

function getCubeTexture(lut: ParsedCubeLut): Texture {
  const key = lut as object;
  const cached = cubeTextureCache.get(key);
  if (cached !== undefined) return cached;
  const pixels = new Float32Array(lut.size * lut.size * lut.size * 4);
  for (let r = 0; r < lut.size; r += 1)
    for (let g = 0; g < lut.size; g += 1)
      for (let b = 0; b < lut.size; b += 1) {
        const source = (r * lut.size * lut.size + g * lut.size + b) * 3;
        const target = (g * lut.size * lut.size + r * lut.size + b) * 4;
        pixels.set(lut.data.subarray(source, source + 3), target);
        pixels[target + 3] = 1;
      }
  const texture = new Texture({
    source: new BufferImageSource({
      resource: pixels,
      width: lut.size * lut.size,
      height: lut.size,
      format: 'rgba32float',
    }),
  });
  cubeTextureCache.set(key, texture);
  return texture;
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

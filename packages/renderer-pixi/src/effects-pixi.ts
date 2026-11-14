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
import {
  colorCurvesKey,
  getColorCurveLuts,
  normalizeColorGradeHslBands,
} from './color-grade-math.js';
import type { ParsedCubeLut } from './lut.js';
import {
  createBrightnessContrastFilter,
  normalizeBrightnessContrastParams,
} from '@joy-media/visual-effects';
import { createCreativeEffectFilter } from './creative-effects.js';

export { colorGradeSignature, effectsSignature, isIdentityColorGrade } from './effects-cpu.js';

const DEFAULT_FILTER_VERT = `
precision highp float;
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
precision highp float;
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

const EFFECT_FRAG_HEADER = `
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
`;

/**
 * Bloom (T-V04): a bright-pass blur added back onto the picture. Only pixels brighter than the
 * threshold feed the glow, so the Threshold slider changes the result (before this the slider did
 * nothing and the whole picture was blurred). One pass, a 7 by 7 Gaussian-weighted tap grid whose
 * spread grows with the intensity.
 */
const BLOOM_FRAG = `${EFFECT_FRAG_HEADER}
uniform float uAmount;
uniform float uThreshold;

void main()
{
    vec4 base = texture(uTexture, vTextureCoord);
    vec2 px = uInputSize.zw;
    float radius = 2.0 + uAmount * 14.0;
    vec3 glow = vec3(0.0);
    float weightSum = 0.0;
    for (int y = -3; y <= 3; y++)
    {
        for (int x = -3; x <= 3; x++)
        {
            vec2 o = vec2(float(x), float(y));
            float w = exp(-dot(o, o) / 6.0);
            vec3 c = texture(uTexture, vTextureCoord + o * px * (radius / 3.0)).rgb;
            float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
            float bright = smoothstep(uThreshold, uThreshold + 0.15, luma);
            glow += c * bright * w;
            weightSum += w;
        }
    }
    glow /= weightSum;
    finalColor = vec4(min(base.rgb + glow * (uAmount * 2.5), vec3(1.0)), base.a);
}
`;

const COLOR_OVERLAY_FRAG = `${EFFECT_FRAG_HEADER}
uniform float uR;
uniform float uG;
uniform float uB;
uniform float uOpacity;

void main()
{
    vec4 color = texture(uTexture, vTextureCoord);
    vec3 overlay = clamp(vec3(uR, uG, uB) / 255.0, 0.0, 1.0);
    float op = clamp(uOpacity, 0.0, 1.0);
    finalColor = vec4(mix(color.rgb, overlay * color.a, op), color.a);
}
`;

const CURVES_FRAG = `${EFFECT_FRAG_HEADER}
uniform float uShadows;
uniform float uMidtones;
uniform float uHighlights;

void main()
{
    vec4 color = texture(uTexture, vTextureCoord);
    float lum = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    float sw = pow(1.0 - lum, 2.0);
    float hw = pow(lum, 2.0);
    float mw = clamp(1.0 - sw - hw, 0.0, 1.0);
    float delta = uShadows * sw + uMidtones * mw + uHighlights * hw;
    finalColor = vec4(clamp(color.rgb + delta, 0.0, 1.0), color.a);
}
`;

const BULGE_FRAG = `${EFFECT_FRAG_HEADER}
uniform float uAmount;
uniform float uRadius;

void main()
{
    vec2 contentMax = max(uOutputFrame.zw * uInputSize.zw, vec2(0.0001));
    vec2 uv = vTextureCoord / contentMax;
    vec2 centered = uv - 0.5;
    float aspect = uOutputFrame.z / max(1.0, uOutputFrame.w);
    vec2 scaled = vec2(centered.x * aspect, centered.y);
    float dist = length(scaled);
    float radius = max(0.05, uRadius);
    if (dist < radius && dist > 0.0001) {
        float norm = dist / radius;
        float factor = uAmount >= 0.0
            ? pow(norm, 1.0 + uAmount * 1.4)
            : 1.0 / max(0.25, 1.0 - (-uAmount) * (1.0 - norm));
        centered *= (factor / max(norm, 0.0001));
    }
    vec2 targetUv = clamp(0.5 + centered, vec2(0.0), vec2(1.0)) * contentMax;
    finalColor = texture(uTexture, targetUv);
}
`;

const TWIST_FRAG = `${EFFECT_FRAG_HEADER}
uniform float uAngle;
uniform float uRadius;

void main()
{
    vec2 contentMax = max(uOutputFrame.zw * uInputSize.zw, vec2(0.0001));
    vec2 uv = vTextureCoord / contentMax;
    vec2 centered = uv - 0.5;
    float dist = length(centered);
    float radius = max(0.05, uRadius);
    if (dist < radius) {
        float falloff = 1.0 - dist / radius;
        float theta = uAngle * 3.14159265 * falloff * falloff;
        float c = cos(theta);
        float s = sin(theta);
        centered = vec2(centered.x * c - centered.y * s, centered.x * s + centered.y * c);
    }
    vec2 targetUv = clamp(0.5 + centered, vec2(0.0), vec2(1.0)) * contentMax;
    finalColor = texture(uTexture, targetUv);
}
`;

const RIPPLE_FRAG = `${EFFECT_FRAG_HEADER}
uniform float uAmplitude;
uniform float uFrequency;

void main()
{
    vec2 contentMax = max(uOutputFrame.zw * uInputSize.zw, vec2(0.0001));
    vec2 uv = vTextureCoord / contentMax;
    vec2 centered = uv - 0.5;
    float dist = length(centered);
    float wave = sin(dist * uFrequency * 6.2831853 + uv.y * uFrequency);
    vec2 dir = dist > 0.0001 ? centered / dist : vec2(1.0, 0.0);
    vec2 displaced = clamp(uv + dir * wave * uAmplitude, vec2(0.0), vec2(1.0));
    finalColor = texture(uTexture, displaced * contentMax);
}
`;

const CRT_FRAG = `${EFFECT_FRAG_HEADER}
uniform float uScanlines;
uniform float uNoise;

void main()
{
    vec2 contentMax = max(uOutputFrame.zw * uInputSize.zw, vec2(0.0001));
    vec2 uv = vTextureCoord / contentMax;
    float scanY = uv.y * max(1.0, uOutputFrame.w);
    float scanMask = 1.0 - clamp(uScanlines, 0.0, 1.0) * (0.5 + 0.5 * sin(scanY * 3.14159265));
    vec2 chroma = vec2(uInputSize.z * 2.0, 0.0);
    float r = texture(uTexture, clamp(uv + chroma, vec2(0.0), vec2(1.0)) * contentMax).r;
    float g = texture(uTexture, clamp(uv, vec2(0.0), vec2(1.0)) * contentMax).g;
    float b = texture(uTexture, clamp(uv - chroma, vec2(0.0), vec2(1.0)) * contentMax).b;
    float a = texture(uTexture, clamp(uv, vec2(0.0), vec2(1.0)) * contentMax).a;
    float grain = (fract(sin(dot(floor(uv * uOutputFrame.zw), vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * uNoise;
    finalColor = vec4(clamp(vec3(r, g, b) * scanMask + grain, 0.0, 1.0), a);
}
`;

const EDGE_DETECT_FRAG = `${EFFECT_FRAG_HEADER}
uniform float uThreshold;

void main()
{
    vec2 stepUv = uInputSize.zw * 1.5;
    vec2 contentMax = max(uOutputFrame.zw * uInputSize.zw, vec2(0.0001));
    float tl = dot(texture(uTexture, clamp(vTextureCoord + vec2(-stepUv.x, -stepUv.y), vec2(0.0), contentMax)).rgb, vec3(0.299, 0.587, 0.114));
    float tc = dot(texture(uTexture, clamp(vTextureCoord + vec2(0.0, -stepUv.y), vec2(0.0), contentMax)).rgb, vec3(0.299, 0.587, 0.114));
    float tr = dot(texture(uTexture, clamp(vTextureCoord + vec2(stepUv.x, -stepUv.y), vec2(0.0), contentMax)).rgb, vec3(0.299, 0.587, 0.114));
    float ml = dot(texture(uTexture, clamp(vTextureCoord + vec2(-stepUv.x, 0.0), vec2(0.0), contentMax)).rgb, vec3(0.299, 0.587, 0.114));
    float mr = dot(texture(uTexture, clamp(vTextureCoord + vec2(stepUv.x, 0.0), vec2(0.0), contentMax)).rgb, vec3(0.299, 0.587, 0.114));
    float bl = dot(texture(uTexture, clamp(vTextureCoord + vec2(-stepUv.x, stepUv.y), vec2(0.0), contentMax)).rgb, vec3(0.299, 0.587, 0.114));
    float bc = dot(texture(uTexture, clamp(vTextureCoord + vec2(0.0, stepUv.y), vec2(0.0), contentMax)).rgb, vec3(0.299, 0.587, 0.114));
    float br = dot(texture(uTexture, clamp(vTextureCoord + vec2(stepUv.x, stepUv.y), vec2(0.0), contentMax)).rgb, vec3(0.299, 0.587, 0.114));
    float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
    float gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
    float edge = smoothstep(clamp(uThreshold * 0.5, 0.02, 0.6), 0.75, length(vec2(gx, gy)));
    vec4 center = texture(uTexture, vTextureCoord);
    finalColor = vec4(max(center.rgb * 0.08, vec3(edge) * mix(vec3(0.85), center.rgb * 1.4, 0.5)), center.a);
}
`;

const EMBOSS_FRAG = `${EFFECT_FRAG_HEADER}
uniform float uStrength;

void main()
{
    vec2 stepUv = uInputSize.zw * 1.5;
    vec2 contentMax = max(uOutputFrame.zw * uInputSize.zw, vec2(0.0001));
    vec3 tl = texture(uTexture, clamp(vTextureCoord - stepUv, vec2(0.0), contentMax)).rgb;
    vec3 br = texture(uTexture, clamp(vTextureCoord + stepUv, vec2(0.0), contentMax)).rgb;
    vec4 center = texture(uTexture, vTextureCoord);
    vec3 diff = (tl - br) * max(0.1, uStrength);
    float relief = clamp(0.5 + dot(diff, vec3(0.299, 0.587, 0.114)) * 2.0, 0.0, 1.0);
    finalColor = vec4(vec3(relief), center.a);
}
`;

const UNSHARP_MASK_FRAG = `${EFFECT_FRAG_HEADER}
uniform float uAmount;
uniform float uRadius;
uniform float uThreshold;

void main()
{
    vec2 stepUv = uInputSize.zw * max(1.5, uRadius * 2.0);
    vec2 contentMax = max(uOutputFrame.zw * uInputSize.zw, vec2(0.0001));
    vec4 center = texture(uTexture, vTextureCoord);
    vec3 ring = (
        texture(uTexture, clamp(vTextureCoord + vec2(stepUv.x, 0.0), vec2(0.0), contentMax)).rgb +
        texture(uTexture, clamp(vTextureCoord - vec2(stepUv.x, 0.0), vec2(0.0), contentMax)).rgb +
        texture(uTexture, clamp(vTextureCoord + vec2(0.0, stepUv.y), vec2(0.0), contentMax)).rgb +
        texture(uTexture, clamp(vTextureCoord - vec2(0.0, stepUv.y), vec2(0.0), contentMax)).rgb +
        texture(uTexture, clamp(vTextureCoord + vec2(stepUv.x, stepUv.y), vec2(0.0), contentMax)).rgb +
        texture(uTexture, clamp(vTextureCoord + vec2(-stepUv.x, stepUv.y), vec2(0.0), contentMax)).rgb +
        texture(uTexture, clamp(vTextureCoord + vec2(stepUv.x, -stepUv.y), vec2(0.0), contentMax)).rgb +
        texture(uTexture, clamp(vTextureCoord - vec2(stepUv.x, stepUv.y), vec2(0.0), contentMax)).rgb
    ) * 0.125;
    vec3 detail = center.rgb - ring;
    float mask = smoothstep(max(0.0, uThreshold * 0.2), max(0.03, uThreshold + 0.03), length(detail));
    finalColor = vec4(clamp(center.rgb + detail * (uAmount * 3.2) * mask, 0.0, 1.0), center.a);
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
// WebGL1-compatible: Pixi compiles these sources as GLSL ES 1.00, which has no texelFetch.
vec3 cubeTexel(float x, float y) { return texture(uCubeLutTexture, vec2((x+0.5)/(uCubeSize*uCubeSize), (y+0.5)/uCubeSize)).rgb; }
vec3 sampleCube(vec3 rgb) {
  vec3 p=clamp((rgb-uCubeDomainMin)/(uCubeDomainMax-uCubeDomainMin),0.0,1.0)*(uCubeSize-1.0);
  vec3 lo=floor(p), hi=min(vec3(uCubeSize-1.0),lo+1.0), f=p-lo;
  float n=uCubeSize;
  vec3 c000=cubeTexel(lo.x*n+lo.z,lo.y).rgb;
  vec3 c100=cubeTexel(hi.x*n+lo.z,lo.y).rgb;
  vec3 c010=cubeTexel(lo.x*n+lo.z,hi.y).rgb;
  vec3 c110=cubeTexel(hi.x*n+lo.z,hi.y).rgb;
  vec3 c001=cubeTexel(lo.x*n+hi.z,lo.y).rgb;
  vec3 c101=cubeTexel(hi.x*n+hi.z,lo.y).rgb;
  vec3 c011=cubeTexel(lo.x*n+hi.z,hi.y).rgb;
  vec3 c111=cubeTexel(hi.x*n+hi.z,hi.y).rgb;
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

interface CurveTextureEntry {
  readonly texture: Texture;
  references: number;
}

interface CurveTextureLease {
  readonly texture: Texture;
  release(): void;
}

interface CubeTextureEntry {
  readonly texture: Texture;
  references: number;
}

interface CubeTextureLease {
  readonly texture: Texture;
  release(): void;
}

const curveTextureCache = new Map<string, CurveTextureEntry>();
const identityCurveTextureCache = new WeakMap<object, Texture>();
const identityCubeTextureCache = new WeakMap<object, Texture>();
const cubeTextureCache = new WeakMap<object, CubeTextureEntry>();

/** Release the grade filter and the curve/cube texture leases it owns. */
export function disposePixiColorGradeFilter(filter: Filter | undefined): void {
  filter?.destroy();
}

function createColorGradeV2Filter(grade: ColorGradeIR, cubeLut?: ParsedCubeLut): Filter {
  const adjust = grade.adjust;
  const lut = grade.lut;
  const curves = grade.curves;
  const curveLease = curves === undefined ? undefined : getCurveTexture(curves);
  const curveTexture = curveLease?.texture ?? identityCurveTexture();
  let cubeLease: CubeTextureLease | undefined;
  const wheel = (key: 'lift' | 'gamma' | 'gain' | 'offset') => {
    const value = grade.wheels?.[key];
    return new Float32Array([value?.r ?? 0, value?.g ?? 0, value?.b ?? 0, value?.master ?? 0]);
  };
  const bands = normalizeColorGradeHslBands(grade.hsl);
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
  try {
    cubeLease = cubeLut === undefined ? undefined : getCubeTexture(cubeLut);
    const cubeTexture = cubeLease?.texture ?? identityCubeTexture();
    const filter = new Filter({
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
          uCubeIntensity: {
            value: cubeLut === undefined ? 0 : (lut?.intensity ?? 1),
            type: 'f32',
          },
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
        // Pixi binds a filter's own textures by their source, not by the Texture object.
        uCurveTexture: curveTexture.source,
        uCubeLutTexture: cubeTexture.source,
      },
    });
    if (curveLease !== undefined || cubeLease !== undefined) {
      let released = false;
      const destroy = filter.destroy.bind(filter);
      filter.destroy = (destroyPrograms?: boolean): void => {
        if (!released) {
          released = true;
          curveLease?.release();
          cubeLease?.release();
        }
        destroy(destroyPrograms);
      };
    }
    return filter;
  } catch (error) {
    curveLease?.release();
    cubeLease?.release();
    throw error;
  }
}

function identityCurveTexture(): Texture {
  const cached = identityCurveTextureCache.get(identityCurveTexture);
  if (cached !== undefined) return cached;
  const pixels = new Uint8Array(256 * 4);
  for (let x = 0; x < 256; x += 1) pixels.fill(x, x * 4, x * 4 + 4);
  const texture = new Texture({
    source: new BufferImageSource({
      resource: pixels,
      width: 256,
      height: 1,
      scaleMode: 'nearest',
    }),
  });
  identityCurveTextureCache.set(identityCurveTexture, texture);
  return texture;
}

function getCurveTexture(curves: NonNullable<ColorGradeIR['curves']>): CurveTextureLease {
  const key = colorCurvesKey(curves);
  const cached = curveTextureCache.get(key);
  if (cached !== undefined) {
    cached.references += 1;
    return curveTextureLease(key, cached);
  }
  const tables = getColorCurveLuts(curves);
  const pixels = new Uint8Array(256 * 4);
  for (let x = 0; x < 256; x += 1)
    for (let channel = 0; channel < 4; channel += 1)
      pixels[x * 4 + channel] = tables[(['rgb', 'red', 'green', 'blue'] as const)[channel]!][x]!;
  const texture = new Texture({
    source: new BufferImageSource({
      resource: pixels,
      width: 256,
      height: 1,
      scaleMode: 'nearest',
    }),
  });
  const entry = { texture, references: 1 };
  curveTextureCache.set(key, entry);
  return curveTextureLease(key, entry);
}

function curveTextureLease(key: string, entry: CurveTextureEntry): CurveTextureLease {
  let released = false;
  return {
    texture: entry.texture,
    release(): void {
      if (released) return;
      released = true;
      entry.references -= 1;
      if (entry.references === 0 && curveTextureCache.get(key) === entry) {
        curveTextureCache.delete(key);
        entry.texture.destroy(true);
      }
    },
  };
}

function identityCubeTexture(): Texture {
  const cached = identityCubeTextureCache.get(identityCubeTexture);
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
      scaleMode: 'nearest',
    }),
  });
  identityCubeTextureCache.set(identityCubeTexture, texture);
  return texture;
}

function getCubeTexture(lut: ParsedCubeLut): CubeTextureLease {
  const key = lut as object;
  const cached = cubeTextureCache.get(key);
  if (cached !== undefined) {
    cached.references += 1;
    return cubeTextureLease(key, cached);
  }
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
      scaleMode: 'nearest',
    }),
  });
  const entry = { texture, references: 1 };
  cubeTextureCache.set(key, entry);
  return cubeTextureLease(key, entry);
}

function cubeTextureLease(key: object, entry: CubeTextureEntry): CubeTextureLease {
  let released = false;
  return {
    texture: entry.texture,
    release(): void {
      if (released) return;
      released = true;
      entry.references -= 1;
      if (entry.references === 0 && cubeTextureCache.get(key) === entry) {
        cubeTextureCache.delete(key);
        entry.texture.destroy(true);
      }
    },
  };
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
      const amount = Math.max(0, Math.min(1, effect.params.amount ?? 0.5));
      const matrix = new ColorMatrixFilter();
      const s = amount;
      const inv = 1 - s;
      matrix.matrix = [
        inv + s * 0.393,
        s * 0.769,
        s * 0.189,
        0,
        0,
        s * 0.349,
        inv + s * 0.686,
        s * 0.168,
        0,
        0,
        s * 0.272,
        s * 0.534,
        inv + s * 0.131,
        0,
        0,
        0,
        0,
        0,
        1,
        0,
      ];
      return [matrix];
    }
    case 'hue-saturation': {
      const matrix = new ColorMatrixFilter();
      const hue = (effect.params.hue ?? 0) * 180;
      const sat = effect.params.saturation ?? 0;
      if (hue !== 0) matrix.hue(hue, false);
      if (sat !== 0) matrix.saturate(sat, hue !== 0);
      return [matrix];
    }
    case 'vibrance': {
      const amount = effect.params.amount ?? 0;
      const matrix = new ColorMatrixFilter();
      if (amount !== 0) matrix.saturate(amount * 0.85, false);
      return [matrix];
    }
    case 'color-overlay': {
      return [
        createShaderEffectFilter('joy-color-overlay-filter', COLOR_OVERLAY_FRAG, {
          uR: effect.params.r ?? 255,
          uG: effect.params.g ?? 0,
          uB: effect.params.b ?? 0,
          uOpacity: effect.params.opacity ?? 0.3,
        }),
      ];
    }
    case 'curves': {
      return [
        createShaderEffectFilter('joy-curves-filter', CURVES_FRAG, {
          uShadows: effect.params.shadows ?? 0,
          uMidtones: effect.params.midtones ?? 0,
          uHighlights: effect.params.highlights ?? 0,
        }),
      ];
    }
    case 'bulge': {
      return [
        createShaderEffectFilter('joy-bulge-filter', BULGE_FRAG, {
          uAmount: effect.params.amount ?? 0,
          uRadius: effect.params.radius ?? 0.4,
        }),
      ];
    }
    case 'twist': {
      return [
        createShaderEffectFilter('joy-twist-filter', TWIST_FRAG, {
          uAngle: effect.params.angle ?? 0,
          uRadius: effect.params.radius ?? 0.5,
        }),
      ];
    }
    case 'ripple': {
      return [
        createShaderEffectFilter('joy-ripple-filter', RIPPLE_FRAG, {
          uAmplitude: effect.params.amplitude ?? 0.02,
          uFrequency: effect.params.frequency ?? 10,
        }),
      ];
    }
    case 'crt': {
      return [
        createShaderEffectFilter('joy-crt-filter', CRT_FRAG, {
          uScanlines: effect.params.scanlines ?? 0.5,
          uNoise: effect.params.noise ?? 0.08,
        }),
      ];
    }
    case 'edge-detect': {
      return [
        createShaderEffectFilter('joy-edge-detect-filter', EDGE_DETECT_FRAG, {
          uThreshold: effect.params.threshold ?? 0.3,
        }),
      ];
    }
    case 'emboss': {
      return [
        createShaderEffectFilter('joy-emboss-filter', EMBOSS_FRAG, {
          uStrength: effect.params.strength ?? 1,
        }),
      ];
    }
    case 'unsharp-mask': {
      return [
        createShaderEffectFilter('joy-unsharp-mask-filter', UNSHARP_MASK_FRAG, {
          uAmount: effect.params.amount ?? 0.5,
          uRadius: effect.params.radius ?? 1,
          uThreshold: effect.params.threshold ?? 0.05,
        }),
      ];
    }
    case 'bloom': {
      const amount = effect.params.amount ?? 0.4;
      const threshold = effect.params.threshold ?? 0.6;
      return [
        createShaderEffectFilter('joy-bloom-filter', BLOOM_FRAG, {
          uAmount: amount,
          uThreshold: threshold,
        }),
      ];
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
  return createShaderEffectFilter('joy-vignette-filter', VIGNETTE_FRAG, { uAmount: amount });
}

function createShaderEffectFilter(
  name: string,
  fragment: string,
  values: Readonly<Record<string, number>>,
): Filter {
  const uniforms: Record<string, { value: number; type: 'f32' }> = {};
  for (const [key, value] of Object.entries(values)) {
    uniforms[key] = { value, type: 'f32' };
  }
  return new Filter({
    glProgram: GlProgram.from({
      vertex: DEFAULT_FILTER_VERT,
      fragment,
      name,
    }),
    resources: {
      effectUniforms: uniforms,
    },
  });
}

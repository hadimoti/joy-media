import { Filter, GlProgram } from 'pixi.js';
import type { EffectInstanceIR } from '@joy-media/render-ir';

const FILTER_VERT = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void)
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(void)
{
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void)
{
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;

const FRAGMENT_HEADER = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uInputSize;

float luminance(vec3 color)
{
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
}
`;

const PIXELATE_FRAG = `${FRAGMENT_HEADER}
uniform float uBlockSize;

void main()
{
    vec2 block = vec2(max(1.0, uBlockSize));
    vec2 pixel = vTextureCoord * uInputSize.xy;
    vec2 samplePixel = (floor(pixel / block) + 0.5) * block;
    finalColor = texture(uTexture, clamp(samplePixel * uInputSize.zw, vec2(0.0), vec2(1.0)));
}
`;

const POSTERIZE_FRAG = `${FRAGMENT_HEADER}
uniform float uLevels;

void main()
{
    vec4 color = texture(uTexture, vTextureCoord);
    float levels = max(2.0, floor(uLevels + 0.5));
    color.rgb = floor(color.rgb * (levels - 1.0) + 0.5) / (levels - 1.0);
    finalColor = color;
}
`;

const MONOCHROME_FRAG = `${FRAGMENT_HEADER}
uniform float uThreshold;
uniform float uSoftness;
uniform float uContrast;
uniform float uInvert;

void main()
{
    vec4 color = texture(uTexture, vTextureCoord);
    float tone = (luminance(color.rgb) - 0.5) * (1.0 + uContrast) + 0.5;
    float halfSoftness = max(0.0001, uSoftness * 0.5);
    float mono = smoothstep(uThreshold - halfSoftness, uThreshold + halfSoftness, tone);
    mono = mix(mono, 1.0 - mono, step(0.5, uInvert));
    finalColor = vec4(vec3(mono), color.a);
}
`;

const BAYER_DITHER_FRAG = `${FRAGMENT_HEADER}
uniform float uCellSize;
uniform float uLevels;
uniform float uStrength;
uniform float uColorMode;
uniform float uInvert;

float bayer4(vec2 pixel)
{
    int x = int(mod(floor(pixel.x / max(1.0, uCellSize)), 4.0));
    int y = int(mod(floor(pixel.y / max(1.0, uCellSize)), 4.0));
    int index = y * 4 + x;
    float value = 0.0;
    if (index == 0) value = 0.0;
    else if (index == 1) value = 8.0;
    else if (index == 2) value = 2.0;
    else if (index == 3) value = 10.0;
    else if (index == 4) value = 12.0;
    else if (index == 5) value = 4.0;
    else if (index == 6) value = 14.0;
    else if (index == 7) value = 6.0;
    else if (index == 8) value = 3.0;
    else if (index == 9) value = 11.0;
    else if (index == 10) value = 1.0;
    else if (index == 11) value = 9.0;
    else if (index == 12) value = 15.0;
    else if (index == 13) value = 7.0;
    else if (index == 14) value = 13.0;
    else value = 5.0;
    return (value + 0.5) / 16.0;
}

void main()
{
    vec4 color = texture(uTexture, vTextureCoord);
    float tone = luminance(color.rgb);
    vec3 source = mix(vec3(tone), color.rgb, step(0.5, uColorMode));
    float levels = max(2.0, floor(uLevels + 0.5));
    float threshold = mix(0.5, bayer4(vTextureCoord * uInputSize.xy), uStrength);
    vec3 result = floor(source * (levels - 1.0) + threshold) / (levels - 1.0);
    result = mix(result, 1.0 - result, step(0.5, uInvert));
    finalColor = vec4(clamp(result, 0.0, 1.0), color.a);
}
`;

const HALFTONE_FRAG = `${FRAGMENT_HEADER}
uniform float uCellSize;
uniform float uAngle;
uniform float uDotScale;
uniform float uShape;
uniform float uColorMode;
uniform float uInvert;

mat2 rotation(float angle)
{
    float c = cos(angle);
    float s = sin(angle);
    return mat2(c, -s, s, c);
}

void main()
{
    vec2 resolution = uInputSize.xy;
    vec2 pixel = vTextureCoord * resolution - resolution * 0.5;
    float angle = radians(uAngle);
    mat2 rotateGrid = rotation(angle);
    mat2 unrotateGrid = rotation(-angle);
    vec2 rotated = rotateGrid * pixel;
    float cellSize = max(2.0, uCellSize);
    vec2 cellCenter = (floor(rotated / cellSize) + 0.5) * cellSize;
    vec2 sourcePixel = unrotateGrid * cellCenter + resolution * 0.5;
    vec4 source = texture(uTexture, clamp(sourcePixel / resolution, vec2(0.0), vec2(1.0)));
    float tone = luminance(source.rgb);
    tone = mix(tone, 1.0 - tone, step(0.5, uInvert));

    vec2 local = (rotated - cellCenter) / cellSize;
    float radius = 0.72 * sqrt(max(0.0, 1.0 - tone)) * uDotScale;
    float distanceToShape = length(local);
    if (uShape > 0.5 && uShape < 1.5) {
        distanceToShape = abs(local.x) + abs(local.y);
    } else if (uShape >= 1.5) {
        distanceToShape = abs(local.y) * 1.8;
    }
    float antialias = max(fwidth(distanceToShape), 0.006);
    float ink = 1.0 - smoothstep(radius - antialias, radius + antialias, distanceToShape);
    vec3 inkColor = mix(vec3(0.0), source.rgb, step(0.5, uColorMode));
    finalColor = vec4(mix(vec3(1.0), inkColor, ink), source.a);
}
`;

const CONTOUR_MAP_FRAG = `${FRAGMENT_HEADER}
uniform float uSpacing;
uniform float uThickness;
uniform float uEdgeBoost;
uniform float uDetail;
uniform float uInvert;

float sampleTone(vec2 uv)
{
    return luminance(texture(uTexture, clamp(uv, vec2(0.0), vec2(1.0))).rgb);
}

void main()
{
    vec4 color = texture(uTexture, vTextureCoord);
    float tone = luminance(color.rgb);
    vec2 texel = uInputSize.zw * max(1.0, uDetail);
    float tl = sampleTone(vTextureCoord + texel * vec2(-1.0, -1.0));
    float tc = sampleTone(vTextureCoord + texel * vec2(0.0, -1.0));
    float tr = sampleTone(vTextureCoord + texel * vec2(1.0, -1.0));
    float ml = sampleTone(vTextureCoord + texel * vec2(-1.0, 0.0));
    float mr = sampleTone(vTextureCoord + texel * vec2(1.0, 0.0));
    float bl = sampleTone(vTextureCoord + texel * vec2(-1.0, 1.0));
    float bc = sampleTone(vTextureCoord + texel * vec2(0.0, 1.0));
    float br = sampleTone(vTextureCoord + texel * vec2(1.0, 1.0));
    float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
    float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
    float edge = smoothstep(0.04, 0.35, length(vec2(gx, gy)) * uEdgeBoost);

    float phase = fract(tone * max(2.0, uSpacing));
    float bandDistance = min(phase, 1.0 - phase);
    float band = 1.0 - smoothstep(0.0, max(0.002, uThickness), bandDistance);
    float ink = max(band, edge);
    float result = 1.0 - ink;
    result = mix(result, 1.0 - result, step(0.5, uInvert));
    finalColor = vec4(vec3(result), color.a);
}
`;

const GLYPH_MATRIX_FRAG = `${FRAGMENT_HEADER}
uniform float uCellWidth;
uniform float uCellHeight;
uniform float uDensity;
uniform float uContrast;
uniform float uStyle;
uniform float uFlow;
uniform float uForegroundR;
uniform float uForegroundG;
uniform float uForegroundB;
uniform float uColorMode;
uniform float uInvert;

float hash21(vec2 value)
{
    return fract(sin(dot(value, vec2(127.1, 311.7))) * 43758.5453123);
}

void main()
{
    vec2 resolution = uInputSize.xy;
    vec2 cell = vec2(max(3.0, uCellWidth), max(5.0, uCellHeight));
    vec2 pixel = vTextureCoord * resolution;
    vec2 sourceId = floor(pixel / cell);
    vec2 sourceCenter = (sourceId + 0.5) * cell;
    vec4 source = texture(uTexture, clamp(sourceCenter / resolution, vec2(0.0), vec2(1.0)));
    float tone = (luminance(source.rgb) - 0.5) * (1.0 + uContrast) + 0.5;
    tone = clamp(mix(tone, 1.0 - tone, step(0.5, uInvert)), 0.0, 1.0);

    float flowOffset = floor(hash21(vec2(sourceId.x, 9.31)) * 8.0) * cell.y * uFlow;
    vec2 flowingPixel = pixel + vec2(0.0, flowOffset);
    vec2 glyphId = floor(flowingPixel / cell);
    vec2 local = fract(flowingPixel / cell);
    vec2 subGrid = vec2(3.0, 5.0);
    vec2 subId = floor(local * subGrid);
    vec2 subLocal = fract(local * subGrid) - 0.5;
    float randomMark = hash21(glyphId * 17.0 + subId * 5.13);
    float enabled = step(randomMark, clamp(tone * uDensity, 0.0, 1.0));

    float mark = 0.0;
    if (uStyle < 0.5) {
        mark = 1.0 - smoothstep(0.24, 0.38, length(subLocal));
    } else if (uStyle < 1.5) {
        mark = 1.0 - smoothstep(0.31, 0.42, max(abs(subLocal.x), abs(subLocal.y)));
    } else {
        float horizontal = 1.0 - smoothstep(0.10, 0.18, abs(subLocal.y));
        float vertical = 1.0 - smoothstep(0.10, 0.18, abs(subLocal.x));
        mark = mix(horizontal, vertical, step(0.5, mod(subId.x + subId.y, 2.0)));
    }
    float mask = enabled * mark;
    vec3 customInk = vec3(uForegroundR, uForegroundG, uForegroundB) / 255.0;
    vec3 ink = mix(customInk, source.rgb, step(0.5, uColorMode));
    finalColor = vec4(mix(vec3(0.008), ink, mask), source.a);
}
`;

const SCATTER_MOSAIC_FRAG = `${FRAGMENT_HEADER}
uniform float uCellSize;
uniform float uScatter;
uniform float uLevels;
uniform float uColorMode;
uniform float uSeed;

float hash21(vec2 value)
{
    return fract(sin(dot(value, vec2(127.1, 311.7))) * 43758.5453123);
}

vec2 hash22(vec2 value)
{
    return vec2(hash21(value + uSeed), hash21(value.yx + 19.19 + uSeed));
}

void main()
{
    vec2 resolution = uInputSize.xy;
    float cellSize = max(2.0, uCellSize);
    vec2 pixel = vTextureCoord * resolution;
    vec2 cellId = floor(pixel / cellSize);
    vec2 offset = (hash22(cellId) - 0.5) * cellSize * uScatter;
    vec2 samplePixel = (cellId + 0.5) * cellSize + offset;
    vec4 source = texture(uTexture, clamp(samplePixel / resolution, vec2(0.0), vec2(1.0)));
    float tone = luminance(source.rgb);
    vec3 result = mix(vec3(tone), source.rgb, step(0.5, uColorMode));
    float levels = max(2.0, floor(uLevels + 0.5));
    result = floor(result * (levels - 1.0) + 0.5) / (levels - 1.0);
    finalColor = vec4(result, source.a);
}
`;

const TONE_GEOMETRY_FRAG = `${FRAGMENT_HEADER}
uniform float uCellSize;
uniform float uScale;
uniform float uAngle;
uniform float uShape;
uniform float uColorMode;
uniform float uInvert;

mat2 rotation(float angle)
{
    float c = cos(angle);
    float s = sin(angle);
    return mat2(c, -s, s, c);
}

void main()
{
    vec2 resolution = uInputSize.xy;
    float cellSize = max(3.0, uCellSize);
    vec2 pixel = vTextureCoord * resolution;
    vec2 cellId = floor(pixel / cellSize);
    vec2 center = (cellId + 0.5) * cellSize;
    vec4 source = texture(uTexture, clamp(center / resolution, vec2(0.0), vec2(1.0)));
    float tone = luminance(source.rgb);
    tone = mix(tone, 1.0 - tone, step(0.5, uInvert));
    vec2 local = rotation(radians(uAngle)) * ((pixel - center) / cellSize);
    float radius = 0.7 * sqrt(max(0.0, 1.0 - tone)) * uScale;
    float distanceToShape = length(local);
    if (uShape > 0.5 && uShape < 1.5) {
        distanceToShape = abs(local.x) + abs(local.y);
    } else if (uShape >= 1.5 && uShape < 2.5) {
        distanceToShape = min(max(abs(local.x), abs(local.y) * 3.2), max(abs(local.y), abs(local.x) * 3.2));
    } else if (uShape >= 2.5) {
        distanceToShape = abs(local.y) * 1.8;
    }
    float antialias = max(fwidth(distanceToShape), 0.006);
    float mask = 1.0 - smoothstep(radius - antialias, radius + antialias, distanceToShape);
    vec3 ink = mix(vec3(0.0), source.rgb, step(0.5, uColorMode));
    finalColor = vec4(mix(vec3(1.0), ink, mask), source.a);
}
`;

const PIXEL_SORT_FRAG = `${FRAGMENT_HEADER}
uniform float uDirection;
uniform float uLowThreshold;
uniform float uHighThreshold;
uniform float uLength;
uniform float uIntensity;
uniform float uColorMode;

float hash11(float value)
{
    return fract(sin(value * 12.9898) * 43758.5453123);
}

void main()
{
    vec2 resolution = uInputSize.xy;
    vec2 pixel = vTextureCoord * resolution;
    vec4 source = texture(uTexture, vTextureCoord);
    float tone = luminance(source.rgb);
    float selected = step(uLowThreshold, tone) * step(tone, max(uLowThreshold + 0.001, uHighThreshold));
    vec2 direction = mix(vec2(1.0, 0.0), vec2(0.0, 1.0), step(0.5, uDirection));
    float lane = mix(floor(pixel.y / 3.0), floor(pixel.x / 3.0), step(0.5, uDirection));
    float laneJitter = hash11(lane) - 0.5;
    float gateRange = max(0.001, uHighThreshold - uLowThreshold);
    float positionInGate = clamp((tone - uLowThreshold) / gateRange, 0.0, 1.0);
    float offset = ((positionInGate - 0.5) * 2.0 + laneJitter * 0.35) * uLength * uIntensity;
    vec2 sortedUv = clamp(vTextureCoord - direction * offset / resolution, vec2(0.0), vec2(1.0));
    vec4 sorted = texture(uTexture, sortedUv);
    vec4 result = mix(source, sorted, selected);
    float resultTone = luminance(result.rgb);
    result.rgb = mix(vec3(resultTone), result.rgb, step(0.5, uColorMode));
    finalColor = result;
}
`;

export function createCreativeEffectFilter(effect: EffectInstanceIR): Filter | undefined {
  const number = (key: string, fallback: number): number => effect.params[key] ?? fallback;
  switch (effect.kind) {
    case 'pixelate':
    case 'mosaic':
      return createFilter('joy-pixelate-filter', PIXELATE_FRAG, {
        uBlockSize: number('blockSize', effect.kind === 'mosaic' ? 16 : 8),
      });
    case 'posterize':
      return createFilter('joy-posterize-filter', POSTERIZE_FRAG, {
        uLevels: number('levels', 8),
      });
    case 'monochrome':
      return createFilter('joy-monochrome-filter', MONOCHROME_FRAG, {
        uThreshold: number('threshold', 0.5),
        uSoftness: number('softness', 0.04),
        uContrast: number('contrast', 0.2),
        uInvert: number('invert', 0),
      });
    case 'bayer-dither':
      return createFilter('joy-bayer-dither-filter', BAYER_DITHER_FRAG, {
        uCellSize: number('cellSize', 2),
        uLevels: number('levels', 2),
        uStrength: number('strength', 1),
        uColorMode: number('colorMode', 0),
        uInvert: number('invert', 0),
      });
    case 'halftone':
      return createFilter('joy-halftone-filter', HALFTONE_FRAG, {
        uCellSize: number('cellSize', 10),
        uAngle: number('angle', 22.5),
        uDotScale: number('dotScale', 1),
        uShape: number('shape', 0),
        uColorMode: number('colorMode', 0),
        uInvert: number('invert', 0),
      });
    case 'contour-map':
      return createFilter('joy-contour-map-filter', CONTOUR_MAP_FRAG, {
        uSpacing: number('spacing', 9),
        uThickness: number('thickness', 0.16),
        uEdgeBoost: number('edgeBoost', 0.75),
        uDetail: number('detail', 1),
        uInvert: number('invert', 0),
      });
    case 'glyph-matrix':
      return createFilter('joy-glyph-matrix-filter', GLYPH_MATRIX_FRAG, {
        uCellWidth: number('cellWidth', 10),
        uCellHeight: number('cellHeight', 14),
        uDensity: number('density', 1),
        uContrast: number('contrast', 0.3),
        uStyle: number('style', 1),
        uFlow: number('flow', 0),
        uForegroundR: number('foregroundR', 110),
        uForegroundG: number('foregroundG', 255),
        uForegroundB: number('foregroundB', 155),
        uColorMode: number('colorMode', 0),
        uInvert: number('invert', 0),
      });
    case 'scatter-mosaic':
      return createFilter('joy-scatter-mosaic-filter', SCATTER_MOSAIC_FRAG, {
        uCellSize: number('cellSize', 12),
        uScatter: number('scatter', 0.75),
        uLevels: number('levels', 8),
        uColorMode: number('colorMode', 1),
        uSeed: number('seed', 3),
      });
    case 'tone-geometry':
      return createFilter('joy-tone-geometry-filter', TONE_GEOMETRY_FRAG, {
        uCellSize: number('cellSize', 14),
        uScale: number('scale', 1),
        uAngle: number('angle', 0),
        uShape: number('shape', 0),
        uColorMode: number('colorMode', 0),
        uInvert: number('invert', 0),
      });
    case 'pixel-sort':
      return createFilter('joy-pixel-sort-filter', PIXEL_SORT_FRAG, {
        uDirection: number('direction', 1),
        uLowThreshold: number('lowThreshold', 0.18),
        uHighThreshold: number('highThreshold', 0.9),
        uLength: number('length', 72),
        uIntensity: number('intensity', 1),
        uColorMode: number('colorMode', 1),
      });
    default:
      return undefined;
  }
}

function createFilter(
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
      vertex: FILTER_VERT,
      fragment,
      name,
    }),
    resources: {
      creativeEffectUniforms: uniforms,
    },
  });
}

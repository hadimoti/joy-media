type NumericParams = Readonly<Record<string, number>>;

const BAYER_4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;

export function applyCreativeEffect(
  pixels: Uint8Array,
  width: number,
  height: number,
  kind: string,
  params: NumericParams,
): boolean {
  switch (kind) {
    case 'pixelate':
      pixelate(pixels, width, height, params.blockSize ?? 8);
      return true;
    case 'mosaic':
      pixelate(pixels, width, height, params.blockSize ?? 16);
      return true;
    case 'monochrome':
      monochrome(pixels, params);
      return true;
    case 'bayer-dither':
      bayerDither(pixels, width, params);
      return true;
    case 'halftone':
      halftone(pixels, width, height, params);
      return true;
    case 'contour-map':
      contourMap(pixels, width, height, params);
      return true;
    case 'glyph-matrix':
      glyphMatrix(pixels, width, height, params);
      return true;
    case 'scatter-mosaic':
      scatterMosaic(pixels, width, height, params);
      return true;
    case 'tone-geometry':
      toneGeometry(pixels, width, height, params);
      return true;
    case 'pixel-sort':
      pixelSort(pixels, width, height, params);
      return true;
    default:
      return false;
  }
}

function monochrome(pixels: Uint8Array, params: NumericParams): void {
  const threshold = params.threshold ?? 0.5;
  const softness = Math.max(0.0001, (params.softness ?? 0.04) * 0.5);
  const contrast = params.contrast ?? 0.2;
  const invert = (params.invert ?? 0) >= 0.5;
  for (let index = 0; index < pixels.length; index += 4) {
    const tone = (luminanceAt(pixels, index) - 0.5) * (1 + contrast) + 0.5;
    let value = smoothstep(threshold - softness, threshold + softness, tone);
    if (invert) value = 1 - value;
    const byte = toByte(value * 255);
    pixels[index] = byte;
    pixels[index + 1] = byte;
    pixels[index + 2] = byte;
  }
}

function bayerDither(pixels: Uint8Array, width: number, params: NumericParams): void {
  const cellSize = Math.max(1, Math.round(params.cellSize ?? 2));
  const levels = Math.max(2, Math.round(params.levels ?? 2));
  const strength = clamp01(params.strength ?? 1);
  const colorMode = (params.colorMode ?? 0) >= 0.5;
  const invert = (params.invert ?? 0) >= 0.5;
  for (let index = 0; index < pixels.length; index += 4) {
    const pixelIndex = index / 4;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const bx = Math.floor(x / cellSize) % 4;
    const by = Math.floor(y / cellSize) % 4;
    const ordered = ((BAYER_4[by * 4 + bx] ?? 0) + 0.5) / 16;
    const threshold = 0.5 + (ordered - 0.5) * strength;
    const tone = luminanceAt(pixels, index);
    const channels = colorMode
      ? [pixels[index]! / 255, pixels[index + 1]! / 255, pixels[index + 2]! / 255]
      : [tone, tone, tone];
    for (let channel = 0; channel < 3; channel++) {
      let result = Math.floor(channels[channel]! * (levels - 1) + threshold) / (levels - 1);
      if (invert) result = 1 - result;
      pixels[index + channel] = toByte(result * 255);
    }
  }
}

function halftone(pixels: Uint8Array, width: number, height: number, params: NumericParams): void {
  const source = new Uint8Array(pixels);
  const cellSize = Math.max(2, params.cellSize ?? 10);
  const radians = ((params.angle ?? 22.5) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dotScale = params.dotScale ?? 1;
  const shape = Math.round(params.shape ?? 0);
  const colorMode = (params.colorMode ?? 0) >= 0.5;
  const invert = (params.invert ?? 0) >= 0.5;
  const centerX = width * 0.5;
  const centerY = height * 0.5;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5 - centerX;
      const py = y + 0.5 - centerY;
      const rotatedX = cos * px - sin * py;
      const rotatedY = sin * px + cos * py;
      const cellX = (Math.floor(rotatedX / cellSize) + 0.5) * cellSize;
      const cellY = (Math.floor(rotatedY / cellSize) + 0.5) * cellSize;
      const sourceX = cos * cellX + sin * cellY + centerX;
      const sourceY = -sin * cellX + cos * cellY + centerY;
      const sourceIndex = sampleIndex(width, height, sourceX, sourceY);
      let tone = luminanceAt(source, sourceIndex);
      if (invert) tone = 1 - tone;
      const localX = (rotatedX - cellX) / cellSize;
      const localY = (rotatedY - cellY) / cellSize;
      const radius = 0.72 * Math.sqrt(Math.max(0, 1 - tone)) * dotScale;
      let distance = Math.hypot(localX, localY);
      if (shape === 1) distance = Math.abs(localX) + Math.abs(localY);
      if (shape >= 2) distance = Math.abs(localY) * 1.8;
      const ink = distance <= radius ? 1 : 0;
      const targetIndex = (y * width + x) * 4;
      if (ink === 0) {
        pixels[targetIndex] = 255;
        pixels[targetIndex + 1] = 255;
        pixels[targetIndex + 2] = 255;
      } else if (colorMode) {
        pixels[targetIndex] = source[sourceIndex]!;
        pixels[targetIndex + 1] = source[sourceIndex + 1]!;
        pixels[targetIndex + 2] = source[sourceIndex + 2]!;
      } else {
        pixels[targetIndex] = 0;
        pixels[targetIndex + 1] = 0;
        pixels[targetIndex + 2] = 0;
      }
      pixels[targetIndex + 3] = source[sourceIndex + 3]!;
    }
  }
}

function contourMap(
  pixels: Uint8Array,
  width: number,
  height: number,
  params: NumericParams,
): void {
  const source = new Uint8Array(pixels);
  const tones = new Float32Array(width * height);
  for (let index = 0; index < tones.length; index++) {
    tones[index] = luminanceAt(source, index * 4);
  }
  const spacing = Math.max(2, params.spacing ?? 9);
  const thickness = Math.max(0.002, params.thickness ?? 0.16);
  const edgeBoost = params.edgeBoost ?? 0.75;
  const detail = Math.max(1, Math.round(params.detail ?? 1));
  const invert = (params.invert ?? 0) >= 0.5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tone = toneAt(tones, width, height, x, y);
      const tl = toneAt(tones, width, height, x - detail, y - detail);
      const tc = toneAt(tones, width, height, x, y - detail);
      const tr = toneAt(tones, width, height, x + detail, y - detail);
      const ml = toneAt(tones, width, height, x - detail, y);
      const mr = toneAt(tones, width, height, x + detail, y);
      const bl = toneAt(tones, width, height, x - detail, y + detail);
      const bc = toneAt(tones, width, height, x, y + detail);
      const br = toneAt(tones, width, height, x + detail, y + detail);
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      const edge = smoothstep(0.04, 0.35, Math.hypot(gx, gy) * edgeBoost);
      const phase = positiveModulo(tone * spacing, 1);
      const bandDistance = Math.min(phase, 1 - phase);
      const band = 1 - smoothstep(0, thickness, bandDistance);
      const ink = Math.max(band, edge);
      let result = 1 - ink;
      if (invert) result = 1 - result;
      const byte = toByte(result * 255);
      const index = (y * width + x) * 4;
      pixels[index] = byte;
      pixels[index + 1] = byte;
      pixels[index + 2] = byte;
    }
  }
}

function glyphMatrix(
  pixels: Uint8Array,
  width: number,
  height: number,
  params: NumericParams,
): void {
  const source = new Uint8Array(pixels);
  const cellWidth = Math.max(3, params.cellWidth ?? 10);
  const cellHeight = Math.max(5, params.cellHeight ?? 14);
  const density = params.density ?? 1;
  const contrast = params.contrast ?? 0.3;
  const style = Math.round(params.style ?? 1);
  const flow = params.flow ?? 0;
  const foreground = [
    toByte(params.foregroundR ?? 110),
    toByte(params.foregroundG ?? 255),
    toByte(params.foregroundB ?? 155),
  ] as const;
  const sourceColor = (params.colorMode ?? 0) >= 0.5;
  const invert = (params.invert ?? 0) >= 0.5;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceCellX = Math.floor(x / cellWidth);
      const sourceCellY = Math.floor(y / cellHeight);
      const sourceIndex = sampleIndex(
        width,
        height,
        (sourceCellX + 0.5) * cellWidth,
        (sourceCellY + 0.5) * cellHeight,
      );
      let tone = (luminanceAt(source, sourceIndex) - 0.5) * (1 + contrast) + 0.5;
      if (invert) tone = 1 - tone;
      tone = clamp01(tone);

      const flowOffset = Math.floor(hash2(sourceCellX, 9.31) * 8) * cellHeight * flow;
      const flowingY = y + flowOffset;
      const glyphX = Math.floor(x / cellWidth);
      const glyphY = Math.floor(flowingY / cellHeight);
      const localX = positiveModulo(x / cellWidth, 1);
      const localY = positiveModulo(flowingY / cellHeight, 1);
      const subX = Math.floor(localX * 3);
      const subY = Math.floor(localY * 5);
      const subLocalX = positiveModulo(localX * 3, 1) - 0.5;
      const subLocalY = positiveModulo(localY * 5, 1) - 0.5;
      const enabled =
        hash2(glyphX * 17 + subX * 5.13, glyphY * 17 + subY * 5.13) <= clamp01(tone * density);
      let mark = false;
      if (style === 0) mark = Math.hypot(subLocalX, subLocalY) <= 0.34;
      else if (style === 1) mark = Math.max(Math.abs(subLocalX), Math.abs(subLocalY)) <= 0.38;
      else if ((subX + subY) % 2 === 0) mark = Math.abs(subLocalY) <= 0.14;
      else mark = Math.abs(subLocalX) <= 0.14;

      const targetIndex = (y * width + x) * 4;
      if (enabled && mark) {
        pixels[targetIndex] = sourceColor ? source[sourceIndex]! : foreground[0];
        pixels[targetIndex + 1] = sourceColor ? source[sourceIndex + 1]! : foreground[1];
        pixels[targetIndex + 2] = sourceColor ? source[sourceIndex + 2]! : foreground[2];
      } else {
        pixels[targetIndex] = 2;
        pixels[targetIndex + 1] = 2;
        pixels[targetIndex + 2] = 2;
      }
      pixels[targetIndex + 3] = source[sourceIndex + 3]!;
    }
  }
}

function scatterMosaic(
  pixels: Uint8Array,
  width: number,
  height: number,
  params: NumericParams,
): void {
  const source = new Uint8Array(pixels);
  const cellSize = Math.max(2, params.cellSize ?? 12);
  const scatter = params.scatter ?? 0.75;
  const levels = Math.max(2, Math.round(params.levels ?? 8));
  const sourceColor = (params.colorMode ?? 1) >= 0.5;
  const seed = params.seed ?? 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cellX = Math.floor(x / cellSize);
      const cellY = Math.floor(y / cellSize);
      const offsetX = (hash2(cellX + seed, cellY) - 0.5) * cellSize * scatter;
      const offsetY = (hash2(cellY + 19.19 + seed, cellX) - 0.5) * cellSize * scatter;
      const sourceIndex = sampleIndex(
        width,
        height,
        (cellX + 0.5) * cellSize + offsetX,
        (cellY + 0.5) * cellSize + offsetY,
      );
      const tone = luminanceAt(source, sourceIndex);
      const targetIndex = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const value = sourceColor ? source[sourceIndex + channel]! / 255 : tone;
        pixels[targetIndex + channel] = toByte(
          (Math.round(value * (levels - 1)) / (levels - 1)) * 255,
        );
      }
      pixels[targetIndex + 3] = source[sourceIndex + 3]!;
    }
  }
}

function toneGeometry(
  pixels: Uint8Array,
  width: number,
  height: number,
  params: NumericParams,
): void {
  const source = new Uint8Array(pixels);
  const cellSize = Math.max(3, params.cellSize ?? 14);
  const scale = params.scale ?? 1;
  const radians = ((params.angle ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const shape = Math.round(params.shape ?? 0);
  const sourceColor = (params.colorMode ?? 0) >= 0.5;
  const invert = (params.invert ?? 0) >= 0.5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cellX = Math.floor(x / cellSize);
      const cellY = Math.floor(y / cellSize);
      const centerX = (cellX + 0.5) * cellSize;
      const centerY = (cellY + 0.5) * cellSize;
      const sourceIndex = sampleIndex(width, height, centerX, centerY);
      let tone = luminanceAt(source, sourceIndex);
      if (invert) tone = 1 - tone;
      const rawX = (x + 0.5 - centerX) / cellSize;
      const rawY = (y + 0.5 - centerY) / cellSize;
      const localX = cos * rawX - sin * rawY;
      const localY = sin * rawX + cos * rawY;
      const radius = 0.7 * Math.sqrt(Math.max(0, 1 - tone)) * scale;
      let distance = Math.hypot(localX, localY);
      if (shape === 1) distance = Math.abs(localX) + Math.abs(localY);
      else if (shape === 2) {
        distance = Math.min(
          Math.max(Math.abs(localX), Math.abs(localY) * 3.2),
          Math.max(Math.abs(localY), Math.abs(localX) * 3.2),
        );
      } else if (shape >= 3) distance = Math.abs(localY) * 1.8;
      const ink = distance <= radius;
      const targetIndex = (y * width + x) * 4;
      if (!ink) {
        pixels[targetIndex] = 255;
        pixels[targetIndex + 1] = 255;
        pixels[targetIndex + 2] = 255;
      } else if (sourceColor) {
        pixels[targetIndex] = source[sourceIndex]!;
        pixels[targetIndex + 1] = source[sourceIndex + 1]!;
        pixels[targetIndex + 2] = source[sourceIndex + 2]!;
      } else {
        pixels[targetIndex] = 0;
        pixels[targetIndex + 1] = 0;
        pixels[targetIndex + 2] = 0;
      }
      pixels[targetIndex + 3] = source[sourceIndex + 3]!;
    }
  }
}

function pixelSort(pixels: Uint8Array, width: number, height: number, params: NumericParams): void {
  const source = new Uint8Array(pixels);
  const vertical = (params.direction ?? 1) >= 0.5;
  const low = params.lowThreshold ?? 0.18;
  const high = Math.max(low + 0.001, params.highThreshold ?? 0.9);
  const length = params.length ?? 72;
  const intensity = params.intensity ?? 1;
  const sourceColor = (params.colorMode ?? 1) >= 0.5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const targetIndex = (y * width + x) * 4;
      const tone = luminanceAt(source, targetIndex);
      if (tone < low || tone > high) continue;
      const lane = vertical ? Math.floor(x / 3) : Math.floor(y / 3);
      const laneJitter = hash1(lane) - 0.5;
      const positionInGate = clamp01((tone - low) / (high - low));
      const offset = ((positionInGate - 0.5) * 2 + laneJitter * 0.35) * length * intensity;
      const sourceIndex = sampleIndex(
        width,
        height,
        vertical ? x : x - offset,
        vertical ? y - offset : y,
      );
      if (sourceColor) {
        pixels[targetIndex] = source[sourceIndex]!;
        pixels[targetIndex + 1] = source[sourceIndex + 1]!;
        pixels[targetIndex + 2] = source[sourceIndex + 2]!;
      } else {
        const value = toByte(luminanceAt(source, sourceIndex) * 255);
        pixels[targetIndex] = value;
        pixels[targetIndex + 1] = value;
        pixels[targetIndex + 2] = value;
      }
      pixels[targetIndex + 3] = source[sourceIndex + 3]!;
    }
  }
}

function pixelate(pixels: Uint8Array, width: number, height: number, rawSize: number): void {
  const source = new Uint8Array(pixels);
  const blockSize = Math.max(1, Math.round(rawSize));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sampleX = (Math.floor(x / blockSize) + 0.5) * blockSize;
      const sampleY = (Math.floor(y / blockSize) + 0.5) * blockSize;
      const sourceIndex = sampleIndex(width, height, sampleX, sampleY);
      const targetIndex = (y * width + x) * 4;
      pixels[targetIndex] = source[sourceIndex]!;
      pixels[targetIndex + 1] = source[sourceIndex + 1]!;
      pixels[targetIndex + 2] = source[sourceIndex + 2]!;
      pixels[targetIndex + 3] = source[sourceIndex + 3]!;
    }
  }
}

function sampleIndex(width: number, height: number, x: number, y: number): number {
  const sampleX = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const sampleY = Math.max(0, Math.min(height - 1, Math.floor(y)));
  return (sampleY * width + sampleX) * 4;
}

function toneAt(tones: Float32Array, width: number, height: number, x: number, y: number): number {
  const sampleX = Math.max(0, Math.min(width - 1, x));
  const sampleY = Math.max(0, Math.min(height - 1, y));
  return tones[sampleY * width + sampleX] ?? 0;
}

function luminanceAt(pixels: Uint8Array, index: number): number {
  return (
    (pixels[index]! * 0.2126 + pixels[index + 1]! * 0.7152 + pixels[index + 2]! * 0.0722) / 255
  );
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function hash1(value: number): number {
  return positiveModulo(Math.sin(value * 12.9898) * 43_758.5453123, 1);
}

function hash2(x: number, y: number): number {
  return positiveModulo(Math.sin(x * 127.1 + y * 311.7) * 43_758.5453123, 1);
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function toByte(value: number): number {
  return Math.round(Math.max(0, Math.min(255, value)));
}

/**
 * CPU-side effect / color-grade helpers shared by the Node software rasterizer.
 * Browser Pixi filter construction lives in `effects-pixi.ts` so this module
 * stays free of `pixi.js` (required for Node vitest / golden parity).
 */

import type { ColorGradeIR, EffectInstanceIR, Rgba } from '@joy-media/render-ir';

export function isIdentityColorGrade(grade: ColorGradeIR | undefined): boolean {
  if (grade === undefined) return true;
  return (
    grade.lift === 0 &&
    grade.gamma === 1 &&
    grade.gain === 1 &&
    grade.saturation === 1 &&
    (grade.lutId === undefined || grade.lutId === 'none')
  );
}

export function effectsSignature(effects: readonly EffectInstanceIR[] | undefined): string {
  if (effects === undefined || effects.length === 0) return '';
  return effects
    .filter((effect) => effect.enabled)
    .map((effect) => `${effect.id}:${effect.kind}:${stableParams(effect.params)}`)
    .join('|');
}

export function colorGradeSignature(grade: ColorGradeIR | undefined): string {
  if (grade === undefined || isIdentityColorGrade(grade)) return '';
  return `${grade.lift}:${grade.gamma}:${grade.gain}:${grade.saturation}:${grade.lutId ?? 'none'}`;
}

/** CPU color-grade of a full RGBA8 surface (Node / parity path). */
export function applyColorGradeToPixels(
  pixels: Uint8Array,
  grade: ColorGradeIR | undefined,
): void {
  if (grade === undefined || isIdentityColorGrade(grade)) return;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    let r = pixels[offset]! / 255;
    let g = pixels[offset + 1]! / 255;
    let b = pixels[offset + 2]! / 255;
    r = gradeChannel(r, grade);
    g = gradeChannel(g, grade);
    b = gradeChannel(b, grade);
    if (grade.saturation !== 1) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = lum + (r - lum) * grade.saturation;
      g = lum + (g - lum) * grade.saturation;
      b = lum + (b - lum) * grade.saturation;
    }
    if (grade.lutId === 'contrast') {
      r = contrastChannel(r, 0.25);
      g = contrastChannel(g, 0.25);
      b = contrastChannel(b, 0.25);
    } else if (grade.lutId === 'rec709') {
      r = contrastChannel(r, 0.1);
      g = contrastChannel(g, 0.1);
      b = contrastChannel(b, 0.1);
    }
    pixels[offset] = clampByte(r * 255);
    pixels[offset + 1] = clampByte(g * 255);
    pixels[offset + 2] = clampByte(b * 255);
  }
}

/** Sample a color after per-object CPU effects (grain / simple glow tint). */
export function applyCpuEffectsToColor(
  color: Rgba,
  effects: readonly EffectInstanceIR[] | undefined,
  localX: number,
  localY: number,
): Rgba {
  if (effects === undefined || effects.length === 0) return color;
  let r = color.r;
  let g = color.g;
  let b = color.b;
  let a = color.a;
  for (const effect of effects) {
    if (!effect.enabled) continue;
    switch (effect.kind) {
      case 'grain': {
        const amount = effect.params.amount ?? 0.2;
        const n = (hashNoise(localX, localY) - 0.5) * amount * 255;
        r = clampByte(r + n);
        g = clampByte(g + n);
        b = clampByte(b + n);
        break;
      }
      case 'glow': {
        const amount = effect.params.amount ?? 0.4;
        r = clampByte(r + amount * 40);
        g = clampByte(g + amount * 40);
        b = clampByte(b + amount * 40);
        break;
      }
      case 'sharpen': {
        const amount = effect.params.amount ?? 0.3;
        r = clampByte(lumPush(r, amount));
        g = clampByte(lumPush(g, amount));
        b = clampByte(lumPush(b, amount));
        break;
      }
      case 'shadow': {
        const opacity = effect.params.opacity ?? 0.5;
        a = clampByte(a * (1 - opacity * 0.15));
        break;
      }
      default:
        break;
    }
  }
  return { r, g, b, a };
}

/** Frame-level vignette darken for Node surfaces. */
export function applyVignetteToPixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  amount: number,
): void {
  if (amount <= 0) return;
  const cx = width / 2;
  const cy = height / 2;
  const maxDist = Math.hypot(cx, cy);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dist = Math.hypot(x - cx, y - cy) / maxDist;
      const vig = Math.max(0, (dist - 0.35) / 0.65) * amount;
      if (vig <= 0) continue;
      const offset = (y * width + x) * 4;
      const factor = 1 - vig;
      pixels[offset] = clampByte(pixels[offset]! * factor);
      pixels[offset + 1] = clampByte(pixels[offset + 1]! * factor);
      pixels[offset + 2] = clampByte(pixels[offset + 2]! * factor);
    }
  }
}

function gradeChannel(v: number, grade: ColorGradeIR): number {
  let x = v * grade.gain + grade.lift;
  x = Math.max(0, x);
  if (grade.gamma !== 1 && x > 0) {
    x = Math.pow(x, 1 / Math.max(0.01, grade.gamma));
  }
  return Math.min(1, Math.max(0, x));
}

function contrastChannel(v: number, amount: number): number {
  return Math.min(1, Math.max(0, (v - 0.5) * (1 + amount) + 0.5));
}

function lumPush(v: number, amount: number): number {
  return v + (v - 128) * amount;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hashNoise(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

function stableParams(params: Readonly<Record<string, number>>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join(',');
}

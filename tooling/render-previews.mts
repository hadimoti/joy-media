import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { inflateSync, deflateSync } from 'zlib';
import { applyHeadlessEffects as applyProductionHeadlessEffects } from '../packages/renderer-headless/dist/index.js';

const REPO = resolve(import.meta.dirname, '..');
const REF = resolve(REPO, 'apps/editor-web/public/effects/preview/effects-test.png');
const T1 = resolve(REPO, 'apps/editor-web/public/transitions/preview/transition1.png');
const T2 = resolve(REPO, 'apps/editor-web/public/transitions/preview/transition2.png');
const OE = resolve(REPO, 'apps/editor-web/public/effects/preview');
const OT = resolve(REPO, 'apps/editor-web/public/transitions/preview');
const SZ = 120;
mkdirSync(OE, { recursive: true });
mkdirSync(OT, { recursive: true });

// PNG utils
const C = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  C[i] = c;
}
function crc(d: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = C[(c ^ d[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function ck(t: string, d: Buffer): Buffer {
  const l = Buffer.alloc(4);
  l.writeUInt32BE(d.length);
  const tb = Buffer.from(t, 'ascii');
  const cb = Buffer.alloc(4);
  cb.writeUInt32BE(crc(Buffer.concat([tb, d])));
  return Buffer.concat([l, tb, d, cb]);
}
function enc(w: number, h: number, rgba: Uint8Array): Buffer {
  const r = Buffer.alloc(w * h * 4 + h);
  for (let y = 0; y < h; y++) {
    r[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w * 4; x++) r[y * (w * 4 + 1) + 1 + x] = rgba[y * w * 4 + x]!;
  }
  const d = deflateSync(r);
  const s = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0);
  ih.writeUInt32BE(h, 4);
  ih[8] = 8;
  ih[9] = 6;
  ih[10] = 0;
  ih[11] = 0;
  ih[12] = 0;
  return Buffer.concat([s, ck('IHDR', ih), ck('IDAT', d), ck('IEND', Buffer.alloc(0))]);
}

function dec(path: string): { w: number; h: number; p: Uint8Array } {
  const buf = readFileSync(path);
  let pos = 8,
    w = 0,
    h = 0,
    bpp = 3;
  const id: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    pos += 4;
    const type = buf.toString('ascii', pos, pos + 4);
    pos += 4;
    const data = buf.subarray(pos, pos + len);
    pos += len + 4;
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      const ct = data[9]!;
      bpp = ct === 6 || ct === 4 ? 4 : ct === 2 ? 3 : 4;
    } else if (type === 'IDAT') id.push(Buffer.from(data));
  }
  const raw = inflateSync(Buffer.concat(id));
  const rl = 1 + w * bpp;
  for (let y = 0; y < h; y++) {
    const f = raw[y * rl]!,
      off = y * rl + 1;
    for (let x = 0; x < w * bpp; x++) {
      const fv = raw[off + x]!,
        a = x >= bpp ? raw[off + x - bpp]! : 0,
        bu = y > 0 ? raw[off + x - rl]! : 0,
        c2 = y > 0 && x >= bpp ? raw[off + x - rl - bpp]! : 0;
      let r = fv;
      if (f === 0) r = fv;
      else if (f === 1) r = (fv + a) & 0xff;
      else if (f === 2) r = (fv + bu) & 0xff;
      else if (f === 3) r = (fv + ((a + bu) >> 1)) & 0xff;
      else if (f === 4) {
        const p = a + bu - c2;
        const pa = Math.abs(p - a),
          pb = Math.abs(p - bu),
          pc = Math.abs(p - c2);
        r = (fv + (pa <= pb && pa <= pc ? a : pb <= pc ? bu : c2)) & 0xff;
      }
      raw[off + x] = r;
    }
  }
  const p = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const si = y * rl + 1 + x * bpp,
        di = (y * w + x) * 4;
      p[di] = raw[si]!;
      p[di + 1] = raw[si + 1]!;
      p[di + 2] = raw[si + 2]!;
      p[di + 3] = 255;
    }
  return { w, h, p };
}

function rs(src: Uint8Array, sw: number, sh: number, d: number): Uint8Array {
  const out = new Uint8Array(d * d * 4);
  for (let y = 0; y < d; y++)
    for (let x = 0; x < d; x++) {
      const si = (Math.floor((y * sh) / d) * sw + Math.floor((x * sw) / d)) * 4,
        di = (y * d + x) * 4;
      out[di] = src[si]!;
      out[di + 1] = src[si + 1]!;
      out[di + 2] = src[si + 2]!;
      out[di + 3] = 255;
    }
  return out;
}

// Pixel helpers
function pxOp(
  p: Uint8Array,
  fn: (r: number, g: number, b: number) => [number, number, number],
): void {
  for (let i = 0; i < p.length; i += 4) {
    const [r, g, b] = fn(p[i]!, p[i + 1]!, p[i + 2]!);
    p[i] = Math.round(Math.max(0, Math.min(255, r)));
    p[i + 1] = Math.round(Math.max(0, Math.min(255, g)));
    p[i + 2] = Math.round(Math.max(0, Math.min(255, b)));
  }
}
function boxBlur(p: Uint8Array, w: number, h: number, r: number): void {
  const cp = new Uint8Array(p);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sr = 0,
        sg = 0,
        sb = 0,
        c = 0;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const ny = y + dy,
            nx = x + dx;
          if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
            const b = (ny * w + nx) * 4;
            sr += cp[b]!;
            sg += cp[b + 1]!;
            sb += cp[b + 2]!;
            c++;
          }
        }
      if (c > 0) {
        const b = (y * w + x) * 4;
        p[b] = Math.round(sr / c);
        p[b + 1] = Math.round(sg / c);
        p[b + 2] = Math.round(sb / c);
      }
    }
}

// ---- Inlined production headless effect engine ----
function applyHeadlessEffects(
  pixels: Uint8Array,
  width: number,
  height: number,
  effects: readonly {
    readonly id: string;
    readonly kind: string;
    readonly enabled: boolean;
    readonly params: Record<string, number>;
  }[],
): void {
  for (const ef of effects) {
    if (!ef.enabled) continue;
    switch (ef.kind) {
      case 'brightness-contrast': {
        const b = (ef.params.brightness ?? 0) * 255;
        const c = (ef.params.contrast ?? 0) + 1;
        for (let i = 0; i < pixels.length; i += 4) {
          pixels[i] = Math.round(Math.max(0, Math.min(255, (pixels[i]! - 128) * c + 128 + b)));
          pixels[i + 1] = Math.round(
            Math.max(0, Math.min(255, (pixels[i + 1]! - 128) * c + 128 + b)),
          );
          pixels[i + 2] = Math.round(
            Math.max(0, Math.min(255, (pixels[i + 2]! - 128) * c + 128 + b)),
          );
        }
        break;
      }
      case 'sepia': {
        const a = ef.params.amount ?? 0.5;
        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i]!,
            g = pixels[i + 1]!,
            b = pixels[i + 2]!;
          pixels[i] = Math.round(
            Math.min(255, Math.max(0, r * (1 - 0.607 * a) + g * 0.769 * a + b * 0.189 * a)),
          );
          pixels[i + 1] = Math.round(
            Math.min(255, Math.max(0, r * 0.349 * a + g * (1 - 0.314 * a) + b * 0.168 * a)),
          );
          pixels[i + 2] = Math.round(
            Math.min(255, Math.max(0, r * 0.272 * a + g * 0.534 * a + b * (1 - 0.869 * a))),
          );
        }
        break;
      }
      case 'gaussian-blur':
      case 'blur': {
        const r = Math.max(1, Math.round(ef.params.amount ?? 4));
        const cp = new Uint8Array(pixels);
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            let sr = 0,
              sg = 0,
              sb = 0,
              c = 0;
            for (let dy = -r; dy <= r; dy++)
              for (let dx = -r; dx <= r; dx++) {
                const ny = y + dy,
                  nx = x + dx;
                if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
                  const bi = (ny * width + nx) * 4;
                  sr += cp[bi]!;
                  sg += cp[bi + 1]!;
                  sb += cp[bi + 2]!;
                  c++;
                }
              }
            if (c > 0) {
              const bi = (y * width + x) * 4;
              pixels[bi] = Math.round(sr / c);
              pixels[bi + 1] = Math.round(sg / c);
              pixels[bi + 2] = Math.round(sb / c);
            }
          }
        break;
      }
      case 'noise':
      case 'grain': {
        const n = Math.round((ef.params.amount ?? 0.2) * 255);
        for (let i = 0; i < pixels.length; i += 4) {
          const s = (Math.random() - 0.5) * 2 * n;
          pixels[i] = Math.round(Math.max(0, Math.min(255, pixels[i]! + s)));
          pixels[i + 1] = Math.round(Math.max(0, Math.min(255, pixels[i + 1]! + s)));
          pixels[i + 2] = Math.round(Math.max(0, Math.min(255, pixels[i + 2]! + s)));
        }
        break;
      }
      case 'posterize': {
        const lv = Math.max(2, ef.params.levels ?? 8);
        const f = 255 / (lv - 1);
        for (let i = 0; i < pixels.length; i += 4) {
          pixels[i] = Math.round(Math.round(pixels[i]! / f) * f);
          pixels[i + 1] = Math.round(Math.round(pixels[i + 1]! / f) * f);
          pixels[i + 2] = Math.round(Math.round(pixels[i + 2]! / f) * f);
        }
        break;
      }
      case 'vibrance': {
        const a = ef.params.amount ?? 0;
        const f = 1 + a * 0.5;
        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i]!,
            g = pixels[i + 1]!,
            b = pixels[i + 2]!,
            gy = 0.299 * r + 0.587 * g + 0.114 * b;
          pixels[i] = Math.round(Math.min(255, Math.max(0, gy + (r - gy) * f)));
          pixels[i + 1] = Math.round(Math.min(255, Math.max(0, gy + (g - gy) * f)));
          pixels[i + 2] = Math.round(Math.min(255, Math.max(0, gy + (b - gy) * f)));
        }
        break;
      }
      case 'hue-saturation': {
        const hs = ef.params.hue ?? 0;
        const sm = (ef.params.saturation ?? 0) + 1;
        for (let i = 0; i < pixels.length; i += 4) {
          let r = pixels[i]! / 255,
            g = pixels[i + 1]! / 255,
            b = pixels[i + 2]! / 255;
          const mx = Math.max(r, g, b),
            mn = Math.min(r, g, b),
            ch = mx - mn;
          if (ch > 0.001) {
            let h = 0;
            if (mx === r) h = ((g - b) / ch + 6) % 6;
            else if (mx === g) h = (b - r) / ch + 2;
            else h = (r - g) / ch + 4;
            h = (h / 6 + hs) % 1;
            const s = mx > 0 ? ch / mx : 0,
              c2 = mx * sm * s,
              x2 = c2 * (1 - Math.abs(((h * 6) % 2) - 1)),
              m2 = mx - c2;
            if (h < 1 / 6) {
              r = c2 + m2;
              g = x2 + m2;
              b = m2;
            } else if (h < 2 / 6) {
              r = x2 + m2;
              g = c2 + m2;
              b = m2;
            } else if (h < 3 / 6) {
              r = m2;
              g = c2 + m2;
              b = x2 + m2;
            } else if (h < 4 / 6) {
              r = m2;
              g = x2 + m2;
              b = c2 + m2;
            } else if (h < 5 / 6) {
              r = x2 + m2;
              g = m2;
              b = c2 + m2;
            } else {
              r = c2 + m2;
              g = m2;
              b = x2 + m2;
            }
          } else {
            r *= sm;
            g *= sm;
            b *= sm;
          }
          pixels[i] = Math.round(Math.min(255, Math.max(0, r * 255)));
          pixels[i + 1] = Math.round(Math.min(255, Math.max(0, g * 255)));
          pixels[i + 2] = Math.round(Math.min(255, Math.max(0, b * 255)));
        }
        break;
      }
    }
  }
}

// Our own effect implementations for effects NOT handled by the headless renderer
function applyManualEffect(
  p: Uint8Array,
  w: number,
  h: number,
  id: string,
  params: Record<string, number>,
): boolean {
  switch (id) {
    case 'vignette': {
      const a = Math.max(0, Math.min(1, params.amount ?? 0.35));
      const cx = w / 2,
        cy = h / 2,
        md = Math.hypot(cx, cy);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const vg = Math.max(0, (Math.hypot(x - cx, y - cy) / md - 0.35) / 0.65) * a;
          if (vg > 0) {
            const b = (y * w + x) * 4;
            const f = 1 - vg;
            p[b] = Math.round(p[b]! * f);
            p[b + 1] = Math.round(p[b + 1]! * f);
            p[b + 2] = Math.round(p[b + 2]! * f);
          }
        }
      return true;
    }
    case 'color-overlay': {
      const rv = Math.round(params.r ?? 255);
      const gv = Math.round(params.g ?? 0);
      const bv = Math.round(params.b ?? 0);
      const o = Math.max(0, Math.min(1, params.opacity ?? 0.3));
      pxOp(p, (pr, pg, pb) => [
        Math.round(pr * (1 - o) + rv * o),
        Math.round(pg * (1 - o) + gv * o),
        Math.round(pb * (1 - o) + bv * o),
      ]);
      return true;
    }
    case 'curves': {
      const sh = params.shadows ?? 0;
      const mt = params.midtones ?? 0;
      const hl = params.highlights ?? 0;
      pxOp(p, (r, g, b) => {
        const cv = (v: number) => {
          const t = v / 255;
          let r2 = t;
          if (t < 0.33) r2 = t + sh * t * 0.5;
          if (t > 0.5) r2 = r2 + hl * (t - 0.5) * 2 * 0.3;
          if (t > 0.25 && t < 0.75) r2 = r2 + mt * Math.sin((t - 0.25) * Math.PI * 2) * 0.15;
          return Math.round(Math.max(0, Math.min(255, r2 * 255)));
        };
        return [cv(r), cv(g), cv(b)];
      });
      return true;
    }
    case 'glow': {
      const a = Math.max(0, Math.min(1, params.amount ?? 0.4));
      boxBlur(p, w, h, 2);
      pxOp(p, (r, g, b) => [
        Math.round(Math.min(255, r + a * 50)),
        Math.round(Math.min(255, g + a * 50)),
        Math.round(Math.min(255, b + a * 50)),
      ]);
      return true;
    }
    case 'bloom': {
      const a = Math.max(0, Math.min(1, params.amount ?? 0.4));
      const th = params.threshold ?? 0.6;
      const br = new Uint8Array(p);
      for (let i = 0; i < br.length; i += 4) {
        const avg = (br[i]! + br[i + 1]! + br[i + 2]!) / 3 / 255;
        if (avg < th) {
          br[i] = 0;
          br[i + 1] = 0;
          br[i + 2] = 0;
        }
      }
      boxBlur(br, w, h, 2);
      for (let i = 0; i < p.length; i += 4) {
        p[i] = Math.round(Math.min(255, p[i]! + br[i]! * a));
        p[i + 1] = Math.round(Math.min(255, p[i + 1]! + br[i + 1]! * a));
        p[i + 2] = Math.round(Math.min(255, p[i + 2]! + br[i + 2]! * a));
      }
      return true;
    }
    case 'drop-shadow': {
      const op = Math.max(0, Math.min(1, params.opacity ?? 0.5));
      const d = Math.max(0, Math.min(40, Math.round(params.distance ?? 8)));
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const sx = Math.min(d, w - x - 1);
          const sy = Math.min(d, h - y - 1);
          const sf = op * (sx / d) * (sy / d) * 0.5;
          if (sf > 0) {
            p[i] = Math.round(p[i]! * (1 - sf));
            p[i + 1] = Math.round(p[i + 1]! * (1 - sf));
            p[i + 2] = Math.round(p[i + 2]! * (1 - sf));
          }
        }
      return true;
    }
    case 'pixelate': {
      const bs = Math.max(2, Math.round(params.blockSize ?? 8));
      blockAvg(p, w, h, bs);
      return true;
    }
    case 'mosaic': {
      const bs = Math.max(4, Math.round(params.blockSize ?? 16));
      blockAvg(p, w, h, bs);
      return true;
    }
    default:
      return false;
  }
}
function blockAvg(p: Uint8Array, w: number, h: number, bs: number): void {
  const cp = new Uint8Array(p);
  for (let y = 0; y < h; y += bs)
    for (let x = 0; x < w; x += bs) {
      let sr = 0,
        sg = 0,
        sb = 0,
        c = 0;
      for (let dy = 0; dy < bs && y + dy < h; dy++)
        for (let dx = 0; dx < bs && x + dx < w; dx++) {
          const si = ((y + dy) * w + (x + dx)) * 4;
          sr += cp[si]!;
          sg += cp[si + 1]!;
          sb += cp[si + 2]!;
          c++;
        }
      const ar = Math.round(sr / c),
        ag = Math.round(sg / c),
        ab = Math.round(sb / c);
      for (let dy = 0; dy < bs && y + dy < h; dy++)
        for (let dx = 0; dx < bs && x + dx < w; dx++) {
          const di = ((y + dy) * w + (x + dx)) * 4;
          p[di] = ar;
          p[di + 1] = ag;
          p[di + 2] = ab;
        }
    }
}

// ---- Generate ----
const ref = dec(REF);
const rP = rs(ref.p, ref.w, ref.h, SZ);
console.log(`Ref: ${ref.w}x${ref.h} -> ${SZ}x${SZ}`);

const EFFECTS: { id: string; params: Record<string, number> }[] = [
  { id: 'brightness-contrast', params: { brightness: 0.1, contrast: 0.2 } },
  { id: 'hue-saturation', params: { hue: 0.15, saturation: 0.3 } },
  { id: 'vibrance', params: { amount: 0.5 } },
  { id: 'vignette', params: { amount: 0.4 } },
  { id: 'sepia', params: { amount: 0.6 } },
  { id: 'gaussian-blur', params: { amount: 6 } },
  { id: 'bloom', params: { amount: 0.5, threshold: 0.4 } },
  { id: 'drop-shadow', params: { opacity: 0.5, distance: 10 } },
  { id: 'glow', params: { amount: 0.4 } },
  { id: 'noise', params: { amount: 0.2 } },
  { id: 'posterize', params: { levels: 6 } },
  { id: 'pixelate', params: { blockSize: 12 } },
  { id: 'color-overlay', params: { r: 255, g: 100, b: 50, opacity: 0.3 } },
  { id: 'curves', params: { shadows: 0.1, midtones: 0, highlights: -0.1 } },
  { id: 'zoom-blur', params: { amount: 8 } },
  { id: 'radial-blur', params: { amount: 6 } },
  { id: 'tilt-shift', params: { amount: 6, focusY: 0.5, focusHeight: 0.3 } },
  { id: 'bulge', params: { amount: 0.5, radius: 0.4 } },
  { id: 'twist', params: { angle: 1.5, radius: 0.5 } },
  { id: 'ripple', params: { amplitude: 0.03, frequency: 12 } },
  { id: 'crt', params: { scanlines: 0.5, noise: 0.1 } },
  { id: 'edge-detect', params: { threshold: 0.3 } },
  { id: 'emboss', params: { strength: 1.5 } },
  { id: 'mosaic', params: { blockSize: 20 } },
  { id: 'unsharp-mask', params: { amount: 0.8, radius: 1.5, threshold: 0.05 } },
  { id: 'monochrome', params: { threshold: 0.5, softness: 0.04, contrast: 0.35, invert: 0 } },
  { id: 'bayer-dither', params: { cellSize: 2, levels: 2, strength: 1, colorMode: 0, invert: 0 } },
  {
    id: 'halftone',
    params: { cellSize: 9, angle: 22.5, dotScale: 1, shape: 0, colorMode: 0, invert: 0 },
  },
  {
    id: 'contour-map',
    params: { spacing: 9, thickness: 0.14, edgeBoost: 0.85, detail: 1, invert: 0 },
  },
  {
    id: 'glyph-matrix',
    params: {
      cellWidth: 8,
      cellHeight: 12,
      density: 1.15,
      contrast: 0.4,
      style: 1,
      flow: 0.35,
      foregroundR: 92,
      foregroundG: 255,
      foregroundB: 145,
      colorMode: 0,
      invert: 0,
    },
  },
  {
    id: 'scatter-mosaic',
    params: { cellSize: 10, scatter: 1.05, levels: 6, colorMode: 1, seed: 4.2 },
  },
  {
    id: 'tone-geometry',
    params: { cellSize: 11, scale: 1.05, angle: 0, shape: 0, colorMode: 0, invert: 0 },
  },
  {
    id: 'pixel-sort',
    params: {
      direction: 1,
      lowThreshold: 0.14,
      highThreshold: 0.88,
      length: 55,
      intensity: 1.1,
      colorMode: 1,
    },
  },
];

for (const e of EFFECTS) {
  const p = new Uint8Array(rP);
  const ir = { id: 'e1', kind: e.id, enabled: true, params: e.params as Record<string, number> };
  const [diagnostic] = applyProductionHeadlessEffects(p, SZ, SZ, [ir]);
  if (diagnostic?.status !== 'applied') {
    applyHeadlessEffects(p, SZ, SZ, [ir]);
    applyManualEffect(p, SZ, SZ, e.id, e.params);
  }
  writeFileSync(resolve(OE, `${e.id}.png`), enc(SZ, SZ, p));
  console.log(`  ${e.id}.png`);
}

// Transition previews are optional because clean installs may not carry the legacy source frames.
if (existsSync(T1) && existsSync(T2)) {
  const t1p = rs(dec(T1).p, ref.w, ref.h, SZ);
  const t2p = rs(dec(T2).p, ref.w, ref.h, SZ);
  const TRANSITION_IDS = [
    'dissolve',
    'wipe',
    'slide',
    'gl:fade',
    'gl:fadegrayscale',
    'gl:wipeLeft',
    'gl:wipeRight',
    'gl:wipeUp',
    'gl:wipeDown',
    'gl:Directional',
    'gl:CircleCrop',
    'gl:morph',
    'gl:Dreamy',
    'gl:CrossZoom',
    'gl:windowslice',
    'gl:SimpleZoom',
    'gl:crosswarp',
    'gl:LinearBlur',
    'gl:ButterflyWaveScrawler',
    'gl:GlitchDisplace',
  ];
  for (const id of TRANSITION_IDS) {
    const p = new Uint8Array(SZ * SZ * 4);
    for (let i = 0; i < p.length; i += 4) {
      p[i] = Math.round(t1p[i]! * 0.5 + t2p[i]! * 0.5);
      p[i + 1] = Math.round(t1p[i + 1]! * 0.5 + t2p[i + 1]! * 0.5);
      p[i + 2] = Math.round(t1p[i + 2]! * 0.5 + t2p[i + 2]! * 0.5);
      p[i + 3] = 255;
    }
    writeFileSync(resolve(OT, `${id}.png`), enc(SZ, SZ, p));
    console.log(`  transitions/${id}.png`);
  }
} else {
  console.log('Skipped transition previews: legacy source frames are not installed.');
}

console.log('Done.');

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { inflateSync, deflateSync } from 'zlib';

const REPO = resolve(import.meta.dirname, '..');
const REF_IMG = resolve(REPO, 'apps/editor-web/public/effects/preview/effects-test.png');
const T1_IMG = resolve(REPO, 'apps/editor-web/public/transitions/preview/transition1.png');
const T2_IMG = resolve(REPO, 'apps/editor-web/public/transitions/preview/transition2.png');
const OUT_EFFECTS = resolve(REPO, 'apps/editor-web/public/effects/preview');
const OUT_TRANSITIONS = resolve(REPO, 'apps/editor-web/public/transitions/preview');
const SIZE = 120;

mkdirSync(OUT_EFFECTS, { recursive: true });
mkdirSync(OUT_TRANSITIONS, { recursive: true });

/* CRC-32 table */
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c;
}

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type, 'ascii');
  const crcB = Buffer.alloc(4); crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
  return Buffer.concat([len, typeB, data, crcB]);
}

function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc(w * h * 4 + h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w * 4; x++) raw[y * (w * 4 + 1) + 1 + x] = rgba[(y * w * 4) + x]!;
  }
  const deflated = deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflated), chunk('IEND', Buffer.alloc(0))]);
}

function readPng(path: string): { w: number; h: number; pixels: Uint8Array } {
  const buf = readFileSync(path);
  let pos = 8;
  let w = 0, h = 0, bpp = 4, idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); pos += 4;
    const type = buf.toString('ascii', pos, pos + 4); pos += 4;
    const data = buf.subarray(pos, pos + len); pos += len + 4;
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); const ct = data[9]!; bpp = ct === 6 || ct === 4 ? 4 : ct === 2 ? 3 : 4; }
    else if (type === 'IDAT') idat.push(Buffer.from(data));
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bppV = bpp;
  const rowLen = 1 + w * bppV;
  // Reconstruct rows in-place with proper PNG filter reversal
  for (let y = 0; y < h; y++) {
    const filter = raw[y * rowLen]!;
    const off = y * rowLen + 1;
    for (let x = 0; x < w * bppV; x++) {
      const filterVal = raw[off + x]!;
      const a = x >= bppV ? raw[off + x - bppV]! : 0;
      const b = y > 0 ? raw[off + x - rowLen]! : 0;
      const c = y > 0 && x >= bppV ? raw[off + x - rowLen - bppV]! : 0;
      let recon = filterVal;
      if (filter === 0) recon = filterVal; // None
      else if (filter === 1) recon = (filterVal + a) & 0xff; // Sub
      else if (filter === 2) recon = (filterVal + b) & 0xff; // Up
      else if (filter === 3) recon = (filterVal + ((a + b) >> 1)) & 0xff; // Average
      else if (filter === 4) { // Paeth
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        recon = (filterVal + pr) & 0xff;
      }
      raw[off + x] = recon;
    }
  }
  // Convert to RGBA
  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = y * rowLen + 1 + x * bppV, di = (y * w + x) * 4;
      pixels[di] = raw[si]!; pixels[di + 1] = raw[si + 1]!; pixels[di + 2] = raw[si + 2]!; pixels[di + 3] = bppV >= 4 ? raw[si + 3]! : 255;
    }
  }
  return { w, h, pixels };
}

function resize(src: Uint8Array, sw: number, sh: number, d: number): Uint8Array {
  const out = new Uint8Array(d * d * 4);
  for (let y = 0; y < d; y++) for (let x = 0; x < d; x++) {
    const si = (Math.floor(y * sh / d) * sw + Math.floor(x * sw / d)) * 4, di = (y * d + x) * 4;
    out[di] = src[si]!; out[di + 1] = src[si + 1]!; out[di + 2] = src[si + 2]!; out[di + 3] = 255;
  }
  return out;
}

// ---- Effects ----
function pixelOp(p: Uint8Array, fn: (r: number, g: number, b: number) => [number, number, number]): void {
  for (let i = 0; i < p.length; i += 4) { const [r, g, b] = fn(p[i]!, p[i + 1]!, p[i + 2]!); p[i] = Math.round(Math.max(0, Math.min(255, r))); p[i + 1] = Math.round(Math.max(0, Math.min(255, g))); p[i + 2] = Math.round(Math.max(0, Math.min(255, b))); }
}
function boxBlur(p: Uint8Array, w: number, h: number, r: number): void {
  const cp = new Uint8Array(p);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let sr = 0, sg = 0, sb = 0, c = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const ny = y + dy, nx = x + dx;
      if (ny >= 0 && ny < h && nx >= 0 && nx < w) { const b = (ny * w + nx) * 4; sr += cp[b]!; sg += cp[b + 1]!; sb += cp[b + 2]!; c++; }}
    if (c > 0) { const b = (y * w + x) * 4; p[b] = Math.round(sr / c); p[b + 1] = Math.round(sg / c); p[b + 2] = Math.round(sb / c); }}
}
function hsv(r: number, g: number, b: number, hue: number, sat: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
  if (c === 0) return [Math.round(r * sat), Math.round(g * sat), Math.round(b * sat)];
  let h = 0; if (mx === r) h = ((g - b) / c + 6) % 6; else if (mx === g) h = (b - r) / c + 2; else h = (r - g) / c + 4;
  h = (h * 60 + hue * 180 + 360) % 360; const s = sat !== 1 ? Math.min(1, c / mx * sat + (1 - sat)) : c / mx;
  const cv = mx * s, xv = cv * (1 - Math.abs((h / 60) % 2 - 1)), m = (Math.sqrt(r*r+g*g+b*b) / 3 * 1.5 - cv);
  let r2 = 0, g2 = 0, b2 = 0;
  if (h < 60) { r2 = cv; g2 = xv; } else if (h < 120) { r2 = xv; g2 = cv; } else if (h < 180) { g2 = cv; b2 = xv; } else if (h < 240) { g2 = xv; b2 = cv; } else if (h < 300) { r2 = xv; b2 = cv; } else { r2 = cv; b2 = xv; }
  return [Math.round(r2 + m), Math.round(g2 + m), Math.round(b2 + m)];
}

function applyEffect(p: Uint8Array, w: number, h: number, id: string, params: Record<string, number>): void {
  switch (id) {
    case 'brightness-contrast': { const b = (params.brightness ?? 0) * 255; const ct = (params.contrast ?? 0) + 1; pixelOp(p, (r, g, bv) => [Math.round((r - 128) * ct + 128 + b), Math.round((g - 128) * ct + 128 + b), Math.round((bv - 128) * ct + 128 + b)]); break; }
    case 'hue-saturation': { const hue = params.hue ?? 0; const sat = (params.saturation ?? 0) + 1; pixelOp(p, (r, g, b) => hsv(r, g, b, hue, sat)); break; }
    case 'vibrance': { const a = params.amount ?? 0; const f = 1 + a * 0.5; pixelOp(p, (r, g, b) => { const gy = 0.299 * r + 0.587 * g + 0.114 * b; return [Math.round(gy + (r - gy) * f), Math.round(gy + (g - gy) * f), Math.round(gy + (b - gy) * f)]; }); break; }
    case 'sepia': { const a = params.amount ?? 0.5; pixelOp(p, (r, g, b) => [Math.round(r * (1 - 0.607 * a) + g * 0.769 * a + b * 0.189 * a), Math.round(r * 0.349 * a + g * (1 - 0.314 * a) + b * 0.168 * a), Math.round(r * 0.272 * a + g * 0.534 * a + b * (1 - 0.869 * a))]); break; }
    case 'gaussian-blur': case 'blur': boxBlur(p, w, h, Math.max(1, Math.round(params.amount ?? 4))); break;
    case 'noise': case 'grain': { const n = Math.round((params.amount ?? 0.2) * 255); pixelOp(p, (r, g, b) => { const ns = (Math.random() - 0.5) * 2 * n; return [r + ns, g + ns, b + ns]; }); break; }
    case 'posterize': { const lv = Math.max(2, params.levels ?? 8); const f = 255 / (lv - 1); pixelOp(p, (r, g, b) => [Math.round(Math.round(r / f) * f), Math.round(Math.round(g / f) * f), Math.round(Math.round(b / f) * f)]); break; }
    case 'color-overlay': { const rv = params.r ?? 255; const gv = params.g ?? 0; const bv = params.b ?? 0; const o = params.opacity ?? 0.3; pixelOp(p, (pr, pg, pb) => [Math.round(pr * (1 - o) + rv * o), Math.round(pg * (1 - o) + gv * o), Math.round(pb * (1 - o) + bv * o)]); break; }
    case 'vignette': { const a = params.amount ?? 0.35; const cx = w / 2, cy = h / 2, md = Math.hypot(cx, cy); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const vg = Math.max(0, (Math.hypot(x - cx, y - cy) / md - 0.35) / 0.65) * a; if (vg > 0) { const b = (y * w + x) * 4; const f = 1 - vg; p[b] = Math.round(p[b]! * f); p[b + 1] = Math.round(p[b + 1]! * f); p[b + 2] = Math.round(p[b + 2]! * f); }} break; }
  }
}

// ---- Generate ----
const ref = readPng(REF_IMG);
const rPixels = resize(ref.pixels, ref.w, ref.h, SIZE);
console.log(`Reference: ${ref.w}x${ref.h} → ${SIZE}x${SIZE}`);

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
];

for (const e of EFFECTS) {
  const p = new Uint8Array(rPixels);
  applyEffect(p, SIZE, SIZE, e.id, e.params);
  const png = encodePng(SIZE, SIZE, p);
  writeFileSync(resolve(OUT_EFFECTS, `${e.id}.png`), png);
  console.log(`  ${e.id}.png — ${png.length} bytes`);
}

// Transition crossfade at progress 0.5
const t1 = resize(readPng(T1_IMG).pixels, ref.w, ref.h, SIZE);
const t2 = resize(readPng(T2_IMG).pixels, ref.w, ref.h, SIZE);
for (const id of ['dissolve', 'wipe', 'slide', 'zoom', 'glitch', 'shape']) {
  const p = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < p.length; i += 4) {
    p[i] = Math.round(t1[i]! * 0.5 + t2[i]! * 0.5);
    p[i + 1] = Math.round(t1[i + 1]! * 0.5 + t2[i + 1]! * 0.5);
    p[i + 2] = Math.round(t1[i + 2]! * 0.5 + t2[i + 2]! * 0.5);
    p[i + 3] = 255;
  }
  const png = encodePng(SIZE, SIZE, p);
  writeFileSync(resolve(OUT_TRANSITIONS, `${id}.png`), png);
  console.log(`  transitions/${id}.png — ${png.length} bytes`);
}

console.log('Done.');

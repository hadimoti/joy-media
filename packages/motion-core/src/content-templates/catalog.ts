import type { P0TemplateId } from '@joy-media/project-schema';
import { EASED_HANDLES } from '../interpolation.js';

/** Paint values shared by P0 compilation, motion sampling and scene painting. */
export const P0_PAINT_POLICY = Object.freeze({
  textColour: '#ffffff',
  plateColour: '#000000',
  plateOpacity: 153 / 255,
  lineHeightMultiplier: 1.25,
  slideExcursionPx: 80,
  easedHandles: EASED_HANDLES,
});

export interface P0TemplateDefinition {
  readonly id: P0TemplateId;
  readonly version: 1;
  readonly scenePackageId: P0TemplateId;
  readonly alignment: 'left' | 'center';
  readonly primaryRole: 'name' | 'headline';
  readonly secondaryRole: 'role' | 'subline';
  readonly primary: {
    readonly maxLines: 2;
    readonly minSizePx: 24;
    readonly maxSizePx: 48;
    readonly stepPx: 2;
  };
  readonly secondary: {
    readonly maxLines: 1;
    readonly minSizePx: 18;
    readonly maxSizePx: 30;
    readonly stepPx: 2;
  };
  readonly plate: {
    readonly kind: 'translucent-rectangle' | 'transparent';
    readonly paddingX: number;
    readonly paddingY: number;
  };
}

export const P0_TEMPLATES: Readonly<Record<P0TemplateId, P0TemplateDefinition>> = {
  'joy.p0.lower-third': {
    id: 'joy.p0.lower-third',
    version: 1,
    scenePackageId: 'joy.p0.lower-third',
    alignment: 'left',
    primaryRole: 'name',
    secondaryRole: 'role',
    primary: { maxLines: 2, minSizePx: 24, maxSizePx: 48, stepPx: 2 },
    secondary: { maxLines: 1, minSizePx: 18, maxSizePx: 30, stepPx: 2 },
    plate: { kind: 'translucent-rectangle', paddingX: 48, paddingY: 24 },
  },
  'joy.p0.title': {
    id: 'joy.p0.title',
    version: 1,
    scenePackageId: 'joy.p0.title',
    alignment: 'center',
    primaryRole: 'headline',
    secondaryRole: 'subline',
    primary: { maxLines: 2, minSizePx: 24, maxSizePx: 48, stepPx: 2 },
    secondary: { maxLines: 1, minSizePx: 18, maxSizePx: 30, stepPx: 2 },
    plate: { kind: 'transparent', paddingX: 0, paddingY: 0 },
  },
};

/** Stable, explicitly ordered serialization used as the catalog hash input. */
export function serializeTemplate(templateId: P0TemplateId): string {
  const t = P0_TEMPLATES[templateId];
  return JSON.stringify({
    id: t.id,
    version: t.version,
    scenePackageId: t.scenePackageId,
    alignment: t.alignment,
    primaryRole: t.primaryRole,
    secondaryRole: t.secondaryRole,
    primary: {
      maxLines: t.primary.maxLines,
      minSizePx: t.primary.minSizePx,
      maxSizePx: t.primary.maxSizePx,
      stepPx: t.primary.stepPx,
    },
    secondary: {
      maxLines: t.secondary.maxLines,
      minSizePx: t.secondary.minSizePx,
      maxSizePx: t.secondary.maxSizePx,
      stepPx: t.secondary.stepPx,
    },
    plate: { kind: t.plate.kind, paddingX: t.plate.paddingX, paddingY: t.plate.paddingY },
  });
}

// Dependency-free SHA-256 (catalog hashing must work in both browser and Node).
export function templateSha256(templateId: P0TemplateId): string {
  return `sha256:${sha256(serializeTemplate(templateId))}`;
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
function sha256(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] ?? 0;
      const b = w[i - 2] ?? 0;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let a = h[0] ?? 0;
    let b = h[1] ?? 0;
    let c = h[2] ?? 0;
    let d = h[3] ?? 0;
    let e = h[4] ?? 0;
    let f = h[5] ?? 0;
    let g = h[6] ?? 0;
    let hh = h[7] ?? 0;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const working = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = ((h[i] ?? 0) + (working[i] ?? 0)) >>> 0;
  }
  return h.map((n) => n.toString(16).padStart(8, '0')).join('');
}

export interface ParsedCubeLut {
  readonly size: number;
  readonly domainMin: readonly [number, number, number];
  readonly domainMax: readonly [number, number, number];
  readonly data: Float32Array;
}

const MAX_BYTES = 32 * 1024 * 1024;
const MIN_SIZE = 2;
const MAX_SIZE = 65;

/** Strict, bounded parser for 3D .cube LUT files. */
export function parseCubeLut(source: string | Uint8Array): ParsedCubeLut {
  const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES)
    throw new Error('LUT exceeds the 32 MiB limit');
  let size: number | undefined;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const rows: number[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const keyword = parts[0];
    if (keyword === 'TITLE') continue;
    if (keyword === 'LUT_1D_SIZE') throw new Error('1D LUTs are not supported');
    if (keyword === 'LUT_3D_SIZE') {
      if (size !== undefined || parts.length !== 2) throw new Error('invalid LUT_3D_SIZE');
      size = integer(parts[1], 'LUT_3D_SIZE');
      if (size < MIN_SIZE || size > MAX_SIZE) throw new Error('LUT_3D_SIZE is out of range');
      continue;
    }
    if (keyword === 'DOMAIN_MIN' || keyword === 'DOMAIN_MAX') {
      const values = triple(parts.slice(1), keyword);
      if (keyword === 'DOMAIN_MIN') domainMin = values;
      else domainMax = values;
      continue;
    }
    if (parts.length !== 3) throw new Error(`invalid LUT row: ${keyword}`);
    for (const part of parts) rows.push(finite(part, 'LUT row'));
  }
  if (size === undefined) throw new Error('LUT_3D_SIZE is required');
  const expected = size * size * size * 3;
  if (rows.length !== expected)
    throw new Error(`expected ${expected / 3} LUT rows, got ${rows.length / 3}`);
  if (domainMin.some((value, index) => value >= domainMax[index]!))
    throw new Error('LUT domain is invalid');
  return { size, domainMin, domainMax, data: Float32Array.from(rows) };
}

function finite(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} contains a non-finite value`);
  return parsed;
}

function integer(value: string | undefined, label: string): number {
  const parsed = finite(value, label);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

function triple(parts: string[], label: string): [number, number, number] {
  if (parts.length !== 3) throw new Error(`${label} requires three values`);
  return [finite(parts[0], label), finite(parts[1], label), finite(parts[2], label)];
}

export function sampleCubeLut(
  lut: ParsedCubeLut,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const coords = [r, g, b].map((value, index) =>
    Math.max(
      0,
      Math.min(
        1,
        (value - lut.domainMin[index]!) / (lut.domainMax[index]! - lut.domainMin[index]!),
      ),
    ),
  );
  const scale = lut.size - 1;
  const x = coords[0]! * scale;
  const y = coords[1]! * scale;
  const z = coords[2]! * scale;
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    z0 = Math.floor(z);
  const x1 = Math.min(scale, x0 + 1),
    y1 = Math.min(scale, y0 + 1),
    z1 = Math.min(scale, z0 + 1);
  const tx = x - x0,
    ty = y - y0,
    tz = z - z0;
  const at = (ix: number, iy: number, iz: number, channel: number) =>
    lut.data[(ix * lut.size * lut.size + iy * lut.size + iz) * 3 + channel]!;
  const result: number[] = [];
  for (let channel = 0; channel < 3; channel++) {
    const c000 = at(x0, y0, z0, channel),
      c100 = at(x1, y0, z0, channel);
    const c010 = at(x0, y1, z0, channel),
      c110 = at(x1, y1, z0, channel);
    const c001 = at(x0, y0, z1, channel),
      c101 = at(x1, y0, z1, channel);
    const c011 = at(x0, y1, z1, channel),
      c111 = at(x1, y1, z1, channel);
    const c00 = c000 + (c100 - c000) * tx,
      c10 = c010 + (c110 - c010) * tx;
    const c01 = c001 + (c101 - c001) * tx,
      c11 = c011 + (c111 - c011) * tx;
    result.push(c00 + (c10 - c00) * ty + (c01 + (c11 - c01) * ty - (c00 + (c10 - c00) * ty)) * tz);
  }
  return [result[0]!, result[1]!, result[2]!];
}

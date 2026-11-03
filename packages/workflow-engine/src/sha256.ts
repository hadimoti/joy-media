/**
 * Dependency-free SHA-256 (FIPS 180-4).
 *
 * Run keys (§23.5) must be computable in both Node and the browser; node:crypto
 * is unavailable in the browser and crypto.subtle is async, so the workflow
 * engine carries its own small synchronous implementation.
 *
 * `createSha256` is streaming: the caller feeds bytes in pieces, so a large file can be
 * hashed without holding it in memory whole. `sha256Hex` hashes one string in one go.
 */

const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** A streaming SHA-256 hasher: feed bytes with `update`, then read the digest once. */
export interface Sha256Stream {
  /** Hashes the next bytes. They are read now and not kept. */
  update(bytes: Uint8Array): void;
  /** The digest as lowercase hex. It can be read once; the hasher cannot be used after that. */
  hexDigest(): string;
}

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** Starts a streaming SHA-256 hash of the bytes fed to it. */
export function createSha256(): Sha256Stream {
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Array<number>(64).fill(0);
  // The bytes of a block that is not complete yet.
  const pending = new Uint8Array(64);
  const pendingView = new DataView(pending.buffer);
  let pendingLength = 0;
  let totalBytes = 0;
  let finished = false;

  /** Runs the compression function over the 64-byte block that starts at `offset` in `view`. */
  const compress = (view: DataView, offset: number): void => {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i]! + w[i]!) >>> 0;
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

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  };

  return {
    update(bytes) {
      if (finished) throw new Error('SHA-256: update() after hexDigest()');
      totalBytes += bytes.length;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let offset = 0;
      if (pendingLength > 0) {
        const take = Math.min(64 - pendingLength, bytes.length);
        pending.set(bytes.subarray(0, take), pendingLength);
        pendingLength += take;
        offset = take;
        if (pendingLength < 64) return;
        compress(pendingView, 0);
        pendingLength = 0;
      }
      for (; offset + 64 <= bytes.length; offset += 64) compress(view, offset);
      if (offset < bytes.length) {
        pending.set(bytes.subarray(offset), 0);
        pendingLength = bytes.length - offset;
      }
    },
    hexDigest() {
      if (finished) throw new Error('SHA-256: hexDigest() can be read only once');
      finished = true;
      const bitLength = totalBytes * 8;
      // Padding: one 1 bit, zeros up to 56 bytes into a block, then the 64-bit message length.
      pending[pendingLength] = 0x80;
      pendingLength += 1;
      if (pendingLength > 56) {
        pending.fill(0, pendingLength);
        compress(pendingView, 0);
        pendingLength = 0;
      }
      pending.fill(0, pendingLength);
      pendingView.setUint32(56, Math.floor(bitLength / 0x1_0000_0000), false);
      pendingView.setUint32(60, bitLength >>> 0, false);
      compress(pendingView, 0);
      return h.map((word) => word.toString(16).padStart(8, '0')).join('');
    },
  };
}

/** SHA-256 of a UTF-8 string, as lowercase hex. */
export function sha256Hex(text: string): string {
  const hasher = createSha256();
  hasher.update(new TextEncoder().encode(text));
  return hasher.hexDigest();
}

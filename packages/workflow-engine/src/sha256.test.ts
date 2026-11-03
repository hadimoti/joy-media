import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { createSha256, sha256Hex } from './sha256.js';

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('matches node:crypto for multi-block and non-ASCII inputs', () => {
    const samples = [
      'a'.repeat(200),
      '{"workflowId":"wf-reels","params":{"language":"fa"}}',
      'سلام دنیا — یک متن فارسی برای آزمون UTF-8',
      'emoji \u{1F3AC}\u{1F39E}',
    ];
    for (const sample of samples) {
      expect(sha256Hex(sample)).toBe(createHash('sha256').update(sample, 'utf8').digest('hex'));
    }
  });
});

describe('createSha256', () => {
  it('gives the same digest for any way of splitting the bytes', () => {
    const text = 'streaming '.repeat(97);
    const bytes = new TextEncoder().encode(text);
    const expected = sha256Hex(text);
    for (const piece of [1, 3, 63, 64, 65, 200]) {
      const hasher = createSha256();
      for (let offset = 0; offset < bytes.length; offset += piece) {
        hasher.update(bytes.subarray(offset, offset + piece));
      }
      expect(hasher.hexDigest()).toBe(expected);
    }
  });

  it('hashes an empty input and a view into a larger buffer', () => {
    expect(createSha256().hexDigest()).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    const big = new Uint8Array([9, 9, 97, 98, 99, 9]);
    const hasher = createSha256();
    hasher.update(big.subarray(2, 5));
    expect(hasher.hexDigest()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('refuses to be used after the digest is read', () => {
    const hasher = createSha256();
    hasher.hexDigest();
    expect(() => hasher.update(new Uint8Array(1))).toThrow();
    expect(() => hasher.hexDigest()).toThrow();
  });
});

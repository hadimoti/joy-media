import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { sha256Hex } from './sha256.js';

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
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

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256OfBlob } from './blob-sha256.js';

/** Deterministic bytes that are not all the same, so a wrong byte order shows up. */
function sampleBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + (i >>> 8) * 7) & 0xff;
  return bytes;
}

function nodeSha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('sha256OfBlob', () => {
  it.each([0, 1, 55, 56, 63, 64, 65, 127, 128, 1000, 4099])(
    'matches node:crypto for %i bytes read in 7-byte slices',
    async (length) => {
      const bytes = sampleBytes(length);
      const digest = await sha256OfBlob(new Blob([bytes]), { sliceBytes: 7 });
      expect(digest).toBe(nodeSha256Hex(bytes));
    },
  );

  it('gives the same digest whatever the slice size', async () => {
    const bytes = sampleBytes(10_000);
    const expected = nodeSha256Hex(bytes);
    for (const sliceBytes of [1, 63, 64, 65, 8 * 1024 * 1024]) {
      expect(await sha256OfBlob(new Blob([bytes]), { sliceBytes })).toBe(expected);
    }
  });

  it('hashes a Blob made of several parts as one file', async () => {
    const first = sampleBytes(300);
    const second = sampleBytes(77);
    const whole = new Uint8Array(new ArrayBuffer(first.length + second.length));
    whole.set(first, 0);
    whole.set(second, first.length);
    const digest = await sha256OfBlob(new Blob([first, second]), { sliceBytes: 100 });
    expect(digest).toBe(nodeSha256Hex(whole));
  });

  it('rejects a slice size that is not a positive whole number', async () => {
    const blob = new Blob([sampleBytes(4)]);
    await expect(sha256OfBlob(blob, { sliceBytes: 0 })).rejects.toThrow(RangeError);
    await expect(sha256OfBlob(blob, { sliceBytes: 1.5 })).rejects.toThrow(RangeError);
  });

  it('stops between slices when the signal is aborted mid-way', async () => {
    const controller = new AbortController();
    const blob = new Blob([sampleBytes(100)]);
    let slices = 0;
    const source = {
      size: blob.size,
      slice: (start: number, end: number) => {
        slices += 1;
        if (slices === 2) controller.abort();
        return blob.slice(start, end);
      },
    } as unknown as Blob;

    await expect(
      sha256OfBlob(source, { sliceBytes: 10, signal: controller.signal }),
    ).rejects.toThrow();
    expect(slices).toBe(2);
  });

  it('stops without a digest when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      sha256OfBlob(new Blob([sampleBytes(10)]), { signal: controller.signal }),
    ).rejects.toThrow();
  });
});

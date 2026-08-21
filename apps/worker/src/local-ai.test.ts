import { describe, expect, it } from 'vitest';
import { descriptorForLocalAiOutput } from './local-ai.js';

const ONE_BY_ONE_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5WQAAAAASUVORK5CYII=',
    'base64',
  ),
);

describe('local AI media descriptors', () => {
  it('normalizes video outputs to protocol-compatible descriptors', () => {
    expect(descriptorForLocalAiOutput('video', 'video/mp4', new Uint8Array([0, 1, 2]))).toEqual({
      mimeType: 'video/mp4',
    });
  });

  it('fails closed on unsupported video formats', () => {
    expect(() =>
      descriptorForLocalAiOutput('video', 'video/webm', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])),
    ).toThrow(/AI_OUTPUT_UNAVAILABLE/);
  });

  it('extracts PNG dimensions for image outputs', () => {
    expect(descriptorForLocalAiOutput('image', 'image/png', ONE_BY_ONE_PNG)).toEqual({
      mimeType: 'image/png',
      width: 1,
      height: 1,
    });
  });

  it('fails closed on unsupported image formats', () => {
    expect(() =>
      descriptorForLocalAiOutput('image', 'image/jpeg', new Uint8Array([0xff, 0xd8, 0xff])),
    ).toThrow(/AI_OUTPUT_UNAVAILABLE/);
  });
});

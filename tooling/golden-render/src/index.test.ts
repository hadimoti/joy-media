import { describe, expect, it } from 'vitest';
import { createParitySpikeFrame, compareGoldenFrame, PACKAGE_NAME } from './index.js';

describe('@joy-media/golden-render', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@joy-media/golden-render');
  });

  it.each([
    [0, 'a304eb627967deed'],
    [500_000, '4523a48a86817e81'],
    [1_000_000, '53265b3a365b6c91'],
  ])('matches preview and headless output against the pinned golden at %i us', (timeUs, digest) => {
    const frame = createParitySpikeFrame(timeUs);
    expect(frame.nodes.map((node) => node.kind)).toEqual(['sprite', 'video-frame', 'text']);
    const comparison = compareGoldenFrame(frame);
    expect(comparison.identical).toBe(true);
    expect(comparison.previewDigest).toBe(digest);
    expect(comparison.headlessDigest).toBe(digest);
  });

  it('has an evaluated transform animation rather than renderer-side animation state', () => {
    const start = createParitySpikeFrame(0).nodes[0]!;
    const end = createParitySpikeFrame(1_000_000).nodes[0]!;
    expect(start.transform).toEqual({ translateX: 2, translateY: 2, scaleX: 1, scaleY: 1 });
    expect(end.transform).toEqual({ translateX: 8, translateY: 2, scaleX: 1.5, scaleY: 1.5 });
  });

  it('reopens a serialized reference frame with the same preview/export result', () => {
    const original = createParitySpikeFrame(500_000);
    const reopened = JSON.parse(JSON.stringify(original)) as typeof original;
    expect(compareGoldenFrame(reopened)).toEqual(compareGoldenFrame(original));
  });
});

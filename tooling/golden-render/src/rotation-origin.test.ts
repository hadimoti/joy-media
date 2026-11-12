import { describe, expect, it } from 'vitest';
import type { RenderFrameIR, RenderNode } from '@joy-media/render-ir';
import { renderHeadlessFrame } from '@joy-media/renderer-headless';
import { renderPixiPreview } from '@joy-media/renderer-pixi';
import { compareGoldenFrame, createParitySpikeFrame } from './index.js';

/**
 * T-M15: rotation and origin in the IR. The pinned digests are the same ones
 * `index.test.ts` checks; they must not move when every node states the
 * default rotation and any origin, because the origin only matters once a
 * node is rotated.
 */
const PINNED: ReadonlyArray<readonly [number, string]> = [
  [0, 'a304eb627967deed'],
  [500_000, '4523a48a86817e81'],
  [1_000_000, '53265b3a365b6c91'],
];

function withTransform(frame: RenderFrameIR, extra: Record<string, unknown>): RenderFrameIR {
  return {
    ...frame,
    nodes: frame.nodes.map(
      (node) => ({ ...node, transform: { ...node.transform, ...extra } }) as RenderNode,
    ),
  };
}

describe('T-M15 default rotation and origin draw exactly as before', () => {
  it.each(PINNED)('explicit rotationDeg 0 keeps the pinned golden at %i us', (timeUs, digest) => {
    const frame = withTransform(createParitySpikeFrame(timeUs), {
      rotationDeg: 0,
      origin: { x: 0.5, y: 0.5 },
    });
    const comparison = compareGoldenFrame(frame);
    expect(comparison.identical).toBe(true);
    expect(comparison.previewDigest).toBe(digest);
    expect(comparison.headlessDigest).toBe(digest);
  });

  it.each(PINNED)(
    'any origin without rotation keeps the pinned golden at %i us',
    (timeUs, digest) => {
      for (const origin of [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: -2, y: 7.5 },
      ]) {
        const comparison = compareGoldenFrame(
          withTransform(createParitySpikeFrame(timeUs), { origin }),
        );
        expect(comparison.previewDigest).toBe(digest);
        expect(comparison.headlessDigest).toBe(digest);
      }
    },
  );
});

const sprite = (rotationDeg: number, origin?: { x: number; y: number }): RenderFrameIR => ({
  version: 1,
  compositionId: 'rotation',
  timeUs: 0,
  viewport: { width: 8, height: 8, dpr: 1 },
  background: { r: 0, g: 0, b: 0, a: 255 },
  nodes: [
    {
      kind: 'sprite',
      id: 'bar',
      zIndex: 0,
      opacity: 1,
      transform: {
        translateX: 2,
        translateY: 3,
        scaleX: 1,
        scaleY: 1,
        rotationDeg,
        ...(origin === undefined ? {} : { origin }),
      },
      width: 4,
      height: 2,
      color: { r: 255, g: 255, b: 255, a: 255 },
    },
  ],
});

/** The lit cells of an 8x8 frame as a picture, one string per row. */
function picture(pixels: Uint8Array): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 8; y++) {
    let row = '';
    for (let x = 0; x < 8; x++) row += pixels[(y * 8 + x) * 4]! > 0 ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

describe('T-M15 rotation in the Node rasterisers', () => {
  it('a 4x2 bar turned 90 degrees about its centre stands upright around the same centre', () => {
    const before = picture(renderHeadlessFrame(sprite(0)).pixels);
    expect(before).toEqual([
      '........',
      '........',
      '........',
      '..####..',
      '..####..',
      '........',
      '........',
      '........',
    ]);
    const turned = picture(renderHeadlessFrame(sprite(90)).pixels);
    expect(turned).toEqual([
      '........',
      '........',
      '...##...',
      '...##...',
      '...##...',
      '...##...',
      '........',
      '........',
    ]);
  });

  it('the origin decides the pivot: turned 90 degrees about the top-left corner', () => {
    expect(picture(renderHeadlessFrame(sprite(90, { x: 0, y: 0 })).pixels)).toEqual([
      '........',
      '........',
      '........',
      '##......',
      '##......',
      '##......',
      '##......',
      '........',
    ]);
  });

  it('a full turn draws the same picture as no turn', () => {
    expect(picture(renderHeadlessFrame(sprite(360)).pixels)).toEqual(
      picture(renderHeadlessFrame(sprite(0)).pixels),
    );
  });

  it('preview and headless draw a rotated frame the same (sprite, video and text with a plate)', () => {
    for (const timeUs of [0, 500_000, 1_000_000]) {
      const frame = createParitySpikeFrame(timeUs);
      const rotated: RenderFrameIR = {
        ...frame,
        nodes: frame.nodes.map((node, index) => {
          const turned = {
            ...node,
            transform: {
              ...node.transform,
              rotationDeg: [90, -30, 45][index]!,
              ...(index === 1 ? { origin: { x: 0, y: 1 } } : {}),
            },
          };
          return (
            node.kind === 'text' ? { ...turned, background: { r: 9, g: 9, b: 9, a: 200 } } : turned
          ) as RenderNode;
        }),
      };
      const comparison = compareGoldenFrame(rotated);
      expect(comparison.identical).toBe(true);
      expect(comparison.previewDigest).not.toBe(compareGoldenFrame(frame).previewDigest);
      expect(renderPixiPreview(rotated).pixels).toEqual(renderHeadlessFrame(rotated).pixels);
    }
  });
});

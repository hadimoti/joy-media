import { describe, expect, it } from 'vitest';
import type { RenderFrameIR } from '@joy-media/render-ir';
import { validateRenderFrameIR } from '@joy-media/render-ir';
import type { DecodedFrame } from './index.js';
import {
  importedClipToMediaSource,
  videoFrameNodeFromDecoded,
  withVideoFrameNode,
} from './video-frame-node.js';
import type { VideoClipSpec } from './video-frame-node.js';

const baseFrame: RenderFrameIR = {
  version: 1,
  compositionId: 'comp-1',
  timeUs: 1_000_000,
  viewport: { width: 1920, height: 1080, dpr: 1 },
  background: { r: 12, g: 16, b: 28, a: 255 },
  nodes: [],
};

const baseClip: VideoClipSpec = {
  id: 'clip-1',
  originalToken: 'media://original',
  startUs: 0,
  durationUs: 2_000_000,
  sourceInUs: 500_000,
  transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
  opacity: 1,
  zIndex: 0,
};

describe('video-frame-node bridge', () => {
  it('maps an imported clip with a proxy to a MediaSource that prefers the proxy', () => {
    expect(importedClipToMediaSource({ ...baseClip, proxyToken: 'media://proxy' })).toEqual({
      assetId: 'clip-1',
      originalToken: 'media://original',
      proxyToken: 'media://proxy',
    });
    expect(importedClipToMediaSource(baseClip)).toEqual({
      assetId: 'clip-1',
      originalToken: 'media://original',
    });
  });

  it('builds a VideoFrameNode from a decoded frame and uses bitmap dimensions when present', () => {
    const decoded: DecodedFrame = {
      assetId: 'media://proxy',
      sourceTimeUs: 750_000,
      token: 'html-media:4',
      bitmap: {
        width: 128,
        height: 72,
        data: new Uint8ClampedArray(128 * 72 * 4),
      },
    };
    const node = videoFrameNodeFromDecoded(baseClip, decoded);
    expect(node.kind).toBe('video-frame');
    expect(node.id).toBe('clip-1');
    expect(node.sourceTimeUs).toBe(750_000);
    expect(node.width).toBe(128);
    expect(node.height).toBe(72);
  });

  it('falls back to intrinsic dimensions when no bitmap is captured', () => {
    const decoded: DecodedFrame = { assetId: 'm', sourceTimeUs: 0, token: 't' };
    const node = videoFrameNodeFromDecoded(baseClip, decoded, { width: 1920, height: 1080 });
    expect(node.width).toBe(1920);
    expect(node.height).toBe(1080);
  });

  it('carries a resolved clip grade on the video node before compositing', () => {
    const grade = {
      version: 2 as const,
      enabled: true,
      adjust: { exposure: 1 },
    };
    const decoded: DecodedFrame = { assetId: 'm', sourceTimeUs: 0, token: 't' };
    const node = videoFrameNodeFromDecoded(
      { ...baseClip, colorGrade: { ...grade, lift: 0, gamma: 1, gain: 1, saturation: 1 } },
      decoded,
      { width: 640, height: 360 },
    );
    expect(node.colorGrade).toEqual({
      ...grade,
      lift: 0,
      gamma: 1,
      gain: 1,
      saturation: 1,
    });
  });

  it('appends a VideoFrameNode to a RenderFrameIR and keeps the frame valid', () => {
    const decoded: DecodedFrame = { assetId: 'm', sourceTimeUs: 0, token: 't' };
    const node = videoFrameNodeFromDecoded(baseClip, decoded, { width: 640, height: 360 });
    const next = withVideoFrameNode(baseFrame, node);
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]).toBe(node);
    expect(() => validateRenderFrameIR(next)).not.toThrow();
  });
});

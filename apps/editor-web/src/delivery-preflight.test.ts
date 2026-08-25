import { describe, expect, it } from 'vitest';
import {
  deliveryMediaStateFromEvidence,
  deliveryPreflight,
  type DeliveryTimelineClip,
} from './delivery-preflight.js';

const CLIP: DeliveryTimelineClip = { id: 'clip-1', assetId: 'asset-1', durationUs: 1_000_000 };

function run(overrides: Partial<Parameters<typeof deliveryPreflight>[0]> = {}) {
  return deliveryPreflight({
    channel: 'quick-browser-export',
    clips: [CLIP],
    mediaStates: new Map([[CLIP.id, 'ready']]),
    capabilities: ['browser-mp4'],
    ...overrides,
  });
}

describe('deliveryPreflight', () => {
  it('does not treat metadata-only ready evidence as playable media', () => {
    expect(deliveryMediaStateFromEvidence({ state: 'ready' })).toBe('unavailable');
    expect(
      deliveryPreflight({
        channel: 'quick-browser-export',
        clips: [CLIP],
        mediaStates: new Map([[CLIP.id, deliveryMediaStateFromEvidence({ state: 'ready' })]]),
        capabilities: ['browser-mp4'],
      }),
    ).toMatchObject({ allowed: false, code: 'media-not-ready' });
  });

  it('blocks an empty timeline with an actionable reason', () => {
    expect(run({ clips: [] })).toMatchObject({
      allowed: false,
      code: 'no-renderable-media',
      reason: expect.stringContaining('Add a video clip'),
    });
  });

  it('keeps catalog-only video blocked without resolver evidence', () => {
    expect(run({ mediaStates: new Map() })).toMatchObject({
      allowed: false,
      code: 'media-not-ready',
      reason: expect.stringContaining('missing'),
    });
    expect(run({ mediaStates: new Map([[CLIP.id, 'pending']]) })).toMatchObject({
      allowed: false,
      code: 'media-not-ready',
      reason: expect.stringContaining('preparing'),
    });
  });

  it('blocks a delivery channel without its supported capability', () => {
    expect(run({ capabilities: [] })).toMatchObject({
      allowed: false,
      code: 'capability-unavailable',
      reason: expect.stringContaining('Browser MP4'),
    });
    expect(
      run({ channel: 'verified-delivery', capabilities: ['worker-render-export'] }),
    ).toMatchObject({ allowed: true });
  });
});

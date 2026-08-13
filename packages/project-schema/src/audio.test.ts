import { describe, expect, it } from 'vitest';
import {
  AUDIO_AUTOMATION_DESCRIPTORS,
  audioAutomationDescriptor,
  audioBusPropertyBinding,
  audioClipPropertyBinding,
  audioEffectPropertyBinding,
} from './audio.js';

describe('audio automation descriptors', () => {
  it('provides stable timeline bindings for clip, bus, and effect owners', () => {
    expect(audioClipPropertyBinding('clip-1', 'gain')).toEqual({
      ownerKind: 'audio-clip',
      ownerId: 'clip-1',
      propertyId: 'gain',
      timeDomain: 'audio-timeline',
    });
    expect(audioBusPropertyBinding('master', 'mute')).toEqual({
      ownerKind: 'audio-bus',
      ownerId: 'master',
      propertyId: 'mute',
      timeDomain: 'audio-timeline',
    });
    expect(audioEffectPropertyBinding('effect-1', 'compressor.threshold')).toEqual({
      ownerKind: 'audio-effect',
      ownerId: 'effect-1',
      propertyId: 'compressor.threshold',
      timeDomain: 'audio-timeline',
    });
  });

  it('smooths continuous controls and holds mute exactly', () => {
    expect(AUDIO_AUTOMATION_DESCRIPTORS).toHaveLength(6);
    expect(audioAutomationDescriptor('audio-clip', 'gain')).toMatchObject({
      interpolation: 'linear-ramp',
      smoothingUs: 5_000,
    });
    expect(audioAutomationDescriptor('audio-bus', 'mute')).toMatchObject({
      interpolation: 'hold',
      smoothingUs: 0,
    });
    expect(audioAutomationDescriptor('audio-bus', 'solo')).toBeUndefined();
  });
});

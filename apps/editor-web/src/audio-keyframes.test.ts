import { describe, expect, it } from 'vitest';
import {
  audioClipPropertyBinding,
  canonicalBindingKey,
  type JoyProjectV1,
} from '@joy-media/project-schema';
import { audioKeyframeState, audioKeyframeTransaction } from './audio-keyframes.js';

const binding = audioClipPropertyBinding('clip-1', 'gain');
const project = {
  propertyAnimations: {
    [canonicalBindingKey(binding)]: {
      binding,
      value: {
        kind: 'scalar' as const,
        curve: { keyframes: [{ timeUs: 10, value: 1, interpolation: 'linear' as const }] },
      },
    },
  },
} as Pick<JoyProjectV1, 'propertyAnimations'>;

describe('audio keyframes', () => {
  it('reports none, between, and exact key states from the shared map', () => {
    expect(audioKeyframeState({}, binding, 10)).toBe('none');
    expect(audioKeyframeState(project, binding, 9)).toBe('between');
    expect(audioKeyframeState(project, binding, 10)).toBe('keyed');
  });

  it('toggles the exact key through one property-animation command', () => {
    expect(audioKeyframeTransaction(project, binding, 10, 1, 'Clip gain').commands).toEqual([
      { type: 'propertyAnimation.removeKey', payload: { binding, timeUs: 10 } },
    ]);
    expect(audioKeyframeTransaction({}, binding, 10, 1, 'Clip gain').commands).toEqual([
      {
        type: 'propertyAnimation.replace',
        payload: {
          binding,
          value: {
            kind: 'scalar',
            curve: { keyframes: [{ timeUs: 10, value: 1, interpolation: 'linear' }] },
          },
        },
      },
    ]);
  });
});

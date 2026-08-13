import {
  canonicalBindingKey,
  type JoyProjectV1,
  type PropertyBindingV2,
} from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import type { PropertyAnimationState } from './components/PropertyRow.js';

type AudioKeyframeValue = number | boolean;

export function audioKeyframeState(
  project: Pick<JoyProjectV1, 'propertyAnimations'>,
  binding: PropertyBindingV2,
  timeUs: number,
): PropertyAnimationState {
  const value = project.propertyAnimations?.[canonicalBindingKey(binding)]?.value;
  if (value === undefined) return 'none';
  const keyed =
    value.kind === 'scalar'
      ? value.curve.keyframes.some((key) => key.timeUs === timeUs)
      : value.kind === 'boolean'
        ? value.keys.some((key) => key.timeUs === timeUs)
        : false;
  return keyed ? 'keyed' : 'between';
}

/**
 * One durable command either adds/removes a key at the current audio time.
 * It never changes the static mixer value, so undo restores only animation
 * ownership and UI surfaces remain synchronized through the project document.
 */
export function audioKeyframeTransaction(
  project: Pick<JoyProjectV1, 'propertyAnimations'>,
  binding: PropertyBindingV2,
  timeUs: number,
  value: AudioKeyframeValue,
  label: string,
): VisualObjectTransaction {
  const current = project.propertyAnimations?.[canonicalBindingKey(binding)];
  if (typeof value === 'number') {
    const scalar = current?.value.kind === 'scalar' ? current.value : undefined;
    const hasKey = scalar?.curve.keyframes.some((key) => key.timeUs === timeUs) === true;
    return {
      label: hasKey ? 'Remove ' + label + ' keyframe' : 'Add ' + label + ' keyframe',
      commands: [
        hasKey
          ? { type: 'propertyAnimation.removeKey', payload: { binding, timeUs } }
          : scalar !== undefined
            ? {
                type: 'propertyAnimation.setKey',
                payload: {
                  binding,
                  key: {
                    kind: 'scalar',
                    keyframe: { timeUs, value, interpolation: 'linear' },
                  },
                },
              }
            : {
                type: 'propertyAnimation.replace',
                payload: {
                  binding,
                  value: {
                    kind: 'scalar',
                    curve: { keyframes: [{ timeUs, value, interpolation: 'linear' }] },
                  },
                },
              },
      ],
    };
  }
  const boolean = current?.value.kind === 'boolean' ? current.value : undefined;
  const hasKey = boolean?.keys.some((key) => key.timeUs === timeUs) === true;
  return {
    label: hasKey ? 'Remove ' + label + ' keyframe' : 'Add ' + label + ' keyframe',
    commands: [
      hasKey
        ? { type: 'propertyAnimation.removeKey', payload: { binding, timeUs } }
        : boolean !== undefined
          ? {
              type: 'propertyAnimation.setKey',
              payload: { binding, key: { kind: 'boolean', timeUs, value } },
            }
          : {
              type: 'propertyAnimation.replace',
              payload: { binding, value: { kind: 'boolean', keys: [{ timeUs, value }] } },
            },
    ],
  };
}

/**
 * Inspector with keyframe controls (WP-04.1). Each numeric transform channel
 * gets a stopwatch toggle that adds/removes a keyframe at the playhead, and its
 * value field edits the animated keyframe when the channel is animated, or the
 * static transform otherwise. Every edit is a durable `object.replaceAnimation`
 * (or `object.setTransformProperty`) command, so keyframes undo/redo and persist
 * exactly like any other project edit.
 */

import type { AnimatablePropertyV1, VisualObjectV1 } from '@joy-media/project-schema';
import type { NumericTransformProperty, VisualObjectTransaction } from '@joy-media/property-system';
import { VISUAL_INSPECTOR } from '@joy-media/property-system';
import {
  hasKeyframeAt,
  removeKeyframe,
  resolveObjectTransform,
  sampleCurve,
  setKeyframe,
} from '@joy-media/motion-core';

interface InspectorPanelProps {
  readonly object: VisualObjectV1 | undefined;
  readonly playheadUs: number;
  readonly onSetStatic: (objectId: string, key: NumericTransformProperty, value: number) => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}

const NUMERIC_PROPERTIES = VISUAL_INSPECTOR.filter((property) => property.kind === 'number');

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function InspectorPanel({
  object,
  playheadUs,
  onSetStatic,
  onDispatch,
}: InspectorPanelProps) {
  if (object === undefined) return <p>Select a visual clip to edit.</p>;
  const timeUs = Math.max(0, Math.round(playheadUs));
  const resolved = resolveObjectTransform(object, timeUs);

  const replaceChannel = (
    property: AnimatablePropertyV1,
    curve: ReturnType<typeof setKeyframe> | undefined,
  ) => {
    onDispatch({
      label: curve === undefined ? `Clear ${property} keyframes` : `Keyframe ${property}`,
      commands: [
        {
          type: 'object.replaceAnimation',
          payload:
            curve === undefined
              ? { objectId: object.id, property }
              : { objectId: object.id, property, curve },
        },
      ],
    });
  };

  const toggleKeyframe = (property: AnimatablePropertyV1, value: number) => {
    const curve = object.animations?.[property];
    if (curve !== undefined && hasKeyframeAt(curve, timeUs)) {
      replaceChannel(property, removeKeyframe(curve, timeUs));
      return;
    }
    replaceChannel(property, setKeyframe(curve, { timeUs, value, interpolation: 'linear' }));
  };

  return (
    <article>
      <p>Editing {object.id}</p>
      <p className="inspector-time">Playhead {(timeUs / 1_000_000).toFixed(2)}s</p>
      {NUMERIC_PROPERTIES.map((property) => {
        const key = property.key as AnimatablePropertyV1;
        const curve = object.animations?.[key];
        const animated = curve !== undefined;
        const keyed = animated && hasKeyframeAt(curve, timeUs);
        const value = animated ? sampleCurve(curve, timeUs) : resolved[key];
        return (
          <label key={key} className={animated ? 'inspector-row animated' : 'inspector-row'}>
            <button
              type="button"
              className={keyed ? 'kf kf-active' : animated ? 'kf kf-on' : 'kf'}
              aria-label={`${keyed ? 'Remove' : 'Add'} ${property.label} keyframe`}
              aria-pressed={keyed}
              title={
                keyed
                  ? `Keyframe at playhead — click to remove`
                  : animated
                    ? `Animated — click to add a keyframe here`
                    : `Animate ${property.label}`
              }
              onClick={() => toggleKeyframe(key, value)}
            >
              {keyed ? '◆' : animated ? '◇' : '○'}
            </button>
            <span className="inspector-label">{property.label}</span>
            <input
              type="number"
              min={property.min}
              max={property.max}
              value={round(value)}
              onChange={(event) => {
                const next = event.currentTarget.valueAsNumber;
                if (!Number.isFinite(next)) return;
                if (animated)
                  replaceChannel(
                    key,
                    setKeyframe(curve, { timeUs, value: next, interpolation: 'linear' }),
                  );
                else onSetStatic(object.id, key as NumericTransformProperty, next);
              }}
            />
          </label>
        );
      })}
    </article>
  );
}

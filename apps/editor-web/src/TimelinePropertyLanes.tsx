import { useMemo } from 'react';
import type { VisualObjectV1 } from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import { VISUAL_INSPECTOR } from '@joy-media/property-system';
import {
  hasKeyframeAtCurve,
  removeKeyframe,
  sampleCurve,
  setKeyframe,
} from '@joy-media/motion-core';
import { KeyframeActiveIcon, KeyframeNoneIcon, KeyNextIcon, KeyPrevIcon } from './icons.js';

const TRANSFORM_KEYS = ['x', 'y', 'scaleX', 'scaleY', 'rotationDeg', 'opacity'] as const;
type TransformKey = (typeof TRANSFORM_KEYS)[number];

export interface TimelinePropertyKey {
  readonly timeUs: number;
  readonly value: number;
}

export interface TimelinePropertyLane {
  readonly property: TransformKey;
  readonly label: string;
  readonly keys: readonly TimelinePropertyKey[];
}

export function buildLegacyTransformPropertyLanes(
  object: VisualObjectV1,
): readonly TimelinePropertyLane[] {
  return TRANSFORM_KEYS.map((property) => {
    const descriptor = VISUAL_INSPECTOR.find((candidate) => candidate.key === property);
    const curve = object.animations?.[property];
    return {
      property,
      label: descriptor?.label ?? property,
      keys: curve?.keyframes.map((key) => ({ timeUs: key.timeUs, value: key.value })) ?? [],
    };
  });
}

/** Returns only keys near the viewport — the lane never maps a full 10k-key curve to DOM. */
export function visiblePropertyKeys(
  keys: readonly TimelinePropertyKey[],
  viewportStartUs: number,
  viewportEndUs: number,
  overscanUs: number,
): readonly TimelinePropertyKey[] {
  const start = Math.max(0, viewportStartUs - overscanUs);
  const end = viewportEndUs + overscanUs;
  return keys.filter((key) => key.timeUs >= start && key.timeUs <= end);
}

function snapToFrame(timeUs: number, frameUs: number): number {
  return Math.max(0, Math.round(timeUs / frameUs) * frameUs);
}

export function TimelinePropertyLanes({
  object,
  playheadUs,
  frameUs,
  pixelsPerSecond,
  laneWidthPx,
  scrollLeft,
  viewportWidthPx,
  showAnimatedOnly,
  onShowAnimatedOnlyChange,
  onSeek,
  onDispatch,
}: {
  readonly object: VisualObjectV1;
  readonly playheadUs: number;
  readonly frameUs: number;
  readonly pixelsPerSecond: number;
  readonly laneWidthPx: number;
  readonly scrollLeft: number;
  readonly viewportWidthPx: number;
  readonly showAnimatedOnly: boolean;
  readonly onShowAnimatedOnlyChange: (next: boolean) => void;
  readonly onSeek: (timeUs: number) => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}) {
  const lanes = useMemo(() => buildLegacyTransformPropertyLanes(object), [object]);
  const visibleLanes = showAnimatedOnly ? lanes.filter((lane) => lane.keys.length > 0) : lanes;
  const viewportStartUs = Math.max(0, (scrollLeft / pixelsPerSecond) * 1_000_000);
  const viewportEndUs = ((scrollLeft + viewportWidthPx) / pixelsPerSecond) * 1_000_000;
  const overscanUs = Math.max(1_000_000, ((viewportWidthPx * 0.4) / pixelsPerSecond) * 1_000_000);

  const dispatchCurve = (
    property: TransformKey,
    curve: ReturnType<typeof setKeyframe> | undefined,
  ) =>
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

  const addOrRemove = (lane: TimelinePropertyLane) => {
    const atUs = snapToFrame(playheadUs, frameUs);
    const curve = object.animations?.[lane.property];
    if (curve !== undefined && hasKeyframeAtCurve(curve, atUs)) {
      dispatchCurve(lane.property, removeKeyframe(curve, atUs));
      return;
    }
    const current =
      curve === undefined ? object.transform[lane.property] : sampleCurve(curve, atUs);
    dispatchCurve(
      lane.property,
      setKeyframe(curve, { timeUs: atUs, value: current, interpolation: 'linear' }),
    );
  };

  const seekKey = (keys: readonly TimelinePropertyKey[], direction: -1 | 1) => {
    const current = snapToFrame(playheadUs, frameUs);
    const candidates =
      direction < 0
        ? keys.filter((key) => key.timeUs < current)
        : keys.filter((key) => key.timeUs > current);
    const target = direction < 0 ? candidates.at(-1) : candidates[0];
    if (target !== undefined) onSeek(target.timeUs);
  };

  return (
    <section className="timeline-property-lanes" aria-label={`${object.id} animated properties`}>
      <header className="timeline-property-lanes-header">
        <div className="timeline-property-lanes-title">
          <strong>Properties</strong>
          <span title={object.id}>{object.id}</span>
        </div>
        <label className="timeline-property-lanes-filter">
          <input
            type="checkbox"
            checked={showAnimatedOnly}
            onChange={(event) => onShowAnimatedOnlyChange(event.currentTarget.checked)}
          />
          Show animated
        </label>
      </header>
      {visibleLanes.length === 0 ? (
        <p className="timeline-property-lanes-empty">No animated properties on this object.</p>
      ) : (
        visibleLanes.map((lane) => {
          const curve = object.animations?.[lane.property];
          const keyed =
            curve !== undefined && hasKeyframeAtCurve(curve, snapToFrame(playheadUs, frameUs));
          const keys = visiblePropertyKeys(lane.keys, viewportStartUs, viewportEndUs, overscanUs);
          return (
            <div
              className="timeline-property-lane"
              key={lane.property}
              data-property-lane={lane.property}
            >
              <div className="timeline-property-lane-header">
                <span>{lane.label}</span>
                <div role="group" aria-label={`${lane.label} keyframe controls`}>
                  <button
                    type="button"
                    aria-label={`Previous ${lane.label} keyframe`}
                    onClick={() => seekKey(lane.keys, -1)}
                  >
                    <KeyPrevIcon />
                  </button>
                  <button
                    type="button"
                    aria-label={`${keyed ? 'Remove' : 'Add'} ${lane.label} keyframe`}
                    aria-pressed={keyed}
                    onClick={() => addOrRemove(lane)}
                  >
                    {keyed ? <KeyframeActiveIcon /> : <KeyframeNoneIcon />}
                  </button>
                  <button
                    type="button"
                    aria-label={`Next ${lane.label} keyframe`}
                    onClick={() => seekKey(lane.keys, 1)}
                  >
                    <KeyNextIcon />
                  </button>
                </div>
              </div>
              <div className="timeline-property-key-track" style={{ minWidth: `${laneWidthPx}px` }}>
                {keys.map((key) => (
                  <button
                    key={key.timeUs}
                    type="button"
                    className="timeline-property-key"
                    data-key-time-us={key.timeUs}
                    aria-label={`${lane.label} keyframe at ${(key.timeUs / 1_000_000).toFixed(3)} seconds`}
                    style={{ left: `${(key.timeUs / 1_000_000) * pixelsPerSecond}px` }}
                    onClick={() => onSeek(key.timeUs)}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}

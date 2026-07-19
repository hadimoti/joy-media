/**
 * Motion panel (WP-04.2, §39-64): per-channel keyframe lanes and a graph-editor
 * baseline for the selected object, plus parenting and motion-preset controls.
 * The lanes place a diamond per keyframe (click to seek); the graph plots the
 * sampled value of one channel across the composition with a live playhead. All
 * edits go through the durable command bus via `onDispatch`.
 */

import { useState } from 'react';
import type { AnimatablePropertyV1, VisualObjectV1 } from '@joy-media/project-schema';
import { ANIMATABLE_PROPERTIES } from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import {
  buildPresetChannels,
  JOY_MOTION_PRESETS,
  parentChain,
  sampleCurve,
} from '@joy-media/motion-core';

interface MotionPanelProps {
  readonly object: VisualObjectV1 | undefined;
  readonly allObjects: Readonly<Record<string, VisualObjectV1>>;
  readonly compositionDurationUs: number;
  readonly playheadUs: number;
  readonly onSeek: (timeUs: number) => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}

const LANE_WIDTH = 280;
const GRAPH_HEIGHT = 90;
const PRESET_DURATION_US = 1_000_000;

function animatedChannels(object: VisualObjectV1): readonly AnimatablePropertyV1[] {
  const animations = object.animations;
  if (animations === undefined) return [];
  return ANIMATABLE_PROPERTIES.filter((key) => animations[key] !== undefined);
}

export function MotionPanel({
  object,
  allObjects,
  compositionDurationUs,
  playheadUs,
  onSeek,
  onDispatch,
}: MotionPanelProps) {
  const [graphChannel, setGraphChannel] = useState<AnimatablePropertyV1 | undefined>(undefined);
  const [presetId, setPresetId] = useState<string>(JOY_MOTION_PRESETS[0]!.id);

  if (object === undefined) return <p>Select a visual clip to edit its motion.</p>;

  const duration = Math.max(1, compositionDurationUs);
  const timeToX = (timeUs: number) =>
    (Math.min(duration, Math.max(0, timeUs)) / duration) * LANE_WIDTH;
  const channels = animatedChannels(object);
  const activeGraph =
    graphChannel !== undefined && channels.includes(graphChannel) ? graphChannel : channels[0];

  const applyPreset = () => {
    const built = buildPresetChannels(presetId, {
      startUs: Math.max(0, Math.round(playheadUs)),
      durationUs: PRESET_DURATION_US,
      base: object.transform,
    });
    const commands = Object.entries(built).map(([property, curve]) => ({
      type: 'object.replaceAnimation' as const,
      payload: { objectId: object.id, property: property as AnimatablePropertyV1, curve },
    }));
    if (commands.length > 0) onDispatch({ label: `Apply preset ${presetId}`, commands });
  };

  const setParent = (parentId: string) => {
    onDispatch({
      label: 'Set parent',
      commands: [
        {
          type: 'object.setParent',
          payload: parentId === '' ? { objectId: object.id } : { objectId: object.id, parentId },
        },
      ],
    });
  };

  // Parent candidates: every other object that is not a descendant of this one
  // (a descendant parent would form a cycle the command would reject anyway).
  const parentCandidates = Object.values(allObjects).filter(
    (candidate) =>
      candidate.id !== object.id &&
      !parentChain(candidate.id, allObjects).some((ancestor) => ancestor.id === object.id),
  );

  return (
    <article className="motion-panel">
      <p>Motion · {object.id}</p>

      <div className="motion-controls">
        <label className="motion-field">
          Parent
          <select value={object.parentId ?? ''} onChange={(event) => setParent(event.target.value)}>
            <option value="">(none)</option>
            {parentCandidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.id}
                {candidate.kind === 'null' ? ' (null)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="motion-field">
          Preset
          <select value={presetId} onChange={(event) => setPresetId(event.target.value)}>
            {JOY_MOTION_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={applyPreset}>
          Apply at playhead
        </button>
      </div>

      {channels.length === 0 ? (
        <p className="motion-empty">
          No keyframes yet — add them in the Inspector or apply a preset above.
        </p>
      ) : (
        <div className="motion-lanes">
          {channels.map((channel) => {
            const curve = object.animations![channel]!;
            return (
              <div key={channel} className="motion-lane">
                <button
                  type="button"
                  className={
                    activeGraph === channel ? 'motion-lane-label active' : 'motion-lane-label'
                  }
                  onClick={() => setGraphChannel(channel)}
                  title="Show this channel in the graph"
                >
                  {channel}
                </button>
                <svg
                  className="motion-lane-track"
                  viewBox={`0 0 ${LANE_WIDTH} 16`}
                  width={LANE_WIDTH}
                  height={16}
                  role="img"
                  aria-label={`${channel} keyframes`}
                >
                  <line x1={0} y1={8} x2={LANE_WIDTH} y2={8} stroke="#303a56" strokeWidth={1} />
                  <line
                    x1={timeToX(playheadUs)}
                    y1={0}
                    x2={timeToX(playheadUs)}
                    y2={16}
                    stroke="#e9b949"
                    strokeWidth={1}
                  />
                  {curve.keyframes.map((keyframe) => (
                    <rect
                      key={keyframe.timeUs}
                      x={timeToX(keyframe.timeUs) - 4}
                      y={4}
                      width={8}
                      height={8}
                      transform={`rotate(45 ${timeToX(keyframe.timeUs)} 8)`}
                      fill="#7cc4ff"
                      style={{ cursor: 'pointer' }}
                      onClick={() => onSeek(keyframe.timeUs)}
                    >
                      <title>{`${channel} @ ${(keyframe.timeUs / 1_000_000).toFixed(2)}s = ${keyframe.value}`}</title>
                    </rect>
                  ))}
                </svg>
              </div>
            );
          })}
        </div>
      )}

      {activeGraph !== undefined && (
        <MotionGraph
          object={object}
          channel={activeGraph}
          duration={duration}
          playheadUs={playheadUs}
        />
      )}
    </article>
  );
}

interface MotionGraphProps {
  readonly object: VisualObjectV1;
  readonly channel: AnimatablePropertyV1;
  readonly duration: number;
  readonly playheadUs: number;
}

function MotionGraph({ object, channel, duration, playheadUs }: MotionGraphProps) {
  const curve = object.animations?.[channel];
  if (curve === undefined) return null;
  const samples = 80;
  const points: { readonly t: number; readonly v: number }[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = (duration * i) / samples;
    points.push({ t, v: sampleCurve(curve, t) });
  }
  const values = points.map((point) => point.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (t: number) => (t / duration) * LANE_WIDTH;
  const y = (v: number) => GRAPH_HEIGHT - 8 - ((v - min) / span) * (GRAPH_HEIGHT - 16);
  const path = points.map((point) => `${x(point.t).toFixed(1)},${y(point.v).toFixed(1)}`).join(' ');

  return (
    <div className="motion-graph">
      <div className="motion-graph-scale">
        <span>{max.toFixed(2)}</span>
        <span>{min.toFixed(2)}</span>
      </div>
      <svg
        viewBox={`0 0 ${LANE_WIDTH} ${GRAPH_HEIGHT}`}
        width={LANE_WIDTH}
        height={GRAPH_HEIGHT}
        role="img"
        aria-label={`${channel} value graph`}
      >
        <polyline points={path} fill="none" stroke="#7cc4ff" strokeWidth={1.5} />
        <line
          x1={x(playheadUs)}
          y1={0}
          x2={x(playheadUs)}
          y2={GRAPH_HEIGHT}
          stroke="#e9b949"
          strokeWidth={1}
        />
        {curve.keyframes.map((keyframe) => (
          <circle
            key={keyframe.timeUs}
            cx={x(keyframe.timeUs)}
            cy={y(keyframe.value)}
            r={3}
            fill="#e9b949"
          />
        ))}
      </svg>
    </div>
  );
}

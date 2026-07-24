/**
 * Editable AE-style value graph: drag keys, multi-select, bezier handles,
 * interpolation, and copy/paste via motion-core.
 */

import { useMemo, useRef, useState } from 'react';
import type {
  AnimatablePropertyV1,
  KeyframeInterpolationV1,
  KeyframeV1,
  VisualObjectV1,
} from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import {
  copyKeyframes,
  EASED_HANDLES,
  pasteKeyframes,
  sampleCurve,
  setKeyframe,
  type KeyframeClipboard,
} from '@joy-media/motion-core';
import {
  CopyIcon,
  InterpBezierIcon,
  InterpEasedIcon,
  InterpHoldIcon,
  InterpLinearIcon,
  KeyNextIcon,
  KeyPrevIcon,
  PasteIcon,
} from './icons.js';

const LANE_WIDTH = 280;
const GRAPH_HEIGHT = 120;
const SNAP_US = 10_000;

let graphClipboard: KeyframeClipboard | undefined;

interface GraphEditorProps {
  readonly object: VisualObjectV1;
  readonly channel: AnimatablePropertyV1;
  readonly duration: number;
  readonly playheadUs: number;
  readonly onSeek: (timeUs: number) => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}

function defaultBezier(): NonNullable<KeyframeV1['bezier']> {
  return { x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
}

export function GraphEditor({
  object,
  channel,
  duration,
  playheadUs,
  onSeek,
  onDispatch,
}: GraphEditorProps) {
  const curve = object.animations?.[channel];
  const [selected, setSelected] = useState<readonly number[]>([]);
  const dragRef = useRef<
    | { kind: 'key'; index: number; originX: number; originY: number; start: KeyframeV1 }
    | { kind: 'handle'; index: number; which: 'in' | 'out'; originX: number; originY: number }
    | null
  >(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const metrics = useMemo(() => {
    if (curve === undefined) return undefined;
    const samples = 80;
    const points: { readonly t: number; readonly v: number }[] = [];
    for (let i = 0; i <= samples; i += 1) {
      const t = (duration * i) / samples;
      points.push({ t, v: sampleCurve(curve, t) });
    }
    const keyValues = curve.keyframes.map((k) => k.value);
    const values = [...points.map((p) => p.v), ...keyValues];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    return { points, min, max, span };
  }, [curve, duration]);

  if (curve === undefined || metrics === undefined) return null;

  const x = (t: number) => (Math.max(0, Math.min(duration, t)) / duration) * LANE_WIDTH;
  const y = (v: number) =>
    GRAPH_HEIGHT - 8 - ((v - metrics.min) / metrics.span) * (GRAPH_HEIGHT - 16);
  const fromX = (px: number) => (px / LANE_WIDTH) * duration;
  const fromY = (py: number) =>
    metrics.min + ((GRAPH_HEIGHT - 8 - py) / (GRAPH_HEIGHT - 16)) * metrics.span;
  const path = metrics.points
    .map((point) => `${x(point.t).toFixed(1)},${y(point.v).toFixed(1)}`)
    .join(' ');

  const replaceCurve = (next: typeof curve, label: string) => {
    onDispatch({
      label,
      commands: [
        {
          type: 'object.replaceAnimation',
          payload: { objectId: object.id, property: channel, curve: next },
        },
      ],
    });
  };

  const setInterp = (interpolation: KeyframeInterpolationV1) => {
    if (selected.length === 0) return;
    const nextKeys = curve.keyframes.map((key, index) => {
      if (!selected.includes(index)) return key;
      if (interpolation === 'bezier')
        return { ...key, interpolation, bezier: key.bezier ?? defaultBezier() };
      if (interpolation === 'eased')
        return { ...key, interpolation, bezier: EASED_HANDLES };
      const { bezier: _drop, ...rest } = key;
      return { ...rest, interpolation };
    });
    replaceCurve({ keyframes: nextKeys }, `Set ${channel} interpolation → ${interpolation}`);
  };

  const copySelected = () => {
    if (selected.length === 0) return;
    const times = selected
      .map((index) => curve.keyframes[index]?.timeUs)
      .filter((time): time is number => time !== undefined)
      .sort((a, b) => a - b);
    const startUs = times[0];
    const endUs = times[times.length - 1];
    if (startUs === undefined || endUs === undefined) return;
    graphClipboard = copyKeyframes(curve, startUs, endUs);
  };

  const pasteAtPlayhead = () => {
    if (graphClipboard === undefined) return;
    replaceCurve(
      pasteKeyframes(curve, graphClipboard, Math.max(0, Math.round(playheadUs))),
      `Paste ${channel} keys`,
    );
  };

  const onSvgPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (drag === null || curve === undefined) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const localX = ((event.clientX - rect.left) / rect.width) * LANE_WIDTH;
    const localY = ((event.clientY - rect.top) / rect.height) * GRAPH_HEIGHT;
    if (drag.kind === 'key') {
      const timeUs = Math.round(fromX(localX) / SNAP_US) * SNAP_US;
      const value = fromY(localY);
      const next = setKeyframe(
        {
          keyframes: curve.keyframes.filter((_, i) => i !== drag.index),
        },
        { ...drag.start, timeUs: Math.max(0, Math.min(duration, timeUs)), value },
      );
      replaceCurve(next, `Move ${channel} key`);
    } else {
      const key = curve.keyframes[drag.index];
      if (key === undefined) return;
      const bezier = key.bezier ?? defaultBezier();
      const nx = Math.max(0, Math.min(1, localX / LANE_WIDTH));
      const ny = 1 - Math.max(0, Math.min(1, localY / GRAPH_HEIGHT));
      const nextBezier =
        drag.which === 'out'
          ? { ...bezier, x2: nx, y2: ny }
          : { ...bezier, x1: nx, y1: ny };
      const next = setKeyframe(curve, {
        ...key,
        interpolation: 'bezier',
        bezier: nextBezier,
      });
      replaceCurve(next, `Edit ${channel} bezier`);
    }
  };

  return (
    <div className="motion-graph graph-editor">
      <div className="graph-editor-toolbar">
        <button
          type="button"
          className="icon-button"
          data-guide="Hold"
          aria-label="Hold interpolation"
          disabled={selected.length === 0}
          onClick={() => setInterp('hold')}
        >
          <InterpHoldIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          data-guide="Linear"
          aria-label="Linear interpolation"
          disabled={selected.length === 0}
          onClick={() => setInterp('linear')}
        >
          <InterpLinearIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          data-guide="Eased"
          aria-label="Eased interpolation"
          disabled={selected.length === 0}
          onClick={() => setInterp('eased')}
        >
          <InterpEasedIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          data-guide="Bezier"
          aria-label="Bezier interpolation"
          disabled={selected.length === 0}
          onClick={() => setInterp('bezier')}
        >
          <InterpBezierIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          data-guide="Copy keys"
          aria-label="Copy selected keys"
          onClick={copySelected}
        >
          <CopyIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          data-guide="Paste keys"
          aria-label="Paste keys at playhead"
          onClick={pasteAtPlayhead}
          disabled={graphClipboard === undefined}
        >
          <PasteIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          data-guide="Previous key"
          aria-label="Jump to previous key"
          onClick={() => {
            const times = curve.keyframes.map((k) => k.timeUs).sort((a, b) => a - b);
            const prev = [...times].reverse().find((t) => t < playheadUs);
            if (prev !== undefined) onSeek(prev);
          }}
        >
          <KeyPrevIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          data-guide="Next key"
          aria-label="Jump to next key"
          onClick={() => {
            const times = curve.keyframes.map((k) => k.timeUs).sort((a, b) => a - b);
            const next = times.find((t) => t > playheadUs);
            if (next !== undefined) onSeek(next);
          }}
        >
          <KeyNextIcon />
        </button>
      </div>
      <div className="motion-graph-scale">
        <span>{metrics.max.toFixed(2)}</span>
        <span>{metrics.min.toFixed(2)}</span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${LANE_WIDTH} ${GRAPH_HEIGHT}`}
        width={LANE_WIDTH}
        height={GRAPH_HEIGHT}
        role="img"
        aria-label={`${channel} editable value graph`}
        onPointerMove={onSvgPointerMove}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerLeave={() => {
          dragRef.current = null;
        }}
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
        {curve.keyframes.map((keyframe, index) => {
          const cx = x(keyframe.timeUs);
          const cy = y(keyframe.value);
          const active = selected.includes(index);
          const bezier = keyframe.bezier;
          return (
            <g key={`${keyframe.timeUs}-${index}`}>
              {keyframe.interpolation === 'bezier' && bezier !== undefined && (
                <>
                  <line
                    x1={cx}
                    y1={cy}
                    x2={bezier.x2 * LANE_WIDTH}
                    y2={(1 - bezier.y2) * GRAPH_HEIGHT}
                    stroke="#9ad0ff"
                    strokeWidth={1}
                  />
                  <circle
                    cx={bezier.x2 * LANE_WIDTH}
                    cy={(1 - bezier.y2) * GRAPH_HEIGHT}
                    r={3}
                    fill="#9ad0ff"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      (event.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(
                        event.pointerId,
                      );
                      dragRef.current = { kind: 'handle', index, which: 'out', originX: 0, originY: 0 };
                    }}
                  />
                </>
              )}
              <rect
                x={cx - 4}
                y={cy - 4}
                width={8}
                height={8}
                transform={`rotate(45 ${cx} ${cy})`}
                fill={active ? '#e9b949' : '#cfcfd2'}
                stroke="#1a1a1c"
                strokeWidth={1}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  (event.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(
                    event.pointerId,
                  );
                  setSelected((prev) =>
                    event.shiftKey
                      ? prev.includes(index)
                        ? prev.filter((i) => i !== index)
                        : [...prev, index]
                      : [index],
                  );
                  onSeek(keyframe.timeUs);
                  dragRef.current = {
                    kind: 'key',
                    index,
                    originX: event.clientX,
                    originY: event.clientY,
                    start: keyframe,
                  };
                }}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

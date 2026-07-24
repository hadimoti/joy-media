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
import type { SetSpatialPathCommand } from '@joy-media/motion-core';
import { FIRST_PARTY_SCENES, type FirstPartySceneId } from '@joy-media/html-scene-runtime/first-party';
import { CheckIcon, CloseIcon, PlusIcon, SaveIcon } from './icons.js';
import { GraphEditor } from './GraphEditor.js';

interface MotionPanelProps {
  readonly object: VisualObjectV1 | undefined;
  readonly allObjects: Readonly<Record<string, VisualObjectV1>>;
  readonly compositionDurationUs: number;
  readonly playheadUs: number;
  readonly onSeek: (timeUs: number) => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}

const LANE_WIDTH = 280;
const PRESET_DURATION_US = 1_000_000;

const IDENTITY_TRANSFORM = {
  x: 0,
  y: 120,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  opacity: 1,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
} as const;

function animatedChannels(object: VisualObjectV1): readonly AnimatablePropertyV1[] {
  const animations = object.animations;
  if (animations === undefined) return [];
  return ANIMATABLE_PROPERTIES.filter((key) => animations[key] !== undefined);
}

function HtmlScenesSection({
  allObjects,
  onDispatch,
}: {
  readonly allObjects: Readonly<Record<string, VisualObjectV1>>;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}) {
  const existing = Object.values(allObjects).filter((item) => item.kind === 'html-scene');
  const addScene = (sceneId: FirstPartySceneId) => {
    const id = `scene-${sceneId.split('.').pop()}-${Date.now().toString(36)}`;
    onDispatch({
      label: `Add HTML scene ${sceneId}`,
      commands: [
        {
          type: 'htmlScene.create',
          payload: {
            object: {
              id,
              kind: 'html-scene',
              scenePackageId: sceneId,
              transform: {
                ...IDENTITY_TRANSFORM,
                x: existing.length * 80,
              },
            },
          },
        },
      ],
    });
  };
  return (
    <section className="html-scenes-section">
      <h3>HTML scenes</h3>
      <p className="empty-hint">
        First-party P04 packages. Instances preview as labeled layers in Monitor/export until iframe
        capture is wired.
      </p>
      <div className="html-scene-actions">
        {FIRST_PARTY_SCENES.map((scene) => (
          <button
            key={scene.id}
            type="button"
            className="icon-button"
            data-guide={scene.name}
            aria-label={`Add HTML scene ${scene.name}`}
            onClick={() => addScene(scene.id)}
          >
            <PlusIcon />
          </button>
        ))}
      </div>
      {existing.length > 0 && (
        <ul className="html-scene-list">
          {existing.map((scene) => (
            <li key={scene.id} dir="ltr">
              <span>{scene.scenePackageId}</span>
              <button
                type="button"
                className="icon-button"
                title={`Remove ${scene.id}`}
                aria-label={`Remove HTML scene ${scene.id}`}
                onClick={() =>
                  onDispatch({
                    label: `Remove HTML scene ${scene.id}`,
                    commands: [{ type: 'htmlScene.remove', payload: { objectId: scene.id } }],
                  })
                }
              >
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
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

  if (object === undefined) {
    return (
      <article className="motion-panel">
        <HtmlScenesSection allObjects={allObjects} onDispatch={onDispatch} />
        <p className="empty-hint">Select a visual clip to edit its motion.</p>
      </article>
    );
  }
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

  const saveSpatialPath = () => {
    const xCurve = object.animations?.x;
    const yCurve = object.animations?.y;
    if (xCurve === undefined || yCurve === undefined) return;
    const samples = 48;
    const keyframes = [];
    for (let i = 0; i <= samples; i += 1) {
      const timeUs = Math.round((duration * i) / samples);
      const point = { x: sampleCurve(xCurve, timeUs), y: sampleCurve(yCurve, timeUs) };
      keyframes.push({ timeUs, point, interpolation: 'linear' as const });
    }
    const command: SetSpatialPathCommand = {
      type: 'object.setSpatialPath',
      payload: { objectId: object.id, spatialPath: { keyframes } },
    };
    onDispatch({ label: 'Save spatial path', commands: [command] });
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
        <div className="field-action">
          <span className="field-action-label" aria-hidden>
            &nbsp;
          </span>
          <div className="field-action-row">
            <button
              type="button"
              className="icon-button"
              data-guide="Apply preset"
              aria-label="Apply motion preset"
              onClick={applyPreset}
            >
              <CheckIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              data-guide="Save spatial path"
              aria-label="Save spatial path"
              onClick={saveSpatialPath}
            >
              <SaveIcon />
            </button>
          </div>
        </div>
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
        <GraphEditor
          object={object}
          channel={activeGraph}
          duration={duration}
          playheadUs={playheadUs}
          onSeek={onSeek}
          onDispatch={onDispatch}
        />
      )}

      {object !== undefined && (
        <SpatialPathPreview object={object} duration={duration} playheadUs={playheadUs} />
      )}
    </article>
  );
}

function SpatialPathPreview({
  object,
  duration,
  playheadUs,
}: {
  readonly object: VisualObjectV1;
  readonly duration: number;
  readonly playheadUs: number;
}) {
  const xCurve = object.animations?.x;
  const yCurve = object.animations?.y;
  if (xCurve === undefined || yCurve === undefined) {
    return (
      <section className="motion-spatial">
        <h3>Spatial path</h3>
        <p className="empty-hint">Animate both X and Y to preview the 2D motion path.</p>
      </section>
    );
  }
  const samples = 48;
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = (duration * i) / samples;
    points.push({ x: sampleCurve(xCurve, t), y: sampleCurve(yCurve, t) });
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const w = 280;
  const h = 100;
  const px = (v: number) => ((v - minX) / spanX) * (w - 16) + 8;
  const py = (v: number) => h - 8 - ((v - minY) / spanY) * (h - 16);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
  const now = { x: sampleCurve(xCurve, playheadUs), y: sampleCurve(yCurve, playheadUs) };
  return (
    <section className="motion-spatial">
      <h3>Spatial path</h3>
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label="XY motion path">
        <path d={d} fill="none" stroke="#7cc4ff" strokeWidth={1.5} />
        <circle cx={px(now.x)} cy={py(now.y)} r={4} fill="#e9b949" />
      </svg>
    </section>
  );
}

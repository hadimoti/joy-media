/**
 * Inspector — labeled property rows (transform + crop + selected-clip audio).
 * CapCut/Figma-style: name beside value, collapse Transform, empty state when idle.
 */

import { useState } from 'react';
import type { AnimatablePropertyV1, VisualObjectV1 } from '@joy-media/project-schema';
import type { AudioCommand, AudioState } from '@joy-media/commands';
import { applyAudioCommand } from '@joy-media/commands';
import type { NumericTransformProperty, VisualObjectTransaction } from '@joy-media/property-system';
import { VISUAL_INSPECTOR } from '@joy-media/property-system';
import {
  hasKeyframeAt,
  removeKeyframe,
  resolveObjectTransformWithExpressions,
  sampleCurve,
  setKeyframe,
  EASED_HANDLES,
} from '@joy-media/motion-core';
import type { KeyframeInterpolationV1 } from '@joy-media/project-schema';
import {
  InterpBezierIcon,
  InterpEasedIcon,
  InterpHoldIcon,
  InterpLinearIcon,
} from './icons.js';

interface InspectorPanelProps {
  readonly object: VisualObjectV1 | undefined;
  readonly selectedClipId?: string;
  readonly allObjects: Readonly<Record<string, VisualObjectV1>>;
  readonly playheadUs: number;
  readonly audioState?: AudioState;
  readonly onAudioChange?: (next: AudioState, label: string) => void;
  readonly onSetStatic: (
    objectId: string,
    key: Exclude<NumericTransformProperty, 'positionZ'>,
    value: number,
  ) => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}

const NUMERIC_PROPERTIES = VISUAL_INSPECTOR.filter((property) => property.kind === 'number');
const DEFAULTS: Record<string, number> = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  opacity: 1,
};

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function InspectorPanel({
  object,
  selectedClipId,
  allObjects,
  playheadUs,
  audioState,
  onAudioChange,
  onSetStatic,
  onDispatch,
}: InspectorPanelProps) {
  const [editingExpression, setEditingExpression] = useState<AnimatablePropertyV1 | undefined>(
    undefined,
  );
  const [draftSource, setDraftSource] = useState('');
  const [commitError, setCommitError] = useState<string | undefined>(undefined);
  const [interpolation, setInterpolation] = useState<KeyframeInterpolationV1>('linear');
  const [transformOpen, setTransformOpen] = useState(true);
  const [audioOpen, setAudioOpen] = useState(true);

  if (object === undefined && selectedClipId === undefined) {
    return (
      <article className="inspector-panel">
        <p className="inspector-empty">Select a clip to edit its properties.</p>
      </article>
    );
  }

  const timeUs = Math.max(0, Math.round(playheadUs));
  const title =
    object !== undefined
      ? object.id
      : selectedClipId !== undefined
        ? selectedClipId
        : 'Selection';

  const clipAudio =
    selectedClipId !== undefined && audioState !== undefined
      ? (audioState.clips[selectedClipId] ?? {
          gain: 1,
          pan: 0,
          mute: false,
          solo: false,
        })
      : undefined;

  const dispatchAudio = (command: AudioCommand, label: string) => {
    if (audioState === undefined || onAudioChange === undefined) return;
    try {
      const { state } = applyAudioCommand(audioState, command);
      onAudioChange(state, label);
    } catch (error) {
      console.warn('audio command rejected', error);
    }
  };

  if (object === undefined) {
    return (
      <article className="inspector-panel">
        <h2 className="inspector-selected-name">{title}</h2>
        {clipAudio !== undefined && selectedClipId !== undefined && (
          <AudioSection
            open={audioOpen}
            onToggle={() => setAudioOpen((v) => !v)}
            clipId={selectedClipId}
            clip={clipAudio}
            dispatch={dispatchAudio}
          />
        )}
        <p className="empty-hint">No linked visual overlay for this clip.</p>
      </article>
    );
  }

  const { transform: resolved, diagnostics } = resolveObjectTransformWithExpressions(
    object.id,
    allObjects,
    timeUs,
  );

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

  const keyframePayload = (value: number) => {
    if (interpolation === 'bezier')
      return {
        timeUs,
        value,
        interpolation,
        bezier: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
      } as const;
    if (interpolation === 'eased')
      return { timeUs, value, interpolation, bezier: EASED_HANDLES } as const;
    return { timeUs, value, interpolation } as const;
  };

  const toggleKeyframe = (property: AnimatablePropertyV1, value: number) => {
    const curve = object.animations?.[property];
    if (curve !== undefined && hasKeyframeAt(curve, timeUs)) {
      replaceChannel(property, removeKeyframe(curve, timeUs));
      return;
    }
    replaceChannel(property, setKeyframe(curve, keyframePayload(value)));
  };

  const commitExpression = (property: AnimatablePropertyV1, source: string) => {
    const trimmed = source.trim();
    try {
      onDispatch({
        label: trimmed === '' ? `Clear ${property} expression` : `Set ${property} expression`,
        commands: [
          {
            type: 'object.setExpression',
            payload:
              trimmed === ''
                ? { objectId: object.id, property }
                : { objectId: object.id, property, source: trimmed },
          },
        ],
      });
      setEditingExpression(undefined);
      setCommitError(undefined);
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <article className="inspector-panel">
      <h2 className="inspector-selected-name">{title}</h2>
      <p className="monitor-meta" dir="ltr">
        Playhead {(timeUs / 1_000_000).toFixed(2)}s
      </p>

      <section className="inspector-section">
        <button
          type="button"
          className="inspector-section-toggle"
          aria-expanded={transformOpen}
          onClick={() => setTransformOpen((v) => !v)}
        >
          <h3>Transform</h3>
        </button>
        {transformOpen && (
          <>
            <div className="preset-icon-group inspector-kf-row" role="group" aria-label="Keyframe interpolation">
              {(
                [
                  ['hold', InterpHoldIcon, 'Hold'],
                  ['linear', InterpLinearIcon, 'Linear'],
                  ['eased', InterpEasedIcon, 'Eased'],
                  ['bezier', InterpBezierIcon, 'Bezier'],
                ] as const
              ).map(([id, Icon, label]) => (
                <button
                  key={id}
                  type="button"
                  className="icon-button"
                  style={{ width: 'var(--control-sm)', height: 'var(--control-sm)', minWidth: 'var(--control-sm)', minHeight: 'var(--control-sm)' }}
                  aria-pressed={interpolation === id}
                  aria-label={label}
                  data-guide={label}
                  onClick={() => setInterpolation(id)}
                >
                  <Icon />
                </button>
              ))}
            </div>
            {NUMERIC_PROPERTIES.map((property) => {
              const key = property.key as Exclude<AnimatablePropertyV1, 'positionZ'>;
              const curve = object.animations?.[key];
              const animated = curve !== undefined;
              const keyed = animated && hasKeyframeAt(curve, timeUs);
              const expressionSource = object.expressions?.[key];
              const hasExpression = expressionSource !== undefined;
              const channelDiagnostic = diagnostics.find((d) => d.property === key);
              const value = hasExpression
                ? resolved[key]
                : animated
                  ? sampleCurve(curve, timeUs)
                  : resolved[key];
              const modified = Math.abs(value - (DEFAULTS[key] ?? 0)) > 0.0005;
              return (
                <div key={key} className={`inspector-prop${modified ? ' modified' : ''}`}>
                  <label htmlFor={`insp-${key}`}>{property.label}</label>
                  <div className="inspector-prop-row">
                    <button
                      type="button"
                      className={keyed ? 'kf kf-active' : animated ? 'kf kf-on' : 'kf'}
                      aria-label={`${keyed ? 'Remove' : 'Add'} ${property.label} keyframe`}
                      aria-pressed={keyed}
                      disabled={hasExpression}
                      title={keyed ? 'Remove keyframe (playhead)' : 'Add keyframe'}
                      onClick={() => toggleKeyframe(key, value)}
                    >
                      {keyed ? '◆' : animated ? '◇' : '○'}
                    </button>
                    <input
                      id={`insp-${key}`}
                      type="number"
                      min={property.min}
                      max={property.max}
                      step={key === 'opacity' ? 0.01 : 1}
                      value={round(value)}
                      disabled={hasExpression}
                      onChange={(event) => {
                        const next = event.currentTarget.valueAsNumber;
                        if (!Number.isFinite(next)) return;
                        if (animated) replaceChannel(key, setKeyframe(curve, keyframePayload(next)));
                        else onSetStatic(object.id, key, next);
                      }}
                    />
                    {key === 'opacity' && <span className="monitor-meta">{formatPercent(value)}</span>}
                    <button
                      type="button"
                      className={hasExpression ? 'fx fx-on' : 'fx'}
                      aria-label={`${hasExpression ? 'Edit' : 'Add'} ${property.label} expression`}
                      title="Expression"
                      onClick={() => {
                        setDraftSource(object.expressions?.[key] ?? '');
                        setCommitError(undefined);
                        setEditingExpression(editingExpression === key ? undefined : key);
                      }}
                    >
                      ƒx
                    </button>
                  </div>
                  {editingExpression === key && (
                    <div className="inspector-expression-editor" style={{ gridColumn: '1 / -1' }}>
                      <input
                        type="text"
                        className="inspector-expression-input"
                        value={draftSource}
                        autoFocus
                        placeholder="e.g. sin(time) * 10"
                        onChange={(event) => setDraftSource(event.currentTarget.value)}
                        onBlur={() => commitExpression(key, draftSource)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitExpression(key, draftSource);
                          if (event.key === 'Escape') {
                            setEditingExpression(undefined);
                            setCommitError(undefined);
                          }
                        }}
                      />
                      {commitError !== undefined && (
                        <p className="inspector-expression-error">{commitError}</p>
                      )}
                    </div>
                  )}
                  {channelDiagnostic !== undefined && (
                    <p className="inspector-expression-error" style={{ gridColumn: '1 / -1' }}>
                      {channelDiagnostic.message}
                    </p>
                  )}
                </div>
              );
            })}
          </>
        )}
      </section>

      {object.kind === 'image' && (
        <section className="inspector-section" aria-label="Crop">
          <h3>Crop</h3>
          {(['left', 'top', 'right', 'bottom'] as const).map((edge) => (
            <div key={edge} className="inspector-prop">
              <label htmlFor={`crop-${edge}`}>{edge}</label>
              <input
                id={`crop-${edge}`}
                type="number"
                min={0}
                max={0.49}
                step={0.01}
                value={round(object.transform.crop[edge])}
                onChange={(event) => {
                  const next = event.currentTarget.valueAsNumber;
                  if (!Number.isFinite(next)) return;
                  onDispatch({
                    label: `Crop ${edge}`,
                    commands: [
                      {
                        type: 'object.setCrop',
                        payload: {
                          objectId: object.id,
                          crop: {
                            ...object.transform.crop,
                            [edge]: Math.min(0.49, Math.max(0, next)),
                          },
                        },
                      },
                    ],
                  });
                }}
              />
            </div>
          ))}
        </section>
      )}

      {clipAudio !== undefined && selectedClipId !== undefined && (
        <AudioSection
          open={audioOpen}
          onToggle={() => setAudioOpen((v) => !v)}
          clipId={selectedClipId}
          clip={clipAudio}
          dispatch={dispatchAudio}
        />
      )}
    </article>
  );
}

function AudioSection({
  open,
  onToggle,
  clipId,
  clip,
  dispatch,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly clipId: string;
  readonly clip: {
    readonly gain: number;
    readonly pan: number;
    readonly mute: boolean;
    readonly solo: boolean;
    readonly fadeInUs?: number;
    readonly fadeOutUs?: number;
  };
  readonly dispatch: (command: AudioCommand, label: string) => void;
}) {
  return (
    <section className="inspector-section">
      <button type="button" className="inspector-section-toggle" aria-expanded={open} onClick={onToggle}>
        <h3>Audio</h3>
      </button>
      {open && (
        <>
          <div className="inspector-prop">
            <label htmlFor="insp-gain">Volume</label>
            <input
              id="insp-gain"
              type="number"
              min={0}
              max={2}
              step={0.01}
              value={round(clip.gain)}
              onChange={(event) =>
                dispatch(
                  {
                    type: 'audioClip.setGain',
                    payload: { clipId, gain: event.currentTarget.valueAsNumber },
                  },
                  `Gain ${clipId}`,
                )
              }
            />
          </div>
          <div className="inspector-prop">
            <label htmlFor="insp-pan">Pan</label>
            <input
              id="insp-pan"
              type="number"
              min={-1}
              max={1}
              step={0.01}
              value={round(clip.pan)}
              onChange={(event) =>
                dispatch(
                  {
                    type: 'audioClip.setPan',
                    payload: { clipId, pan: event.currentTarget.valueAsNumber },
                  },
                  `Pan ${clipId}`,
                )
              }
            />
          </div>
          <div className="inspector-prop">
            <label>Mute</label>
            <button
              type="button"
              className="icon-button icon-button-labeled"
              aria-pressed={clip.mute}
              onClick={() =>
                dispatch(
                  { type: 'audioClip.setMute', payload: { clipId, mute: !clip.mute } },
                  `Mute ${clipId}`,
                )
              }
            >
              {clip.mute ? 'Muted' : 'On'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

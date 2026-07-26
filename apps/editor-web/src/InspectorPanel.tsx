/**
 * Inspector — labeled property rows (transform + crop + selected-clip audio).
 *
 * DESIGN.md §3c: this panel is always mounted. With nothing selected it binds
 * its rows to IDLE_OBJECT and renders them disabled, so the user can see every
 * property the Inspector offers instead of a bare "Select a clip" sentence.
 */

import { useState } from 'react';
import type {
  AnimatablePropertyV1,
  EffectInstanceV1,
  VisualObjectV1,
} from '@joy-media/project-schema';
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
  TrashIcon,
  KeyframeNoneIcon,
  KeyframeActiveIcon,
  KeyframeBetweenIcon,
} from './icons.js';
import { effectRegistry, type EffectDescriptor } from '@joy-media/visual-effects';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';

const TABS: readonly PanelTabSpec[] = [
  { id: 'transform', label: 'Transform' },
  { id: 'effects', label: 'Effects' },
  { id: 'audio', label: 'Audio' },
];

/**
 * Stand-in the rows bind to when nothing is selected (§3c). Values are the
 * schema defaults, so the disabled panel shows a truthful neutral transform
 * rather than stale numbers from a previous selection.
 */
const IDLE_OBJECT: VisualObjectV1 = {
  id: '',
  kind: 'null',
  transform: {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  },
};

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
  const [effectsOpen, setEffectsOpen] = useState(true);
  const [audioOpen, setAudioOpen] = useState(true);
  const [tab, setTab] = useState('transform');

  // §3c — no early returns. `target` is the real selection or a neutral
  // stand-in; `idle` drives the disabled state, not the presence of markup.
  const target = object ?? IDLE_OBJECT;
  const idle = object === undefined;

  const timeUs = Math.max(0, Math.round(playheadUs));
  const title =
    object !== undefined
      ? target.id
      : selectedClipId !== undefined
        ? selectedClipId
        : 'Nothing selected';

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

  // A clip can be selected without a linked visual overlay; the transform rows
  // then have nothing to drive, so they read as idle too.
  const noOverlay = object === undefined && selectedClipId !== undefined;

  const { transform: resolved, diagnostics } = idle
    ? {
        transform: target.transform,
        diagnostics: [] as ReturnType<typeof resolveObjectTransformWithExpressions>['diagnostics'],
      }
    : resolveObjectTransformWithExpressions(target.id, allObjects, timeUs);

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
              ? { objectId: target.id, property }
              : { objectId: target.id, property, curve },
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
    const curve = target.animations?.[property];
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
                ? { objectId: target.id, property }
                : { objectId: target.id, property, source: trimmed },
          },
        ],
      });
      setEditingExpression(undefined);
      setCommitError(undefined);
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : String(error));
    }
  };

  const note = idle
    ? noOverlay
      ? 'این کلیپ لایهٔ تصویری پیوندخورده‌ای ندارد.'
      : 'برای ویرایش ویژگی‌ها، یک کلیپ را انتخاب کنید.'
    : undefined;

  return (
    <PanelShell
      title="Inspector"
      iconUrl={panelTabIconUrl('inspector')}
      className="inspector-panel"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      inactive={idle}
      {...(note !== undefined ? { note } : {})}
    >
      <h2 className="inspector-selected-name" dir="ltr">
        {title}
      </h2>
      <p className="monitor-meta" dir="ltr">
        Playhead {(timeUs / 1_000_000).toFixed(2)}s
      </p>

      {tab === 'transform' && (
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
              <div
                className="preset-icon-group inspector-kf-row"
                role="group"
                aria-label="Keyframe interpolation"
              >
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
                    style={{
                      width: 'var(--control-sm)',
                      height: 'var(--control-sm)',
                      minWidth: 'var(--control-sm)',
                      minHeight: 'var(--control-sm)',
                    }}
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
                const curve = target.animations?.[key];
                const animated = curve !== undefined;
                const keyed = animated && hasKeyframeAt(curve, timeUs);
                const expressionSource = target.expressions?.[key];
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
                        disabled={idle || hasExpression}
                        title={keyed ? 'Remove keyframe (playhead)' : 'Add keyframe'}
                        onClick={() => toggleKeyframe(key, value)}
                      >
                        {keyed ? (
                          <KeyframeActiveIcon />
                        ) : animated ? (
                          <KeyframeBetweenIcon />
                        ) : (
                          <KeyframeNoneIcon />
                        )}
                      </button>
                      <input
                        id={`insp-${key}`}
                        type="number"
                        min={property.min}
                        max={property.max}
                        step={key === 'opacity' ? 0.01 : 1}
                        value={round(value)}
                        disabled={idle || hasExpression}
                        onChange={(event) => {
                          const next = event.currentTarget.valueAsNumber;
                          if (!Number.isFinite(next)) return;
                          if (animated)
                            replaceChannel(key, setKeyframe(curve, keyframePayload(next)));
                          else onSetStatic(target.id, key, next);
                        }}
                      />
                      {key === 'opacity' && (
                        <span className="monitor-meta">{formatPercent(value)}</span>
                      )}
                      <button
                        type="button"
                        className={hasExpression ? 'fx fx-on' : 'fx'}
                        disabled={idle}
                        aria-label={`${hasExpression ? 'Edit' : 'Add'} ${property.label} expression`}
                        title="Expression"
                        onClick={() => {
                          setDraftSource(target.expressions?.[key] ?? '');
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
      )}

      {tab === 'transform' && target.kind === 'image' && (
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
                value={round(target.transform.crop[edge])}
                disabled={idle}
                onChange={(event) => {
                  const next = event.currentTarget.valueAsNumber;
                  if (!Number.isFinite(next)) return;
                  onDispatch({
                    label: `Crop ${edge}`,
                    commands: [
                      {
                        type: 'object.setCrop',
                        payload: {
                          objectId: target.id,
                          crop: {
                            ...target.transform.crop,
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

      {tab === 'effects' && (
        <EffectsSection
          object={target}
          open={effectsOpen}
          onToggle={() => setEffectsOpen((v) => !v)}
          onDispatch={onDispatch}
        />
      )}

      {tab === 'audio' &&
        (clipAudio !== undefined && selectedClipId !== undefined ? (
          <AudioSection
            open={audioOpen}
            onToggle={() => setAudioOpen((v) => !v)}
            clipId={selectedClipId}
            clip={clipAudio}
            dispatch={dispatchAudio}
          />
        ) : (
          <p className="empty-hint" lang="fa">
            برای میکس صدای کلیپ، ابتدا آن را انتخاب کنید.
          </p>
        ))}
    </PanelShell>
  );
}

function EffectsSection({
  object,
  open,
  onToggle,
  onDispatch,
}: {
  readonly object: VisualObjectV1;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}) {
  const effects = object.effects ?? [];

  if (effects.length === 0) return null;

  return (
    <section className="inspector-section">
      <button
        type="button"
        className="inspector-section-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <h3>Effects</h3>
      </button>
      {open && (
        <ul className="inspector-effects-list">
          {effects.map((effect) => {
            const descriptor = effectRegistry.getEffect(effect.effectId);
            const label = descriptor?.label ?? effect.effectId;
            return (
              <li key={effect.id} className="inspector-effect-item">
                <div className="inspector-effect-header">
                  <button
                    type="button"
                    className="icon-button inspector-effect-drag"
                    aria-label={`Reorder ${label}`}
                    title="Drag to reorder"
                    data-drag-handle
                  >
                    ⠿
                  </button>
                  <span className="inspector-effect-label" title={effect.effectId}>
                    {label}
                  </span>
                  <div className="inspector-effect-actions">
                    <button
                      type="button"
                      className="icon-button icon-button-labeled"
                      aria-pressed={effect.enabled}
                      onClick={() => {
                        onDispatch({
                          label: `${effect.enabled ? 'Disable' : 'Enable'} ${label}`,
                          commands: [
                            {
                              type: 'effect.toggle',
                              payload: {
                                objectId: object.id,
                                effectInstanceId: effect.id,
                                enabled: !effect.enabled,
                              },
                            },
                          ],
                        });
                      }}
                    >
                      {effect.enabled ? 'On' : 'Off'}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove ${label}`}
                      title="Remove"
                      onClick={() => {
                        onDispatch({
                          label: `Remove ${label}`,
                          commands: [
                            {
                              type: 'effect.remove',
                              payload: {
                                objectId: object.id,
                                effectInstanceId: effect.id,
                              },
                            },
                          ],
                        });
                      }}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>
                {descriptor && (
                  <div className="inspector-effect-params">
                    {descriptor.params.map((param) => (
                      <EffectParamControl
                        key={param.key}
                        descriptor={descriptor}
                        param={param}
                        value={effect.params[param.key] ?? param.defaultValue}
                        effectInstanceId={effect.id}
                        objectId={object.id}
                        onDispatch={onDispatch}
                      />
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function EffectParamControl({
  descriptor,
  param,
  value,
  effectInstanceId,
  objectId,
  onDispatch,
}: {
  readonly descriptor: EffectDescriptor;
  readonly param: EffectDescriptor['params'][number];
  readonly value: unknown;
  readonly effectInstanceId: string;
  readonly objectId: string;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}) {
  const label = descriptor.id;
  const setValue = (next: unknown) => {
    onDispatch({
      label: `Set ${param.label} on ${label}`,
      commands: [
        {
          type: 'effect.setParam',
          payload: {
            objectId,
            effectInstanceId,
            paramKey: param.key,
            value: next as never,
          },
        },
      ],
    });
  };

  if (param.type === 'number' || param.type === 'vector2') {
    const numValue = typeof value === 'number' ? value : (param.defaultValue as number);
    return (
      <div className="inspector-prop">
        <label>{param.label}</label>
        <div className="inspector-prop-row">
          <input
            type="range"
            min={param.min ?? -1}
            max={param.max ?? 1}
            step={param.step ?? 0.01}
            value={numValue}
            aria-label={`${param.label}`}
            title={`${numValue.toFixed(2)}${param.unit ?? ''}`}
            onChange={(e) => setValue(e.currentTarget.valueAsNumber)}
          />
          <span className="value">
            {numValue.toFixed(2)}
            {param.unit}
          </span>
        </div>
      </div>
    );
  }

  if (param.type === 'boolean') {
    const boolValue = typeof value === 'boolean' ? value : (param.defaultValue as boolean);
    return (
      <div className="inspector-prop">
        <label>{param.label}</label>
        <button
          type="button"
          className="icon-button icon-button-labeled"
          aria-pressed={boolValue}
          onClick={() => setValue(!boolValue)}
        >
          {boolValue ? 'On' : 'Off'}
        </button>
      </div>
    );
  }

  if (param.type === 'enum' && param.options) {
    const strValue = typeof value === 'string' ? value : String(param.defaultValue);
    return (
      <div className="inspector-prop">
        <label>{param.label}</label>
        <select value={strValue} onChange={(e) => setValue(e.currentTarget.value)}>
          {param.options.map((opt) => (
            <option key={String(opt.value)} value={String(opt.value)}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (param.type === 'color') {
    const strValue = typeof value === 'string' ? value : (param.defaultValue as string);
    return (
      <div className="inspector-prop">
        <label>{param.label}</label>
        <div className="inspector-prop-row">
          <input
            type="color"
            value={strValue}
            onChange={(e) => setValue(e.currentTarget.value)}
            aria-label={param.label}
          />
          <span className="value">{strValue}</span>
        </div>
      </div>
    );
  }

  return null;
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
      <button
        type="button"
        className="inspector-section-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
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

/**
 * Inspector — labeled property rows (transform + crop + selected-clip audio).
 *
 * DESIGN.md §3c: this panel is always mounted. With nothing selected it binds
 * its rows to IDLE_OBJECT and renders them disabled, so the user can see every
 * property the Inspector offers instead of a bare "Select a clip" sentence.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  audioClipPropertyBinding,
  canonicalBindingKey,
  type AnimatablePropertyV1,
  type JoyProjectV1,
  type PropertyBindingV2,
  type TimeRemapV2,
  type VisualObjectV1,
} from '@joy-media/project-schema';
import type { AudioCommand, AudioState } from '@joy-media/commands';
import { applyAudioCommand } from '@joy-media/commands';
import type { NumericTransformProperty, VisualObjectTransaction } from '@joy-media/property-system';
import { VISUAL_INSPECTOR } from '@joy-media/property-system';
import {
  hasKeyframeAtCurve,
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
  SlidersIcon,
  TrashIcon,
} from './icons.js';
import { effectRegistry, type EffectDescriptor } from '@joy-media/visual-effects';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import { AgentPreviewBadge } from './AgentPreviewBadge.js';
import { effectReorderTransaction } from './effect-reorder.js';
import { PropertyRow } from './components/PropertyRow.js';
import {
  NumericPropertyControl,
  SliderPropertyControl,
  useTransientPropertyControl,
} from './components/PropertyControlAdapters.js';
import { audioKeyframeState, audioKeyframeTransaction } from './audio-keyframes.js';
import type { BrowserJob } from './control-plane-client.js';
import { MaskInspector } from './MaskInspector.js';
import { readMaskSettings, type MaskSettings, type MaskTarget } from './masking.js';
import { EnhanceInspector } from './EnhanceInspector.js';
import { readUpscaleSettings, type UpscaleSettings, type UpscaleTarget } from './upscaling.js';

const TABS: readonly PanelTabSpec[] = [
  { id: 'visual', label: 'Visual', ariaLabel: 'Visual (Transform)' },
  { id: 'enhance', label: 'Enhance', ariaLabel: 'AI upscaling' },
  { id: 'mask', label: 'Mask', ariaLabel: 'Mask and background removal' },
  { id: 'adjust', label: 'Adjust', ariaLabel: 'Adjustment layer' },
  { id: 'effects', label: 'Effects' },
  { id: 'audio', label: 'Audio' },
  { id: 'speed', label: 'Speed' },
];

/**
 * The curve is intentionally a compact UI contract. The timeline/controller
 * owns how a supported clip stores or renders the ramp; keeping that concern
 * out of the Inspector lets audio, still, and video selections share the
 * same panel without pretending every format supports ramps.
 */
export type SpeedRampPreset = 'ease-in' | 'ease-out' | 'ease-in-out';

/** The playback capabilities and current value of the selected timeline clip. */
export interface InspectorClipSpeed {
  /** A signed multiplier. Negative values represent reverse playback. */
  readonly rate: number;
  /** Reverse is exposed only when the timeline/media pipeline supports it. */
  readonly supportsReverse?: boolean | undefined;
  /** Ramps are exposed only when the timeline/media pipeline supports them. */
  readonly supportsRamps?: boolean | undefined;
  /** Omit to use a constant rate. */
  readonly ramp?: SpeedRampPreset | undefined;
  readonly timeRemap?: TimeRemapV2 | undefined;
  readonly durationUs?: number | undefined;
  readonly sourceInUs?: number | undefined;
}

/** A small, controller-facing change request emitted by the Speed tab. */
export interface InspectorSpeedChange {
  /** When set, replace the selected clip's constant playback multiplier. */
  readonly rate?: number | undefined;
  /** Apply the selected source-continuous three-segment ramp. */
  readonly ramp?: SpeedRampPreset | undefined;
  readonly timeRemap?: TimeRemapV2 | undefined;
}

export interface InspectorAdjustmentTarget {
  readonly clipId: string;
  readonly label: string;
  readonly kind: 'video' | 'picture';
}

export interface InspectorAdjustmentLayer {
  readonly targetClipId?: string;
  readonly targets: readonly InspectorAdjustmentTarget[];
}

export const SPEED_RATE_PRESETS = [0.25, 0.5, 1, 1.25, 1.5, 2] as const;
export const MIN_INSPECTOR_SPEED_RATE = 0.1;
export const MAX_INSPECTOR_SPEED_RATE = 8;

/**
 * Reject invalid manual input before it reaches the timeline controller.
 * Freeze frames remain a separate timeline operation: zero is never a speed
 * value, which avoids silently turning a typed rate into a different edit.
 */
export function validInspectorSpeedRate(
  value: number,
  supportsReverse = false,
): number | undefined {
  if (!Number.isFinite(value) || Math.abs(value) < MIN_INSPECTOR_SPEED_RATE) return undefined;
  if (Math.abs(value) > MAX_INSPECTOR_SPEED_RATE) return undefined;
  if (!supportsReverse && value < 0) return undefined;
  return value;
}

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
  /** Human-readable selection metadata supplied by the timeline controller. */
  readonly selectedKind?: string | undefined;
  readonly selectedName?: string | undefined;
  readonly selectedTrackName?: string | undefined;
  readonly selectedSourceDurationUs?: number | undefined;
  readonly selectedTimelineDurationUs?: number | undefined;
  /** Present only for a selected clip whose controller can change speed. */
  readonly clipSpeed?: InspectorClipSpeed | undefined;
  /** Optional so Inspector remains usable in non-timeline surfaces. */
  readonly onSpeedChange?: ((change: InspectorSpeedChange, label: string) => void) | undefined;
  readonly allObjects: Readonly<Record<string, VisualObjectV1>>;
  readonly playheadUs: number;
  /** Shared durable map for audio keyframes; omitted in read-only embeddings. */
  readonly project?: JoyProjectV1;
  readonly maskTarget?: MaskTarget;
  readonly maskProjectId?: string;
  readonly maskProjectTitle?: string;
  readonly onMaskSettingsChange?: (next: MaskSettings) => void;
  readonly onApplyMaskResult?: (job: BrowserJob, settings: MaskSettings) => Promise<string>;
  readonly onClearMask?: () => void;
  readonly upscaleTarget?: UpscaleTarget;
  readonly upscaleProjectId?: string;
  readonly upscaleProjectTitle?: string;
  readonly onUpscaleSettingsChange?: (next: UpscaleSettings) => void;
  readonly onApplyUpscaleResult?: (job: BrowserJob, settings: UpscaleSettings) => Promise<string>;
  readonly audioState?: AudioState;
  readonly onAudioChange?: (next: AudioState, label: string) => void;
  readonly onSetStatic: (
    objectId: string,
    key: Exclude<NumericTransformProperty, 'positionZ'>,
    value: number,
  ) => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
  /** Present when the selected controller is a targeted Adjust layer. */
  readonly adjustmentLayer?: InspectorAdjustmentLayer;
  readonly onAdjustmentTargetChange?: (targetClipId: string) => void;
  /** Creates a separate timeline Adjust layer above the selected media. */
  readonly onCreateAdjustmentLayer?: () => void;
  /** Opens a durable animated transform in the shared Motion graph view. */
  readonly onOpenAnimationGraph?:
    ((objectId: string, channel: AnimatablePropertyV1) => void) | undefined;
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

function formatDuration(durationUs: number | undefined): string {
  if (durationUs === undefined || !Number.isFinite(durationUs) || durationUs < 0) return '—';
  const seconds = durationUs / 1_000_000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
}

interface TransformPropertyRowProps {
  readonly property: {
    readonly key: Exclude<AnimatablePropertyV1, 'positionZ'>;
    readonly label: string;
    readonly min?: number | undefined;
    readonly max?: number | undefined;
  };
  readonly target: VisualObjectV1;
  readonly resolvedValue: number;
  readonly timeUs: number;
  readonly idle: boolean;
  readonly hasExpression: boolean;
  readonly diagnostic?: string | undefined;
  readonly onSetStatic: InspectorPanelProps['onSetStatic'];
  readonly onReplaceChannel: (
    property: AnimatablePropertyV1,
    curve: ReturnType<typeof setKeyframe> | undefined,
  ) => void;
  readonly onKeyframePayload: (value: number) => Parameters<typeof setKeyframe>[1];
  readonly onToggleKeyframe: (property: AnimatablePropertyV1, value: number) => void;
  readonly expressionButton: ReactNode;
  readonly onOpenAnimationGraph?:
    ((objectId: string, channel: AnimatablePropertyV1) => void) | undefined;
  readonly children?: ReactNode;
}

/**
 * The first consumer of the universal property shell. Preview stays in this
 * row until the gesture completes, then exactly one legacy-compatible visual
 * object transaction is dispatched. WP34-17 supplies monitor/render preview.
 */
function TransformPropertyRow({
  property,
  target,
  resolvedValue,
  timeUs,
  idle,
  hasExpression,
  diagnostic,
  onSetStatic,
  onReplaceChannel,
  onKeyframePayload,
  onToggleKeyframe,
  expressionButton,
  onOpenAnimationGraph,
  children,
}: TransformPropertyRowProps) {
  const curve = target.animations?.[property.key];
  const animated = curve !== undefined;
  const keyed = animated && hasKeyframeAtCurve(curve, timeUs);
  const sourceValue = hasExpression
    ? resolvedValue
    : animated
      ? sampleCurve(curve, timeUs)
      : resolvedValue;
  const [previewValue, setPreviewValue] = useState(sourceValue);

  useEffect(() => {
    setPreviewValue(sourceValue);
  }, [sourceValue]);

  const commitValue = (next: number) => {
    if (animated) onReplaceChannel(property.key, setKeyframe(curve, onKeyframePayload(next)));
    else onSetStatic(target.id, property.key, next);
  };
  const adapter = useTransientPropertyControl(
    {
      read: () => previewValue,
      preview: setPreviewValue,
      restore: setPreviewValue,
      commit: ({ next }) => commitValue(next),
    },
    `Set ${property.label}`,
  );
  const disabled = idle || hasExpression;
  const modified = Math.abs(previewValue - (DEFAULTS[property.key] ?? 0)) > 0.0005;

  return (
    <div className={`inspector-transform-property${modified ? ' modified' : ''}`}>
      <PropertyRow
        label={property.label}
        controlId={`insp-${property.key}`}
        value={property.key === 'opacity' ? formatPercent(previewValue) : round(previewValue)}
        disabled={disabled}
        error={diagnostic}
        onReset={() => commitValue(DEFAULTS[property.key] ?? 0)}
        onToggleAnimation={() => onToggleKeyframe(property.key, previewValue)}
        animationState={keyed ? 'keyed' : animated ? 'between' : 'none'}
        {...(animated && onOpenAnimationGraph !== undefined
          ? { onOpenGraph: () => onOpenAnimationGraph(target.id, property.key) }
          : {})}
      >
        <div className="inspector-prop-row">
          <NumericPropertyControl
            id={`insp-${property.key}`}
            value={round(previewValue)}
            adapter={adapter}
            ariaLabel={property.label}
            min={property.min}
            max={property.max}
            step={property.key === 'opacity' ? 0.01 : 1}
            disabled={disabled}
          />
          {expressionButton}
        </div>
      </PropertyRow>
      {children}
    </div>
  );
}

export function InspectorPanel({
  object,
  selectedClipId,
  selectedKind,
  selectedName,
  selectedTrackName,
  selectedSourceDurationUs,
  selectedTimelineDurationUs,
  clipSpeed,
  onSpeedChange,
  allObjects,
  playheadUs,
  project,
  maskTarget,
  maskProjectId,
  maskProjectTitle,
  onMaskSettingsChange,
  onApplyMaskResult,
  onClearMask,
  upscaleTarget,
  upscaleProjectId,
  upscaleProjectTitle,
  onUpscaleSettingsChange,
  onApplyUpscaleResult,
  audioState,
  onAudioChange,
  onSetStatic,
  onDispatch,
  adjustmentLayer,
  onAdjustmentTargetChange,
  onCreateAdjustmentLayer,
  onOpenAnimationGraph,
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
  const [speedOpen, setSpeedOpen] = useState(true);
  const [tab, setTab] = useState(adjustmentLayer === undefined ? 'visual' : 'adjust');

  // §3c — no early returns. `target` is the real selection or a neutral
  // stand-in; `idle` drives the disabled state, not the presence of markup.
  const target = object ?? IDLE_OBJECT;
  const idle = object === undefined;
  // A timeline controller may supply speed for a selected video before it has
  // a visual-object counterpart. Transform remains disabled through `idle`.
  const inspectorInactive = idle && clipSpeed === undefined;
  const isAdjustmentLayer = adjustmentLayer !== undefined;

  const timeUs = Math.max(0, Math.round(playheadUs));
  const title =
    selectedName ??
    (object !== undefined
      ? target.id
      : selectedClipId !== undefined
        ? selectedClipId
        : 'Nothing selected');

  const clipAudio =
    selectedClipId !== undefined && audioState !== undefined
      ? (audioState.clips[selectedClipId] ?? {
          gain: 1,
          pan: 0,
          mute: false,
          solo: false,
        })
      : undefined;

  const visibleTabs = TABS.filter((candidate) => {
    if (isAdjustmentLayer) return candidate.id === 'adjust' || candidate.id === 'effects';
    if (candidate.id === 'adjust') return false;
    return (
      (candidate.id !== 'mask' ||
        (maskTarget !== undefined &&
          project !== undefined &&
          maskProjectId !== undefined &&
          maskProjectTitle !== undefined &&
          onMaskSettingsChange !== undefined &&
          onApplyMaskResult !== undefined &&
          onClearMask !== undefined)) &&
      (candidate.id !== 'enhance' ||
        (upscaleTarget !== undefined &&
          project !== undefined &&
          upscaleProjectId !== undefined &&
          upscaleProjectTitle !== undefined &&
          onUpscaleSettingsChange !== undefined &&
          onApplyUpscaleResult !== undefined)) &&
      (candidate.id !== 'audio' || clipAudio !== undefined) &&
      (candidate.id !== 'speed' || clipSpeed !== undefined)
    );
  });

  useEffect(() => {
    // Older sessions used the Transform tab id. Keep that selection usable
    // while exposing the clearer Visual label in the current IA, and never
    // strand the user on a capability tab after selection changes.
    if (tab === 'transform' || !visibleTabs.some((candidate) => candidate.id === tab))
      setTab('visual');
  }, [tab, visibleTabs]);

  useEffect(() => {
    setTab(isAdjustmentLayer ? 'adjust' : 'visual');
  }, [isAdjustmentLayer, target.id]);

  const dispatchAudio = (command: AudioCommand, label: string) => {
    if (audioState === undefined || onAudioChange === undefined) return;
    try {
      const { state } = applyAudioCommand(audioState, command);
      onAudioChange(state, label);
    } catch (error) {
      console.warn('audio command rejected', error);
    }
  };

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
    if (curve !== undefined && hasKeyframeAtCurve(curve, timeUs)) {
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

  return (
    <PanelShell
      title="Inspector"
      iconUrl={panelTabIconUrl('inspector')}
      className="inspector-panel"
      tabs={visibleTabs}
      activeTab={tab}
      onTabChange={setTab}
      inactive={inspectorInactive}
      note={inspectorInactive ? 'Select a clip to edit its properties.' : undefined}
      noteMode={inspectorInactive ? 'hint' : undefined}
    >
      <AgentPreviewBadge surface="Inspector" />
      <div className="inspector-selection-row">
        <h2 className="inspector-selected-name" dir="ltr">
          {title}
        </h2>
        <p className="monitor-meta inspector-playhead-meta" dir="ltr">
          Playhead {(timeUs / 1_000_000).toFixed(2)}s
        </p>
      </div>
      <div className="inspector-selection-summary" aria-label="Selection details">
        <div className="inspector-selection-detail">
          <span>Kind</span>
          <strong>
            {selectedKind ?? (object === undefined ? 'Nothing selected' : target.kind)}
          </strong>
        </div>
        <div className="inspector-selection-detail">
          <span>Track</span>
          <strong>{selectedTrackName ?? '—'}</strong>
        </div>
        <div className="inspector-selection-detail">
          <span>Source</span>
          <strong>{formatDuration(selectedSourceDurationUs)}</strong>
        </div>
        <div className="inspector-selection-detail">
          <span>Timeline</span>
          <strong>{formatDuration(selectedTimelineDurationUs)}</strong>
        </div>
      </div>

      {tab === 'visual' && (
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
                const expressionSource = target.expressions?.[key];
                const hasExpression = expressionSource !== undefined;
                const channelDiagnostic = diagnostics.find((d) => d.property === key);
                return (
                  <TransformPropertyRow
                    key={key}
                    property={{ key, label: property.label, min: property.min, max: property.max }}
                    target={target}
                    resolvedValue={resolved[key]}
                    timeUs={timeUs}
                    idle={idle}
                    hasExpression={hasExpression}
                    diagnostic={channelDiagnostic?.message}
                    onSetStatic={onSetStatic}
                    onReplaceChannel={replaceChannel}
                    onKeyframePayload={keyframePayload}
                    onToggleKeyframe={toggleKeyframe}
                    expressionButton={
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
                    }
                    onOpenAnimationGraph={onOpenAnimationGraph}
                  >
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
                  </TransformPropertyRow>
                );
              })}
            </>
          )}
        </section>
      )}

      {tab === 'visual' && target.kind === 'image' && (
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

      {tab === 'visual' && onCreateAdjustmentLayer !== undefined && (
        <section className="inspector-section" aria-label="Adjustment layer">
          <h3>Adjustment layer</h3>
          <button
            type="button"
            className="icon-button icon-button-labeled inspector-create-adjustment"
            aria-label="Create Adjust layer for selected media"
            title="Create a separate Adjust layer targeting this media"
            onClick={onCreateAdjustmentLayer}
          >
            <SlidersIcon />
            Add Adjust
          </button>
        </section>
      )}

      {tab === 'adjust' && adjustmentLayer !== undefined && (
        <AdjustmentLayerSection
          object={target}
          adjustment={adjustmentLayer}
          playheadUs={timeUs}
          {...(project === undefined ? {} : { project })}
          {...(onAdjustmentTargetChange === undefined
            ? {}
            : { onTargetChange: onAdjustmentTargetChange })}
          onDispatch={onDispatch}
        />
      )}

      {tab === 'effects' && (
        <EffectsSection
          object={target}
          {...(project === undefined ? {} : { project })}
          open={effectsOpen}
          onToggle={() => setEffectsOpen((v) => !v)}
          playheadUs={timeUs}
          onDispatch={onDispatch}
        />
      )}

      {tab === 'mask' &&
        maskTarget !== undefined &&
        project !== undefined &&
        maskProjectId !== undefined &&
        maskProjectTitle !== undefined &&
        onMaskSettingsChange !== undefined &&
        onApplyMaskResult !== undefined &&
        onClearMask !== undefined && (
          <MaskInspector
            projectId={maskProjectId}
            projectTitle={maskProjectTitle}
            target={maskTarget}
            settings={readMaskSettings(project, maskTarget.targetId, maskTarget.kind)}
            onChange={onMaskSettingsChange}
            onApplyResult={onApplyMaskResult}
            onClear={onClearMask}
          />
        )}

      {tab === 'enhance' &&
        upscaleTarget !== undefined &&
        project !== undefined &&
        upscaleProjectId !== undefined &&
        upscaleProjectTitle !== undefined &&
        onUpscaleSettingsChange !== undefined &&
        onApplyUpscaleResult !== undefined && (
          <EnhanceInspector
            projectId={upscaleProjectId}
            projectTitle={upscaleProjectTitle}
            target={upscaleTarget}
            settings={readUpscaleSettings(project, upscaleTarget.targetId)}
            onChange={onUpscaleSettingsChange}
            onApplyResult={onApplyUpscaleResult}
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
            playheadUs={timeUs}
            {...(project === undefined ? {} : { project, onProjectDispatch: onDispatch })}
          />
        ) : (
          <p className="empty-hint">Select a clip to mix its audio.</p>
        ))}

      {tab === 'speed' && (
        <SpeedSection
          open={speedOpen}
          onToggle={() => setSpeedOpen((value) => !value)}
          clipId={selectedClipId ?? 'none'}
          speed={clipSpeed ?? { rate: 1, supportsReverse: false, supportsRamps: false }}
          {...(clipSpeed === undefined || selectedClipId === undefined
            ? {}
            : { onChange: onSpeedChange })}
        />
      )}
    </PanelShell>
  );
}

function AdjustmentLayerSection({
  object,
  adjustment,
  project,
  playheadUs,
  onTargetChange,
  onDispatch,
}: {
  readonly object: VisualObjectV1;
  readonly adjustment: InspectorAdjustmentLayer;
  readonly project?: Pick<JoyProjectV1, 'propertyAnimations'>;
  readonly playheadUs: number;
  readonly onTargetChange?: (targetClipId: string) => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}) {
  const adjustmentEffects = (object.effects ?? []).filter(
    (effect) =>
      effect.effectId === 'brightness-contrast' ||
      effect.effectId === 'hue-saturation' ||
      effect.effectId === 'vibrance',
  );
  return (
    <>
      <section className="inspector-section inspector-adjustment-target" aria-label="Adjust target">
        <h3>Parent media</h3>
        <label className="inspector-adjustment-parent">
          <span>Target</span>
          <select
            aria-label="Adjustment parent media"
            value={adjustment.targetClipId ?? ''}
            disabled={onTargetChange === undefined || adjustment.targets.length === 0}
            onChange={(event) => onTargetChange?.(event.currentTarget.value)}
          >
            <option value="" disabled>
              Choose video or picture
            </option>
            {adjustment.targets.map((candidate) => (
              <option key={candidate.clipId} value={candidate.clipId}>
                {candidate.label} · {candidate.kind}
              </option>
            ))}
          </select>
        </label>
        <span className="inspector-adjustment-routing" role="status">
          Adjust → {adjustment.targetClipId ?? 'No parent selected'}
        </span>
      </section>
      <section className="inspector-section" aria-label="Adjustments">
        <h3>Adjustments</h3>
        {adjustmentEffects.length === 0 ? (
          <div className="inspector-empty-state" role="status">
            <strong>No color adjustments</strong>
            <span>Add a color effect from the Effects tab.</span>
          </div>
        ) : (
          <div className="inspector-adjustment-stack">
            {adjustmentEffects.map((effect) => {
              const descriptor = effectRegistry.getEffect(effect.effectId);
              if (descriptor === undefined) return null;
              return (
                <div className="inspector-adjustment-group" key={effect.id}>
                  <strong>{descriptor.label}</strong>
                  <div className="inspector-effect-params">
                    {descriptor.params.map((param) => (
                      <EffectParamControl
                        key={param.key}
                        descriptor={descriptor}
                        param={param}
                        value={effect.params[param.key] ?? param.defaultValue}
                        effect={effect}
                        {...(project === undefined ? {} : { project })}
                        objectId={object.id}
                        playheadUs={playheadUs}
                        onDispatch={onDispatch}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

export function EffectsSection({
  object,
  project,
  open,
  onToggle,
  playheadUs,
  onDispatch,
}: {
  readonly object: VisualObjectV1;
  readonly project?: Pick<JoyProjectV1, 'propertyAnimations'>;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly playheadUs: number;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}) {
  const effects = object.effects ?? [];
  const [draggedEffectId, setDraggedEffectId] = useState<string | null>(null);

  if (effects.length === 0)
    return (
      <section className="inspector-section" aria-label="Effects">
        <button
          type="button"
          className="inspector-section-toggle"
          aria-expanded={open}
          onClick={onToggle}
        >
          <h3>Effects</h3>
        </button>
        {open && (
          <div className="inspector-empty-state" role="status">
            <strong>No effects applied</strong>
            <span>
              Choose an effect in the Effects tab, then return here to edit and keyframe it.
            </span>
          </div>
        )}
      </section>
    );

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
          {effects.map((effect, index) => {
            const descriptor = effectRegistry.getEffect(effect.effectId);
            const label = descriptor?.label ?? effect.effectId;
            return (
              <li
                key={effect.id}
                className="inspector-effect-item"
                data-effect-instance-id={effect.id}
                onDragOver={(event) => {
                  if (draggedEffectId !== null && draggedEffectId !== effect.id) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const effectInstanceId =
                    draggedEffectId ??
                    event.dataTransfer.getData('application/x-joy-effect-instance');
                  if (effectInstanceId === '' || effectInstanceId === effect.id) return;
                  const movedEffect = effects.find((item) => item.id === effectInstanceId);
                  if (movedEffect === undefined) return;
                  const movedLabel =
                    effectRegistry.getEffect(movedEffect.effectId)?.label ?? movedEffect.effectId;
                  onDispatch(
                    effectReorderTransaction(object.id, effectInstanceId, index, movedLabel),
                  );
                  setDraggedEffectId(null);
                }}
              >
                <div className="inspector-effect-header">
                  <button
                    type="button"
                    className="icon-button inspector-effect-drag"
                    aria-label={`Reorder ${label}`}
                    title="Drag to reorder"
                    data-drag-handle
                    draggable
                    onDragStart={(event) => {
                      setDraggedEffectId(effect.id);
                      event.dataTransfer.setData('application/x-joy-effect-instance', effect.id);
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => setDraggedEffectId(null)}
                  >
                    ⠿
                  </button>
                  <span className="inspector-effect-label" title={effect.effectId}>
                    {label}
                  </span>
                  <div className="inspector-effect-actions">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move ${label} up`}
                      title="Move up"
                      disabled={index === 0}
                      onClick={() => {
                        onDispatch(
                          effectReorderTransaction(object.id, effect.id, index - 1, label),
                        );
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move ${label} down`}
                      title="Move down"
                      disabled={index === effects.length - 1}
                      onClick={() => {
                        onDispatch(
                          effectReorderTransaction(object.id, effect.id, index + 1, label),
                        );
                      }}
                    >
                      ↓
                    </button>
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
                        effect={effect}
                        {...(project === undefined ? {} : { project })}
                        objectId={object.id}
                        playheadUs={playheadUs}
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
  effect,
  project,
  objectId,
  playheadUs,
  onDispatch,
}: {
  readonly descriptor: EffectDescriptor;
  readonly param: EffectDescriptor['params'][number];
  readonly value: unknown;
  readonly effect: NonNullable<VisualObjectV1['effects']>[number];
  readonly project?: Pick<JoyProjectV1, 'propertyAnimations'>;
  readonly objectId: string;
  readonly playheadUs: number;
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
            effectInstanceId: effect.id,
            paramKey: param.key,
            value: next as never,
          },
        },
      ],
    });
  };

  if (param.type === 'number')
    return (
      <EffectNumericParamControl
        descriptor={descriptor}
        param={param}
        value={typeof value === 'number' ? value : (param.defaultValue as number)}
        effect={effect}
        {...(project === undefined ? {} : { project })}
        objectId={objectId}
        playheadUs={playheadUs}
        onDispatch={onDispatch}
      />
    );

  if (param.type === 'vector2') return null;

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

function EffectNumericParamControl({
  descriptor,
  param,
  value,
  effect,
  project,
  objectId,
  playheadUs,
  onDispatch,
}: {
  readonly descriptor: EffectDescriptor;
  readonly param: EffectDescriptor['params'][number];
  readonly value: number;
  readonly effect: NonNullable<VisualObjectV1['effects']>[number];
  readonly project?: Pick<JoyProjectV1, 'propertyAnimations'>;
  readonly objectId: string;
  readonly playheadUs: number;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}) {
  const binding: PropertyBindingV2 = {
    ownerKind: 'object-effect',
    ownerId: effect.id,
    propertyId: param.key,
    timeDomain: 'composition',
  };
  const animation = project?.propertyAnimations?.[canonicalBindingKey(binding)];
  const v2Curve = animation?.value.kind === 'scalar' ? animation.value.curve : undefined;
  const legacyCurve = effect.animations?.[param.key];
  const curve = v2Curve ?? legacyCurve;
  const animated = curve !== undefined;
  const keyed = animated && hasKeyframeAtCurve(curve, playheadUs);
  const sourceValue = animated ? sampleCurve(curve, playheadUs) : value;
  const [previewValue, setPreviewValue] = useState(sourceValue);
  useEffect(() => setPreviewValue(sourceValue), [sourceValue]);
  const replaceCurve = (next: ReturnType<typeof setKeyframe>, label: string) =>
    onDispatch({
      label,
      commands: [
        {
          type: 'propertyAnimation.replace',
          payload: { binding, value: { kind: 'scalar', curve: next } },
        },
      ],
    });
  const setPropertyKey = (keyframe: Parameters<typeof setKeyframe>[1], label: string) => {
    if (v2Curve === undefined && legacyCurve === undefined) {
      onDispatch({
        label,
        commands: [
          {
            type: 'propertyAnimation.enable',
            payload: {
              animation: {
                binding,
                value: { kind: 'scalar', curve: { keyframes: [keyframe] } },
              },
            },
          },
        ],
      });
      return;
    }
    onDispatch({
      label,
      commands: [
        {
          type: 'propertyAnimation.setKey',
          payload: { binding, key: { kind: 'scalar', keyframe } },
        },
      ],
    });
  };
  const removePropertyKey = (timeUs: number, next: ReturnType<typeof setKeyframe> | undefined) => {
    if (next === undefined) {
      onDispatch({
        label: `Remove ${param.label} keyframe`,
        commands: [{ type: 'propertyAnimation.removeKey', payload: { binding, timeUs } }],
      });
      return;
    }
    replaceCurve(next, `Remove ${param.label} keyframe`);
  };
  const commitValue = (next: number) => {
    if (animated) {
      const keyframe = { timeUs: playheadUs, value: next, interpolation: 'linear' as const };
      setPropertyKey(keyframe, `Set ${param.label} on ${descriptor.label}`);
      return;
    }
    onDispatch({
      label: `Set ${param.label} on ${descriptor.label}`,
      commands: [
        {
          type: 'effect.setParam',
          payload: { objectId, effectInstanceId: effect.id, paramKey: param.key, value: next },
        },
      ],
    });
  };
  const adapter = useTransientPropertyControl(
    {
      read: () => previewValue,
      preview: setPreviewValue,
      restore: setPreviewValue,
      commit: ({ next }) => commitValue(next),
    },
    `Set ${param.label} on ${descriptor.label}`,
  );
  const controlId = `effect-${effect.id}-${param.key}`;
  return (
    <PropertyRow
      label={param.label}
      controlId={controlId}
      value={`${previewValue.toFixed(2)}${param.unit ?? ''}`}
      onReset={() => commitValue(param.defaultValue as number)}
      {...(param.animatable
        ? {
            onToggleAnimation: () => {
              if (keyed) {
                const next = removeKeyframe(curve!, playheadUs);
                removePropertyKey(playheadUs, next);
              } else {
                const keyframe = {
                  timeUs: playheadUs,
                  value: previewValue,
                  interpolation: 'linear' as const,
                };
                setPropertyKey(keyframe, `Add ${param.label} keyframe`);
              }
            },
            animationState: keyed
              ? ('keyed' as const)
              : animated
                ? ('between' as const)
                : ('none' as const),
          }
        : {})}
    >
      <div className="inspector-prop-row">
        <SliderPropertyControl
          value={previewValue}
          adapter={adapter}
          ariaLabel={param.label}
          min={param.min ?? -1}
          max={param.max ?? 1}
          step={param.step ?? 0.01}
        />
        <NumericPropertyControl
          id={controlId}
          value={previewValue}
          adapter={adapter}
          ariaLabel={`${param.label} value`}
          min={param.min}
          max={param.max}
          step={param.step}
        />
      </div>
    </PropertyRow>
  );
}

export const SPEED_RAMP_PRESETS: readonly {
  readonly id: SpeedRampPreset;
  readonly label: string;
  readonly description: string;
}[] = [
  { id: 'ease-in', label: 'Ease In', description: 'Gradually accelerate' },
  { id: 'ease-out', label: 'Ease Out', description: 'Gradually decelerate' },
  { id: 'ease-in-out', label: 'Ease In/Out', description: 'Ease at both ends' },
];

export function formatInspectorSpeedRate(rate: number): string {
  const magnitude = Math.abs(rate);
  const rounded = Math.round(magnitude * 100) / 100;
  return `${rate < 0 ? '−' : ''}${rounded}×`;
}

/**
 * Selected-clip speed controls. The Inspector deliberately requests semantic
 * changes through `onChange`; the timeline integration decides how a rate or
 * ramp becomes an undoable command for the current clip kind.
 */
export function SpeedSection({
  open,
  onToggle,
  clipId,
  speed,
  onChange,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly clipId: string;
  readonly speed: InspectorClipSpeed;
  readonly onChange?: ((change: InspectorSpeedChange, label: string) => void) | undefined;
}) {
  const frozen = speed.rate === 0;
  const canChange = onChange !== undefined && !frozen;
  const supportsReverse = speed.supportsReverse === true;
  const supportsRamps = speed.supportsRamps === true;
  const rate = frozen ? 0 : (validInspectorSpeedRate(speed.rate, supportsReverse) ?? 1);
  const remapDurationUs = Math.max(1, speed.durationUs ?? 1_000_000);
  const remapStartUs = speed.timeRemap?.keyframes[0]?.sourceTimeUs ?? speed.sourceInUs ?? 0;
  const remapEndUs =
    speed.timeRemap?.keyframes.at(-1)?.sourceTimeUs ??
    remapStartUs + Math.round(remapDurationUs * rate);
  const [draftRemapStartUs, setDraftRemapStartUs] = useState(String(remapStartUs));
  const [draftRemapEndUs, setDraftRemapEndUs] = useState(String(remapEndUs));
  const [remapError, setRemapError] = useState<string | undefined>();
  const rateInputMin = supportsReverse ? -MAX_INSPECTOR_SPEED_RATE : MIN_INSPECTOR_SPEED_RATE;
  const rateInputMax = MAX_INSPECTOR_SPEED_RATE;
  const rateControlId = `insp-speed-rate-${clipId}`;
  const rateOutputId = `${rateControlId}-value`;
  const rampHintId = `insp-speed-ramp-support-${clipId}`;
  const [draftRate, setDraftRate] = useState(String(rate));
  const [rateError, setRateError] = useState<string | undefined>();

  useEffect(() => {
    setDraftRate(String(rate));
    setRateError(undefined);
    setDraftRemapStartUs(String(remapStartUs));
    setDraftRemapEndUs(String(remapEndUs));
    setRemapError(undefined);
  }, [clipId, rate, remapStartUs, remapEndUs]);

  const requestRate = (next: number) => {
    const valid = validInspectorSpeedRate(next, supportsReverse);
    if (valid === undefined) {
      setRateError(
        `Enter a rate from ${supportsReverse ? '−' : ''}${MIN_INSPECTOR_SPEED_RATE}× to ${MAX_INSPECTOR_SPEED_RATE}×.`,
      );
      return;
    }
    setRateError(undefined);
    setDraftRate(String(valid));
    onChange?.({ rate: valid }, `Speed ${clipId} → ${formatInspectorSpeedRate(valid)}`);
  };

  const commitDraftRate = () => {
    const next = Number(draftRate);
    const valid = validInspectorSpeedRate(next, supportsReverse);
    if (valid === undefined) {
      setRateError(
        `Enter a rate from ${supportsReverse ? '−' : ''}${MIN_INSPECTOR_SPEED_RATE}× to ${MAX_INSPECTOR_SPEED_RATE}×.`,
      );
      return;
    }
    requestRate(valid);
  };

  const requestRamp = (ramp: SpeedRampPreset) => {
    const label = `Speed ramp ${clipId} → ${
      SPEED_RAMP_PRESETS.find((preset) => preset.id === ramp)?.label ?? ramp
    }`;
    onChange?.({ ramp }, label);
  };

  const requestTimeRemap = () => {
    const start = Number(draftRemapStartUs);
    const end = Number(draftRemapEndUs);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < 0) {
      setRemapError('Source times must be non-negative whole microseconds.');
      return;
    }
    setRemapError(undefined);
    onChange?.(
      {
        timeRemap: {
          version: 2,
          direction: end >= start ? 'forward' : 'reverse',
          keyframes: [
            { timeUs: 0, sourceTimeUs: start, interpolation: 'linear' },
            { timeUs: remapDurationUs, sourceTimeUs: end, interpolation: 'linear' },
          ],
        },
      },
      `Remap source time for ${clipId}`,
    );
  };

  return (
    <section className="inspector-section inspector-speed-section" aria-label="Speed">
      <button
        type="button"
        className="inspector-section-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <h3>Speed</h3>
      </button>
      {open && (
        <>
          {frozen && (
            <p className="inspector-speed-support-note" role="status">
              This is a freeze frame. Speed changes are read-only; use Undo to restore its source
              motion.
            </p>
          )}
          <div className="inspector-speed-control">
            <span className="inspector-speed-label">Direction</span>
            <div className="inspector-speed-presets" role="group" aria-label="Playback direction">
              <button
                type="button"
                className="inspector-speed-preset"
                aria-pressed={rate >= 0}
                disabled={!canChange}
                onClick={() => requestRate(Math.max(Math.abs(rate), 1))}
              >
                Forward
              </button>
              <button
                type="button"
                className="inspector-speed-preset inspector-speed-reverse"
                aria-label="Set speed to reverse"
                aria-pressed={rate < 0}
                aria-description={
                  supportsReverse
                    ? 'Program Monitor reverse preview is silent; export reverses audio.'
                    : undefined
                }
                disabled={!canChange || !supportsReverse}
                title={supportsReverse ? 'Play backwards' : 'Reverse is unavailable for this clip'}
                onClick={() => requestRate(-Math.max(Math.abs(rate), 1))}
              >
                Reverse
              </button>
            </div>
            {rate < 0 && (
              <p className="inspector-speed-support-note">
                Reverse preview is silent; exported audio plays in reverse.
              </p>
            )}
          </div>

          {!frozen && (
            <div className="inspector-speed-control">
              <span className="inspector-speed-label">Constant speed</span>
              <div className="inspector-prop inspector-speed-rate">
                <label htmlFor={rateControlId}>Rate</label>
                <div className="inspector-prop-row">
                  <input
                    id={rateControlId}
                    type="number"
                    min={rateInputMin}
                    max={rateInputMax}
                    step={0.05}
                    inputMode="decimal"
                    value={draftRate}
                    disabled={!canChange}
                    aria-describedby={rateOutputId}
                    onChange={(event) => {
                      setDraftRate(event.currentTarget.value);
                      setRateError(undefined);
                    }}
                    onBlur={commitDraftRate}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitDraftRate();
                    }}
                  />
                  <button
                    type="button"
                    className="icon-button icon-button-labeled inspector-speed-apply"
                    disabled={!canChange}
                    onClick={commitDraftRate}
                  >
                    Apply
                  </button>
                  <output id={rateOutputId} className="inspector-speed-value" aria-live="polite">
                    {formatInspectorSpeedRate(rate)}
                  </output>
                </div>
              </div>
              {rateError !== undefined && (
                <p className="inspector-speed-support-note inspector-speed-error" role="alert">
                  {rateError}
                </p>
              )}
            </div>
          )}

          <div className="inspector-speed-control">
            <span className="inspector-speed-label">Speed presets</span>
            <div className="inspector-speed-presets" role="group" aria-label="Speed presets">
              {SPEED_RATE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="inspector-speed-preset"
                  aria-label={`Set speed to ${formatInspectorSpeedRate(preset)}`}
                  aria-pressed={rate === preset}
                  disabled={!canChange}
                  onClick={() => requestRate(preset)}
                >
                  {formatInspectorSpeedRate(preset)}
                </button>
              ))}
            </div>
          </div>

          <div className="inspector-speed-control" aria-label="Time remap">
            <span className="inspector-speed-label">Time remap</span>
            <div className="inspector-prop-row">
              <label htmlFor={`insp-remap-start-${clipId}`}>Start source µs</label>
              <input
                id={`insp-remap-start-${clipId}`}
                type="number"
                min={0}
                step={1}
                value={draftRemapStartUs}
                disabled={!canChange}
                onChange={(event) => setDraftRemapStartUs(event.currentTarget.value)}
              />
              <label htmlFor={`insp-remap-end-${clipId}`}>End source µs</label>
              <input
                id={`insp-remap-end-${clipId}`}
                type="number"
                min={0}
                step={1}
                value={draftRemapEndUs}
                disabled={!canChange}
                onChange={(event) => setDraftRemapEndUs(event.currentTarget.value)}
              />
              <button
                type="button"
                className="icon-button icon-button-labeled inspector-speed-apply"
                disabled={!canChange}
                onClick={requestTimeRemap}
              >
                {speed.timeRemap === undefined ? 'Enable' : 'Apply'}
              </button>
              {speed.timeRemap !== undefined && (
                <button
                  type="button"
                  className="icon-button icon-button-labeled inspector-speed-apply"
                  disabled={!canChange}
                  onClick={() =>
                    onChange?.({ timeRemap: undefined }, `Clear time remap for ${clipId}`)
                  }
                >
                  Clear
                </button>
              )}
            </div>
            {remapError !== undefined ? (
              <p className="inspector-speed-support-note inspector-speed-error" role="alert">
                {remapError}
              </p>
            ) : (
              <p className="inspector-speed-support-note">
                Two bounded endpoints define a monotonic source-time curve; reverse remaps are
                allowed.
              </p>
            )}
          </div>

          <div className="inspector-speed-control">
            <span className="inspector-speed-label">Speed ramp</span>
            <div
              className="inspector-speed-presets"
              role="group"
              aria-label="Speed ramp presets"
              aria-describedby={supportsRamps ? undefined : rampHintId}
            >
              {SPEED_RAMP_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="inspector-speed-preset"
                  aria-label={preset.label}
                  aria-description={preset.description}
                  aria-pressed={speed.ramp === preset.id}
                  disabled={!canChange || !supportsRamps}
                  onClick={() => requestRamp(preset.id)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {supportsRamps ? (
              <p className="inspector-speed-support-note">
                Applying a ramp creates three source-continuous speed segments. Undo restores the
                original clip.
              </p>
            ) : (
              <p id={rampHintId} className="inspector-speed-support-note">
                Speed ramps are unavailable for this clip.
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function AudioSection({
  open,
  onToggle,
  clipId,
  clip,
  dispatch,
  playheadUs,
  project,
  onProjectDispatch,
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
  readonly playheadUs: number;
  readonly project?: Pick<JoyProjectV1, 'propertyAnimations'>;
  readonly onProjectDispatch?: (transaction: VisualObjectTransaction) => void;
}) {
  const keyframe = (propertyId: 'gain' | 'pan' | 'mute', value: number | boolean) => {
    if (project === undefined || onProjectDispatch === undefined) return {};
    const binding = audioClipPropertyBinding(clipId, propertyId);
    const label =
      propertyId === 'gain' ? 'Clip gain' : propertyId === 'pan' ? 'Clip pan' : 'Clip mute';
    return {
      animationState: audioKeyframeState(project, binding, playheadUs),
      onToggleAnimation: () =>
        onProjectDispatch(audioKeyframeTransaction(project, binding, playheadUs, value, label)),
    };
  };
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
          <PropertyRow
            label="Volume"
            controlId="insp-gain"
            value={round(clip.gain)}
            {...keyframe('gain', clip.gain)}
          >
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
          </PropertyRow>
          <PropertyRow
            label="Pan"
            controlId="insp-pan"
            value={round(clip.pan)}
            {...keyframe('pan', clip.pan)}
          >
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
          </PropertyRow>
          <PropertyRow
            label="Mute"
            value={clip.mute ? 'Muted' : 'On'}
            {...keyframe('mute', clip.mute)}
          >
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
          </PropertyRow>
        </>
      )}
    </section>
  );
}

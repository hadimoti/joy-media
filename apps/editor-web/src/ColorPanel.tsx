import { useEffect, useRef, useState } from 'react';
import type { ColorGradeV1, ColorGradeV2, JoyProjectV1 } from '@joy-media/project-schema';
import {
  canonicalBindingKey,
  colorCurveToSnapshot,
  colorLutReferenceIdentity,
  colorPropertyBinding,
  createIdentityColorGrade,
  encodeColorLutReference,
  IDENTITY_COLOR_ADJUSTMENTS,
  IDENTITY_COLOR_CURVES,
  IDENTITY_HSL_BANDS,
  IDENTITY_COLOR_WHEELS,
  isColorLutReferenceAvailable,
} from '@joy-media/project-schema';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { PropertyRow, type PropertyAnimationState } from './components/PropertyRow.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import { readMonitorPixels as readLiveMonitorPixels } from './monitor-readback.js';
import type { VisualObjectTransaction } from '@joy-media/property-system';

type TabId = 'adjust' | 'wheels' | 'curves' | 'hsl' | 'looks' | 'scopes';
const TABS: readonly PanelTabSpec[] = [
  { id: 'adjust', label: 'Adjust' },
  { id: 'wheels', label: 'Wheels' },
  { id: 'curves', label: 'Curves' },
  { id: 'hsl', label: 'HSL' },
  { id: 'looks', label: 'Looks' },
  { id: 'scopes', label: 'Scopes' },
];

const ADJUST_RANGES = [
  ['temperature', 'Temperature', -1, 1, 0],
  ['tint', 'Tint', -1, 1, 0],
  ['exposure', 'Exposure', -4, 4, 0],
  ['contrast', 'Contrast', -1, 1, 0],
  ['pivot', 'Pivot', 0, 1, 0.5],
  ['highlights', 'Highlights', -1, 1, 0],
  ['shadows', 'Shadows', -1, 1, 0],
  ['whites', 'Whites', -1, 1, 0],
  ['blacks', 'Blacks', -1, 1, 0],
  ['saturation', 'Saturation', 0, 2, 1],
  ['vibrance', 'Vibrance', -1, 1, 0],
  ['hue', 'Hue', -180, 180, 0],
] as const;

export interface ScopePixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

interface ColorPanelProps {
  readonly project: JoyProjectV1;
  readonly onChange: (next: JoyProjectV1) => void;
  readonly onDispatch?: (transaction: VisualObjectTransaction) => void;
  readonly selectedClipId?: string;
  readonly selectedClipName?: string;
  readonly selectedClipStartUs?: number;
  readonly selectedClipDurationUs?: number;
  readonly playheadUs?: number;
  readonly readMonitorPixels?: () => ScopePixels | undefined;
}

export const DEFAULT_GRADE: ColorGradeV1 = {
  lift: 0,
  gamma: 1,
  gain: 1,
  saturation: 1,
  lutId: 'none',
};

export function readColorGrade(project: JoyProjectV1): ColorGradeV1 {
  const raw = project.colorGrade;
  return raw !== undefined && 'version' in raw
    ? DEFAULT_GRADE
    : { ...DEFAULT_GRADE, ...(raw ?? {}) };
}

function v2From(value: ColorGradeV1 | ColorGradeV2 | undefined): ColorGradeV2 {
  if (value !== undefined && 'version' in value) return value;
  const legacy = value ?? DEFAULT_GRADE;
  return {
    ...createIdentityColorGrade(),
    wheels: {
      ...IDENTITY_COLOR_WHEELS,
      lift: { ...IDENTITY_COLOR_WHEELS.lift, master: legacy.lift },
      gamma: { ...IDENTITY_COLOR_WHEELS.gamma, master: legacy.gamma - 1 },
      gain: { ...IDENTITY_COLOR_WHEELS.gain, master: legacy.gain - 1 },
    },
    adjust: { ...IDENTITY_COLOR_ADJUSTMENTS, saturation: legacy.saturation },
    lut: { builtIn: legacy.lutId === 'contrast' ? 'clean-contrast' : 'none', intensity: 1 },
  };
}

export function ColorPanel({
  project,
  onChange,
  onDispatch,
  selectedClipId,
  selectedClipName,
  selectedClipStartUs,
  selectedClipDurationUs,
  playheadUs = 0,
  readMonitorPixels,
}: ColorPanelProps) {
  // App only passes selectedClipId after resolving a gradeable video clip from
  // the timeline project. The visual project intentionally has a different
  // composition graph, so validating against it would disable Clip mode.
  const clipAvailable = selectedClipId !== undefined;
  const [target, setTarget] = useState<'clip' | 'output'>(clipAvailable ? 'clip' : 'output');
  const [tab, setTab] = useState<TabId>('adjust');
  const source =
    target === 'clip'
      ? clipAvailable && selectedClipId !== undefined
        ? project.clipColorGrades?.[selectedClipId]
        : undefined
      : project.colorGrade;
  const committed = v2From(source);
  const [draft, setDraft] = useState<ColorGradeV2>(committed);
  const committedKey = JSON.stringify(committed);
  const draftKey = useRef(committedKey);
  useEffect(() => {
    if (draftKey.current !== committedKey) {
      draftKey.current = committedKey;
      setDraft(committed);
    }
  }, [committedKey, committed, target, clipAvailable]);

  const commit = (next: ColorGradeV2 = draft) => {
    if (target === 'clip' && (!clipAvailable || selectedClipId === undefined)) return;
    draftKey.current = JSON.stringify(next);
    const updated = { ...project, updatedAt: new Date().toISOString() };
    if (onDispatch !== undefined) {
      onDispatch({
        label: `${target === 'clip' ? 'Clip' : 'Output'} color grade`,
        commands: [
          {
            type: 'color.setGrade',
            payload: {
              target:
                target === 'clip' && selectedClipId !== undefined && clipAvailable
                  ? { scope: 'clip', clipId: selectedClipId }
                  : { scope: 'output' },
              grade: next,
            },
          },
        ],
      });
    } else if (target === 'clip' && selectedClipId !== undefined && clipAvailable) {
      onChange({
        ...updated,
        clipColorGrades: { ...(project.clipColorGrades ?? {}), [selectedClipId]: next },
      });
    } else onChange({ ...updated, colorGrade: next });
  };
  const patchAdjust = (key: string, value: number, finalize = false) => {
    const next = {
      ...draft,
      adjust: { ...IDENTITY_COLOR_ADJUSTMENTS, ...(draft.adjust ?? {}), [key]: value },
    };
    setDraft(next);
    if (finalize) commit(next);
  };
  const animationStateFor = (propertyId: string): PropertyAnimationState => {
    if (target === 'clip' && selectedClipId === undefined) return 'none';
    const binding = colorPropertyBinding(
      target,
      propertyId,
      target === 'clip' ? selectedClipId : undefined,
    );
    const value = project.propertyAnimations?.[canonicalBindingKey(binding)]?.value;
    if (value === undefined) return 'none';
    const localTimeUs =
      target === 'clip'
        ? Math.max(
            0,
            Math.min(
              selectedClipDurationUs ?? Number.MAX_SAFE_INTEGER,
              playheadUs - (selectedClipStartUs ?? playheadUs),
            ),
          )
        : playheadUs;
    const hasKey =
      value.kind === 'scalar' || value.kind === 'angle' || value.kind === 'hue'
        ? value.curve.keyframes.some((key) => key.timeUs === localTimeUs)
        : value.kind === 'vector' || value.kind === 'color'
          ? Object.values(value.curve).some((curve) =>
              curve.keyframes.some((key) => key.timeUs === localTimeUs),
            )
          : value.kind === 'boolean' || value.kind === 'string'
            ? value.keys.some((key) => key.timeUs === localTimeUs)
            : value.samples.some((sample) => sample.timeUs === localTimeUs);
    return hasKey ? 'keyed' : 'between';
  };
  const toggleNumericAnimation = (
    propertyId: string,
    value: number,
    kind: 'scalar' | 'hue' = 'scalar',
  ) => {
    if (onDispatch === undefined) return;
    if (target === 'clip' && selectedClipId === undefined) return;
    const binding = colorPropertyBinding(
      target,
      propertyId,
      target === 'clip' ? selectedClipId : undefined,
    );
    const localTimeUs =
      target === 'clip'
        ? Math.max(
            0,
            Math.min(
              selectedClipDurationUs ?? Number.MAX_SAFE_INTEGER,
              playheadUs - (selectedClipStartUs ?? playheadUs),
            ),
          )
        : playheadUs;
    const current = project.propertyAnimations?.[canonicalBindingKey(binding)];
    const isCurrentKind = current?.value.kind === kind;
    const hasKey =
      isCurrentKind &&
      'curve' in current.value &&
      current.value.curve.keyframes.some((frame) => frame.timeUs === localTimeUs);
    onDispatch({
      label: `${hasKey ? 'Remove' : 'Add'} Color ${propertyId} keyframe`,
      commands: [
        hasKey
          ? { type: 'propertyAnimation.removeKey', payload: { binding, timeUs: localTimeUs } }
          : isCurrentKind
            ? {
                type: 'propertyAnimation.setKey',
                payload: {
                  binding,
                  key: {
                    kind,
                    keyframe: { timeUs: localTimeUs, value, interpolation: 'linear' },
                  },
                },
              }
            : {
                type: 'propertyAnimation.replace',
                payload: {
                  binding,
                  value: {
                    kind,
                    curve: { keyframes: [{ timeUs: localTimeUs, value, interpolation: 'linear' }] },
                  },
                },
              },
      ],
    });
  };
  const toggleCurveAnimation = (
    channel: 'rgb' | 'red' | 'green' | 'blue',
    curves: ColorGradeV2['curves'],
  ) => {
    if (onDispatch === undefined || curves === undefined) return;
    if (target === 'clip' && selectedClipId === undefined) return;
    const binding = colorPropertyBinding(
      target,
      `curves.${channel}`,
      target === 'clip' ? selectedClipId : undefined,
    );
    const localTimeUs =
      target === 'clip'
        ? Math.max(
            0,
            Math.min(
              selectedClipDurationUs ?? Number.MAX_SAFE_INTEGER,
              playheadUs - (selectedClipStartUs ?? playheadUs),
            ),
          )
        : playheadUs;
    const current = project.propertyAnimations?.[canonicalBindingKey(binding)];
    const isSnapshot = current?.value.kind === 'curve-snapshot';
    const hasKey =
      isSnapshot && current.value.samples.some((sample) => sample.timeUs === localTimeUs);
    const key = {
      kind: 'curve-snapshot' as const,
      timeUs: localTimeUs,
      channels: { [channel]: colorCurveToSnapshot(curves[channel]) },
      interpolation: 'linear',
    };
    onDispatch({
      label: `${hasKey ? 'Remove' : 'Add'} Color ${channel.toUpperCase()} curve keyframe`,
      commands: [
        hasKey
          ? { type: 'propertyAnimation.removeKey', payload: { binding, timeUs: localTimeUs } }
          : isSnapshot
            ? { type: 'propertyAnimation.setKey', payload: { binding, key } }
            : {
                type: 'propertyAnimation.replace',
                payload: {
                  binding,
                  value: { kind: 'curve-snapshot', samples: [key] },
                },
              },
      ],
    });
  };
  const toggleLutReferenceAnimation = () => {
    if (onDispatch === undefined || draft.lut === undefined) return;
    if (target === 'clip' && selectedClipId === undefined) return;
    const reference = colorLutReferenceIdentity(draft.lut);
    if (!isColorLutReferenceAvailable(reference, project.assets)) return;
    const binding = colorPropertyBinding(
      target,
      'lut.reference',
      target === 'clip' ? selectedClipId : undefined,
    );
    const localTimeUs =
      target === 'clip'
        ? Math.max(
            0,
            Math.min(
              selectedClipDurationUs ?? Number.MAX_SAFE_INTEGER,
              playheadUs - (selectedClipStartUs ?? playheadUs),
            ),
          )
        : playheadUs;
    const current = project.propertyAnimations?.[canonicalBindingKey(binding)];
    const isString = current?.value.kind === 'string';
    const hasKey = isString && current.value.keys.some((key) => key.timeUs === localTimeUs);
    const key = {
      kind: 'string' as const,
      timeUs: localTimeUs,
      value: encodeColorLutReference(draft.lut),
    };
    onDispatch({
      label: `${hasKey ? 'Remove' : 'Add'} Color look keyframe`,
      commands: [
        hasKey
          ? { type: 'propertyAnimation.removeKey', payload: { binding, timeUs: localTimeUs } }
          : isString
            ? { type: 'propertyAnimation.setKey', payload: { binding, key } }
            : {
                type: 'propertyAnimation.replace',
                payload: { binding, value: { kind: 'string', keys: [key] } },
              },
      ],
    });
  };
  const reset = () => {
    const next = createIdentityColorGrade();
    setDraft(next);
    commit(next);
  };
  const gradeIsIdentity = JSON.stringify(draft) === JSON.stringify(createIdentityColorGrade());

  return (
    <PanelShell
      title="Color"
      iconUrl={panelTabIconUrl('color')}
      className="color-panel"
      tabs={TABS}
      activeTab={tab}
      onTabChange={(id) => setTab(id as TabId)}
      actions={
        <button
          type="button"
          className="icon-button"
          aria-label="Reset color grade"
          title="Reset all color controls"
          disabled={gradeIsIdentity}
          onClick={reset}
        >
          ↺
        </button>
      }
    >
      <div className="color-target-bar" role="group" aria-label="Color target">
        <button
          type="button"
          className={target === 'clip' ? 'is-active' : ''}
          onClick={() => setTarget('clip')}
          disabled={!clipAvailable}
        >
          Clip{selectedClipName ? ` · ${selectedClipName}` : ''}
        </button>
        <button
          type="button"
          className={target === 'output' ? 'is-active' : ''}
          onClick={() => setTarget('output')}
        >
          Output
        </button>
        <button
          type="button"
          className="color-bypass"
          aria-label="Bypass current grade"
          onClick={() => {
            const next = { ...draft, enabled: !draft.enabled };
            setDraft(next);
            commit(next);
          }}
        >
          {draft.enabled ? 'Bypass' : 'Enable'}
        </button>
      </div>
      {target === 'clip' && !clipAvailable && (
        <p className="color-empty">Select one visual clip to grade it.</p>
      )}
      <fieldset
        className="color-controls"
        disabled={target === 'clip' && !clipAvailable}
        aria-label={target === 'clip' && !clipAvailable ? 'Color controls disabled' : undefined}
      >
        {tab === 'adjust' && (
          <AdjustSection
            draft={draft}
            onPatch={patchAdjust}
            onCommit={commit}
            animationStateFor={animationStateFor}
            onToggleAnimation={toggleNumericAnimation}
            canAnimate={onDispatch !== undefined}
          />
        )}
        {tab === 'wheels' && (
          <WheelsSection
            draft={draft}
            onChange={setDraft}
            onCommit={commit}
            animationStateFor={animationStateFor}
            onToggleAnimation={toggleNumericAnimation}
            canAnimate={onDispatch !== undefined}
          />
        )}
        {tab === 'curves' && (
          <CurvesSection
            draft={draft}
            onChange={setDraft}
            onCommit={commit}
            animationStateFor={animationStateFor}
            onToggleAnimation={toggleCurveAnimation}
            canAnimate={onDispatch !== undefined}
          />
        )}
        {tab === 'hsl' && (
          <HslSection
            draft={draft}
            onChange={setDraft}
            onCommit={commit}
            animationStateFor={animationStateFor}
            onToggleAnimation={toggleNumericAnimation}
            canAnimate={onDispatch !== undefined}
          />
        )}
        {tab === 'looks' && (
          <LooksSection
            draft={draft}
            onChange={setDraft}
            onCommit={commit}
            animationStateFor={animationStateFor}
            onToggleReference={toggleLutReferenceAnimation}
            canAnimate={onDispatch !== undefined}
            referenceAvailable={
              draft.lut === undefined
                ? true
                : isColorLutReferenceAvailable(colorLutReferenceIdentity(draft.lut), project.assets)
            }
          />
        )}
        {tab === 'scopes' && (
          <ScopeSection {...(readMonitorPixels === undefined ? {} : { readMonitorPixels })} />
        )}
      </fieldset>
      <div className="color-utility-row">
        <button type="button" onClick={() => setTab('scopes')}>
          ◒ Mini scopes
        </button>
        <button
          type="button"
          onClick={() => setDraft((value) => ({ ...value, enabled: !value.enabled }))}
        >
          A/B wipe
        </button>
        <button type="button" onClick={reset}>
          Reset all
        </button>
      </div>
      <div className="color-mini-scope">
        <ScopeCanvas readMonitorPixels={readMonitorPixels ?? readLiveMonitorPixels} compact />
      </div>
    </PanelShell>
  );
}

function AdjustSection({
  draft,
  onPatch,
  onCommit,
  animationStateFor,
  onToggleAnimation,
  canAnimate,
}: {
  draft: ColorGradeV2;
  onPatch: (key: string, value: number, finalize?: boolean) => void;
  onCommit: (next: ColorGradeV2) => void;
  animationStateFor: (propertyId: string) => PropertyAnimationState;
  onToggleAnimation: (propertyId: string, value: number, kind?: 'scalar' | 'hue') => void;
  canAnimate: boolean;
}) {
  const adjust = { ...IDENTITY_COLOR_ADJUSTMENTS, ...(draft.adjust ?? {}) };
  return (
    <section className="color-section">
      <h3>Primary adjustments</h3>
      {ADJUST_RANGES.map(([key, label, min, max, step]) => (
        <PropertyRow
          key={key}
          label={label}
          controlId={`color-adjust-${key}`}
          value={key === 'hue' ? `${adjust[key].toFixed(0)}°` : adjust[key].toFixed(2)}
          onReset={() => onPatch(key, step, true)}
          {...(!canAnimate
            ? {}
            : {
                animationState: animationStateFor(`adjust.${key}`),
                onToggleAnimation: () =>
                  onToggleAnimation(`adjust.${key}`, adjust[key], key === 'hue' ? 'hue' : 'scalar'),
              })}
        >
          <input
            id={`color-adjust-${key}`}
            type="range"
            min={min}
            max={max}
            step={key === 'hue' ? 1 : 0.01}
            value={adjust[key]}
            aria-label={label}
            onChange={(event) => onPatch(key, event.currentTarget.valueAsNumber)}
            onPointerUp={(event) => onPatch(key, event.currentTarget.valueAsNumber, true)}
            onDoubleClick={() => onPatch(key, step, true)}
          />
        </PropertyRow>
      ))}
      <button
        type="button"
        className="section-reset"
        onClick={() => onCommit({ ...draft, adjust: IDENTITY_COLOR_ADJUSTMENTS })}
      >
        Reset section
      </button>
    </section>
  );
}

function WheelsSection({
  draft,
  onChange,
  onCommit,
  animationStateFor,
  onToggleAnimation,
  canAnimate,
}: {
  draft: ColorGradeV2;
  onChange: (next: ColorGradeV2) => void;
  onCommit: (next: ColorGradeV2) => void;
  animationStateFor: (propertyId: string) => PropertyAnimationState;
  onToggleAnimation: (propertyId: string, value: number, kind?: 'scalar' | 'hue') => void;
  canAnimate: boolean;
}) {
  const wheels = { ...IDENTITY_COLOR_WHEELS, ...(draft.wheels ?? {}) };
  const update = (
    name: 'lift' | 'gamma' | 'gain' | 'offset',
    key: 'r' | 'g' | 'b' | 'master',
    value: number,
    commit = false,
  ) => {
    const next = { ...draft, wheels: { ...wheels, [name]: { ...wheels[name], [key]: value } } };
    onChange(next);
    if (commit) onCommit(next);
  };
  return (
    <section className="color-section">
      <h3>Lift · Gamma · Gain</h3>
      <div className="color-wheels-grid">
        {(['lift', 'gamma', 'gain', 'offset'] as const).map((name) => (
          <div className="color-wheel-card" key={name}>
            <div className={`color-wheel color-wheel--${name}`} aria-label={`${name} color wheel`}>
              <span>+</span>
            </div>
            <strong>{name}</strong>
            <PropertyRow
              label="Master"
              controlId={`color-wheel-${name}-master`}
              value={wheels[name].master.toFixed(2)}
              onReset={() => update(name, 'master', 0, true)}
              {...(!canAnimate
                ? {}
                : {
                    animationState: animationStateFor(`wheels.${name}.master`),
                    onToggleAnimation: () =>
                      onToggleAnimation(`wheels.${name}.master`, wheels[name].master),
                  })}
            >
              <input
                id={`color-wheel-${name}-master`}
                type="range"
                min={-1}
                max={1}
                step={0.01}
                value={wheels[name].master}
                onChange={(e) => update(name, 'master', e.currentTarget.valueAsNumber)}
                onPointerUp={(e) => update(name, 'master', e.currentTarget.valueAsNumber, true)}
              />
            </PropertyRow>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="section-reset"
        onClick={() => onCommit({ ...draft, wheels: IDENTITY_COLOR_WHEELS })}
      >
        Reset wheels
      </button>
    </section>
  );
}

function CurvesSection({
  draft,
  onChange,
  onCommit,
  animationStateFor,
  onToggleAnimation,
  canAnimate,
}: {
  draft: ColorGradeV2;
  onChange: (next: ColorGradeV2) => void;
  onCommit: (next: ColorGradeV2) => void;
  animationStateFor: (propertyId: string) => PropertyAnimationState;
  onToggleAnimation: (
    channel: 'rgb' | 'red' | 'green' | 'blue',
    curves: ColorGradeV2['curves'],
  ) => void;
  canAnimate: boolean;
}) {
  const [channel, setChannel] = useState<'rgb' | 'red' | 'green' | 'blue'>('rgb');
  const curves = { ...IDENTITY_COLOR_CURVES, ...(draft.curves ?? {}) };
  const points = curves[channel];
  const updatePoint = (index: number, y: number, finalize = false) => {
    const next = {
      ...draft,
      curves: {
        ...curves,
        [channel]: points.map((point, i) => (i === index ? { ...point, y } : point)),
      },
    };
    onChange(next);
    if (finalize) onCommit(next);
  };
  return (
    <section className="color-section">
      <h3>Curves</h3>
      <div className="curve-tabs">
        {(['rgb', 'red', 'green', 'blue'] as const).map((id) => (
          <button
            type="button"
            className={channel === id ? 'is-active' : ''}
            key={id}
            onClick={() => setChannel(id)}
          >
            {id.toUpperCase()}
          </button>
        ))}
      </div>
      <PropertyRow
        label={`${channel.toUpperCase()} curve`}
        value={canAnimate ? animationStateFor(`curves.${channel}`) : undefined}
        {...(!canAnimate
          ? {}
          : {
              animationState: animationStateFor(`curves.${channel}`),
              onToggleAnimation: () => onToggleAnimation(channel, curves),
            })}
      >
        <div className="curve-editor" aria-label={`${channel} curve`}>
          <svg viewBox="0 0 100 100" role="img">
            <path d="M0 100 L100 0" className="curve-grid-line" />
            {points.map((point, index) => (
              <circle
                key={`${point.x}-${index}`}
                cx={point.x * 100}
                cy={(1 - point.y) * 100}
                r="4"
                className="curve-point"
                onDoubleClick={() => updatePoint(index, point.x, true)}
              />
            ))}
          </svg>
        </div>
        <div className="curve-sliders">
          {points.map((point, index) => (
            <label key={index}>
              Point {index + 1}
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={point.y}
                onChange={(e) => updatePoint(index, e.currentTarget.valueAsNumber)}
                onPointerUp={(e) => updatePoint(index, e.currentTarget.valueAsNumber, true)}
              />
            </label>
          ))}
        </div>
      </PropertyRow>
      <button
        type="button"
        className="section-reset"
        onClick={() => onCommit({ ...draft, curves: IDENTITY_COLOR_CURVES })}
      >
        Reset curves
      </button>
    </section>
  );
}

function HslSection({
  draft,
  onChange,
  onCommit,
  animationStateFor,
  onToggleAnimation,
  canAnimate,
}: {
  draft: ColorGradeV2;
  onChange: (next: ColorGradeV2) => void;
  onCommit: (next: ColorGradeV2) => void;
  animationStateFor: (propertyId: string) => PropertyAnimationState;
  onToggleAnimation: (propertyId: string, value: number, kind?: 'scalar' | 'hue') => void;
  canAnimate: boolean;
}) {
  const bands = draft.hsl ?? IDENTITY_HSL_BANDS;
  const update = (
    index: number,
    key: 'hue' | 'hueWidth' | 'softness' | 'saturation' | 'luminance',
    value: number,
  ) => {
    const next = {
      ...draft,
      hsl: bands.map((band, i) => (i === index ? { ...band, [key]: value } : band)),
    };
    onChange(next);
    onCommit(next);
  };
  return (
    <section className="color-section">
      <h3>Hue bands</h3>
      {bands.map((band, index) => {
        const bandId = band.id ?? IDENTITY_HSL_BANDS[index]!.id!;
        return (
          <div className="hsl-band" key={bandId}>
            <span className="hsl-swatch" style={{ background: `hsl(${band.hue} 85% 55%)` }} />{' '}
            <strong>{bandId}</strong>
            <PropertyRow
              label="Saturation"
              controlId={`hsl-${bandId}-saturation`}
              value={band.saturation.toFixed(2)}
              onReset={() => update(index, 'saturation', 0)}
              {...(!canAnimate
                ? {}
                : {
                    animationState: animationStateFor(`hsl.${bandId}.saturation`),
                    onToggleAnimation: () =>
                      onToggleAnimation(`hsl.${bandId}.saturation`, band.saturation),
                  })}
            >
              <input
                id={`hsl-${bandId}-saturation`}
                aria-label={`${bandId} saturation`}
                type="range"
                min={-1}
                max={1}
                step={0.01}
                value={band.saturation}
                onChange={(e) => update(index, 'saturation', e.currentTarget.valueAsNumber)}
                onPointerUp={(e) => update(index, 'saturation', e.currentTarget.valueAsNumber)}
              />
            </PropertyRow>
          </div>
        );
      })}
    </section>
  );
}

function LooksSection({
  draft,
  onChange,
  onCommit,
  animationStateFor,
  onToggleReference,
  canAnimate,
  referenceAvailable,
}: {
  draft: ColorGradeV2;
  onChange: (next: ColorGradeV2) => void;
  onCommit: (next: ColorGradeV2) => void;
  animationStateFor: (propertyId: string) => PropertyAnimationState;
  onToggleReference: () => void;
  canAnimate: boolean;
  referenceAvailable: boolean;
}) {
  const looks = [
    ['none', 'None'],
    ['clean-contrast', 'Clean Contrast'],
    ['soft-film', 'Soft Film'],
    ['warm-cinema', 'Warm Cinema'],
    ['cool-fade', 'Cool Fade'],
    ['monochrome', 'Monochrome'],
  ] as const;
  const selected = draft.lut?.builtIn ?? 'none';
  return (
    <section className="color-section">
      <h3>Looks & LUTs</h3>
      <PropertyRow
        label="Look or LUT"
        value={selected}
        disabled={!referenceAvailable}
        {...(!canAnimate || !referenceAvailable
          ? {}
          : {
              animationState: animationStateFor('lut.reference'),
              onToggleAnimation: onToggleReference,
            })}
      >
        <div className="looks-grid">
          {looks.map(([id, label]) => (
            <button
              type="button"
              className={selected === id ? 'is-active' : ''}
              key={id}
              onClick={() => {
                const next = { ...draft, lut: { builtIn: id, intensity: 1 } };
                onChange(next);
                onCommit(next);
              }}
            >
              <span className={`look-thumb look-thumb--${id}`} />
              {label}
            </button>
          ))}
        </div>
      </PropertyRow>
      <label className="color-control">
        <span>LUT intensity</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={draft.lut?.intensity ?? 1}
          onChange={(e) =>
            onChange({
              ...draft,
              lut: { ...(draft.lut ?? {}), intensity: e.currentTarget.valueAsNumber },
            })
          }
          onPointerUp={(e) =>
            onCommit({
              ...draft,
              lut: { ...(draft.lut ?? {}), intensity: e.currentTarget.valueAsNumber },
            })
          }
        />
        <output>{(draft.lut?.intensity ?? 1).toFixed(2)}</output>
      </label>
      <p className="color-hint">
        Custom .cube LUT import is private, hashed, and portable across your devices.
      </p>
      {!referenceAvailable && (
        <p className="color-empty" role="alert">
          Restore this LUT before previewing or exporting the grade.
        </p>
      )}
    </section>
  );
}

function ScopeSection({
  readMonitorPixels,
}: {
  readMonitorPixels?: () => ScopePixels | undefined;
}) {
  const [scope, setScope] = useState<'waveform' | 'parade' | 'vectorscope' | 'histogram'>(
    'waveform',
  );
  return (
    <section className="color-section">
      <h3>Program scopes</h3>
      <div className="scope-source">
        <button type="button" className="is-active">
          Program
        </button>
        <button type="button">Selected clip</button>
      </div>
      <div className="scope-source" role="group" aria-label="Scope type">
        {(['waveform', 'parade', 'vectorscope', 'histogram'] as const).map((id) => (
          <button
            type="button"
            className={scope === id ? 'is-active' : ''}
            key={id}
            onClick={() => setScope(id)}
          >
            {id}
          </button>
        ))}
      </div>
      <ScopeCanvas scope={scope} readMonitorPixels={readMonitorPixels ?? readLiveMonitorPixels} />
    </section>
  );
}

function ScopeCanvas({
  readMonitorPixels,
  compact = false,
  scope = 'waveform',
}: {
  readMonitorPixels?: () => ScopePixels | undefined;
  compact?: boolean;
  scope?: 'waveform' | 'parade' | 'vectorscope' | 'histogram';
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const draw = () => {
      const canvas = ref.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const pixels = readMonitorPixels?.();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#17181c';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = '#45464c';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(0, (i * canvas.height) / 4);
        ctx.lineTo(canvas.width, (i * canvas.height) / 4);
        ctx.stroke();
      }
      if (!pixels) return;
      const scaleX = canvas.width / pixels.width;
      if (scope === 'histogram') {
        const bins = new Uint32Array(64);
        for (let offset = 0; offset < pixels.data.length; offset += 4) {
          const lum = Math.round(
            ((0.2126 * pixels.data[offset]! +
              0.7152 * pixels.data[offset + 1]! +
              0.0722 * pixels.data[offset + 2]!) /
              255) *
              63,
          );
          bins[lum] = (bins[lum] ?? 0) + 1;
        }
        const peak = Math.max(1, ...bins);
        ctx.fillStyle = '#e9b529';
        bins.forEach((value, index) =>
          ctx.fillRect(
            (index * canvas.width) / bins.length,
            canvas.height - (value / peak) * canvas.height,
            canvas.width / bins.length + 1,
            (value / peak) * canvas.height,
          ),
        );
      } else {
        for (let y = 0; y < pixels.height; y += 2)
          for (let x = 0; x < pixels.width; x += 2) {
            const offset = (y * pixels.width + x) * 4;
            const red = pixels.data[offset]! / 255;
            const green = pixels.data[offset + 1]! / 255;
            const blue = pixels.data[offset + 2]! / 255;
            const lum = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
            if (scope === 'vectorscope') {
              ctx.fillStyle = '#63d39b';
              ctx.fillRect(
                canvas.width / 2 + (red - lum) * 0.7 * canvas.width,
                canvas.height / 2 + (blue - lum) * 0.7 * canvas.height,
                1,
                1,
              );
            } else if (scope === 'parade') {
              const channel =
                x < pixels.width / 3 ? red : x < (pixels.width * 2) / 3 ? green : blue;
              ctx.fillStyle =
                x < pixels.width / 3
                  ? '#e66b70'
                  : x < (pixels.width * 2) / 3
                    ? '#65c988'
                    : '#6e9fe8';
              ctx.fillRect(
                x * scaleX,
                (1 - channel) * canvas.height,
                compact ? 1 : 2,
                compact ? 1 : 2,
              );
            } else {
              ctx.fillStyle = '#e9b529';
              ctx.fillRect(x * scaleX, (1 - lum) * canvas.height, compact ? 1 : 2, compact ? 1 : 2);
            }
          }
      }
    };
    draw();
    const timer = window.setInterval(draw, 84);
    return () => window.clearInterval(timer);
  }, [readMonitorPixels, compact, scope]);
  return (
    <canvas
      ref={ref}
      width={compact ? 240 : 420}
      height={compact ? 64 : 180}
      className="scope-canvas"
      aria-label="Luma waveform scope"
    />
  );
}

import {
  useContext,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
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
import { CloseIcon, LayersIcon } from './icons.js';
import { EditorPanelContext } from './editor-panel-context.js';
import {
  computeHistogram,
  computeParadeColumns,
  computeVectorscopePoints,
  computeWaveformColumns,
  sampleScopePixels,
  scopeAxisLabels,
  scopeLabel,
  VECTORSCOPE_HUE_MARKS,
  vectorscopeOffset,
  type ScopeKind,
  type ScopePixels,
  type ScopeSample,
} from './color-scopes.js';
import {
  clampColorScopesWindowGeometry,
  DEFAULT_COLOR_SCOPES_WINDOW_GEOMETRY,
  fitColorScopesWindowGeometry,
  loadColorScopesWindowGeometry,
  sameColorScopesWindowGeometry,
  saveColorScopesWindowGeometry,
  type ColorScopesWindowGeometry,
  type ViewportSize,
} from './color-scopes-window.js';

export type { ScopePixels };

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

const HSL_CONTROL_DEFINITIONS = [
  ['hue', 'Hue', 0, 359, 1, 'hue'],
  ['hueWidth', 'Range', 1, 180, 1, 'hue'],
  ['softness', 'Softness', 0, 1, 0.01, 'scalar'],
  ['saturation', 'Saturation', -1, 1, 0.01, 'scalar'],
  ['luminance', 'Luminance', -1, 1, 0.01, 'scalar'],
] as const;

interface ColorPanelProps {
  readonly title?: string;
  readonly project: JoyProjectV1;
  readonly onChange: (next: JoyProjectV1) => void;
  readonly onDispatch?: (transaction: VisualObjectTransaction) => void;
  readonly selectedClipId?: string;
  readonly selectedClipName?: string;
  readonly selectedClipStartUs?: number;
  readonly selectedClipDurationUs?: number;
  readonly playheadUs?: number;
  readonly readMonitorPixels?: () => ScopePixels | undefined;
  readonly onCreateFilterLayer?: () => void;
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

/** The size of the screen the floating window has to stay inside. */
function scopesWindowViewport(): ViewportSize | undefined {
  if (typeof window === 'undefined') return undefined;
  return { width: window.innerWidth, height: window.innerHeight };
}

export function ColorPanel({
  title = 'Color',
  project,
  onChange,
  onDispatch,
  selectedClipId,
  selectedClipName,
  selectedClipStartUs,
  selectedClipDurationUs,
  playheadUs = 0,
  readMonitorPixels,
  onCreateFilterLayer,
}: ColorPanelProps) {
  // App only passes selectedClipId after resolving a gradeable video clip from
  // the timeline project. The visual project intentionally has a different
  // composition graph, so validating against it would disable Clip mode.
  const clipAvailable = selectedClipId !== undefined;
  const [target, setTarget] = useState<'clip' | 'output'>(clipAvailable ? 'clip' : 'output');
  const [tab, setTab] = useState<TabId>('adjust');
  const editorContext = useContext(EditorPanelContext);
  const showToast = editorContext?.showToast;
  const [scopesWindowOpen, setScopesWindowOpen] = useState(false);
  const scopesButtonRef = useRef<HTMLButtonElement>(null);
  const scopesWindowWasOpen = useRef(false);
  const [scopesWindowGeometry, setScopesWindowGeometry] = useState<ColorScopesWindowGeometry>(
    () => {
      // A position remembered on a bigger screen is fitted back into this one,
      // so the window never comes back where it cannot be reached.
      const viewport = scopesWindowViewport();
      const stored = loadColorScopesWindowGeometry(editorContext?.storage, viewport);
      if (stored !== undefined) return stored;
      return viewport === undefined
        ? DEFAULT_COLOR_SCOPES_WINDOW_GEOMETRY
        : fitColorScopesWindowGeometry(DEFAULT_COLOR_SCOPES_WINDOW_GEOMETRY, viewport);
    },
  );
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

  // The floating scopes window keeps its place between sessions, so a colourist
  // finds it where they left it. The write is debounced because dragging the
  // window reports a new geometry on every pointer move.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveColorScopesWindowGeometry(editorContext?.storage, scopesWindowGeometry);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [editorContext?.storage, scopesWindowGeometry]);

  // A window that was on screen when the viewport was larger has to follow
  // the screen down: it is pulled back inside whenever the viewport changes.
  useEffect(() => {
    const onResize = () => {
      const viewport = scopesWindowViewport();
      if (viewport === undefined) return;
      setScopesWindowGeometry((current) => {
        const next = fitColorScopesWindowGeometry(current, viewport);
        return sameColorScopesWindowGeometry(current, next) ? current : next;
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // The window takes the focus when it opens, so it has to give it back when
  // it closes: the colourist continues where they left off.
  useEffect(() => {
    if (scopesWindowWasOpen.current && !scopesWindowOpen) scopesButtonRef.current?.focus();
    scopesWindowWasOpen.current = scopesWindowOpen;
  }, [scopesWindowOpen]);

  const commit = (next: ColorGradeV2 = draft) => {
    if (target === 'clip' && (!clipAvailable || selectedClipId === undefined)) return;
    const nextKey = JSON.stringify(next);
    if (draftKey.current === nextKey) return;
    draftKey.current = nextKey;
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
  /**
   * A reset throws away every colour control at once, so it offers an Undo:
   * the toast puts the grade the colourist had back.
   */
  const resetWithUndo = () => {
    const previous = draft;
    reset();
    showToast?.('Colour grade reset.', 'info', {
      label: 'Undo',
      run: () => {
        setDraft(previous);
        commit(previous);
      },
    });
  };
  const gradeIsIdentity = JSON.stringify(draft) === JSON.stringify(createIdentityColorGrade());

  return (
    <PanelShell
      title={title}
      iconUrl={panelTabIconUrl('color')}
      className="color-panel"
      tabs={TABS}
      activeTab={tab}
      onTabChange={(id) => setTab(id as TabId)}
      actions={
        <>
          {title === 'Filters' && (
            <button
              type="button"
              className="icon-button"
              aria-label="Add Filters layer"
              title="Add a parented Filters layer"
              disabled={onCreateFilterLayer === undefined}
              onClick={onCreateFilterLayer}
            >
              <LayersIcon />
            </button>
          )}
          <button
            type="button"
            ref={scopesButtonRef}
            className="color-header-button"
            aria-pressed={scopesWindowOpen}
            title="Open the scopes in a window you can move and resize"
            onClick={() => setScopesWindowOpen((open) => !open)}
          >
            ◒ Scopes
          </button>
          <button
            type="button"
            className="color-header-button"
            aria-label="Reset all color controls"
            title="Reset all color controls"
            disabled={gradeIsIdentity}
            onClick={resetWithUndo}
          >
            ↺ Reset all
          </button>
        </>
      }
    >
      <div className="color-target-bar" role="group" aria-label="Color target">
        <button
          type="button"
          className={target === 'clip' ? 'is-active' : ''}
          title="Grade only the selected clip"
          onClick={() => setTarget('clip')}
          disabled={!clipAvailable}
        >
          Clip{selectedClipName ? ` · ${selectedClipName}` : ''}
        </button>
        <button
          type="button"
          className={target === 'output' ? 'is-active' : ''}
          title="Grade the whole program output"
          onClick={() => setTarget('output')}
        >
          Output
        </button>
        <button
          type="button"
          className="color-bypass"
          aria-label="Bypass current grade"
          title={draft.enabled ? 'Turn the grade off without losing it' : 'Turn the grade back on'}
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
            onToggleAnimation={toggleNumericAnimation}
            canAnimate={onDispatch !== undefined}
            {...(draft.lut?.assetId === undefined ||
            project.assets[draft.lut.assetId]?.displayName === undefined
              ? {}
              : { customLutName: project.assets[draft.lut.assetId]!.displayName })}
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
      {scopesWindowOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <FloatingScopesWindow
            readMonitorPixels={readMonitorPixels ?? readLiveMonitorPixels}
            geometry={scopesWindowGeometry}
            onGeometryChange={setScopesWindowGeometry}
            onClose={() => setScopesWindowOpen(false)}
          />,
          document.body,
        )}
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
            onBlur={(event) => onPatch(key, event.currentTarget.valueAsNumber, true)}
            onKeyUp={(event) => {
              if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End')
                onPatch(key, event.currentTarget.valueAsNumber, true);
            }}
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
                onBlur={(e) => update(name, 'master', e.currentTarget.valueAsNumber, true)}
                onKeyUp={(e) => {
                  if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End')
                    update(name, 'master', e.currentTarget.valueAsNumber, true);
                }}
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

export function HslSection({
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
    finalize = false,
  ) => {
    const next = {
      ...draft,
      hsl: bands.map((band, i) => (i === index ? { ...band, [key]: value } : band)),
    };
    onChange(next);
    if (finalize) onCommit(next);
  };
  return (
    <section className="color-section">
      <h3>Hue bands</h3>
      {bands.map((band, index) => {
        const bandId = band.id ?? IDENTITY_HSL_BANDS[index]!.id!;
        const bandLabel = `${bandId[0]!.toUpperCase()}${bandId.slice(1)}`;
        const identityBand = IDENTITY_HSL_BANDS[index]!;
        return (
          <details className="hsl-band" key={bandId}>
            <summary>
              <span
                className="hsl-swatch"
                style={{ background: `hsl(${band.hue} 85% 55%)` }}
                aria-hidden="true"
              />
              <strong>{bandLabel}</strong>
              <span>{Math.round(band.hue)}° center</span>
            </summary>
            <div className="hsl-band-controls">
              {HSL_CONTROL_DEFINITIONS.map(([key, label, min, max, step, valueKind]) => {
                const value = band[key];
                const propertyId = `hsl.${bandId}.${key}`;
                const controlId = `hsl-${bandId}-${key}`;
                const rowLabel = `${bandLabel} ${label}`;
                const resetValue = identityBand[key];
                return (
                  <PropertyRow
                    key={key}
                    label={rowLabel}
                    controlId={controlId}
                    value={valueKind === 'hue' ? `${value.toFixed(0)}°` : value.toFixed(2)}
                    onReset={() => update(index, key, resetValue, true)}
                    {...(!canAnimate
                      ? {}
                      : {
                          animationState: animationStateFor(propertyId),
                          onToggleAnimation: () => onToggleAnimation(propertyId, value, valueKind),
                        })}
                  >
                    <input
                      id={controlId}
                      aria-label={rowLabel}
                      type="range"
                      min={min}
                      max={max}
                      step={step}
                      value={value}
                      onChange={(event) => update(index, key, event.currentTarget.valueAsNumber)}
                      onPointerUp={(event) =>
                        update(index, key, event.currentTarget.valueAsNumber, true)
                      }
                      onBlur={(event) =>
                        update(index, key, event.currentTarget.valueAsNumber, true)
                      }
                      onKeyUp={(event) => {
                        if (
                          event.key.startsWith('Arrow') ||
                          event.key === 'Home' ||
                          event.key === 'End'
                        )
                          update(index, key, event.currentTarget.valueAsNumber, true);
                      }}
                      onDoubleClick={() => update(index, key, resetValue, true)}
                    />
                  </PropertyRow>
                );
              })}
            </div>
          </details>
        );
      })}
      <button
        type="button"
        className="section-reset"
        onClick={() => onCommit({ ...draft, hsl: IDENTITY_HSL_BANDS })}
      >
        Reset hue bands
      </button>
    </section>
  );
}

/**
 * One line per built-in look, describing what it actually does to the picture.
 * Every line is pinned to the renderer's `applyBuiltInLook`
 * (`packages/renderer-pixi/src/color-grade-math.ts`) by
 * `color-look-notes.test.ts`, so the words cannot drift away from the maths.
 */
export const LOOK_NOTES = {
  none: 'No look: the picture is left exactly as the grade made it.',
  'clean-contrast':
    'Every channel is stretched 1.22× about the mid grey: more contrast, stronger colours, grey stays grey.',
  'soft-film':
    'Lifts the blacks to about 3 %, rolls the highlights off below white and warms the picture: red is raised, blue is pulled down.',
  'warm-cinema':
    'Adds red to the shadows and takes blue out of the highlights: warm shadows, cool highlights.',
  'cool-fade':
    'Lifts the shadows and adds the most blue there, leaving the highlights nearly alone: a cool, faded look.',
  monochrome: 'Turns the picture into grey, keeping the grade’s own light and contrast.',
} as const;

export function LooksSection({
  draft,
  onChange,
  onCommit,
  animationStateFor,
  onToggleReference,
  onToggleAnimation,
  canAnimate,
  customLutName,
  referenceAvailable,
}: {
  draft: ColorGradeV2;
  onChange: (next: ColorGradeV2) => void;
  onCommit: (next: ColorGradeV2) => void;
  animationStateFor: (propertyId: string) => PropertyAnimationState;
  onToggleReference: () => void;
  onToggleAnimation: (propertyId: string, value: number, kind?: 'scalar' | 'hue') => void;
  canAnimate: boolean;
  customLutName?: string;
  referenceAvailable: boolean;
}) {
  const builtInLooks = [
    ['none', 'None'],
    ['clean-contrast', 'Clean Contrast'],
    ['soft-film', 'Soft Film'],
    ['warm-cinema', 'Warm Cinema'],
    ['cool-fade', 'Cool Fade'],
    ['monochrome', 'Monochrome'],
  ] as const;
  const customId = draft.lut?.assetId === undefined ? undefined : `asset:${draft.lut.assetId}`;
  const selected = customId ?? draft.lut?.builtIn ?? 'none';
  const intensity = draft.lut?.intensity ?? 1;
  const updateIntensity = (value: number, finalize = false) => {
    const next = { ...draft, lut: { ...(draft.lut ?? {}), intensity: value } };
    onChange(next);
    if (finalize) onCommit(next);
  };
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
          {builtInLooks.map(([id, label]) => (
            <button
              type="button"
              className={`look-card${selected === id ? ' is-active' : ''}`}
              key={id}
              onClick={() => {
                const next = { ...draft, lut: { builtIn: id, intensity: 1 } };
                onChange(next);
                onCommit(next);
              }}
            >
              <span className={`look-thumb look-thumb--${id}`} />
              <span className="look-card-label">{label}</span>
              <span className="look-card-note">{LOOK_NOTES[id]}</span>
            </button>
          ))}
          {customId !== undefined && (
            <div className="look-card look-option is-active">
              <span className="look-thumb look-thumb--custom" />
              <span className="look-card-label">{customLutName ?? 'Custom LUT'}</span>
              <span className="look-card-note">A LUT file from the project library.</span>
            </div>
          )}
        </div>
      </PropertyRow>
      <PropertyRow
        label="LUT intensity"
        controlId="color-lut-intensity"
        value={intensity.toFixed(2)}
        disabled={!referenceAvailable}
        onReset={() => updateIntensity(1, true)}
        {...(!canAnimate || !referenceAvailable
          ? {}
          : {
              animationState: animationStateFor('lut.intensity'),
              onToggleAnimation: () => onToggleAnimation('lut.intensity', intensity),
            })}
      >
        <input
          id="color-lut-intensity"
          aria-label="LUT intensity"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={intensity}
          disabled={!referenceAvailable}
          onChange={(event) => updateIntensity(event.currentTarget.valueAsNumber)}
          onPointerUp={(event) => updateIntensity(event.currentTarget.valueAsNumber, true)}
          onBlur={(event) => updateIntensity(event.currentTarget.valueAsNumber, true)}
          onKeyUp={(event) => {
            if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End')
              updateIntensity(event.currentTarget.valueAsNumber, true);
          }}
          onDoubleClick={() => updateIntensity(1, true)}
        />
      </PropertyRow>
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
  const [scope, setScope] = useState<ScopeKind>('waveform');
  return (
    <section className="color-section">
      <h3>Program scopes</h3>
      <div className="scope-source" role="group" aria-label="Scope source">
        <button type="button" className="is-active" aria-pressed="true">
          Program
        </button>
        <button
          type="button"
          disabled
          title="Selected Clip scopes need clip-stage monitor readback"
        >
          Selected clip
        </button>
      </div>
      <ScopeTypeButtons scope={scope} onScopeChange={setScope} />
      <ScopeCanvas scope={scope} readMonitorPixels={readMonitorPixels ?? readLiveMonitorPixels} />
    </section>
  );
}

/** The scope picker, shared by the Scopes tab and the floating window. */
function ScopeTypeButtons({
  scope,
  onScopeChange,
}: {
  scope: ScopeKind;
  onScopeChange: (scope: ScopeKind) => void;
}) {
  return (
    <div className="scope-source" role="group" aria-label="Scope type">
      {(['waveform', 'parade', 'vectorscope', 'histogram'] as const).map((id) => (
        <button
          type="button"
          className={scope === id ? 'is-active' : ''}
          key={id}
          aria-pressed={scope === id}
          onClick={() => onScopeChange(id)}
        >
          {scopeLabel(id)}
        </button>
      ))}
    </div>
  );
}

const SCOPE_BACKGROUND = '#17181c';
const SCOPE_GRID = '#45464c';
const SCOPE_WAVEFORM = '#e9b529';
const SCOPE_RED = '#e66b70';
const SCOPE_GREEN = '#65c988';
const SCOPE_BLUE = '#6e9fe8';
const SCOPE_VECTOR = '#63d39b';
const SCOPE_LABEL = 'rgba(224, 226, 232, 0.72)';
const SCOPE_AXIS_FONT = '10px Inter, system-ui, sans-serif';

interface ScopePlot {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function drawScopeGrid(ctx: CanvasRenderingContext2D, plot: ScopePlot): void {
  ctx.strokeStyle = SCOPE_GRID;
  ctx.lineWidth = 1;
  for (let index = 1; index < 4; index += 1) {
    const y = Math.round((index * plot.height) / 4) + 0.5;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.width, y);
    ctx.stroke();
  }
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  plot: ScopePlot,
  samples: readonly ScopeSample[],
  width: number,
): void {
  ctx.fillStyle = SCOPE_WAVEFORM;
  for (const column of computeWaveformColumns(samples, width)) {
    const x = plot.x + column.x * plot.width;
    const top = plot.y + (1 - column.high) * plot.height;
    const bottom = plot.y + (1 - column.low) * plot.height;
    ctx.fillRect(Math.round(x), Math.round(top), 1, Math.max(1, Math.round(bottom - top)));
  }
}

function drawParade(
  ctx: CanvasRenderingContext2D,
  plot: ScopePlot,
  samples: readonly ScopeSample[],
  width: number,
): void {
  const panelWidth = plot.width / 3;
  ctx.strokeStyle = SCOPE_GRID;
  ctx.lineWidth = 1;
  for (const panel of [1, 2]) {
    const x = Math.round(plot.x + panel * panelWidth) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.height);
    ctx.stroke();
  }
  const colours = [SCOPE_RED, SCOPE_GREEN, SCOPE_BLUE];
  for (const column of computeParadeColumns(samples, width)) {
    const x = plot.x + column.panel * panelWidth + column.x * panelWidth;
    const top = plot.y + (1 - column.high) * plot.height;
    const bottom = plot.y + (1 - column.low) * plot.height;
    ctx.fillStyle = colours[column.panel]!;
    ctx.fillRect(Math.round(x), Math.round(top), 1, Math.max(1, Math.round(bottom - top)));
  }
}

function drawHistogram(
  ctx: CanvasRenderingContext2D,
  plot: ScopePlot,
  samples: readonly ScopeSample[],
): void {
  const bins = computeHistogram(samples, 64);
  const peak = Math.max(1, ...bins);
  const barWidth = plot.width / bins.length;
  ctx.fillStyle = SCOPE_WAVEFORM;
  bins.forEach((value, index) => {
    const barHeight = (value / peak) * plot.height;
    ctx.fillRect(
      plot.x + index * barWidth,
      plot.y + plot.height - barHeight,
      Math.max(1, barWidth + 0.5),
      barHeight,
    );
  });
}

/**
 * The vectorscope plots chroma against a density grid: every sampled pixel
 * lands in a cell and the cell is drawn once, so a full frame stays cheap
 * enough to redraw twelve times a second.
 */
function drawVectorscope(
  ctx: CanvasRenderingContext2D,
  plot: ScopePlot,
  samples: readonly ScopeSample[],
): void {
  const radius = Math.max(1, Math.min(plot.width, plot.height) / 2 - 14);
  const centerX = plot.x + plot.width / 2;
  const centerY = plot.y + plot.height / 2;
  const grid = Math.max(8, Math.round(radius));
  const density = new Float32Array(grid * grid);
  for (const point of computeVectorscopePoints(samples)) {
    const cellX = Math.min(grid - 1, Math.max(0, Math.floor((point.x * 0.5 + 0.5) * grid)));
    const cellY = Math.min(grid - 1, Math.max(0, Math.floor((point.y * 0.5 + 0.5) * grid)));
    density[cellY * grid + cellX] = (density[cellY * grid + cellX] ?? 0) + 1;
  }
  const cellSize = (radius * 2) / grid;
  ctx.fillStyle = SCOPE_VECTOR;
  for (let cellY = 0; cellY < grid; cellY += 1) {
    for (let cellX = 0; cellX < grid; cellX += 1) {
      const value = density[cellY * grid + cellX] ?? 0;
      if (value === 0) continue;
      ctx.globalAlpha = Math.min(1, 0.3 + value / 40);
      ctx.fillRect(
        centerX - radius + cellX * cellSize,
        centerY - radius + cellY * cellSize,
        Math.max(1, cellSize),
        Math.max(1, cellSize),
      );
    }
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = SCOPE_GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(centerX - radius, centerY);
  ctx.lineTo(centerX + radius, centerY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(centerX, centerY - radius);
  ctx.lineTo(centerX, centerY + radius);
  ctx.stroke();
  ctx.font = SCOPE_AXIS_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const mark of VECTORSCOPE_HUE_MARKS) {
    const offset = vectorscopeOffset(mark.red, mark.green, mark.blue);
    const x = centerX + offset.x * radius;
    const y = centerY + offset.y * radius;
    ctx.strokeStyle = 'rgba(99, 211, 155, 0.4)';
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = SCOPE_VECTOR;
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = SCOPE_LABEL;
    ctx.fillText(mark.label, x + offset.x * 12, y + offset.y * 12);
  }
}

function drawScopeAxes(
  ctx: CanvasRenderingContext2D,
  plot: ScopePlot,
  scope: ScopeKind,
  width: number,
  height: number,
): void {
  ctx.fillStyle = SCOPE_LABEL;
  ctx.font = SCOPE_AXIS_FONT;
  if (scope === 'waveform' || scope === 'parade') {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const percent of [100, 75, 50, 25, 0]) {
      const y = plot.y + (1 - percent / 100) * plot.height;
      ctx.fillText(percent === 100 ? '100 %' : String(percent), plot.x - 6, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(
      scope === 'parade' ? 'red        green        blue' : 'image columns',
      plot.x + plot.width / 2,
      height - 4,
    );
    return;
  }
  if (scope === 'histogram') {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const percent of [0, 25, 50, 75, 100]) {
      const x = plot.x + (percent / 100) * plot.width;
      ctx.fillText(`${percent} %`, Math.min(width - 12, Math.max(12, x)), plot.y + plot.height + 3);
    }
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('luminance', plot.x + plot.width / 2, height - 3);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('pixels', plot.x + 3, plot.y + 2);
    return;
  }
  // The vectorscope is labelled by its hue marks; the ring is the 100 % mark.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('100 % ring', plot.x + 3, plot.y + 2);
}

function drawScope(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scope: ScopeKind,
  pixels: ScopePixels | undefined,
): void {
  ctx.fillStyle = SCOPE_BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  const gutterLeft = scope === 'waveform' || scope === 'parade' ? 32 : 6;
  const footer = scope === 'vectorscope' ? 4 : 16;
  const plot: ScopePlot = {
    x: gutterLeft,
    y: 0,
    width: Math.max(1, width - gutterLeft),
    height: Math.max(1, height - footer),
  };
  drawScopeGrid(ctx, plot);
  if (pixels !== undefined) {
    const samples = sampleScopePixels(pixels);
    if (scope === 'histogram') drawHistogram(ctx, plot, samples);
    else if (scope === 'vectorscope') drawVectorscope(ctx, plot, samples);
    else if (scope === 'parade') drawParade(ctx, plot, samples, pixels.width);
    else drawWaveform(ctx, plot, samples, pixels.width);
  }
  drawScopeAxes(ctx, plot, scope, width, height);
}

/**
 * The scope canvas. It draws at the screen's pixel ratio so the trace stays
 * sharp on a high density display, and it labels its axes: 0 to 100 per cent
 * on the level scopes, hue marks on the vectorscope.
 */
export function ScopeCanvas({
  readMonitorPixels,
  scope = 'waveform',
  className,
}: {
  readMonitorPixels?: () => ScopePixels | undefined;
  scope?: ScopeKind;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width) || canvas.width);
      const height = Math.max(1, Math.round(rect.height) || canvas.height);
      const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const bufferWidth = Math.max(1, Math.round(width * ratio));
      const bufferHeight = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== bufferWidth) canvas.width = bufferWidth;
      if (canvas.height !== bufferHeight) canvas.height = bufferHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawScope(ctx, width, height, scope, readMonitorPixels?.());
    };
    draw();
    const timer = window.setInterval(draw, 84);
    return () => window.clearInterval(timer);
  }, [readMonitorPixels, scope]);
  const axis = scopeAxisLabels(scope);
  return (
    <div className="scope-frame">
      <canvas
        ref={ref}
        width={420}
        height={180}
        className={className === undefined ? 'scope-canvas' : `scope-canvas ${className}`}
        role="img"
        aria-label={`${scopeLabel(scope)} scope analyzing final Program output`}
      />
      <p className="sr-only">
        {scopeLabel(scope)} scope. Horizontal axis: {axis.horizontal}. Vertical axis:{' '}
        {axis.vertical}.
      </p>
    </div>
  );
}

/**
 * The floating scopes window (T-K05).
 *
 * It follows the colourist across the sub-tabs: it stays open while the wheels,
 * curves or HSL bands are worked on, it can be dragged and resized, and it
 * comes back where it was left.
 */
function FloatingScopesWindow({
  readMonitorPixels,
  geometry,
  onGeometryChange,
  onClose,
}: {
  readonly readMonitorPixels?: () => ScopePixels | undefined;
  readonly geometry: ColorScopesWindowGeometry;
  readonly onGeometryChange: (next: ColorScopesWindowGeometry) => void;
  readonly onClose: () => void;
}) {
  const [scope, setScope] = useState<ScopeKind>('waveform');
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<
    | {
        readonly mode: 'move' | 'resize';
        readonly startX: number;
        readonly startY: number;
        readonly origin: ColorScopesWindowGeometry;
      }
    | undefined
  >(undefined);

  // The window takes the focus when it opens, so the colourist can reach every
  // scope control with the keyboard straight away.
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const startDrag = (mode: 'move' | 'resize') => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button') !== null) return;
    event.preventDefault();
    dragRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      origin: geometry,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag === undefined) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const viewport = scopesWindowViewport();
    if (viewport === undefined) return;
    onGeometryChange(
      clampColorScopesWindowGeometry(
        drag.mode === 'move'
          ? { ...drag.origin, x: drag.origin.x + deltaX, y: drag.origin.y + deltaY }
          : {
              ...drag.origin,
              width: drag.origin.width + deltaX,
              height: drag.origin.height + deltaY,
            },
        viewport,
      ),
    );
  };

  const stopDrag = (event: ReactPointerEvent<HTMLElement>) => {
    dragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      className="scope-window"
      role="dialog"
      aria-label="Program scopes"
      style={{
        left: `${geometry.x}px`,
        top: `${geometry.y}px`,
        width: `${geometry.width}px`,
        height: `${geometry.height}px`,
      }}
    >
      <div
        className="scope-window-header"
        onPointerDown={startDrag('move')}
        onPointerMove={onPointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        <strong className="scope-window-title">Scopes</strong>
        <span className="scope-window-hint">Drag to move</span>
        <button
          type="button"
          ref={closeButtonRef}
          className="icon-button"
          aria-label="Close scopes window"
          title="Close the scopes window"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="scope-window-body">
        <ScopeTypeButtons scope={scope} onScopeChange={setScope} />
        <ScopeCanvas
          scope={scope}
          {...(readMonitorPixels === undefined ? {} : { readMonitorPixels })}
          className="scope-window-canvas"
        />
      </div>
      <div
        className="scope-window-resize"
        aria-hidden="true"
        onPointerDown={startDrag('resize')}
        onPointerMove={onPointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      />
    </div>
  );
}

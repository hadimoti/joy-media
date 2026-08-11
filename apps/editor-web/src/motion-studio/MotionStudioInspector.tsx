import { useCallback, useMemo } from 'react';
import {
  hasKeyframeAtMotion,
  removeKeyframeAt,
  setKeyframeAt,
  type MotionLayer,
  type MotionLayerId,
  type MotionSceneDocument,
  type MotionTransform,
  type MotionTypography,
  type MotionFill,
  type MotionStroke,
  type MotionShadow,
  type MotionFilter,
  type SceneBackground,
  type BlendMode,
} from '@joy-media/motion-core';
import type { SceneCommand } from './state/sceneCommands.js';
import { UI_ICONS } from '../ui-icons.js';
import { MsTitle } from './MsTitle.js';
import {
  layerCapabilities,
  commonCapabilities,
  MOTION_BLEND_MODES,
  type AnimatablePath,
} from './state/motionCapabilities.js';
import { KeyframeDiamondIcon, StrokeIcon, ShadowIcon, FilterIcon } from './MsIcons.js';

/**
 * Curated content-creation fonts (fontiran pack), registered as @font-face
 * in public/assets/fonts/content-fonts.css. 'system-ui' is the fallback.
 */
const CONTENT_FONT_FAMILIES: readonly string[] = [
  'system-ui',
  'YekanBakh',
  'Vazin',
  'Tajrid',
  'Pulad',
  'Damoon Pro',
  'Bon',
  'Bonyade Koodak',
  'Shoor Pro',
  'Aviny',
  'Katibeh',
  'Tahrir',
  '898 Stencil',
  'Radio',
  'Falsafeh',
  'Paradox',
  'Gramophone',
  'Emkan Inline',
];

const TEXT_TRANSFORMS: readonly string[] = ['none', 'uppercase', 'lowercase', 'capitalize'];
const TEXT_ALIGNS: readonly string[] = ['left', 'center', 'right', 'justify'];
const STROKE_STYLES: readonly string[] = ['solid', 'dashed', 'dotted'];
const FILTER_KINDS: readonly string[] = [
  'blur',
  'brightness',
  'contrast',
  'saturation',
  'hueRotate',
  'grayscale',
  'sepia',
  'invert',
  'opacity',
];

export interface InspectorProps {
  readonly document: MotionSceneDocument;
  readonly selectedLayerIds: readonly MotionLayerId[];
  readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
  readonly playheadMs?: number;
}

function mixedPlaceholder(): string | number {
  return 'Mixed';
}

function isMixed<T>(values: readonly T[]): boolean {
  if (values.length === 0) return false;
  const first = values[0];
  return values.some((v) => v !== first);
}

function mixedNumber(values: readonly number[]): number | string {
  if (values.length === 0) return 0;
  return isMixed(values) ? mixedPlaceholder() : values[0]!;
}

function mixedString(values: readonly string[]): string {
  if (values.length === 0) return '';
  return isMixed(values) ? 'Mixed' : values[0]!;
}

function mixedBoolean(values: readonly boolean[]): boolean | 'mixed' {
  if (values.length === 0) return false;
  const first = values[0];
  return values.some((v) => v !== first) ? 'mixed' : first!;
}

function isMixedString(value: string | number): value is string {
  return typeof value === 'string';
}

interface KeyframeControls {
  readonly isActive: (property: string) => boolean;
  readonly toggle: (property: string, value: number) => void;
}

function keyframeControlProps(
  controls: KeyframeControls | undefined,
  property: string,
  value: number | undefined,
): {
  readonly diamond: boolean;
  readonly keyframeActive: boolean;
  readonly onToggleKeyframe?: () => void;
} {
  if (controls === undefined || value === undefined) {
    return { diamond: false, keyframeActive: false };
  }
  return {
    diamond: true,
    keyframeActive: controls.isActive(property),
    onToggleKeyframe: () => controls.toggle(property, value),
  };
}

function NumberRow({
  label,
  value,
  step,
  onChange,
  min,
  max,
  diamond,
  keyframeActive,
  onToggleKeyframe,
}: {
  readonly label: string | number;
  readonly value: number | string;
  readonly step: number;
  readonly onChange: (v: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly diamond?: boolean;
  readonly keyframeActive?: boolean;
  readonly onToggleKeyframe?: () => void;
}) {
  return (
    <div className="ms-inspector-row" key={label}>
      <label className="ms-inspector-label">{label}</label>
      {diamond && (
        <button
          type="button"
          className="ms-inspector-keyframe"
          aria-label="Toggle keyframe"
          aria-pressed={keyframeActive ?? false}
          title={keyframeActive ? 'Remove keyframe' : 'Add keyframe'}
          onClick={onToggleKeyframe}
        >
          <KeyframeDiamondIcon />
        </button>
      )}
      <input
        type="number"
        className="ms-inspector-input"
        value={typeof value === 'number' ? Math.round(value * 100) / 100 : value}
        step={step}
        min={min}
        max={max}
        placeholder={typeof value === 'string' ? value : undefined}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!isNaN(n)) onChange(n);
        }}
        disabled={typeof value === 'string'}
      />
    </div>
  );
}

function SelectRow({
  label,
  value,
  options,
  onChange,
  diamond,
  keyframeActive,
  onToggleKeyframe,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly onChange: (v: string) => void;
  readonly diamond?: boolean;
  readonly keyframeActive?: boolean;
  readonly onToggleKeyframe?: () => void;
}) {
  return (
    <div className="ms-inspector-row" key={label}>
      <label className="ms-inspector-label">{label}</label>
      {diamond && (
        <button
          type="button"
          className="ms-inspector-keyframe"
          aria-label="Toggle keyframe"
          aria-pressed={keyframeActive ?? false}
          title={keyframeActive ? 'Remove keyframe' : 'Add keyframe'}
          onClick={onToggleKeyframe}
        >
          <KeyframeDiamondIcon />
        </button>
      )}
      <select
        className="ms-inspector-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );
}

function ColorRow({
  label,
  color,
  opacity,
  onChange,
}: {
  readonly label: string;
  readonly color: string;
  readonly opacity: number | string;
  readonly onChange: (color: string, opacity: number) => void;
}) {
  return (
    <div className="ms-inspector-row" key={label}>
      <label className="ms-inspector-label">{label}</label>
      <input
        type="color"
        className="ms-inspector-color"
        value={color}
        onChange={(e) => onChange(e.target.value, typeof opacity === 'number' ? opacity : 1)}
      />
      <NumberRow
        label="Opacity"
        value={opacity}
        step={0.05}
        min={0}
        max={1}
        onChange={(v) => onChange(color, v)}
      />
    </div>
  );
}

function useSelectedLayers(
  document: MotionSceneDocument,
  selectedLayerIds: readonly MotionLayerId[],
) {
  return useMemo(
    () =>
      selectedLayerIds
        .map((id) => document.layers.find((l) => l.id === id))
        .filter((l): l is MotionLayer => Boolean(l)),
    [document, selectedLayerIds],
  );
}

function SceneInspector({
  document,
  dispatch,
}: {
  readonly document: MotionSceneDocument;
  readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
}) {
  const bg = document.background;

  const setBg = useCallback(
    (background: SceneBackground) =>
      dispatch('Set background', { type: 'scene.setSceneBackground', payload: { background } }),
    [dispatch],
  );
  const setDimensions = useCallback(
    (w: number, h: number) =>
      dispatch('Set dimensions', {
        type: 'scene.setDocumentDimensions',
        payload: { width: w, height: h },
      }),
    [dispatch],
  );
  const setDuration = useCallback(
    (durationMs: number) =>
      dispatch('Set duration', {
        type: 'scene.setDocumentDuration',
        payload: { durationMs: Math.max(100, durationMs) },
      }),
    [dispatch],
  );

  return (
    <aside className="ms-panel ms-right" aria-label="Inspector">
      <div className="ms-panel-header">
        <MsTitle iconSrc={UI_ICONS.crop} className="ms-panel-title">
          Scene
        </MsTitle>
      </div>
      <div className="ms-panel-body">
        <div className="ms-inspector-section">
          <h4 className="ms-inspector-section-title">Document</h4>
          <div className="ms-inspector-row">
            <label className="ms-inspector-label">Name</label>
            <span className="ms-inspector-readonly">{document.name}</span>
          </div>
          <NumberRow
            label="Width"
            value={document.width}
            step={1}
            min={1}
            onChange={(w) => setDimensions(w, document.height)}
          />
          <NumberRow
            label="Height"
            value={document.height}
            step={1}
            min={1}
            onChange={(h) => setDimensions(document.width, h)}
          />
          <NumberRow
            label="Duration"
            value={document.durationMs / 1000}
            step={0.1}
            min={0.1}
            onChange={(s) => setDuration(Math.round(s * 1000))}
          />
          <div className="ms-inspector-row">
            <label className="ms-inspector-label">Layers</label>
            <span className="ms-inspector-readonly">{document.layers.length}</span>
          </div>
        </div>

        <div className="ms-inspector-section">
          <MsTitle as="h4" iconSrc={UI_ICONS.colors} className="ms-inspector-section-title">
            Background
          </MsTitle>
          <SelectRow
            label="Kind"
            value={bg.kind}
            options={[
              'transparent',
              'solid',
              'gradient',
              'image',
              'video',
              'animated-gradient',
              'noise',
              'particles',
            ]}
            onChange={(kind) => setBg({ kind: kind as SceneBackground['kind'] })}
          />
          {bg.kind === 'solid' && (
            <ColorRow
              label="Fill"
              color={bg.color ?? '#000000'}
              opacity={bg.opacity ?? 1}
              onChange={(color, opacity) => setBg({ ...bg, color, opacity })}
            />
          )}
          {bg.kind === 'gradient' && bg.gradient && (
            <>
              <NumberRow
                label="Angle"
                value={bg.gradient.angle ?? 0}
                step={1}
                onChange={(angle) => setBg({ ...bg, gradient: { ...bg.gradient!, angle } })}
              />
              <NumberRow
                label="Opacity"
                value={bg.opacity ?? 1}
                step={0.05}
                min={0}
                max={1}
                onChange={(opacity) => setBg({ ...bg, opacity })}
              />
            </>
          )}
          {bg.kind !== 'solid' && bg.kind !== 'gradient' && (
            <NumberRow
              label="Opacity"
              value={bg.opacity ?? 1}
              step={0.05}
              min={0}
              max={1}
              onChange={(opacity) => setBg({ ...bg, opacity })}
            />
          )}
        </div>
      </div>
    </aside>
  );
}

function TransformSection({
  selected,
  dispatch,
  keyframes,
}: {
  readonly selected: readonly MotionLayer[];
  readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
  readonly keyframes: KeyframeControls | undefined;
}) {
  const xs = selected.map((l) => l.transform.x);
  const ys = selected.map((l) => l.transform.y);
  const ws = selected.map((l) => l.transform.width);
  const hs = selected.map((l) => l.transform.height);
  const rots = selected.map((l) => l.transform.rotationDeg);
  const ops = selected.map((l) => l.transform.opacity);
  const scaleXs = selected.map((l) => l.transform.scaleX);
  const scaleYs = selected.map((l) => l.transform.scaleY);

  const updateTransform = (patch: Partial<MotionTransform>) => {
    dispatch(
      'Set transform',
      ...selected.map<SceneCommand>((layer) => ({
        type: 'scene.setLayerTransform',
        payload: { layerId: layer.id, transform: patch },
      })),
    );
  };

  return (
    <div className="ms-inspector-section">
      <h4 className="ms-inspector-section-title">Transform</h4>
      <NumberRow
        label="X"
        value={mixedNumber(xs)}
        step={1}
        onChange={(v) => updateTransform({ x: v })}
        {...keyframeControlProps(keyframes, 'transform.x', xs[0])}
      />
      <NumberRow
        label="Y"
        value={mixedNumber(ys)}
        step={1}
        onChange={(v) => updateTransform({ y: v })}
        {...keyframeControlProps(keyframes, 'transform.y', ys[0])}
      />
      <NumberRow
        label="Width"
        value={mixedNumber(ws)}
        step={1}
        min={1}
        onChange={(v) => updateTransform({ width: Math.max(1, v) })}
        {...keyframeControlProps(keyframes, 'transform.width', ws[0])}
      />
      <NumberRow
        label="Height"
        value={mixedNumber(hs)}
        step={1}
        min={1}
        onChange={(v) => updateTransform({ height: Math.max(1, v) })}
        {...keyframeControlProps(keyframes, 'transform.height', hs[0])}
      />
      <NumberRow
        label="Rotation"
        value={mixedNumber(rots)}
        step={1}
        onChange={(v) => updateTransform({ rotationDeg: v })}
        {...keyframeControlProps(keyframes, 'transform.rotationDeg', rots[0])}
      />
      <NumberRow
        label="Scale X"
        value={mixedNumber(scaleXs)}
        step={0.05}
        min={-10}
        max={10}
        onChange={(v) => updateTransform({ scaleX: v })}
        {...keyframeControlProps(keyframes, 'transform.scaleX', scaleXs[0])}
      />
      <NumberRow
        label="Scale Y"
        value={mixedNumber(scaleYs)}
        step={0.05}
        min={-10}
        max={10}
        onChange={(v) => updateTransform({ scaleY: v })}
        {...keyframeControlProps(keyframes, 'transform.scaleY', scaleYs[0])}
      />
      <NumberRow
        label="Opacity"
        value={mixedNumber(ops)}
        step={0.05}
        min={0}
        max={1}
        onChange={(v) => updateTransform({ opacity: Math.min(1, Math.max(0, v)) })}
        {...keyframeControlProps(keyframes, 'transform.opacity', ops[0])}
      />
    </div>
  );
}

function TextSection({
  selected,
  dispatch,
  keyframes,
}: {
  readonly selected: readonly MotionLayer[];
  readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
  readonly keyframes: KeyframeControls | undefined;
}) {
  const texts = selected.map((l) => l.text ?? '');
  const fontFamilies = selected.map((l) => l.typography?.fontFamily ?? 'system-ui');
  const fontSizes = selected.map((l) => l.typography?.fontSize ?? 48);
  const lineHeights = selected.map((l) => l.typography?.lineHeight ?? 1.2);
  const letterSpacings = selected.map((l) => l.typography?.letterSpacing ?? 0);
  const wordSpacings = selected.map((l) => l.typography?.wordSpacing ?? 0);
  const paragraphSpacings = selected.map((l) => l.typography?.paragraphSpacing ?? 0);
  const fontWeights = selected.map((l) => l.typography?.fontWeight ?? 400);
  const textAligns = selected.map((l) => l.typography?.textAlign ?? 'center');
  const textTransforms = selected.map((l) => l.typography?.textTransform ?? 'none');
  const directions = selected.map((l) => l.typography?.direction ?? 'auto');

  const updateText = (text: string) =>
    dispatch(
      'Set text',
      ...selected.map<SceneCommand>((layer) => ({
        type: 'scene.setLayerText',
        payload: { layerId: layer.id, text },
      })),
    );
  const updateTypography = (patch: Partial<MotionTypography>) =>
    dispatch(
      'Set typography',
      ...selected.map<SceneCommand>((layer) => ({
        type: 'scene.setLayerTypography',
        payload: { layerId: layer.id, typography: patch },
      })),
    );

  return (
    <>
      <div className="ms-inspector-section">
        <h4 className="ms-inspector-section-title">Text</h4>
        <textarea
          className="ms-inspector-textarea"
          value={mixedString(texts)}
          onChange={(e) => !isMixed(texts) && updateText(e.target.value)}
          rows={3}
          placeholder="Enter text…"
        />
      </div>
      <div className="ms-inspector-section">
        <h4 className="ms-inspector-section-title">Typography</h4>
        <SelectRow
          label="Font Family"
          value={mixedString(fontFamilies)}
          options={CONTENT_FONT_FAMILIES}
          onChange={(v) => updateTypography({ fontFamily: v })}
        />
        <NumberRow
          label="Font Size"
          value={mixedNumber(fontSizes)}
          step={1}
          min={1}
          max={400}
          onChange={(v) => updateTypography({ fontSize: v })}
          {...keyframeControlProps(keyframes, 'typography.fontSize', fontSizes[0])}
        />
        <NumberRow
          label="Line Height"
          value={mixedNumber(lineHeights)}
          step={0.1}
          min={0.5}
          max={5}
          onChange={(v) => updateTypography({ lineHeight: v })}
          {...keyframeControlProps(keyframes, 'typography.lineHeight', lineHeights[0])}
        />
        <NumberRow
          label="Letter Spacing"
          value={mixedNumber(letterSpacings)}
          step={0.1}
          min={-20}
          max={100}
          onChange={(v) => updateTypography({ letterSpacing: v })}
          {...keyframeControlProps(keyframes, 'typography.letterSpacing', letterSpacings[0])}
        />
        <NumberRow
          label="Word Spacing"
          value={mixedNumber(wordSpacings)}
          step={0.1}
          min={-50}
          max={100}
          onChange={(v) => updateTypography({ wordSpacing: v })}
          {...keyframeControlProps(keyframes, 'typography.wordSpacing', wordSpacings[0])}
        />
        <NumberRow
          label="Paragraph Spacing"
          value={mixedNumber(paragraphSpacings)}
          step={0.1}
          min={0}
          max={200}
          onChange={(v) => updateTypography({ paragraphSpacing: v })}
          {...keyframeControlProps(keyframes, 'typography.paragraphSpacing', paragraphSpacings[0])}
        />
        <NumberRow
          label="Font Weight"
          value={mixedNumber(fontWeights)}
          step={100}
          min={100}
          max={900}
          onChange={(v) => updateTypography({ fontWeight: v })}
        />
        <SelectRow
          label="Text Align"
          value={mixedString(textAligns)}
          options={TEXT_ALIGNS}
          onChange={(v) => updateTypography({ textAlign: v as MotionTypography['textAlign'] })}
        />
        <SelectRow
          label="Text Transform"
          value={mixedString(textTransforms)}
          options={TEXT_TRANSFORMS}
          onChange={(v) =>
            updateTypography({ textTransform: v as MotionTypography['textTransform'] })
          }
        />
        <SelectRow
          label="Direction"
          value={mixedString(directions)}
          options={['auto', 'ltr', 'rtl']}
          onChange={(v) => updateTypography({ direction: v as MotionTypography['direction'] })}
        />
      </div>
    </>
  );
}

function FillSection({
  selected,
  dispatch,
  keyframes,
}: {
  readonly selected: readonly MotionLayer[];
  readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
  readonly keyframes: KeyframeControls | undefined;
}) {
  const firstFills = selected.map((l) => l.fills[0]);
  const colors = firstFills.map((f) => (f?.kind === 'solid' ? f.color : '#ffffff'));
  const opacities = firstFills.map((f) => (f?.kind === 'solid' ? f.opacity : 1));
  const kinds = firstFills.map((f) => f?.kind ?? 'solid');

  const updateFill = (patch: Partial<MotionFill>) => {
    dispatch(
      'Set fill',
      ...selected.map<SceneCommand>((layer) => {
        const existing = layer.fills[0] ?? { kind: 'solid', color: '#ffffff', opacity: 1 };
        const next = { ...existing, ...patch } as MotionFill;
        return { type: 'scene.setLayerFills', payload: { layerId: layer.id, fills: [next] } };
      }),
    );
  };

  return (
    <div className="ms-inspector-section">
      <MsTitle as="h4" iconSrc={UI_ICONS.paint} className="ms-inspector-section-title">
        Fill
      </MsTitle>
      <SelectRow
        label="Kind"
        value={mixedString(kinds)}
        options={['solid', 'gradient', 'transparent']}
        onChange={(v) => updateFill({ kind: v as MotionFill['kind'] })}
      />
      {(mixedString(kinds) === 'solid' || isMixedString(mixedString(kinds))) && (
        <ColorRow
          label="Fill"
          color={mixedString(colors)}
          opacity={mixedNumber(opacities)}
          onChange={(color, opacity) => updateFill({ kind: 'solid', color, opacity })}
        />
      )}
      {keyframes !== undefined && (
        <NumberRow
          label="Opacity"
          value={mixedNumber(opacities)}
          step={0.05}
          min={0}
          max={1}
          onChange={(v) => updateFill({ opacity: v })}
          {...keyframeControlProps(keyframes, 'fill.opacity', opacities[0])}
        />
      )}
    </div>
  );
}

function StrokeSection({
  selected,
  dispatch,
  keyframes,
}: {
  readonly selected: readonly MotionLayer[];
  readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
  readonly keyframes: KeyframeControls | undefined;
}) {
  const widths = selected.map((l) => l.strokes[0]?.width ?? 0);
  const colors = selected.map((l) => l.strokes[0]?.color ?? '#ffffff');
  const styles = selected.map((l) => l.strokes[0]?.style ?? 'solid');

  const updateStrokes = (patch: Partial<MotionStroke>) => {
    dispatch(
      'Set stroke',
      ...selected.map<SceneCommand>((layer) => {
        const existing = layer.strokes[0] ?? { color: '#ffffff', width: 2 };
        const next = { ...existing, ...patch } as MotionStroke;
        return { type: 'scene.setLayerStrokes', payload: { layerId: layer.id, strokes: [next] } };
      }),
    );
  };

  return (
    <div className="ms-inspector-section">
      <MsTitle as="h4" iconSrc={UI_ICONS.borderRadius} className="ms-inspector-section-title">
        <StrokeIcon /> Stroke
      </MsTitle>
      <NumberRow
        label="Width"
        value={mixedNumber(widths)}
        step={0.5}
        min={0}
        max={50}
        onChange={(v) => updateStrokes({ width: v })}
        {...keyframeControlProps(keyframes, 'stroke.width', widths[0])}
      />
      <div className="ms-inspector-row">
        <label className="ms-inspector-label">Color</label>
        <input
          type="color"
          className="ms-inspector-color"
          value={mixedString(colors)}
          onChange={(e) => updateStrokes({ color: e.target.value })}
        />
      </div>
      <SelectRow
        label="Style"
        value={mixedString(styles)}
        options={STROKE_STYLES}
        onChange={(v) => updateStrokes({ style: v as NonNullable<MotionStroke['style']> })}
      />
    </div>
  );
}

function ShadowSection({
  selected,
  dispatch,
  keyframes,
}: {
  readonly selected: readonly MotionLayer[];
  readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
  readonly keyframes: KeyframeControls | undefined;
}) {
  const xs = selected.map((l) => l.shadows[0]?.x ?? 0);
  const ys = selected.map((l) => l.shadows[0]?.y ?? 0);
  const blurs = selected.map((l) => l.shadows[0]?.blur ?? 0);
  const spreads = selected.map((l) => l.shadows[0]?.spread ?? 0);
  const colors = selected.map((l) => l.shadows[0]?.color ?? '#000000');
  const opacities = selected.map((l) => l.shadows[0]?.opacity ?? 1);
  const insets = selected.map((l) => l.shadows[0]?.inset ?? false);

  const updateShadows = (patch: Partial<MotionShadow>) => {
    dispatch(
      'Set shadow',
      ...selected.map<SceneCommand>((layer) => {
        const existing = layer.shadows[0] ?? {
          x: 0,
          y: 0,
          blur: 0,
          spread: 0,
          color: '#000000',
          opacity: 1,
          inset: false,
        };
        const next = { ...existing, ...patch } as MotionShadow;
        return { type: 'scene.setLayerShadows', payload: { layerId: layer.id, shadows: [next] } };
      }),
    );
  };

  return (
    <div className="ms-inspector-section">
      <MsTitle as="h4" iconSrc={UI_ICONS.opacity} className="ms-inspector-section-title">
        <ShadowIcon /> Shadow
      </MsTitle>
      <NumberRow
        label="X"
        value={mixedNumber(xs)}
        step={1}
        onChange={(v) => updateShadows({ x: v })}
      />
      <NumberRow
        label="Y"
        value={mixedNumber(ys)}
        step={1}
        onChange={(v) => updateShadows({ y: v })}
      />
      <NumberRow
        label="Blur"
        value={mixedNumber(blurs)}
        step={0.5}
        min={0}
        max={100}
        onChange={(v) => updateShadows({ blur: v })}
      />
      <NumberRow
        label="Spread"
        value={mixedNumber(spreads)}
        step={0.5}
        min={0}
        max={100}
        onChange={(v) => updateShadows({ spread: v })}
      />
      <NumberRow
        label="Opacity"
        value={mixedNumber(opacities)}
        step={0.05}
        min={0}
        max={1}
        onChange={(v) => updateShadows({ opacity: v })}
        {...keyframeControlProps(keyframes, 'shadow.opacity', opacities[0])}
      />
      <div className="ms-inspector-row">
        <label className="ms-inspector-label">Color</label>
        <input
          type="color"
          className="ms-inspector-color"
          value={mixedString(colors)}
          onChange={(e) => updateShadows({ color: e.target.value })}
        />
      </div>
      <div className="ms-inspector-row">
        <label className="ms-inspector-label">Inset</label>
        <input
          type="checkbox"
          checked={mixedBoolean(insets) === true}
          ref={(el) => {
            if (el) el.indeterminate = mixedBoolean(insets) === 'mixed';
          }}
          onChange={(e) => updateShadows({ inset: e.target.checked })}
        />
      </div>
    </div>
  );
}

function CornerRadiusSection({
  selected,
  dispatch,
}: {
  readonly selected: readonly MotionLayer[];
  readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
}) {
  const r0 = selected.map((l) => l.borderRadius[0]);
  const r1 = selected.map((l) => l.borderRadius[1]);
  const r2 = selected.map((l) => l.borderRadius[2]);
  const r3 = selected.map((l) => l.borderRadius[3]);

  const update = (index: 0 | 1 | 2 | 3, value: number) => {
    dispatch(
      'Set border radius',
      ...selected.map<SceneCommand>((layer) => {
        const next = [...layer.borderRadius] as [number, number, number, number];
        next[index] = value;
        return {
          type: 'scene.setLayerBorderRadius',
          payload: { layerId: layer.id, borderRadius: next },
        };
      }),
    );
  };

  return (
    <div className="ms-inspector-section">
      <MsTitle as="h4" iconSrc={UI_ICONS.borderRadius} className="ms-inspector-section-title">
        Corner Radius
      </MsTitle>
      <div className="ms-inspector-row ms-inspector-four">
        <NumberRow
          label="TL"
          value={mixedNumber(r0)}
          step={1}
          min={0}
          onChange={(v) => update(0, v)}
        />
        <NumberRow
          label="TR"
          value={mixedNumber(r1)}
          step={1}
          min={0}
          onChange={(v) => update(1, v)}
        />
        <NumberRow
          label="BR"
          value={mixedNumber(r2)}
          step={1}
          min={0}
          onChange={(v) => update(2, v)}
        />
        <NumberRow
          label="BL"
          value={mixedNumber(r3)}
          step={1}
          min={0}
          onChange={(v) => update(3, v)}
        />
      </div>
    </div>
  );
}

function BlendModeSection({
  selected,
  dispatch,
}: {
  readonly selected: readonly MotionLayer[];
  readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
}) {
  const values = selected.map((l) => l.blendMode);

  const update = (blendMode: BlendMode) =>
    dispatch(
      'Set blend mode',
      ...selected.map<SceneCommand>((layer) => ({
        type: 'scene.setLayerProperty',
        payload: { layerId: layer.id, property: 'blendMode', value: blendMode },
      })),
    );

  return (
    <div className="ms-inspector-section">
      <MsTitle as="h4" iconSrc={UI_ICONS.blend} className="ms-inspector-section-title">
        Blend Mode
      </MsTitle>
      <SelectRow
        label="Blend"
        value={mixedString(values)}
        options={MOTION_BLEND_MODES}
        onChange={(v) => update(v as BlendMode)}
      />
    </div>
  );
}

function SimpleFilterSection({
  selected,
  dispatch,
  keyframes,
}: {
  readonly selected: readonly MotionLayer[];
  readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
  readonly keyframes: KeyframeControls | undefined;
}) {
  const firsts = selected.map((l) => l.filters[0]);
  const kinds = firsts.map((f) => f?.kind ?? 'blur');
  const values = firsts.map((f) => (f && 'value' in f ? f.value : 0));

  const updateFilters = (patch: Partial<MotionFilter>) => {
    dispatch(
      'Set filter',
      ...selected.map<SceneCommand>((layer) => {
        const existing = layer.filters[0] ?? { kind: 'blur', value: 0 };
        const next = { ...existing, ...patch } as MotionFilter;
        return {
          type: 'scene.setLayerProperty',
          payload: { layerId: layer.id, property: 'filters', value: [next] },
        };
      }),
    );
  };

  return (
    <div className="ms-inspector-section">
      <MsTitle as="h4" iconSrc={UI_ICONS.opacity} className="ms-inspector-section-title">
        <FilterIcon /> Filter
      </MsTitle>
      <SelectRow
        label="Kind"
        value={mixedString(kinds)}
        options={FILTER_KINDS}
        onChange={(v) => updateFilters({ kind: v as MotionFilter['kind'] })}
      />
      <NumberRow
        label="Value"
        value={mixedNumber(values)}
        step={1}
        min={0}
        max={1000}
        onChange={(v) => updateFilters({ value: v })}
        {...keyframeControlProps(keyframes, 'filter.value', values[0])}
      />
    </div>
  );
}

function LayerInspector({
  selected,
  dispatch,
  playheadMs,
}: {
  readonly selected: readonly MotionLayer[];
  readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
  readonly playheadMs: number;
}) {
  const isMulti = selected.length > 1;
  const types = selected.map((l) => l.type);
  const first = selected[0]!;
  const capabilities = layerCapabilities(first.type);
  const sections = useMemo(
    () => (isMulti ? commonCapabilities(types) : layerCapabilities(types[0]!).sections),
    [isMulti, types],
  );
  const isAnimatable = (property: string): property is AnimatablePath =>
    capabilities.animatable.includes(property as AnimatablePath);
  const keyframes: KeyframeControls | undefined = isMulti
    ? undefined
    : {
        isActive: (property) => {
          if (!isAnimatable(property)) return false;
          return hasKeyframeAtMotion(
            first.animations.find((animation) => animation.property === property),
            playheadMs,
          );
        },
        toggle: (property, value) => {
          if (!isAnimatable(property)) return;
          const existing = first.animations.find((animation) => animation.property === property);
          const animations = hasKeyframeAtMotion(existing, playheadMs)
            ? removeKeyframeAt(first.animations, property, playheadMs)
            : setKeyframeAt(first.animations, property, playheadMs, value);
          dispatch('Toggle keyframe', {
            type: 'scene.setLayerAnimations',
            payload: { layerId: first.id, animations },
          });
        },
      };

  return (
    <aside className="ms-panel ms-right" aria-label="Inspector">
      <div className="ms-panel-header">
        <h3 className="ms-panel-title">{isMulti ? `${selected.length} selected` : first.name}</h3>
      </div>
      <div className="ms-panel-body">
        {sections.includes('transform') && (
          <TransformSection selected={selected} dispatch={dispatch} keyframes={keyframes} />
        )}
        {sections.includes('text') && (
          <TextSection selected={selected} dispatch={dispatch} keyframes={keyframes} />
        )}
        {sections.includes('fill') && (
          <FillSection selected={selected} dispatch={dispatch} keyframes={keyframes} />
        )}
        {sections.includes('stroke') && (
          <StrokeSection selected={selected} dispatch={dispatch} keyframes={keyframes} />
        )}
        {sections.includes('shadow') && (
          <ShadowSection selected={selected} dispatch={dispatch} keyframes={keyframes} />
        )}
        {sections.includes('cornerRadius') && (
          <CornerRadiusSection selected={selected} dispatch={dispatch} />
        )}
        {sections.includes('blendMode') && (
          <BlendModeSection selected={selected} dispatch={dispatch} />
        )}
        {sections.includes('filter') && (
          <SimpleFilterSection selected={selected} dispatch={dispatch} keyframes={keyframes} />
        )}
      </div>
    </aside>
  );
}

export function MotionStudioInspector({
  document,
  selectedLayerIds,
  dispatch,
  playheadMs = 0,
}: InspectorProps) {
  const selected = useSelectedLayers(document, selectedLayerIds);
  if (selected.length === 0) {
    return <SceneInspector document={document} dispatch={dispatch} />;
  }
  return <LayerInspector selected={selected} dispatch={dispatch} playheadMs={playheadMs} />;
}

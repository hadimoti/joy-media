import { useCallback } from 'react';
import type {
  MotionLayer,
  MotionTransform,
  MotionTypography,
  MotionFill,
  MotionSceneDocument,
  SceneBackground,
} from '@joy-media/motion-core';
import type { SceneCommand } from './state/sceneCommands.js';

/**
 * Curated content-creation fonts (fontiran pack), registered as @font-face
 * in public/assets/fonts/content-fonts.css. 'system-ui' is the fallback
 * used before the user picks anything.
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
  'Edameh Pro',
  'Paradox',
  'Gramophone',
  'Emkan Inline',
];

interface InspectorProps {
  readonly layer: MotionLayer | undefined;
  readonly document: MotionSceneDocument;
  readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
}

function numberInput(
  label: string,
  value: number,
  step: number,
  onChange: (v: number) => void,
  min?: number,
  max?: number,
) {
  return (
    <div className="ms-inspector-row" key={label}>
      <label className="ms-inspector-label">{label}</label>
      <input
        type="number"
        className="ms-inspector-input"
        value={Math.round(value * 100) / 100}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) onChange(v);
        }}
      />
    </div>
  );
}

function selectInput(
  label: string,
  value: string,
  options: readonly string[],
  onChange: (v: string) => void,
) {
  return (
    <div className="ms-inspector-row" key={label}>
      <label className="ms-inspector-label">{label}</label>
      <select
        className="ms-inspector-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%' }}
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

export function MotionStudioInspector({ layer, document, dispatch }: InspectorProps) {
  const layerId = layer?.id ?? '';

  const setBg = useCallback(
    (background: SceneBackground) => {
      dispatch('Set background', { type: 'scene.setSceneBackground', payload: { background } });
    },
    [dispatch],
  );

  const setTransform = useCallback(
    (patch: Partial<MotionTransform>) => {
      if (!layerId) return;
      dispatch('Set transform', {
        type: 'scene.setLayerTransform',
        payload: { layerId, transform: patch },
      });
    },
    [dispatch, layerId],
  );

  const setText = useCallback(
    (text: string) => {
      if (!layerId) return;
      dispatch('Set text', { type: 'scene.setLayerText', payload: { layerId, text } });
    },
    [dispatch, layerId],
  );

  const setTypography = useCallback(
    (patch: Partial<MotionTypography>) => {
      if (!layerId) return;
      dispatch('Set typography', {
        type: 'scene.setLayerTypography',
        payload: { layerId, typography: patch },
      });
    },
    [dispatch, layerId],
  );

  const setFill = useCallback(
    (fill: MotionFill) => {
      if (!layerId) return;
      dispatch('Set fill', { type: 'scene.setLayerFills', payload: { layerId, fills: [fill] } });
    },
    [dispatch, layerId],
  );

  if (!layer) {
    const bg = document.background;

    return (
      <aside className="ms-panel ms-right" aria-label="Inspector">
        <div className="ms-panel-header">
          <h3 className="ms-panel-title">Scene</h3>
        </div>
        <div className="ms-panel-body">
          <div className="ms-inspector-section">
            <h4 className="ms-inspector-section-title">Document</h4>
            <div className="ms-inspector-row">
              <label className="ms-inspector-label">Name</label>
              <span style={{ fontSize: '12px', color: 'var(--joy-text)' }}>{document.name}</span>
            </div>
            <div className="ms-inspector-row">
              <label className="ms-inspector-label">Size</label>
              <span style={{ fontSize: '12px', color: 'var(--joy-text-muted)' }}>
                {document.width}x{document.height}
              </span>
            </div>
            <div className="ms-inspector-row">
              <label className="ms-inspector-label">Duration</label>
              <span style={{ fontSize: '12px', color: 'var(--joy-text-muted)' }}>
                {(document.durationMs / 1000).toFixed(1)}s
              </span>
            </div>
          </div>

          <div className="ms-inspector-section">
            <h4 className="ms-inspector-section-title">Background</h4>
            {selectInput(
              'Kind',
              bg.kind,
              [
                'transparent',
                'solid',
                'gradient',
                'image',
                'video',
                'animated-gradient',
                'noise',
                'particles',
              ],
              (kind) => setBg({ kind: kind as SceneBackground['kind'] }),
            )}
            {bg.kind === 'solid' && (
              <div className="ms-inspector-row">
                <label className="ms-inspector-label">Color</label>
                <input
                  type="color"
                  className="ms-inspector-color"
                  value={bg.color ?? '#000000'}
                  onChange={(e) => setBg({ ...bg, color: e.target.value })}
                />
              </div>
            )}
            {numberInput(
              'Opacity',
              bg.opacity ?? 1,
              0.05,
              (v) => setBg({ ...bg, opacity: Math.min(1, Math.max(0, v)) }),
              0,
              1,
            )}
          </div>

          <div className="ms-inspector-section">
            <h4 className="ms-inspector-section-title">Layers</h4>
            <p lang="fa" style={{ fontSize: '11px', color: 'var(--joy-text-muted)', margin: 0 }}>
              {document.layers.length} لایه
            </p>
          </div>
        </div>
      </aside>
    );
  }

  const { transform: t, typography: typo } = layer;

  return (
    <aside className="ms-panel ms-right" aria-label="Inspector">
      <div className="ms-panel-header">
        <h3 className="ms-panel-title">{layer.name}</h3>
      </div>
      <div className="ms-panel-body">
        <div className="ms-inspector-section">
          <h4 className="ms-inspector-section-title">Transform</h4>
          {numberInput('X', t.x, 1, (v) => setTransform({ x: v }))}
          {numberInput('Y', t.y, 1, (v) => setTransform({ y: v }))}
          {numberInput('Width', t.width, 1, (v) => setTransform({ width: Math.max(1, v) }), 1)}
          {numberInput('Height', t.height, 1, (v) => setTransform({ height: Math.max(1, v) }), 1)}
          {numberInput(
            'Rotation',
            t.rotationDeg,
            1,
            (v) => setTransform({ rotationDeg: v }),
            -360,
            360,
          )}
          {numberInput(
            'Opacity',
            t.opacity,
            0.05,
            (v) => setTransform({ opacity: Math.min(1, Math.max(0, v)) }),
            0,
            1,
          )}
        </div>

        {layer.type === 'text' && (
          <>
            <div className="ms-inspector-section">
              <h4 className="ms-inspector-section-title">Text</h4>
              <textarea
                className="ms-inspector-textarea"
                value={layer.text ?? ''}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                placeholder="متن را وارد کنید…"
              />
            </div>
            <div className="ms-inspector-section">
              <h4 className="ms-inspector-section-title">Typography</h4>
              {selectInput(
                'Font Family',
                typo?.fontFamily ?? 'system-ui',
                CONTENT_FONT_FAMILIES,
                (v) => setTypography({ fontFamily: v }),
              )}
              {numberInput(
                'Font Size',
                typo?.fontSize ?? 48,
                1,
                (v) => setTypography({ fontSize: v }),
                1,
                400,
              )}
              {numberInput(
                'Line Height',
                typo?.lineHeight ?? 1.2,
                0.1,
                (v) => setTypography({ lineHeight: v }),
                0.5,
                5,
              )}
              {numberInput(
                'Letter Spacing',
                typo?.letterSpacing ?? 0,
                0.1,
                (v) => setTypography({ letterSpacing: v }),
                -20,
                100,
              )}
            </div>
          </>
        )}

        <div className="ms-inspector-section">
          <h4 className="ms-inspector-section-title">Fill</h4>
          <div className="ms-inspector-row">
            <label className="ms-inspector-label">Color</label>
            <input
              type="color"
              className="ms-inspector-color"
              value={layer.fills[0]?.kind === 'solid' ? layer.fills[0].color : '#ffffff'}
              onChange={(e) =>
                setFill({
                  kind: 'solid',
                  color: e.target.value,
                  opacity: layer.fills[0]?.kind === 'solid' ? layer.fills[0].opacity : 1,
                })
              }
            />
          </div>
        </div>
      </div>
    </aside>
  );
}

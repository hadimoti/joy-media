import { useCallback, useState } from 'react';
import type { MotionLayer, MotionTransform, MotionTypography, MotionFill } from '@joy-media/motion-core';
import type { SceneCommand } from './state/sceneCommands.js';

interface InspectorProps {
  readonly layer: MotionLayer | undefined;
  readonly documentId: string;
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

export function MotionStudioInspector({ layer, dispatch }: InspectorProps) {
  if (!layer) {
    return (
      <aside className="ms-panel ms-right" aria-label="Inspector">
        <div className="ms-panel-header">
          <h3 className="ms-panel-title">Properties</h3>
        </div>
        <div className="ms-panel-body">
          <div className="ms-empty-state">Select a layer to edit its properties.</div>
        </div>
      </aside>
    );
  }

  const { transform: t, typography: typo } = layer;

  const setTransform = useCallback(
    (patch: Partial<MotionTransform>) => {
      dispatch('Set transform', { type: 'scene.setLayerTransform', payload: { layerId: layer.id, transform: patch } });
    },
    [dispatch, layer.id],
  );

  const setText = useCallback(
    (text: string) => {
      dispatch('Set text', { type: 'scene.setLayerText', payload: { layerId: layer.id, text } });
    },
    [dispatch, layer.id],
  );

  const setTypography = useCallback(
    (patch: Partial<MotionTypography>) => {
      dispatch('Set typography', { type: 'scene.setLayerTypography', payload: { layerId: layer.id, typography: patch } });
    },
    [dispatch, layer.id],
  );

  const setFill = useCallback(
    (fill: MotionFill) => {
      dispatch('Set fill', { type: 'scene.setLayerFills', payload: { layerId: layer.id, fills: [fill] } });
    },
    [dispatch, layer.id],
  );

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
          {numberInput('Rotation', t.rotationDeg, 1, (v) => setTransform({ rotationDeg: v }), -360, 360)}
          {numberInput('Opacity', t.opacity, 0.05, (v) => setTransform({ opacity: Math.min(1, Math.max(0, v)) }), 0, 1)}
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
                placeholder="Enter text..."
              />
            </div>
            <div className="ms-inspector-section">
              <h4 className="ms-inspector-section-title">Typography</h4>
              {numberInput('Font Size', typo?.fontSize ?? 48, 1, (v) => setTypography({ fontSize: v }), 1, 400)}
              {numberInput('Line Height', typo?.lineHeight ?? 1.2, 0.1, (v) => setTypography({ lineHeight: v }), 0.5, 5)}
              {numberInput('Letter Spacing', typo?.letterSpacing ?? 0, 0.1, (v) => setTypography({ letterSpacing: v }), -20, 100)}
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
              value={
                (layer.fills[0]?.kind === 'solid' ? layer.fills[0].color : '#ffffff')
              }
              onChange={(e) =>
                setFill({ kind: 'solid', color: e.target.value, opacity: layer.fills[0]?.kind === 'solid' ? layer.fills[0].opacity : 1 })
              }
            />
          </div>
        </div>
      </div>
    </aside>
  );
}

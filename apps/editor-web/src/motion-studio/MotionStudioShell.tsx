import { useState, useCallback } from 'react';
import { MotionStudioTopBar, type MotionStudioMode } from './MotionStudioTopBar.js';
import { MotionStudioCanvas } from './MotionStudioCanvas.js';
import { MotionStudioLayersPanel } from './MotionStudioLayersPanel.js';
import { MotionStudioInspector } from './MotionStudioInspector.js';
import { useSceneEditor } from './state/useSceneEditor.js';
import type { SceneCommand } from './state/sceneCommands.js';
import type { MotionLayer, MotionLayerId } from '@joy-media/motion-core';

export interface MotionStudioShellProps {
  readonly motionName: string;
  readonly onClose: () => void;
}

export function MotionStudioShell({ motionName, onClose }: MotionStudioShellProps) {
  const {
    document,
    selectedLayerIds,
    canUndo,
    canRedo,
    dispatch,
    undo,
    redo,
    selectLayer,
  } = useSceneEditor();

  const [mode, setMode] = useState<MotionStudioMode>('visual-edit');
  const [layersOpen, setLayersOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(true);

  const toggleMode = useCallback(() => {
    setMode((current) => (current === 'visual-edit' ? 'code' : 'visual-edit'));
  }, []);

  const handleAddLayer = useCallback(
    (layer: MotionLayer) => {
      dispatch('Add layer', { type: 'scene.addLayer', payload: { layer } });
      selectLayer(layer.id);
    },
    [dispatch, selectLayer],
  );

  const handleRemoveLayer = useCallback(
    (layerId: MotionLayerId) => {
      dispatch('Remove layer', { type: 'scene.removeLayer', payload: { layerId } });
      if (selectedLayerIds.includes(layerId)) selectLayer(null);
    },
    [dispatch, selectedLayerIds, selectLayer],
  );

  const handleToggleVisibility = useCallback(
    (layerId: MotionLayerId) => {
      const layer = document.layers.find((l) => l.id === layerId);
      if (!layer) return;
      dispatch('Toggle visibility', {
        type: 'scene.setLayerVisibility',
        payload: { layerId, visible: !layer.visible },
      });
    },
    [dispatch, document.layers],
  );

  const handleToggleLocked = useCallback(
    (layerId: MotionLayerId) => {
      const layer = document.layers.find((l) => l.id === layerId);
      if (!layer) return;
      dispatch('Toggle lock', {
        type: 'scene.setLayerLocked',
        payload: { layerId, locked: !layer.locked },
      });
    },
    [dispatch, document.layers],
  );

  const handleLayerTransform = useCallback(
    (layerId: MotionLayerId, transform: { x: number; y: number }) => {
      dispatch('Move layer', {
        type: 'scene.setLayerTransform',
        payload: { layerId, transform },
      });
    },
    [dispatch],
  );

  const selectedLayer = selectedLayerIds.length === 1
    ? document.layers.find((l) => l.id === selectedLayerIds[0])
    : undefined;

  const hasLeftPanel = layersOpen;
  const hasRightPanel = inspectorOpen;
  const hasBottomPanel = timelineOpen;

  return (
    <div className="motion-studio-overlay">
      <MotionStudioTopBar
        motionName={motionName}
        canUndo={canUndo}
        canRedo={canRedo}
        mode={mode}
        onBack={onClose}
        onUndo={undo}
        onRedo={redo}
        onToggleMode={toggleMode}
        onPreview={() => {}}
        onPublish={() => {}}
        layersOpen={layersOpen}
        onToggleLayers={() => setLayersOpen((v) => !v)}
        inspectorOpen={inspectorOpen}
        onToggleInspector={() => setInspectorOpen((v) => !v)}
        timelineOpen={timelineOpen}
        onToggleTimeline={() => setTimelineOpen((v) => !v)}
      />

      <div
        className={`ms-body${hasLeftPanel ? ' ms-body-left' : ''}${hasRightPanel ? ' ms-body-right' : ''}${hasBottomPanel ? ' ms-body-bottom' : ''}`}
      >
        {hasLeftPanel && (
          <MotionStudioLayersPanel
            document={document}
            selectedLayerIds={selectedLayerIds}
            onSelectLayer={selectLayer}
            onAddLayer={handleAddLayer}
            onRemoveLayer={handleRemoveLayer}
            onToggleVisibility={handleToggleVisibility}
            onToggleLocked={handleToggleLocked}
          />
        )}

        <section className="ms-center">
          {mode === 'visual-edit' ? (
            <MotionStudioCanvas
              document={document}
              selectedLayerIds={selectedLayerIds}
              onSelectLayer={selectLayer}
              onLayerTransform={handleLayerTransform}
              canvasScale={0.5}
            />
          ) : (
            <div className="ms-code" aria-label="Code editor">
              <div className="ms-code-placeholder">
                <textarea
                  className="ms-code-textarea"
                  placeholder="// HTML / CSS / JavaScript&#10;// The visual editor generates code here.&#10;// Switch back to Visual Edit to use the canvas."
                  readOnly
                />
              </div>
            </div>
          )}

          {hasBottomPanel && (
            <footer className="ms-panel ms-bottom" aria-label="Timeline">
              <div className="ms-panel-header">
                <h3 className="ms-panel-title">Timeline</h3>
              </div>
              <div className="ms-panel-body">
                <div className="ms-empty-state">Timeline — keyframes and animation tracks.</div>
              </div>
            </footer>
          )}
        </section>

        {hasRightPanel && (
          <MotionStudioInspector
            layer={selectedLayer}
            documentId={document.id}
            dispatch={dispatch}
          />
        )}
      </div>
    </div>
  );
}

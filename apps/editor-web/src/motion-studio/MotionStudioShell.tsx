import { useState, useCallback, useEffect, useRef } from 'react';
import { MotionStudioTopBar, type MotionStudioMode } from './MotionStudioTopBar.js';
import { MotionStudioCanvas } from './MotionStudioCanvas.js';
import { MotionStudioLayersPanel } from './MotionStudioLayersPanel.js';
import { MotionStudioInspector } from './MotionStudioInspector.js';
import { useSceneEditor } from './state/useSceneEditor.js';
import type { MotionLayer, MotionLayerId } from '@joy-media/motion-core';

export interface MotionStudioShellProps {
  readonly motionName: string;
  readonly onClose: () => void;
}

export function MotionStudioShell({ motionName, onClose }: MotionStudioShellProps) {
  const { document, selectedLayerIds, canUndo, canRedo, dispatch, undo, redo, selectLayer } =
    useSceneEditor();

  const [mode, setMode] = useState<MotionStudioMode>('visual-edit');
  const [layersOpen, setLayersOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);
  const rafRef = useRef<number | undefined>(undefined);
  const lastTickRef = useRef<number>(0);

  useEffect(() => {
    if (!playing) return;
    lastTickRef.current = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = now - lastTickRef.current;
      lastTickRef.current = now;
      setPlayheadMs((prev) => {
        const next = prev + dt;
        if (next >= document.durationMs) {
          setPlaying(false);
          return 0;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, document.durationMs]);

  const togglePlayback = useCallback(() => {
    setPlaying((p) => {
      if (!p && playheadMs >= document.durationMs) {
        setPlayheadMs(0);
      }
      return !p;
    });
  }, [playheadMs, document.durationMs]);

  const seek = useCallback(
    (timeMs: number) => {
      setPlayheadMs(Math.max(0, Math.min(document.durationMs, timeMs)));
    },
    [document.durationMs],
  );

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

  const handleMoveLayer = useCallback(
    (layerId: MotionLayerId, direction: 'up' | 'down') => {
      const idx = document.layers.findIndex((l) => l.id === layerId);
      if (idx === -1) return;
      const newIndex = direction === 'up' ? idx + 1 : idx - 1;
      if (newIndex < 0 || newIndex >= document.layers.length) return;
      dispatch('Reorder layer', {
        type: 'scene.moveLayer',
        payload: { layerId, newIndex },
      });
    },
    [dispatch, document.layers],
  );

  const selectedLayer =
    selectedLayerIds.length === 1
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
        onPreview={togglePlayback}
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
            onMoveLayer={handleMoveLayer}
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
              playheadMs={playheadMs}
            />
          ) : (
            <div className="ms-code" aria-label="Code editor">
              <div className="ms-code-placeholder">
                <textarea
                  className="ms-code-textarea"
                  placeholder="// HTML / CSS / JavaScript&#10;// ویرایشگر بصری اینجا کد تولید می‌کند.&#10;// برای استفاده از بوم به Visual Edit برگردید."
                  readOnly
                />
              </div>
            </div>
          )}

          {hasBottomPanel && (
            <footer className="ms-panel ms-bottom" aria-label="Timeline">
              <div className="ms-panel-header">
                <h3 className="ms-panel-title">Timeline</h3>
                <div className="ms-timeline-controls">
                  <button
                    type="button"
                    className="ms-timeline-btn"
                    aria-label={playing ? 'Pause' : 'Play'}
                    onClick={togglePlayback}
                  >
                    {playing ? '\u23F8' : '\u25B6'}
                  </button>
                  <span className="ms-timeline-time" dir="ltr">
                    {(playheadMs / 1000).toFixed(1)}s / {(document.durationMs / 1000).toFixed(1)}s
                  </span>
                </div>
              </div>
              <div className="ms-panel-body">
                <div className="ms-timeline-scrubber">
                  <input
                    type="range"
                    className="ms-timeline-range"
                    min={0}
                    max={document.durationMs}
                    value={playheadMs}
                    onChange={(e) => seek(Number(e.target.value))}
                    aria-label="Playhead position"
                  />
                </div>
                <div className="ms-empty-state" lang="fa">
                  کی‌فریم‌ها و ترک‌های انیمیشن اینجا نمایش داده می‌شوند.
                </div>
              </div>
            </footer>
          )}
        </section>

        {hasRightPanel && (
          <MotionStudioInspector layer={selectedLayer} document={document} dispatch={dispatch} />
        )}
      </div>
    </div>
  );
}

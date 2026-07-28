import { useState, useCallback, useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { MotionStudioTopBar, type MotionStudioMode } from './MotionStudioTopBar.js';
import { MotionStudioCanvas } from './MotionStudioCanvas.js';
import { MotionStudioLayersPanel } from './MotionStudioLayersPanel.js';
import { MotionStudioInspector } from './MotionStudioInspector.js';
import { MotionStudioTimeline } from './MotionStudioTimeline.js';
import { useSceneEditor } from './state/useSceneEditor.js';
import type { MotionLayer, MotionLayerId } from '@joy-media/motion-core';

export interface MotionStudioShellProps {
  readonly motionName: string;
  readonly onClose: () => void;
}

const LEFT_WIDTH_DEFAULT = 240;
const RIGHT_WIDTH_DEFAULT = 260;
const BOTTOM_HEIGHT_DEFAULT = 240;
const LEFT_WIDTH_MIN = 180;
const LEFT_WIDTH_MAX = 480;
const RIGHT_WIDTH_MIN = 200;
const RIGHT_WIDTH_MAX = 520;
const BOTTOM_HEIGHT_MIN = 100;
const BOTTOM_HEIGHT_MAX = 480;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type MsResizeEdge = 'left' | 'right' | 'bottom';

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
    beginTransaction,
    updateTransaction,
    commitTransaction,
  } = useSceneEditor();

  const [mode, setMode] = useState<MotionStudioMode>('visual-edit');
  const [layersOpen, setLayersOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(true);
  const [leftWidth, setLeftWidth] = useState(LEFT_WIDTH_DEFAULT);
  const [rightWidth, setRightWidth] = useState(RIGHT_WIDTH_DEFAULT);
  const [bottomHeight, setBottomHeight] = useState(BOTTOM_HEIGHT_DEFAULT);
  const [resizing, setResizing] = useState<MsResizeEdge | null>(null);
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

  const handleLayerDragStart = useCallback(() => {
    beginTransaction();
  }, [beginTransaction]);

  const handleLayerDragPreview = useCallback(
    (layerId: MotionLayerId, transform: { x: number; y: number }) => {
      updateTransaction({ type: 'scene.setLayerTransform', payload: { layerId, transform } });
    },
    [updateTransaction],
  );

  const handleLayerDragCommit = useCallback(() => {
    commitTransaction('Move layer');
  }, [commitTransaction]);

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

  const startPanelResize = useCallback(
    (edge: MsResizeEdge, event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = leftWidth;
      const startRight = rightWidth;
      const startBottom = bottomHeight;
      const pointerId = event.pointerId;
      const sash = event.currentTarget;
      sash.setPointerCapture(pointerId);
      setResizing(edge);

      const onMove = (ev: PointerEvent) => {
        if (edge === 'left') {
          setLeftWidth(clamp(startLeft + (ev.clientX - startX), LEFT_WIDTH_MIN, LEFT_WIDTH_MAX));
        } else if (edge === 'right') {
          setRightWidth(clamp(startRight - (ev.clientX - startX), RIGHT_WIDTH_MIN, RIGHT_WIDTH_MAX));
        } else {
          setBottomHeight(
            clamp(startBottom - (ev.clientY - startY), BOTTOM_HEIGHT_MIN, BOTTOM_HEIGHT_MAX),
          );
        }
      };

      const onUp = () => {
        sash.releasePointerCapture(pointerId);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        setResizing(null);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [leftWidth, rightWidth, bottomHeight],
  );

  const bodyStyle = {
    '--ms-left-w': `${leftWidth}px`,
    '--ms-right-w': `${rightWidth}px`,
    '--ms-bottom-h': `${bottomHeight}px`,
  } as CSSProperties;

  return (
    <div
      className={`motion-studio-overlay${resizing ? ` ms-resizing ms-resizing-${resizing}` : ''}`}
    >
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
        style={bodyStyle}
      >
        {hasLeftPanel && (
          <div className="ms-panel-host">
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
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize layers panel"
              aria-valuenow={leftWidth}
              aria-valuemin={LEFT_WIDTH_MIN}
              aria-valuemax={LEFT_WIDTH_MAX}
              className="ms-sash ms-sash-east"
              onPointerDown={(e) => startPanelResize('left', e)}
            />
          </div>
        )}

        <section className="ms-center">
          {mode === 'visual-edit' ? (
            <MotionStudioCanvas
              document={document}
              selectedLayerIds={selectedLayerIds}
              onSelectLayer={selectLayer}
              onLayerDragStart={handleLayerDragStart}
              onLayerDragPreview={handleLayerDragPreview}
              onLayerDragCommit={handleLayerDragCommit}
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
            <div className="ms-panel-host ms-bottom-host">
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize timeline panel"
                aria-valuenow={bottomHeight}
                aria-valuemin={BOTTOM_HEIGHT_MIN}
                aria-valuemax={BOTTOM_HEIGHT_MAX}
                className="ms-sash ms-sash-north"
                onPointerDown={(e) => startPanelResize('bottom', e)}
              />
              <footer className="ms-panel ms-bottom" aria-label="Timeline">
                <MotionStudioTimeline
                  document={document}
                  playheadMs={playheadMs}
                  playing={playing}
                  selectedLayerIds={selectedLayerIds}
                  onSeek={seek}
                  onTogglePlayback={togglePlayback}
                  onSelectLayer={selectLayer}
                  onToggleVisibility={handleToggleVisibility}
                  onToggleLocked={handleToggleLocked}
                />
              </footer>
            </div>
          )}
        </section>

        {hasRightPanel && (
          <div className="ms-panel-host">
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize inspector panel"
              aria-valuenow={rightWidth}
              aria-valuemin={RIGHT_WIDTH_MIN}
              aria-valuemax={RIGHT_WIDTH_MAX}
              className="ms-sash ms-sash-west"
              onPointerDown={(e) => startPanelResize('right', e)}
            />
            <MotionStudioInspector layer={selectedLayer} document={document} dispatch={dispatch} />
          </div>
        )}
      </div>
    </div>
  );
}

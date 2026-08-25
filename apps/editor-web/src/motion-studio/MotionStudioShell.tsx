import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  MotionStudioTopBar,
  type MotionStudioMode,
  type MotionSaveState,
} from './MotionStudioTopBar.js';
import { MotionStudioCanvas } from './MotionStudioCanvas.js';
import { MotionStudioLayersPanel } from './MotionStudioLayersPanel.js';
import { MotionStudioInspector } from './MotionStudioInspector.js';
import { MotionStudioTimeline } from './MotionStudioTimeline.js';
import { useSceneEditor } from './state/useSceneEditor.js';
import type { MotionLayer, MotionLayerId } from '@joy-media/motion-core';
import { createBlankScene } from '@joy-media/motion-core';
import {
  createTextLayer,
  createRectangleLayer,
  createEllipseLayer,
  createImageLayer,
  createVideoLayer,
} from './state/layerFactory.js';
import {
  loadMotionSceneDocument,
  saveMotionSceneDocument,
  publishMotionScene,
} from '../motion-scene-catalog.js';

export interface MotionStudioShellProps {
  readonly sceneId: string;
  readonly onClose: () => void;
}

const AUTOSAVE_DEBOUNCE_MS = 800;

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

export function MotionStudioShell({ sceneId, onClose }: MotionStudioShellProps) {
  const storage = window.localStorage;
  const [initialDocument] = useState(
    () => loadMotionSceneDocument(storage, sceneId) ?? createBlankScene('Untitled Motion'),
  );

  const {
    document,
    selectedLayerIds,
    canUndo,
    canRedo,
    dispatch,
    undo,
    redo,
    selectLayer,
    selectLayers,
    clearSelection,
    toggleLayerSelection,
    duplicateSelected,
    deleteSelected,
    bringToFront,
    sendToBack,
    groupSelected,
    ungroupSelected,
    beginTransaction,
    updateTransaction,
    commitTransaction,
    cancelTransaction,
  } = useSceneEditor(initialDocument);

  const [saveState, setSaveState] = useState<MotionSaveState>('saved');
  const saveTimeoutRef = useRef<number | undefined>(undefined);
  const skipNextAutosaveRef = useRef(true);

  const persist = useCallback((run: () => void) => {
    if (saveTimeoutRef.current !== undefined) {
      window.clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
    setSaveState('saving');
    try {
      run();
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }, []);

  const saveNow = useCallback(() => {
    persist(() => saveMotionSceneDocument(storage, document));
  }, [persist, storage, document]);

  const handlePublish = useCallback(() => {
    persist(() => publishMotionScene(storage, document));
  }, [persist, storage, document]);

  // Every document change past the first render schedules a debounced
  // autosave; Ctrl/Cmd+S and Publish flush it immediately instead of waiting.
  useEffect(() => {
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return;
    }
    setSaveState('unsaved');
    saveTimeoutRef.current = window.setTimeout(() => {
      saveTimeoutRef.current = undefined;
      persist(() => saveMotionSceneDocument(storage, document));
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimeoutRef.current !== undefined) window.clearTimeout(saveTimeoutRef.current);
    };
  }, [document, storage, persist]);

  const handleClose = useCallback(() => {
    saveNow();
    onClose();
  }, [saveNow, onClose]);

  const [mode, setMode] = useState<MotionStudioMode>('visual-edit');
  const [layersOpen, setLayersOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(true);
  const [leftWidth, setLeftWidth] = useState(LEFT_WIDTH_DEFAULT);
  const [rightWidth, setRightWidth] = useState(RIGHT_WIDTH_DEFAULT);
  const [bottomHeight, setBottomHeight] = useState(BOTTOM_HEIGHT_DEFAULT);
  const [resizing, setResizing] = useState<MsResizeEdge | null>(null);
  const [canvasScale] = useState(0.5);
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

  const handleAddTextLayer = useCallback(() => {
    const text = createTextLayer('Hello');
    dispatch('Add text layer', { type: 'scene.addLayer', payload: { layer: text } });
    selectLayer(text.id);
  }, [dispatch, selectLayer]);

  const handleAddRectangleLayer = useCallback(() => {
    const rect = createRectangleLayer();
    dispatch('Add rectangle layer', { type: 'scene.addLayer', payload: { layer: rect } });
    selectLayer(rect.id);
  }, [dispatch, selectLayer]);

  const handleAddEllipseLayer = useCallback(() => {
    const ellipse = createEllipseLayer();
    dispatch('Add ellipse layer', { type: 'scene.addLayer', payload: { layer: ellipse } });
    selectLayer(ellipse.id);
  }, [dispatch, selectLayer]);

  const handleAddImageLayer = useCallback(() => {
    const image = createImageLayer('', 'Image');
    dispatch('Add image layer', { type: 'scene.addLayer', payload: { layer: image } });
    selectLayer(image.id);
  }, [dispatch, selectLayer]);

  const handleAddVideoLayer = useCallback(() => {
    const video = createVideoLayer('', 'Video');
    dispatch('Add video layer', { type: 'scene.addLayer', payload: { layer: video } });
    selectLayer(video.id);
  }, [dispatch, selectLayer]);

  const handleSetLayerTransform = useCallback(
    (layerId: MotionLayerId, transform: Partial<MotionLayer['transform']>) => {
      updateTransaction({ type: 'scene.setLayerTransform', payload: { layerId, transform } });
    },
    [updateTransaction],
  );

  const handleCommit = useCallback(
    (label: string) => {
      commitTransaction(label);
    },
    [commitTransaction],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing =
        target?.isContentEditable || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveNow();
        return;
      }
      if (editing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectLayers(document.layers.map((l) => l.id));
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelected();
        return;
      }
      if (event.key === 'Escape') {
        clearSelection();
        return;
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        beginTransaction();
        for (const id of selectedLayerIds) {
          const layer = document.layers.find((l) => l.id === id);
          if (!layer || layer.locked) continue;
          updateTransaction({
            type: 'scene.setLayerTransform',
            payload: {
              layerId: id,
              transform: { x: layer.transform.x + dx, y: layer.transform.y + dy },
            },
          });
        }
        commitTransaction('Nudge layers');
      }
    },
    [
      beginTransaction,
      clearSelection,
      commitTransaction,
      deleteSelected,
      document.layers,
      saveNow,
      selectLayers,
      selectedLayerIds,
      updateTransaction,
    ],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

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
          setRightWidth(
            clamp(startRight - (ev.clientX - startX), RIGHT_WIDTH_MIN, RIGHT_WIDTH_MAX),
          );
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
        motionName={document.name}
        saveState={saveState}
        canUndo={canUndo}
        canRedo={canRedo}
        mode={mode}
        onBack={handleClose}
        onUndo={undo}
        onRedo={redo}
        onToggleMode={toggleMode}
        onPreview={togglePlayback}
        onPublish={handlePublish}
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
              onToggleLayerSelection={toggleLayerSelection}
              onAddLayer={handleAddLayer}
              onRemoveLayer={handleRemoveLayer}
              onToggleVisibility={handleToggleVisibility}
              onToggleLocked={handleToggleLocked}
              onMoveLayer={handleMoveLayer}
              onDuplicateSelected={duplicateSelected}
              onDeleteSelected={deleteSelected}
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
              onSelectLayers={selectLayers}
              onToggleLayerSelection={toggleLayerSelection}
              onClearSelection={clearSelection}
              onSetLayerTransform={handleSetLayerTransform}
              onDispatch={dispatch}
              onBeginTransaction={beginTransaction}
              onUpdateTransaction={updateTransaction}
              onCommitTransaction={handleCommit}
              onCancelTransaction={cancelTransaction}
              onDuplicateSelected={duplicateSelected}
              onDeleteSelected={deleteSelected}
              onBringToFront={bringToFront}
              onSendToBack={sendToBack}
              onGroupSelected={groupSelected}
              onUngroupSelected={ungroupSelected}
              onAddTextLayer={handleAddTextLayer}
              onAddRectangleLayer={handleAddRectangleLayer}
              onAddEllipseLayer={handleAddEllipseLayer}
              onAddImageLayer={handleAddImageLayer}
              onAddVideoLayer={handleAddVideoLayer}
              canvasScale={canvasScale}
              playheadMs={playheadMs}
              playing={playing}
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
                  dispatch={dispatch}
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
            <MotionStudioInspector
              document={document}
              selectedLayerIds={selectedLayerIds}
              dispatch={dispatch}
              playheadMs={playheadMs}
            />
          </div>
        )}
      </div>
    </div>
  );
}

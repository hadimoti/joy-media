import { useState, useCallback } from 'react';
import { MotionStudioTopBar, type MotionStudioMode } from './MotionStudioTopBar.js';

export interface MotionStudioShellProps {
  readonly motionName: string;
  readonly onClose: () => void;
}

export function MotionStudioShell({ motionName, onClose }: MotionStudioShellProps) {
  const [mode, setMode] = useState<MotionStudioMode>('visual-edit');
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [layersOpen, setLayersOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(true);

  const toggleMode = useCallback(() => {
    setMode((current) => (current === 'visual-edit' ? 'code' : 'visual-edit'));
  }, []);

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
        onUndo={() => {}}
        onRedo={() => {}}
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
          <aside className="ms-panel ms-left" aria-label="Layers">
            <div className="ms-panel-header">
              <h3 className="ms-panel-title">Layers</h3>
            </div>
            <div className="ms-panel-body">
              <div className="ms-empty-state">No layers yet. Add shapes, text, or images.</div>
            </div>
          </aside>
        )}

        <section className="ms-center">
          {mode === 'visual-edit' ? (
            <div className="ms-canvas" aria-label="Motion canvas">
              <div className="ms-canvas-viewport" aria-label="Canvas viewport">
                <div className="ms-empty-state">
                  <p>Canvas — drag layers, set transforms</p>
                  <p className="ms-empty-hint">Click + in the layers panel to add content.</p>
                </div>
              </div>
            </div>
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
          <aside className="ms-panel ms-right" aria-label="Inspector">
            <div className="ms-panel-header">
              <h3 className="ms-panel-title">Properties</h3>
            </div>
            <div className="ms-panel-body">
              <div className="ms-empty-state">Select a layer to edit its properties.</div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

import {
  ChevronLeftIcon,
  UndoIcon,
  RedoIcon,
  CodeIcon,
  EyeIcon,
  ExportIcon,
  LayersIcon,
  TimelineIcon,
  SlidersIcon,
} from '../icons.js';

export type MotionStudioMode = 'visual-edit' | 'code';

export interface MotionStudioTopBarProps {
  readonly motionName: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly mode: MotionStudioMode;
  readonly onBack: () => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onToggleMode: () => void;
  readonly onPreview: () => void;
  readonly onPublish: () => void;
  readonly layersOpen: boolean;
  readonly onToggleLayers: () => void;
  readonly inspectorOpen: boolean;
  readonly onToggleInspector: () => void;
  readonly timelineOpen: boolean;
  readonly onToggleTimeline: () => void;
}

export function MotionStudioTopBar({
  motionName,
  canUndo,
  canRedo,
  mode,
  onBack,
  onUndo,
  onRedo,
  onToggleMode,
  onPreview,
  onPublish,
  layersOpen,
  onToggleLayers,
  inspectorOpen,
  onToggleInspector,
  timelineOpen,
  onToggleTimeline,
}: MotionStudioTopBarProps) {
  return (
    <header className="ms-topbar">
      <div className="ms-topbar-start">
        <button
          type="button"
          className="ms-topbar-btn"
          aria-label="Back to editor"
          title="Back to editor"
          onClick={onBack}
        >
          <ChevronLeftIcon />
        </button>
        <span className="ms-topbar-name" dir="ltr" title={motionName}>
          {motionName}
        </span>
      </div>

      <div className="ms-topbar-center">
        <button
          type="button"
          className="ms-topbar-btn"
          disabled={!canUndo}
          aria-label="Undo"
          title="Undo"
          onClick={onUndo}
        >
          <UndoIcon />
        </button>
        <button
          type="button"
          className="ms-topbar-btn"
          disabled={!canRedo}
          aria-label="Redo"
          title="Redo"
          onClick={onRedo}
        >
          <RedoIcon />
        </button>

        <span className="ms-topbar-separator" aria-hidden="true" />

        <button
          type="button"
          className={`ms-topbar-btn${mode === 'code' ? ' ms-topbar-btn-active' : ''}`}
          aria-label={mode === 'code' ? 'Switch to visual edit' : 'Switch to code'}
          aria-pressed={mode === 'code'}
          title={mode === 'code' ? 'Visual Edit' : 'Code'}
          onClick={onToggleMode}
        >
          <CodeIcon />
        </button>

        <button
          type="button"
          className="ms-topbar-btn"
          aria-label="Preview motion"
          title="Preview"
          onClick={onPreview}
        >
          <EyeIcon />
        </button>

        <button
          type="button"
          className="ms-topbar-btn ms-topbar-publish"
          aria-label="Publish motion"
          title="Publish"
          onClick={onPublish}
        >
          <ExportIcon />
        </button>
      </div>

      <div className="ms-topbar-end">
        <button
          type="button"
          className={`ms-topbar-btn${layersOpen ? ' ms-topbar-btn-active' : ''}`}
          aria-label="Toggle layers panel"
          aria-pressed={layersOpen}
          title="Layers"
          onClick={onToggleLayers}
        >
          <LayersIcon />
        </button>
        <button
          type="button"
          className={`ms-topbar-btn${inspectorOpen ? ' ms-topbar-btn-active' : ''}`}
          aria-label="Toggle inspector panel"
          aria-pressed={inspectorOpen}
          title="Inspector"
          onClick={onToggleInspector}
        >
          <SlidersIcon />
        </button>
        <button
          type="button"
          className={`ms-topbar-btn${timelineOpen ? ' ms-topbar-btn-active' : ''}`}
          aria-label="Toggle timeline panel"
          aria-pressed={timelineOpen}
          title="Timeline"
          onClick={onToggleTimeline}
        >
          <TimelineIcon />
        </button>
      </div>
    </header>
  );
}

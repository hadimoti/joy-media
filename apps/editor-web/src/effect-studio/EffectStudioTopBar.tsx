import {
  ChevronLeftIcon,
  CloudIcon,
  EyeIcon,
  EyeOffIcon,
  LayersIcon,
  RedoIcon,
  RefreshIcon,
  SaveIcon,
  SlidersIcon,
  TimelineIcon,
  UndoIcon,
} from '../icons.js';

export type EffectSaveState = 'saved' | 'saving' | 'unsaved' | 'error';

interface EffectStudioTopBarProps {
  readonly recipeName: string;
  readonly saveState: EffectSaveState;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly compareEnabled: boolean;
  readonly stackOpen: boolean;
  readonly inspectorOpen: boolean;
  readonly automationOpen: boolean;
  readonly canApply: boolean;
  readonly onRename: (name: string) => void;
  readonly onBack: () => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onToggleCompare: () => void;
  readonly onToggleStack: () => void;
  readonly onToggleInspector: () => void;
  readonly onToggleAutomation: () => void;
  readonly onApply: () => void;
}

const SAVE_LABEL: Readonly<Record<EffectSaveState, string>> = {
  saved: 'Saved',
  saving: 'Saving...',
  unsaved: 'Unsaved',
  error: 'Save failed',
};

export function EffectStudioTopBar({
  recipeName,
  saveState,
  canUndo,
  canRedo,
  compareEnabled,
  stackOpen,
  inspectorOpen,
  automationOpen,
  canApply,
  onRename,
  onBack,
  onUndo,
  onRedo,
  onToggleCompare,
  onToggleStack,
  onToggleInspector,
  onToggleAutomation,
  onApply,
}: EffectStudioTopBarProps) {
  const SaveStateIcon =
    saveState === 'saved' ? CloudIcon : saveState === 'saving' ? RefreshIcon : SaveIcon;

  return (
    <header className="es-topbar">
      <div className="es-topbar-start">
        <button className="es-icon-button" type="button" onClick={onBack} title="Back to editor">
          <ChevronLeftIcon />
        </button>
        <span className="es-product-mark" aria-hidden="true">
          FX
        </span>
        <div className="es-title-lockup">
          <span className="es-kicker">Effect Studio</span>
          <input
            className="es-recipe-name"
            value={recipeName}
            aria-label="Recipe name"
            spellCheck={false}
            onChange={(event) => onRename(event.currentTarget.value)}
          />
        </div>
        <span className={`es-save-state es-save-state-${saveState}`} role="status">
          <SaveStateIcon />
          {SAVE_LABEL[saveState]}
        </span>
      </div>

      <div className="es-topbar-center">
        <button
          className="es-icon-button"
          type="button"
          disabled={!canUndo}
          onClick={onUndo}
          title="Undo"
        >
          <UndoIcon />
        </button>
        <button
          className="es-icon-button"
          type="button"
          disabled={!canRedo}
          onClick={onRedo}
          title="Redo"
        >
          <RedoIcon />
        </button>
        <span className="es-toolbar-divider" />
        <button
          className={`es-compare-button${compareEnabled ? ' is-active' : ''}`}
          type="button"
          onClick={onToggleCompare}
          aria-pressed={compareEnabled}
        >
          {compareEnabled ? <EyeIcon /> : <EyeOffIcon />}
          Before / After
        </button>
      </div>

      <div className="es-topbar-end">
        <button
          className={`es-icon-button${stackOpen ? ' is-active' : ''}`}
          type="button"
          onClick={onToggleStack}
          title="Effect stack"
        >
          <LayersIcon />
        </button>
        <button
          className={`es-icon-button${inspectorOpen ? ' is-active' : ''}`}
          type="button"
          onClick={onToggleInspector}
          title="Inspector"
        >
          <SlidersIcon />
        </button>
        <button
          className={`es-icon-button${automationOpen ? ' is-active' : ''}`}
          type="button"
          onClick={onToggleAutomation}
          title="Automation"
        >
          <TimelineIcon />
        </button>
        <button className="es-apply-button" type="button" disabled={!canApply} onClick={onApply}>
          Apply to selection
        </button>
      </div>
    </header>
  );
}

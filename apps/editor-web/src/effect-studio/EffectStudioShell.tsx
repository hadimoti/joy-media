import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties } from 'react';
import type {
  EffectInstanceV1,
  EffectParamValue,
  JoyEffectPresetV1,
} from '@joy-media/visual-effects';
import {
  createEffectRecipeDocument,
  loadEffectRecipe,
  publishEffectRecipe,
  saveEffectRecipe,
} from '../effect-recipe-catalog.js';
import {
  createDefaultEffectInstance,
  createEffectRecipeEditorState,
  reduceEffectRecipeEditor,
} from './effect-recipe-editor.js';
import { EffectStudioTopBar, type EffectSaveState } from './EffectStudioTopBar.js';
import { EffectStudioStackPanel } from './EffectStudioStackPanel.js';
import { EffectStudioPreview } from './EffectStudioPreview.js';
import { EffectStudioInspector } from './EffectStudioInspector.js';
import { EffectStudioTimeline } from './EffectStudioTimeline.js';

interface EffectStudioShellProps {
  readonly recipeId: string;
  readonly canApply: boolean;
  readonly onApply: (effects: readonly EffectInstanceV1[]) => void;
  readonly onClose: () => void;
}

const AUTOSAVE_MS = 700;

export function EffectStudioShell({
  recipeId,
  canApply,
  onApply,
  onClose,
}: EffectStudioShellProps) {
  const storage = window.localStorage;
  const [state, dispatch] = useReducer(reduceEffectRecipeEditor, undefined, () =>
    createEffectRecipeEditorState(
      loadEffectRecipe(storage, recipeId) ?? createEffectRecipeDocument(),
    ),
  );
  const [saveState, setSaveState] = useState<EffectSaveState>('saved');
  const [comparisonEnabled, setComparisonEnabled] = useState(true);
  const [stackOpen, setStackOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [automationOpen, setAutomationOpen] = useState(true);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const skipAutosave = useRef(true);
  const frameRef = useRef<number | undefined>(undefined);
  const lastTickRef = useRef(0);

  const saveNow = useCallback(() => {
    setSaveState('saving');
    try {
      saveEffectRecipe(storage, state.document);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }, [state.document, storage]);

  useEffect(() => {
    if (skipAutosave.current) {
      skipAutosave.current = false;
      return;
    }
    setSaveState('unsaved');
    const timer = window.setTimeout(saveNow, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [state.document, saveNow]);

  useEffect(() => {
    if (!playing) return;
    lastTickRef.current = performance.now();
    const tick = (now: number) => {
      const delta = now - lastTickRef.current;
      lastTickRef.current = now;
      setPlayheadMs((current) => {
        const next = current + delta;
        if (next >= state.document.durationMs) return 0;
        return next;
      });
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, [playing, state.document.durationMs]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveNow();
      } else if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' });
      } else if (!editing && event.key === ' ') {
        event.preventDefault();
        setPlaying((value) => !value);
      } else if (!editing && (event.key === 'Delete' || event.key === 'Backspace')) {
        if (state.selectedEffectId !== undefined) {
          event.preventDefault();
          dispatch({ type: 'remove', effectInstanceId: state.selectedEffectId });
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveNow, state.selectedEffectId]);

  const selectedEffect = state.document.effects.find(
    (effect) => effect.id === state.selectedEffectId,
  );

  const resetSelected = useCallback(() => {
    if (selectedEffect === undefined) return;
    const defaults = createDefaultEffectInstance(selectedEffect.effectId);
    for (const [key, value] of Object.entries(defaults.params)) {
      dispatch({
        type: 'setParam',
        effectInstanceId: selectedEffect.id,
        paramKey: key,
        value,
      });
    }
  }, [selectedEffect]);

  const toggleKeyframe = useCallback(
    (paramKey: string) => {
      if (state.selectedEffectId === undefined) return;
      dispatch({
        type: 'toggleKeyframe',
        effectInstanceId: state.selectedEffectId,
        paramKey,
        timeMs: playheadMs,
      });
    },
    [playheadMs, state.selectedEffectId],
  );

  const handleApply = useCallback(() => {
    publishEffectRecipe(storage, state.document);
    setSaveState('saved');
    onApply(state.document.effects);
  }, [onApply, state.document, storage]);

  const handleClose = useCallback(() => {
    saveNow();
    onClose();
  }, [onClose, saveNow]);

  const layoutStyle = {
    '--es-left': stackOpen ? '286px' : '0px',
    '--es-right': inspectorOpen ? '310px' : '0px',
    '--es-bottom': automationOpen ? '190px' : '0px',
  } as CSSProperties;

  return (
    <div className="effect-studio-overlay">
      <EffectStudioTopBar
        recipeName={state.document.name}
        saveState={saveState}
        canUndo={state.past.length > 0}
        canRedo={state.future.length > 0}
        compareEnabled={comparisonEnabled}
        stackOpen={stackOpen}
        inspectorOpen={inspectorOpen}
        automationOpen={automationOpen}
        canApply={canApply && state.document.effects.some((effect) => effect.enabled)}
        onRename={(name) => dispatch({ type: 'rename', name })}
        onBack={handleClose}
        onUndo={() => dispatch({ type: 'undo' })}
        onRedo={() => dispatch({ type: 'redo' })}
        onToggleCompare={() => setComparisonEnabled((value) => !value)}
        onToggleStack={() => setStackOpen((value) => !value)}
        onToggleInspector={() => setInspectorOpen((value) => !value)}
        onToggleAutomation={() => setAutomationOpen((value) => !value)}
        onApply={handleApply}
      />
      <div className="es-workspace" style={layoutStyle}>
        {stackOpen && (
          <EffectStudioStackPanel
            effects={state.document.effects}
            selectedEffectId={state.selectedEffectId}
            onSelect={(effectId) => dispatch({ type: 'select', effectId })}
            onAdd={(effectId) => dispatch({ type: 'add', effectId })}
            onAddPreset={(preset: JoyEffectPresetV1) =>
              dispatch({ type: 'appendEffects', effects: preset.effects })
            }
            onToggle={(effectInstanceId) => dispatch({ type: 'toggle', effectInstanceId })}
            onDuplicate={(effectInstanceId) => dispatch({ type: 'duplicate', effectInstanceId })}
            onRemove={(effectInstanceId) => dispatch({ type: 'remove', effectInstanceId })}
            onMove={(effectInstanceId, direction) =>
              dispatch({ type: 'move', effectInstanceId, direction })
            }
          />
        )}
        <EffectStudioPreview
          effects={state.document.effects}
          selectedEffectId={state.selectedEffectId}
          comparisonEnabled={comparisonEnabled}
          playheadMs={playheadMs}
        />
        {inspectorOpen && (
          <EffectStudioInspector
            effect={selectedEffect}
            playheadMs={playheadMs}
            onSetParam={(paramKey: string, value: EffectParamValue) => {
              if (state.selectedEffectId === undefined) return;
              dispatch({
                type: 'setParam',
                effectInstanceId: state.selectedEffectId,
                paramKey,
                value,
              });
            }}
            onToggleKeyframe={toggleKeyframe}
            onReset={resetSelected}
          />
        )}
        {automationOpen && (
          <EffectStudioTimeline
            effect={selectedEffect}
            durationMs={state.document.durationMs}
            playheadMs={playheadMs}
            playing={playing}
            onSeek={setPlayheadMs}
            onTogglePlayback={() => setPlaying((value) => !value)}
            onToggleKeyframe={toggleKeyframe}
          />
        )}
      </div>
    </div>
  );
}

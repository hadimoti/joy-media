import { useCallback, useRef, useState } from 'react';
import type { MotionSceneDocument, MotionLayerId } from '@joy-media/motion-core';
import { createBlankScene } from '@joy-media/motion-core';
import { applySceneCommand, type SceneCommand } from './sceneCommands.js';

export interface SceneEditorState {
  readonly document: MotionSceneDocument;
  readonly selectedLayerIds: readonly MotionLayerId[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly selectLayer: (layerId: MotionLayerId | null) => void;
  readonly toggleLayerSelection: (layerId: MotionLayerId) => void;
}

interface HistoryEntry {
  readonly label: string;
  readonly commands: readonly SceneCommand[];
}

export function useSceneEditor(initialDocument?: MotionSceneDocument): SceneEditorState {
  const [document, setDocument] = useState<MotionSceneDocument>(
    () => initialDocument ?? createBlankScene('Untitled Motion'),
  );
  const [selectedLayerIds, setSelectedLayerIds] = useState<readonly MotionLayerId[]>([]);
  const undoStackRef = useRef<HistoryEntry[]>([]);
  const redoStackRef = useRef<HistoryEntry[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const dispatch = useCallback((label: string, ...commands: SceneCommand[]) => {
    setDocument((current) => {
      const inverses: SceneCommand[] = [];
      let doc = current;
      for (const cmd of commands) {
        const result = applySceneCommand(doc, cmd);
        doc = result.document;
        inverses.push(result.inverse);
      }
      undoStackRef.current = [...undoStackRef.current, { label, commands: inverses }];
      redoStackRef.current = [];
      setCanUndo(true);
      setCanRedo(false);
      return doc;
    });
  }, []);

  const undo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const entry = stack[stack.length - 1]!;
    undoStackRef.current = stack.slice(0, -1);
    setDocument((current) => {
      let doc = current;
      const redoCmds: SceneCommand[] = [];
      for (const cmd of entry.commands) {
        const result = applySceneCommand(doc, cmd);
        doc = result.document;
        redoCmds.push(result.inverse);
      }
      redoStackRef.current = [...redoStackRef.current, { label: entry.label, commands: redoCmds }];
      setCanUndo(undoStackRef.current.length - 1 > 0);
      setCanRedo(true);
      return doc;
    });
  }, []);

  const redo = useCallback(() => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    const entry = stack[stack.length - 1]!;
    redoStackRef.current = stack.slice(0, -1);
    setDocument((current) => {
      let doc = current;
      const inverses: SceneCommand[] = [];
      for (const cmd of entry.commands) {
        const result = applySceneCommand(doc, cmd);
        doc = result.document;
        inverses.push(result.inverse);
      }
      undoStackRef.current = [...undoStackRef.current, { label: entry.label, commands: inverses }];
      setCanUndo(true);
      setCanRedo(redoStackRef.current.length - 1 > 0);
      return doc;
    });
  }, []);

  const selectLayer = useCallback((layerId: MotionLayerId | null) => {
    setSelectedLayerIds(layerId === null ? [] : [layerId]);
  }, []);

  const toggleLayerSelection = useCallback((layerId: MotionLayerId) => {
    setSelectedLayerIds((prev) =>
      prev.includes(layerId) ? prev.filter((id) => id !== layerId) : [...prev, layerId],
    );
  }, []);

  return { document, selectedLayerIds, canUndo, canRedo, dispatch, undo, redo, selectLayer, toggleLayerSelection };
}

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
  /**
   * Continuous interactions (drag, resize, rotate) must collapse into a
   * single undo entry instead of one per pointermove. Call beginTransaction
   * on pointer down, updateTransaction on every move (applies live, skips
   * history), then commitTransaction on pointer up to push one entry — or
   * cancelTransaction to roll back to the pre-drag document.
   */
  readonly beginTransaction: () => void;
  readonly updateTransaction: (...commands: SceneCommand[]) => void;
  readonly commitTransaction: (label: string) => void;
  readonly cancelTransaction: () => void;
}

interface HistoryEntry {
  readonly label: string;
  readonly commands: readonly SceneCommand[];
}

export function useSceneEditor(initialDocument?: MotionSceneDocument): SceneEditorState {
  const documentRef = useRef<MotionSceneDocument>(initialDocument ?? createBlankScene('Untitled Motion'));
  const [document, setDocumentState] = useState<MotionSceneDocument>(documentRef.current);
  const [selectedLayerIds, setSelectedLayerIds] = useState<readonly MotionLayerId[]>([]);
  const undoStackRef = useRef<HistoryEntry[]>([]);
  const redoStackRef = useRef<HistoryEntry[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const transactionBaseRef = useRef<MotionSceneDocument | null>(null);

  // documentRef is the synchronous source of truth: two native events (e.g.
  // pointermove, pointerup) can fire back to back before React re-renders,
  // so any code that needs the *current* document mid-gesture must read the
  // ref, not the `document` state value or a React setState updater closure.
  const commitDocument = useCallback((next: MotionSceneDocument) => {
    documentRef.current = next;
    setDocumentState(next);
  }, []);

  const dispatch = useCallback(
    (label: string, ...commands: SceneCommand[]) => {
      const inverses: SceneCommand[] = [];
      let doc = documentRef.current;
      for (const cmd of commands) {
        const result = applySceneCommand(doc, cmd);
        doc = result.document;
        inverses.push(result.inverse);
      }
      commitDocument(doc);
      undoStackRef.current = [...undoStackRef.current, { label, commands: inverses }];
      redoStackRef.current = [];
      setCanUndo(true);
      setCanRedo(false);
    },
    [commitDocument],
  );

  const undo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const entry = stack[stack.length - 1]!;
    undoStackRef.current = stack.slice(0, -1);
    let doc = documentRef.current;
    const redoCmds: SceneCommand[] = [];
    for (const cmd of entry.commands) {
      const result = applySceneCommand(doc, cmd);
      doc = result.document;
      redoCmds.push(result.inverse);
    }
    commitDocument(doc);
    redoStackRef.current = [...redoStackRef.current, { label: entry.label, commands: redoCmds }];
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
  }, [commitDocument]);

  const redo = useCallback(() => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    const entry = stack[stack.length - 1]!;
    redoStackRef.current = stack.slice(0, -1);
    let doc = documentRef.current;
    const inverses: SceneCommand[] = [];
    for (const cmd of entry.commands) {
      const result = applySceneCommand(doc, cmd);
      doc = result.document;
      inverses.push(result.inverse);
    }
    commitDocument(doc);
    undoStackRef.current = [...undoStackRef.current, { label: entry.label, commands: inverses }];
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
  }, [commitDocument]);

  const beginTransaction = useCallback(() => {
    transactionBaseRef.current = documentRef.current;
  }, []);

  const updateTransaction = useCallback(
    (...commands: SceneCommand[]) => {
      if (transactionBaseRef.current === null) return;
      let doc = documentRef.current;
      for (const cmd of commands) {
        doc = applySceneCommand(doc, cmd).document;
      }
      commitDocument(doc);
    },
    [commitDocument],
  );

  const commitTransaction = useCallback((label: string) => {
    const base = transactionBaseRef.current;
    transactionBaseRef.current = null;
    if (base === null) return;
    const final = documentRef.current;
    if (final === base) return;
    const restoreCommands: SceneCommand[] = [];
    for (const baseLayer of base.layers) {
      const finalLayer = final.layers.find((l) => l.id === baseLayer.id);
      if (finalLayer && finalLayer.transform !== baseLayer.transform) {
        restoreCommands.push({
          type: 'scene.setLayerTransform',
          payload: { layerId: baseLayer.id, transform: baseLayer.transform },
        });
      }
    }
    if (restoreCommands.length === 0) return;
    undoStackRef.current = [...undoStackRef.current, { label, commands: restoreCommands }];
    redoStackRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, []);

  const cancelTransaction = useCallback(() => {
    const base = transactionBaseRef.current;
    transactionBaseRef.current = null;
    if (base === null) return;
    commitDocument(base);
  }, [commitDocument]);

  const selectLayer = useCallback((layerId: MotionLayerId | null) => {
    setSelectedLayerIds(layerId === null ? [] : [layerId]);
  }, []);

  const toggleLayerSelection = useCallback((layerId: MotionLayerId) => {
    setSelectedLayerIds((prev) =>
      prev.includes(layerId) ? prev.filter((id) => id !== layerId) : [...prev, layerId],
    );
  }, []);

  return {
    document,
    selectedLayerIds,
    canUndo,
    canRedo,
    dispatch,
    undo,
    redo,
    selectLayer,
    toggleLayerSelection,
    beginTransaction,
    updateTransaction,
    commitTransaction,
    cancelTransaction,
  };
}

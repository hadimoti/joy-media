import { useCallback, useRef, useState } from 'react';
import type { MotionSceneDocument, MotionLayer, MotionLayerId } from '@joy-media/motion-core';
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
  readonly selectLayers: (layerIds: readonly MotionLayerId[]) => void;
  readonly toggleLayerSelection: (layerId: MotionLayerId) => void;
  readonly clearSelection: () => void;
  readonly selectAll: () => void;
  readonly duplicateSelected: () => void;
  readonly deleteSelected: () => void;
  readonly bringToFront: () => void;
  readonly sendToBack: () => void;
  readonly groupSelected: () => void;
  readonly ungroupSelected: () => void;
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

function duplicateLayer(layer: MotionLayer, idMap: Map<string, string>): MotionLayer {
  const newId = crypto.randomUUID();
  idMap.set(layer.id, newId);
  let children = layer.children;
  if (children.length > 0) {
    children = children.map((childId) => idMap.get(childId) ?? childId);
  }
  const copy = {
    ...layer,
    id: newId,
    name: layer.name.replace(/\s*copy\s*\d*$/i, '').trim() + ' copy',
    transform: { ...layer.transform, x: layer.transform.x + 20, y: layer.transform.y + 20 },
    children,
    animations: [...layer.animations],
  } as MotionLayer;
  if (layer.parentId) {
    (copy as unknown as { parentId: string }).parentId =
      idMap.get(layer.parentId) ?? layer.parentId;
  }
  return copy;
}

export function useSceneEditor(initialDocument?: MotionSceneDocument): SceneEditorState {
  const documentRef = useRef<MotionSceneDocument>(
    initialDocument ?? createBlankScene('Untitled Motion'),
  );
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

  const selectLayers = useCallback((layerIds: readonly MotionLayerId[]) => {
    setSelectedLayerIds(layerIds);
  }, []);

  const toggleLayerSelection = useCallback((layerId: MotionLayerId) => {
    setSelectedLayerIds((prev) =>
      prev.includes(layerId) ? prev.filter((id) => id !== layerId) : [...prev, layerId],
    );
  }, []);

  const clearSelection = useCallback(() => setSelectedLayerIds([]), []);

  const selectAll = useCallback(() => {
    setSelectedLayerIds(documentRef.current.layers.map((l) => l.id));
  }, []);

  const duplicateSelected = useCallback(() => {
    const selected = selectedLayerIds;
    if (selected.length === 0) return;
    const idMap = new Map<string, string>();
    const clones: MotionLayer[] = [];
    for (const layerId of selected) {
      const layer = documentRef.current.layers.find((l) => l.id === layerId);
      if (!layer) continue;
      clones.push(duplicateLayer(layer, idMap));
    }
    if (clones.length === 0) return;
    const commands = clones.map<SceneCommand>((layer) => ({
      type: 'scene.addLayer',
      payload: { layer },
    }));
    dispatch('Duplicate layers', ...commands);
    setSelectedLayerIds(clones.map((l) => l.id));
  }, [dispatch, selectedLayerIds]);

  const deleteSelected = useCallback(() => {
    const selected = selectedLayerIds;
    if (selected.length === 0) return;
    dispatch(
      'Delete layers',
      ...selected.map<SceneCommand>((layerId) => ({
        type: 'scene.removeLayer',
        payload: { layerId },
      })),
    );
    setSelectedLayerIds([]);
  }, [dispatch, selectedLayerIds]);

  const bringToFront = useCallback(() => {
    const selected = selectedLayerIds;
    if (selected.length === 0) return;
    const topId = selected[selected.length - 1];
    if (!topId) return;
    dispatch('Bring to front', {
      type: 'scene.moveLayer',
      payload: { layerId: topId, newIndex: documentRef.current.layers.length - 1 },
    });
  }, [dispatch, selectedLayerIds]);

  const sendToBack = useCallback(() => {
    const selected = selectedLayerIds;
    if (selected.length === 0) return;
    const bottomId = selected[0];
    if (!bottomId) return;
    dispatch('Send to back', {
      type: 'scene.moveLayer',
      payload: { layerId: bottomId, newIndex: 0 },
    });
  }, [dispatch, selectedLayerIds]);

  const groupSelected = useCallback(() => {
    const selected = selectedLayerIds;
    if (selected.length < 2) return;
    const layers = selected
      .map((id) => documentRef.current.layers.find((l) => l.id === id))
      .filter((l): l is MotionLayer => Boolean(l));
    if (layers.length < 2) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const layer of layers) {
      const t = layer.transform;
      minX = Math.min(minX, t.x);
      minY = Math.min(minY, t.y);
      maxX = Math.max(maxX, t.x + t.width);
      maxY = Math.max(maxY, t.y + t.height);
    }
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const width = Math.max(20, maxX - minX);
    const height = Math.max(20, maxY - minY);
    const groupId = crypto.randomUUID();
    const groupLayer = {
      ...layers[0]!,
      id: groupId,
      type: 'group',
      name: 'Group',
      transform: {
        ...layers[0]!.transform,
        x: centerX - width / 2,
        y: centerY - height / 2,
        width,
        height,
      },
      fills: [],
      strokes: [],
      shadows: [],
      children: layers.map((l) => l.id),
      animations: [],
    } as MotionLayer;
    const firstIndex = Math.min(
      ...selected
        .map((id) => documentRef.current.layers.findIndex((l) => l.id === id))
        .filter((i) => i >= 0),
    );
    const commands: SceneCommand[] = [
      {
        type: 'scene.addLayer',
        payload: {
          layer: groupLayer,
          index: firstIndex >= 0 ? firstIndex : documentRef.current.layers.length,
        },
      },
      ...layers.map<SceneCommand>((layer) => ({
        type: 'scene.setLayerProperty',
        payload: { layerId: layer.id, property: 'parentId', value: groupId },
      })),
    ];
    dispatch('Group layers', ...commands);
    setSelectedLayerIds([groupId]);
  }, [dispatch, selectedLayerIds]);

  const ungroupSelected = useCallback(() => {
    const selected = selectedLayerIds;
    if (selected.length !== 1) return;
    const group = documentRef.current.layers.find((l) => l.id === selected[0]);
    if (!group || (group.type !== 'group' && group.type !== 'container')) return;
    const childrenIds = group.children;
    const commands: SceneCommand[] = [
      { type: 'scene.removeLayer', payload: { layerId: group.id } },
      ...childrenIds.map<SceneCommand>((layerId) => ({
        type: 'scene.setLayerProperty',
        payload: { layerId, property: 'parentId', value: undefined },
      })),
    ];
    dispatch('Ungroup layers', ...commands);
    setSelectedLayerIds(childrenIds.length > 0 ? [...childrenIds] : []);
  }, [dispatch, selectedLayerIds]);

  return {
    document,
    selectedLayerIds,
    canUndo,
    canRedo,
    dispatch,
    undo,
    redo,
    selectLayer,
    selectLayers,
    toggleLayerSelection,
    clearSelection,
    selectAll,
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
  };
}

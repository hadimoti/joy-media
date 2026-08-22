import { useCallback, useRef, useState } from 'react';
import {
  applyScene3DTransaction,
  type Scene3DCommand,
  type Scene3DDocumentV1,
  type Scene3DTransaction,
} from '@joy-media/scene3d-core';

interface HistoryEntry {
  readonly transaction: Scene3DTransaction;
  readonly inverse: Scene3DTransaction;
}

export interface ThreeDSceneEditorState {
  readonly document: Scene3DDocumentV1;
  readonly selectedObjectId?: string;
  readonly error?: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly selectObject: (objectId: string | undefined) => void;
  readonly dispatch: (transaction: Scene3DTransaction) => boolean;
  readonly undo: () => void;
  readonly redo: () => void;
}

export function useThreeDSceneEditor(initial: Scene3DDocumentV1): ThreeDSceneEditorState {
  const documentRef = useRef(initial);
  const [document, setDocument] = useState(initial);
  const [selectedObjectId, setSelectedObjectId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const undoRef = useRef<HistoryEntry[]>([]);
  const redoRef = useRef<HistoryEntry[]>([]);
  const commit = useCallback((next: Scene3DDocumentV1) => {
    documentRef.current = next;
    setDocument(next);
  }, []);
  const dispatch = useCallback(
    (transaction: Scene3DTransaction): boolean => {
      try {
        const result = applyScene3DTransaction(documentRef.current, transaction);
        commit(result.document);
        undoRef.current = [...undoRef.current, { transaction, inverse: result.record.inverses }];
        redoRef.current = [];
        setError(undefined);
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      }
    },
    [commit],
  );
  const undo = useCallback(() => {
    const entry = undoRef.current.pop();
    if (entry === undefined) return;
    const result = applyScene3DTransaction(documentRef.current, entry.inverse);
    commit(result.document);
    redoRef.current = [
      ...redoRef.current,
      { transaction: entry.transaction, inverse: result.record.inverses },
    ];
    setError(undefined);
  }, [commit]);
  const redo = useCallback(() => {
    const entry = redoRef.current.pop();
    if (entry === undefined) return;
    const result = applyScene3DTransaction(documentRef.current, entry.transaction);
    commit(result.document);
    undoRef.current = [
      ...undoRef.current,
      { transaction: entry.transaction, inverse: result.record.inverses },
    ];
    setError(undefined);
  }, [commit]);
  const selectObject = useCallback(
    (objectId: string | undefined) => setSelectedObjectId(objectId),
    [],
  );
  return {
    document,
    ...(selectedObjectId === undefined ? {} : { selectedObjectId }),
    ...(error === undefined ? {} : { error }),
    canUndo: undoRef.current.length > 0,
    canRedo: redoRef.current.length > 0,
    selectObject,
    dispatch,
    undo,
    redo,
  };
}

export function transformCommand(
  objectId: string,
  transform: Scene3DDocumentV1['objects'][string]['transform'],
): Scene3DCommand {
  return { type: 'object.setTransform', payload: { objectId, transform } };
}

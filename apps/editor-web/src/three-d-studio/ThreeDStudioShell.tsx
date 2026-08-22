import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserAsset } from '../control-plane-client.js';
import {
  emptyScene3D,
  type Scene3DCommand,
  type Scene3DDocumentV1,
  type Scene3DObject,
} from '@joy-media/scene3d-core';
import { loadScene3DDocument, saveScene3DDocument } from '../scene3d-catalog.js';
import { useThreeDSceneEditor } from './state/useThreeDSceneEditor.js';
import { ThreeDStudioCanvas } from './ThreeDStudioCanvas.js';
import { ThreeDStudioHierarchy } from './ThreeDStudioHierarchy.js';
import { ThreeDStudioInspector } from './ThreeDStudioInspector.js';
import { ThreeDStudioChat } from './ThreeDStudioChat.js';
import { isSupported3DAsset } from '../JoyCode3DViewer.js';

export interface ThreeDStudioShellProps {
  readonly sceneId: string;
  readonly assets?: readonly BrowserAsset[];
  readonly onClose: () => void;
}

export function ThreeDStudioShell({ sceneId, assets = [], onClose }: ThreeDStudioShellProps) {
  const storage = typeof window === 'undefined' ? undefined : window.localStorage;
  const [initialDocument] = useState<Scene3DDocumentV1>(
    () =>
      (storage === undefined ? undefined : loadScene3DDocument(storage, sceneId)) ??
      emptyScene3D(sceneId, 'JOY 3D Scene'),
  );
  const editor = useThreeDSceneEditor(initialDocument);
  const [saveState, setSaveState] = useState<'saved' | 'unsaved' | 'saving' | 'error'>('saved');
  useEffect(() => {
    if (storage === undefined) return;
    setSaveState('unsaved');
    const timer = window.setTimeout(() => {
      try {
        setSaveState('saving');
        saveScene3DDocument(storage, editor.document);
        setSaveState('saved');
      } catch {
        setSaveState('error');
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [editor.document, storage]);
  const saveNow = useCallback(() => {
    if (storage === undefined) return;
    try {
      saveScene3DDocument(storage, editor.document);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }, [editor.document, storage]);
  const saveNowRef = useRef<() => void>(() => undefined);
  saveNowRef.current = saveNow;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveNowRef.current();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) editor.redo();
        else editor.undo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editor.redo, editor.undo, onClose]);
  const dispatch = useCallback(
    (label: string, command: Scene3DCommand) => {
      editor.dispatch({ label, commands: [command] });
    },
    [editor],
  );
  const addObject = useCallback(
    (input: { readonly kind: Scene3DObject['kind']; readonly assetId?: string }) => {
      const id = `object-${crypto.randomUUID().slice(0, 8)}`;
      const object: Scene3DObject = {
        id,
        name: input.kind === 'model' ? 'Model' : input.kind[0]!.toUpperCase() + input.kind.slice(1),
        kind: input.kind,
        transform: {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        ...(input.assetId === undefined ? {} : { assetId: input.assetId }),
        ...(input.kind === 'primitive' ? { primitive: 'box' as const } : {}),
        ...(input.kind === 'light'
          ? { light: { kind: 'point' as const, intensity: 1, color: '#ffffff' } }
          : {}),
        ...(input.kind === 'camera' ? { camera: { fieldOfViewDeg: 50, near: 0.1, far: 100 } } : {}),
      };
      if (input.kind === 'model' && input.assetId !== undefined) {
        const asset = assets.find((candidate) => candidate.id === input.assetId);
        if (asset !== undefined && isSupported3DAsset(asset)) {
          const modelAsset = {
            id: asset.id,
            kind: 'model' as const,
            mimeType: asset.descriptor.mimeType as 'model/gltf-binary' | 'model/gltf+json',
            sha256: asset.sha256,
          };
          const applied = editor.dispatch({
            label: 'Add model',
            commands: [
              { type: 'asset.upsert', payload: { asset: modelAsset } },
              {
                type: 'material.upsert',
                payload: {
                  material: { id: 'default', color: '#7c3aed', roughness: 0.55, metalness: 0.1 },
                },
              },
              { type: 'object.add', payload: { object } },
            ],
          });
          if (applied) editor.selectObject(id);
        }
      } else if (
        editor.dispatch({
          label: `Add ${input.kind}`,
          commands: [{ type: 'object.add', payload: { object } }],
        })
      )
        editor.selectObject(id);
    },
    [assets, editor],
  );
  const removeSelected = useCallback(() => {
    if (editor.selectedObjectId === undefined) return;
    if (
      editor.dispatch({
        label: 'Delete object',
        commands: [{ type: 'object.remove', payload: { objectId: editor.selectedObjectId } }],
      })
    )
      editor.selectObject(undefined);
  }, [editor]);
  const close = useCallback(() => {
    saveNow();
    onClose();
  }, [onClose, saveNow]);
  const command = useMemo(
    () => (command: Scene3DCommand) => dispatch('Inspector edit', command),
    [dispatch],
  );
  return (
    <div
      className="three-d-studio-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="JOY 3D Studio"
    >
      <header className="three-d-studio-topbar">
        <button type="button" onClick={close}>
          Back to Editor
        </button>
        <strong>{editor.document.name}</strong>
        <span role="status">{editor.error ?? `Autosave: ${saveState}`}</span>
        <button type="button" onClick={editor.undo} disabled={!editor.canUndo}>
          Undo
        </button>
        <button type="button" onClick={editor.redo} disabled={!editor.canRedo}>
          Redo
        </button>
        <button type="button" onClick={saveNow}>
          Save
        </button>
      </header>
      <div className="three-d-studio-body">
        <ThreeDStudioHierarchy
          document={editor.document}
          assets={assets}
          selectedObjectId={editor.selectedObjectId}
          onSelect={editor.selectObject}
          onAdd={addObject}
          onRemove={removeSelected}
        />
        <main className="three-d-studio-center">
          <ThreeDStudioCanvas
            document={editor.document}
            assets={assets}
            selectedObjectId={editor.selectedObjectId}
            onSelect={editor.selectObject}
          />
        </main>
        <ThreeDStudioInspector
          document={editor.document}
          selectedObjectId={editor.selectedObjectId}
          onCommand={command}
        />
        <ThreeDStudioChat />
      </div>
    </div>
  );
}

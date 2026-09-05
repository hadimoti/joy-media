import { lazy, Suspense } from 'react';
import type { JoyCode3DRenderAsset } from './JoyCode3DViewer.js';
import type { EditorSession } from './editor-session.js';
import { readThreeDSceneStates } from './three-d-render-layer.js';

const JoyCode3DViewer = lazy(() =>
  import('./JoyCode3DViewer.js').then((module) => ({ default: module.JoyCode3DViewer })),
);

/** A first-class editor workspace for local 3D scene preview and rendering. */
export function Scene3DPanel({
  session,
  onAdd3DRender,
}: {
  readonly session: EditorSession;
  readonly onAdd3DRender: (asset: JoyCode3DRenderAsset) => Promise<void>;
}) {
  const savedScene = readThreeDSceneStates(session.visualProject)[0];
  return (
    <Suspense fallback={null}>
      <JoyCode3DViewer
        {...(savedScene === undefined ? {} : { savedScene })}
        onAddToTimeline={onAdd3DRender}
      />
    </Suspense>
  );
}

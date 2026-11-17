import { Component, lazy, Suspense } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import type { JoyCode3DRenderAsset } from './JoyCode3DViewer.js';
import type { EditorSession } from './editor-session.js';
import { readThreeDSceneStates } from './three-d-render-layer.js';

const JoyCode3DViewer = lazy(() =>
  import('./JoyCode3DViewer.js').then((module) => ({ default: module.JoyCode3DViewer })),
);

class Scene3DViewerBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {}

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <p className="empty-hint" role="status">
          3D preview unavailable.
        </p>
      );
    }
    return this.props.children;
  }
}

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
    // Match the accessible-shell contract every other panel follows: a named
    // `article` root that exists even while the lazy viewer chunk is loading.
    <article className="joy-panel-root scene3d-panel" aria-label="3D Scene">
      <Suspense fallback={null}>
        <Scene3DViewerBoundary>
          <JoyCode3DViewer
            {...(savedScene === undefined ? {} : { savedScene })}
            onAddToTimeline={onAdd3DRender}
          />
        </Scene3DViewerBoundary>
      </Suspense>
    </article>
  );
}
